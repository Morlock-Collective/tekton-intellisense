import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc, TASK_LIKE_KINDS, TektonSymbols, TRIGGER_BINDING_LIKE_KINDS } from "./model";
import { TektonWorkspaceIndex } from "./workspaceIndex";
import { CONTEXT_TREE } from "./contextVariables";

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

  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const parsed = parseTektonDocument(document.getText());
    if (!parsed) return undefined;

    const ctx = getRefContext(document, position);
    if (ctx) return this.completionsFor(ctx, parsed);

    return this.identityCompletionsFor(document, position, parsed.symbols);
  }

  private identityCompletionsFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbols: TektonSymbols
  ): vscode.CompletionItem[] | undefined {
    const target = identityRefContextAt(symbols, document.offsetAt(position));
    if (!target) return undefined;

    const replaceRange = new vscode.Range(document.positionAt(target.range[0]), document.positionAt(target.range[1]));
    return target.names(this.workspaceIndex).map((name) => item(name, replaceRange, vscode.CompletionItemKind.Reference, target.detail));
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
}
