import * as vscode from "vscode";
import { ParamSymbol, WorkspaceSymbol, ResultSymbol, TaskSymbol, ParsedTektonDoc, parseTektonFile, findResourceAt } from "./model";
import { paramRefsIn } from "./paramRefs";
import { resolveRenameTarget } from "./renameTarget";
import { CONTEXT_TREE, CONTEXT_GROUP_DESCRIPTIONS } from "./contextVariables";
import { TektonWorkspaceIndex, IndexedResource } from "./workspaceIndex";

function md(text: string): vscode.MarkdownString {
  return new vscode.MarkdownString(text);
}

function inRange(range: [number, number] | undefined, offset: number): boolean {
  return !!range && offset >= range[0] && offset <= range[1];
}

function rangeOf(document: vscode.TextDocument, range: [number, number]): vscode.Range {
  return new vscode.Range(document.positionAt(range[0]), document.positionAt(range[1]));
}

function paramHover(p: ParamSymbol): vscode.MarkdownString {
  const lines = [`**${p.name}** — *${p.type ?? "string"} param*`];
  if (p.description) lines.push("", p.description);
  if (p.default !== undefined) lines.push("", `Default: \`${p.default}\``);
  return md(lines.join("\n"));
}

function workspaceHover(w: WorkspaceSymbol): vscode.MarkdownString {
  const lines = [`**${w.name}** — *workspace*`];
  if (w.description) lines.push("", w.description);
  if (w.optional !== undefined) lines.push("", `Optional: ${w.optional}`);
  return md(lines.join("\n"));
}

function resultHover(r: ResultSymbol): vscode.MarkdownString {
  const lines = [`**${r.name}** — *${r.type ?? "string"} result*`];
  if (r.description) lines.push("", r.description);
  return md(lines.join("\n"));
}

function taskHover(task: TaskSymbol, workspaceIndex: TektonWorkspaceIndex): vscode.MarkdownString {
  const lines = [task.taskRefName ? `**${task.name}** — taskRef: \`${task.taskRefName}\`` : `**${task.name}**`];
  if (task.taskRefName) {
    const resolved = workspaceIndex.lookupTask(task.taskRefName);
    if (resolved) {
      const results = resolved.results.length ? resolved.results.map((r) => `\`${r.name}\``).join(", ") : "_none declared_";
      lines.push("", `Results: ${results}`);
    } else {
      lines.push("", `_Task "${task.taskRefName}" isn't indexed — defined elsewhere, templated, or not yet found in this workspace._`);
    }
  }
  return md(lines.join("\n"));
}

function taskResultHover(task: TaskSymbol, resultName: string, workspaceIndex: TektonWorkspaceIndex): vscode.MarkdownString {
  const resolved = task.taskRefName ? workspaceIndex.lookupTask(task.taskRefName) : undefined;
  const result = resolved?.results.find((r) => r.name === resultName);
  const header = `**${resultName}** — result of task \`${task.name}\`${task.taskRefName ? ` (taskRef: \`${task.taskRefName}\`)` : ""}`;
  if (result) {
    const lines = [header];
    if (result.description) lines.push("", result.description);
    return md(lines.join("\n"));
  }
  return md(`${header}\n\n_Not resolved: taskRef \`${task.taskRefName ?? "?"}\` isn't indexed in this workspace._`);
}

/** Hover for a `params: [{name, value}]` binding — a Pipeline task entry's own (scoped to that entry) or a TaskRun's own top-level one — against the referenced Task's declared param. */
function taskParamHover(paramName: string, taskRefName: string, workspaceIndex: TektonWorkspaceIndex): vscode.MarkdownString {
  const resolved = workspaceIndex.lookupTask(taskRefName);
  const param = resolved?.params.find((p) => p.name === paramName);
  const header = `**${paramName}** — param binding (taskRef: \`${taskRefName}\`)`;
  if (param) {
    const lines = [header, "", `*${param.type ?? "string"} param*`];
    if (param.description) lines.push("", param.description);
    if (param.default !== undefined) lines.push("", `Default: \`${param.default}\``);
    return md(lines.join("\n"));
  }
  return md(
    `${header}\n\n_Not resolved: taskRef \`${taskRefName}\` isn't indexed in this workspace, or declares no param named "${paramName}"._`
  );
}

