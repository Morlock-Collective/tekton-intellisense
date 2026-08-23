import * as vscode from "vscode";
import {
  parseTektonFile,
  findResourceAt,
  ParsedTektonDoc,
  TASK_LIKE_KINDS,
  TektonSymbols,
  TRIGGER_BINDING_LIKE_KINDS,
  taskParamBindingLocationAt,
} from "./model";
import { TektonWorkspaceIndex } from "./workspaceIndex";
import { CONTEXT_TREE } from "./contextVariables";
import { loadSchema } from "./jsonSchemas";
import { schemaPropertyCompletions, SchemaPropertyCompletion } from "./schemaCompletions";

const WORKSPACE_FIELDS = ["path", "claim", "volume", "bound"];
const RESULT_FIELDS = ["path"];

interface RefContext {
  /** the range covering just the in-progress path segment, to be replaced by the chosen completion */
  replaceRange: vscode.Range;
  /** already-typed, dot-separated path segments preceding the partial one currently being completed */
  segments: string[];
}

/**
 * Looks backward from `position` on the current line for an unclosed
 * `$(...)`. Returns the segments already typed (split on `.`) and the range
 * of the in-progress final segment, or undefined if the cursor isn't inside
 * a reference at all.
 */
function getRefContext(document: vscode.TextDocument, position: vscode.Position): RefContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefix = lineText.slice(0, position.character);
  const openIdx = prefix.lastIndexOf("$(");
  if (openIdx === -1) return undefined;

  const between = prefix.slice(openIdx + 2);
  if (between.includes(")")) return undefined;
  // Reference bodies are dots/word-chars/hyphens only; anything else (e.g. an
  // unrelated "$(" earlier in a shell command) means we're not really inside one.
  if (!/^[a-zA-Z0-9_.\-]*$/.test(between)) return undefined;

  const segments = between.split(".");
  const partial = segments.pop() ?? "";
  const partialStart = position.character - partial.length;
  const replaceRange = new vscode.Range(position.line, partialStart, position.line, position.character);
  return { replaceRange, segments };
}

interface IdentityRefContext {
  /** offset range of the plain-scalar ref-name value under the cursor */
  range: [number, number];
  detail: string;
  names: (index: TektonWorkspaceIndex) => string[];
}

function inOffsetRange(range: [number, number] | undefined, offset: number): boolean {
  return !!range && offset >= range[0] && offset <= range[1];
}

/**
 * Finds a plain-scalar identity ref-name field (`taskRef.name`,
 * `pipelineRef.name`, `bindings[].ref`, `template.ref`, `triggerRef`) at
 * `offset`, if any. Unlike `$(...)` refs, these have no delimiter to trigger
 * off of — VS Code invokes completion on ordinary word characters, so this
 * only finds anything once at least one character of the name is typed
 * (matching the field ranges `model.ts` computes: an empty/unwritten scalar
 * has no name to derive a range from).
 */
function identityRefContextAt(symbols: TektonSymbols, offset: number): IdentityRefContext | undefined {
  for (const t of symbols.tasks) {
    if (inOffsetRange(t.taskRefNameRange, offset)) {
      return { range: t.taskRefNameRange!, detail: "Task/ClusterTask/StepAction", names: (i) => i.allTaskNames() };
    }
  }
  if (symbols.kind === "TaskRun" && inOffsetRange(symbols.taskRefNameRange, offset)) {
    return { range: symbols.taskRefNameRange!, detail: "Task/ClusterTask/StepAction", names: (i) => i.allTaskNames() };
  }
  if (symbols.kind === "PipelineRun" && inOffsetRange(symbols.pipelineRefNameRange, offset)) {
    return { range: symbols.pipelineRefNameRange!, detail: "Pipeline", names: (i) => i.allPipelineNames() };
  }

  for (const trigger of symbols.triggers) {
    for (const ref of trigger.bindingRefs) {
      if (inOffsetRange(ref.range, offset)) {
        return {
          range: ref.range!,
          detail: "TriggerBinding/ClusterTriggerBinding",
          names: (i) => i.allTriggerBindingNames(),
        };
      }
    }
    if (inOffsetRange(trigger.templateRefNameRange, offset)) {
      return { range: trigger.templateRefNameRange!, detail: "TriggerTemplate", names: (i) => i.allTriggerTemplateNames() };
    }
    if (inOffsetRange(trigger.triggerRefNameRange, offset)) {
      return { range: trigger.triggerRefNameRange!, detail: "Trigger", names: (i) => i.allTriggerNames() };
    }
  }

  if (symbols.kind === "Trigger") {
    if (inOffsetRange(symbols.templateRefNameRange, offset)) {
      return { range: symbols.templateRefNameRange!, detail: "TriggerTemplate", names: (i) => i.allTriggerTemplateNames() };
    }
    for (const ref of symbols.bindingRefs) {
      if (inOffsetRange(ref.range, offset)) {
        return {
          range: ref.range!,
          detail: "TriggerBinding/ClusterTriggerBinding",
          names: (i) => i.allTriggerBindingNames(),
        };
      }
    }
  }

  return undefined;
}

