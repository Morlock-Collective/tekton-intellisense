import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc } from "./model";
import { TektonWorkspaceIndex } from "./workspaceIndex";

/** context.<a>.<b> — mirrors https://tekton.dev/docs/pipelines/variables/#variables-available-in-a-task */
const CONTEXT_TREE: Record<string, string[]> = {
  pipeline: ["name"],
  pipelineRun: ["name", "namespace", "uid"],
  pipelineTask: ["retries"],
  task: ["name", "retry-count"],
  taskRun: ["name", "namespace", "uid"],
};

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

export class TektonRefCompletionProvider implements vscode.CompletionItemProvider {
  static readonly triggerCharacters = ["(", "."];

  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const ctx = getRefContext(document, position);
    if (!ctx) return undefined;

    const parsed = parseTektonDocument(document.getText());
    if (!parsed) return undefined;

    return this.completionsFor(ctx, parsed);
  }

  private completionsFor(ctx: RefContext, parsed: ParsedTektonDoc): vscode.CompletionItem[] {
    const { segments, replaceRange } = ctx;
    const { symbols } = parsed;
    const isPipeline = symbols.kind === "Pipeline";
    const isTaskLike = symbols.kind === "Task" || symbols.kind === "ClusterTask" || symbols.kind === "StepAction";

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
        return leaves.map((l) => item(l, replaceRange, vscode.CompletionItemKind.Property, "context field"));
      }
    }

    return [];
  }
}