/** Hover card for a resource's own identity (metadata.name), shown whether the cursor is on the declaration or a reference to it (taskRef/pipelineRef/template.ref/bindings[].ref/triggerRef). */
function identityHover(kindLabel: string, record: IndexedResource): vscode.MarkdownString {
  const symbols = record.parsed.symbols;
  const lines = [`**${symbols.metadataName}** — ${kindLabel}`];
  if (symbols.params.length) lines.push("", `Params: ${symbols.params.map((p) => `\`${p.name}\``).join(", ")}`);
  if (symbols.bindingParams.length) lines.push("", `Provides: ${symbols.bindingParams.map((p) => `\`${p.name}\``).join(", ")}`);
  return md(lines.join("\n"));
}

function contextHover(raw: string): vscode.MarkdownString | undefined {
  const inner = raw.slice(2, -1).split(".").slice(1); // "$(context.a.b)" -> ["a", "b"]
  const [group, leaf] = inner;
  if (!group) return undefined;
  if (!leaf) {
    const description = CONTEXT_GROUP_DESCRIPTIONS[group];
    return description ? md(`**context.${group}**\n\n${description}`) : undefined;
  }
  const entry = CONTEXT_TREE[group]?.find((v) => v.key === leaf);
  return entry ? md(`**context.${group}.${leaf}**\n\n${entry.description}`) : undefined;
}

export class TektonHoverProvider implements vscode.HoverProvider {
  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const docs = parseTektonFile(document.getText());
    const offset = document.offsetAt(position);
    const parsed = findResourceAt(docs, offset);
    if (!parsed) return undefined;

    const { symbols } = parsed;

    // Identity sites: hovering a resource's own metadata.name, or a taskRef/
    // pipelineRef/template.ref/bindings[].ref/triggerRef pointing at one.
    const identity = this.identityHoverAt(parsed, offset, document);
    if (identity) return identity;

    // Declaration sites: hovering the `name:` value itself.
    for (const p of symbols.params) {
      if (inRange(p.range, offset)) return new vscode.Hover(paramHover(p), rangeOf(document, p.range!));
    }
    for (const w of symbols.workspaces) {
      if (inRange(w.range, offset)) return new vscode.Hover(workspaceHover(w), rangeOf(document, w.range!));
    }
    for (const r of symbols.results) {
      if (inRange(r.range, offset)) return new vscode.Hover(resultHover(r), rangeOf(document, r.range!));
    }
    for (const t of symbols.tasks) {
      if (inRange(t.range, offset)) return new vscode.Hover(taskHover(t, this.workspaceIndex), rangeOf(document, t.range!));
    }

    // Reference sites: hovering inside a $(...) expression.
    for (const ref of paramRefsIn(parsed)) {
      if (offset < ref.start || offset > ref.end) continue;

      if ((ref.kind === "param" || ref.kind === "tt-param") && ref.name && ref.nameStart !== undefined && ref.nameEnd !== undefined) {
        const p = symbols.params.find((x) => x.name === ref.name);
        if (p) return new vscode.Hover(paramHover(p), rangeOf(document, [ref.nameStart, ref.nameEnd]));
      }

      if (ref.kind === "workspace" && ref.name && ref.nameStart !== undefined && ref.nameEnd !== undefined) {
        const w = symbols.workspaces.find((x) => x.name === ref.name);
        if (w) return new vscode.Hover(workspaceHover(w), rangeOf(document, [ref.nameStart, ref.nameEnd]));
      }

      if (ref.kind === "result" && ref.name && ref.nameStart !== undefined && ref.nameEnd !== undefined) {
        const r = symbols.results.find((x) => x.name === ref.name);
        if (r) return new vscode.Hover(resultHover(r), rangeOf(document, [ref.nameStart, ref.nameEnd]));
      }

      if (ref.kind === "task-result" && ref.name) {
        const task = symbols.tasks.find((x) => x.name === ref.name);
        if (!task) continue;
        if (
          ref.resultName &&
          ref.resultNameStart !== undefined &&
          ref.resultNameEnd !== undefined &&
          offset >= ref.resultNameStart &&
          offset <= ref.resultNameEnd
        ) {
          return new vscode.Hover(
            taskResultHover(task, ref.resultName, this.workspaceIndex),
            rangeOf(document, [ref.resultNameStart, ref.resultNameEnd])
          );
        }
        if (ref.nameStart !== undefined && ref.nameEnd !== undefined) {
          return new vscode.Hover(taskHover(task, this.workspaceIndex), rangeOf(document, [ref.nameStart, ref.nameEnd]));
        }
      }

      if (ref.kind === "context") {
        const hover = contextHover(ref.raw);
        if (hover) return new vscode.Hover(hover, rangeOf(document, [ref.start, ref.end]));
      }
    }

    return undefined;
  }

  private identityHoverAt(parsed: ParsedTektonDoc, offset: number, document: vscode.TextDocument): vscode.Hover | undefined {
    const target = resolveRenameTarget(parsed, offset);
    if (!target) return undefined;

    if (target.kind === "task-param") {
      return new vscode.Hover(taskParamHover(target.paramName, target.taskRefName, this.workspaceIndex), rangeOf(document, target.range));
    }

    let record: IndexedResource | undefined;
    let kindLabel: string;
    switch (target.kind) {
      case "task-identity":
        record = this.workspaceIndex.lookupTaskRecord(target.name);
        kindLabel = "Task";
        break;
      case "pipeline-identity":
        record = this.workspaceIndex.lookupPipelineRecord(target.name);
        kindLabel = "Pipeline";
        break;
      case "template-identity":
        record = this.workspaceIndex.lookupTriggerTemplateRecord(target.name);
        kindLabel = "TriggerTemplate";
        break;
      case "binding-identity":
        record = this.workspaceIndex.lookupTriggerBindingRecord(target.name);
        kindLabel = "TriggerBinding";
        break;
      case "trigger-identity":
        record = this.workspaceIndex.lookupTriggerRecord(target.name);
        kindLabel = "Trigger";
        break;
      default:
        return undefined;
    }
    if (!record) return undefined;
    return new vscode.Hover(identityHover(kindLabel, record), rangeOf(document, target.range));
  }
}