/**
 * The range to replace when completing a `name:` field's *value* on the
 * current line, from `document`/`position` text alone — used for task
 * param-binding-name completion (see {@link taskParamBindingLocationAt}),
 * since that's resolved from the enclosing `params:` sequence's own AST
 * range rather than the binding's own (which a completely blank `name: `
 * doesn't have at all, the state completion is most useful in — so there's
 * no scalar range to derive a replace span from the usual way).
 * Undefined unless the text immediately before the cursor, on this line,
 * is exactly `<indent><"- ">?name:<whitespace>` — i.e. the cursor is
 * really positioned right after a `name:` key's colon (plus whatever
 * whitespace/partial value follows), not somewhere else entirely that
 * happens to share a `params:` sequence's range (its sibling `value:`
 * field, for one).
 */
const NAME_FIELD_PREFIX = /^\s*(-\s+)?name:\s*/;

function nameFieldValueRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.slice(0, position.character);
  const m = NAME_FIELD_PREFIX.exec(beforeCursor);
  if (!m) return undefined;
  return new vscode.Range(new vscode.Position(position.line, m[0].length), position);
}

function item(
  label: string,
  range: vscode.Range,
  kind: vscode.CompletionItemKind,
  detail?: string
): vscode.CompletionItem {
  const ci = new vscode.CompletionItem(label, kind);
  ci.range = range;
  if (detail) ci.detail = detail;
  return ci;
}

/** `$(tt.params.NAME)` / `$(uid)` — a TriggerTemplate's own resourcetemplates. */
function triggerTemplateCompletions(
  segments: string[],
  replaceRange: vscode.Range,
  symbols: TektonSymbols
): vscode.CompletionItem[] {
  if (segments.length === 0) {
    return [
      item("tt", replaceRange, vscode.CompletionItemKind.Module, "This TriggerTemplate's own declared parameter"),
      item("uid", replaceRange, vscode.CompletionItemKind.Constant, "Random value, unique per trigger invocation"),
    ];
  }
  if (segments[0] === "tt") {
    if (segments.length === 1) {
      return [item("params", replaceRange, vscode.CompletionItemKind.Module, "Declared parameter")];
    }
    if (segments.length === 2 && segments[1] === "params") {
      return symbols.params.map((p) => item(p.name, replaceRange, vscode.CompletionItemKind.Variable, "param"));
    }
  }
  return [];
}

/** `$(body...)` / `$(header...)` / `$(extensions...)` / `$(context...)` — a TriggerBinding's value expressions. */
function triggerBindingCompletions(segments: string[], replaceRange: vscode.Range): vscode.CompletionItem[] {
  if (segments.length === 0) {
    return [
      item("body", replaceRange, vscode.CompletionItemKind.Module, "Incoming webhook payload body"),
      item("header", replaceRange, vscode.CompletionItemKind.Module, "Incoming webhook request header"),
      item("extensions", replaceRange, vscode.CompletionItemKind.Module, "Interceptor-added extension fields"),
      item("context", replaceRange, vscode.CompletionItemKind.Module, "Built-in EventListener context"),
    ];
  }
  // body/header/extensions/context are arbitrary paths into the incoming webhook payload, which
  // has no declared schema here to complete against -- same reason diagnostics.ts never flags
  // these as "unknown" either.
  return [];
}

export class TektonRefCompletionProvider implements vscode.CompletionItemProvider {
  static readonly triggerCharacters = ["(", "."];

  constructor(
    private readonly workspaceIndex: TektonWorkspaceIndex,
    private readonly schemasDir: string
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const parsed = findResourceAt(parseTektonFile(document.getText()), document.offsetAt(position));
    if (!parsed) return undefined;

    const ctx = getRefContext(document, position);
    if (ctx) return this.completionsFor(ctx, parsed);

    const identity = this.identityCompletionsFor(document, position, parsed);
    if (identity) return identity;

    // Falls through here for "what key goes here" completion (e.g. suggesting `script` inside a
    // step's own map) whenever the cursor isn't inside a $(...) reference or an identity ref-name
    // field -- the common case, since most of a document's content is neither of those.
    return this.schemaCompletionsFor(document, position, parsed);
  }

  private identityCompletionsFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    parsed: ParsedTektonDoc
  ): vscode.CompletionItem[] | undefined {
    const offset = document.offsetAt(position);

    const target = identityRefContextAt(parsed.symbols, offset);
    if (target) {
      const replaceRange = new vscode.Range(document.positionAt(target.range[0]), document.positionAt(target.range[1]));
      return target.names(this.workspaceIndex).map((name) => item(name, replaceRange, vscode.CompletionItemKind.Reference, target.detail));
    }

    // Only even attempted on a line that's really "name:" (plus whatever's typed after it) --
    // taskParamBindingLocationAt matches by the enclosing params: *sequence's* own range, which
    // also covers a sibling value: field, so this is what keeps it from firing there too.
    const nameRange = nameFieldValueRange(document, position);
    if (nameRange) {
      const location = taskParamBindingLocationAt(parsed, offset);
      if (location) {
        const resolved = this.workspaceIndex.lookupTask(location.taskRefName);
        if (resolved) {
          const already = new Set(location.boundNames);
          return resolved.params
            .filter((p) => !already.has(p.name))
            .map((p) => item(p.name, nameRange, vscode.CompletionItemKind.Variable, `param of ${location.taskRefName}`));
        }
      }
    }

    return undefined;
  }

  private completionsFor(ctx: RefContext, parsed: ParsedTektonDoc): vscode.CompletionItem[] {
    const { segments, replaceRange } = ctx;
    const { symbols } = parsed;

    if (symbols.kind === "TriggerTemplate") return triggerTemplateCompletions(segments, replaceRange, symbols);
    if (TRIGGER_BINDING_LIKE_KINDS.has(symbols.kind)) return triggerBindingCompletions(segments, replaceRange);

    const isPipeline = symbols.kind === "Pipeline";
    const isTaskLike = TASK_LIKE_KINDS.has(symbols.kind);
    // EventListener/Trigger have no $(...) reference syntax of their own — their ref fields
    // (bindings[].ref, template.ref, triggerRef) are plain scalars, handled by identityCompletionsFor.
    if (!isPipeline && !isTaskLike) return [];

    if (segments.length === 0) {
      const items = [item("params", replaceRange, vscode.CompletionItemKind.Module, "Declared parameter")];
      items.push(item("workspaces", replaceRange, vscode.CompletionItemKind.Module, "Declared workspace"));
      if (isTaskLike) {
        items.push(item("results", replaceRange, vscode.CompletionItemKind.Module, "This resource's declared result"));
      }
      if (isPipeline) {
        items.push(item("tasks", replaceRange, vscode.CompletionItemKind.Module, "Another task's result"));
      }
      items.push(item("context", replaceRange, vscode.CompletionItemKind.Module, "Built-in run context"));
      return items;
    }

    const head = segments[0];

    if (head === "params" && segments.length === 1) {
      return symbols.params.map((p) => item(p.name, replaceRange, vscode.CompletionItemKind.Variable, "param"));
    }

    if (head === "workspaces") {
      if (segments.length === 1) {
        return symbols.workspaces.map((w) =>
          item(w.name, replaceRange, vscode.CompletionItemKind.Variable, "workspace")
        );
      }
      if (segments.length === 2) {
        return WORKSPACE_FIELDS.map((f) => item(f, replaceRange, vscode.CompletionItemKind.Property, "workspace field"));
      }
    }

    if (head === "results") {
      if (segments.length === 1) {
        return symbols.results.map((r) => item(r.name, replaceRange, vscode.CompletionItemKind.Variable, "result"));
      }
      if (segments.length === 2) {
        return RESULT_FIELDS.map((f) => item(f, replaceRange, vscode.CompletionItemKind.Property, "result field"));
      }
    }

    if (head === "tasks" && isPipeline) {
      if (segments.length === 1) {
        return symbols.tasks.map((t) => item(t.name, replaceRange, vscode.CompletionItemKind.Variable, "pipeline task"));
      }
      if (segments.length === 2) {
        return [item("results", replaceRange, vscode.CompletionItemKind.Property, "that task's declared results")];
      }
      if (segments.length === 3 && segments[2] === "results") {
        const localTaskName = segments[1];
        const taskEntry = symbols.tasks.find((t) => t.name === localTaskName);
        const resolved = taskEntry?.taskRefName ? this.workspaceIndex.lookupTask(taskEntry.taskRefName) : undefined;
        if (!resolved) return [];
        return resolved.results.map((r) =>
          item(r.name, replaceRange, vscode.CompletionItemKind.Variable, `result of ${taskEntry!.taskRefName}`)
        );
      }
    }

    if (head === "context") {
      if (segments.length === 1) {
        const keys = isPipeline
          ? ["pipeline", "pipelineRun", "pipelineTask"]
          : ["task", "taskRun", "pipeline", "pipelineRun"];
        return keys.map((k) => item(k, replaceRange, vscode.CompletionItemKind.Module, "context"));
      }
      if (segments.length === 2) {
        const leaves = CONTEXT_TREE[segments[1]] ?? [];
        return leaves.map((l) => item(l.key, replaceRange, vscode.CompletionItemKind.Property, l.description));
      }
    }

    return [];
  }

  /** "What key goes here" completion, from the matching schema in `schemas/` -- see `schemaCompletions.ts`. */
  private schemaCompletionsFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    parsed: ParsedTektonDoc
  ): vscode.CompletionItem[] | undefined {
    const schema = loadSchema(this.schemasDir, parsed.symbols.apiVersion, parsed.symbols.kind);
    if (!schema) return undefined;

    const result = schemaPropertyCompletions(parsed.text, schema, document.offsetAt(position));
    if (!result || result.completions.length === 0) return undefined;

    const replaceRange = new vscode.Range(document.positionAt(result.replaceRange[0]), document.positionAt(result.replaceRange[1]));
    return result.completions.map((c) => this.toSchemaCompletionItem(c, replaceRange));
  }

  private toSchemaCompletionItem(c: SchemaPropertyCompletion, replaceRange: vscode.Range): vscode.CompletionItem {
    const ci = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Property);
    // Replaces whatever's already typed on this line (e.g. "p") rather than inserting alongside
    // it -- without this, accepting "params" over a typed "p" would leave "pparams: " behind.
    ci.range = replaceRange;
    if (c.description) ci.documentation = new vscode.MarkdownString(c.description);

    // A snippet, not plain text, in every case -- even the plain scalar one -- so acceptance
    // always leaves the cursor at $0, ready to type the value, rather than after a bare "key: "
    // with nothing selected.
    const snippet = new vscode.SnippetString().appendText(`${c.name}: `);
    if (c.enumValues && c.enumValues.length > 1) {
      snippet.appendChoice(c.enumValues);
    } else if (c.valueShape === "array") {
      snippet.appendText("\n  - ").appendTabstop(0);
    } else if (c.valueShape === "object") {
      snippet.appendText("\n  ").appendTabstop(0);
    } else {
      snippet.appendTabstop(0);
    }
    ci.insertText = snippet;
    return ci;
  }
}
