import * as vscode from "vscode";
import { ParsedTektonDoc, parseTektonFile, findResourceAt } from "./model";
import { paramRefsIn } from "./paramRefs";
import { resolveRenameTarget, resolveIdentityRecord } from "./renameTarget";
import { TektonWorkspaceIndex } from "./workspaceIndex";
import { toVscodeRange } from "./rangeUtils";

function localRange(document: vscode.TextDocument, range: [number, number]): vscode.Range {
  return new vscode.Range(document.positionAt(range[0]), document.positionAt(range[1]));
}

/**
 * "Go to Definition" for $(...) references: jumps from a param/workspace/
 * result/task reference to its declaring `name:` field. For
 * $(tasks.X.results.Y), jumping from Y resolves cross-file to the actual
 * Task X's taskRef points at, via the same workspace index completions and
 * hover use. Also handles the plain-scalar identity references (taskRef/
 * pipelineRef/template.ref/bindings[].ref/triggerRef) via {@link resolveIdentityDefinition}.
 */
export class TektonDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const offset = document.offsetAt(position);
    const parsed = findResourceAt(parseTektonFile(document.getText()), offset);
    if (!parsed) return undefined;

    const { symbols } = parsed;

    const identity = this.resolveIdentityDefinition(parsed, offset);
    if (identity) return identity;

    for (const ref of paramRefsIn(parsed)) {
      if (offset < ref.start || offset > ref.end) continue;

      if ((ref.kind === "param" || ref.kind === "tt-param") && ref.name) {
        const p = symbols.params.find((x) => x.name === ref.name);
        if (p?.range) return new vscode.Location(document.uri, localRange(document, p.range));
        return undefined;
      }

      if (ref.kind === "workspace" && ref.name) {
        const w = symbols.workspaces.find((x) => x.name === ref.name);
        if (w?.range) return new vscode.Location(document.uri, localRange(document, w.range));
        return undefined;
      }

      if (ref.kind === "result" && ref.name) {
        const r = symbols.results.find((x) => x.name === ref.name);
        if (r?.range) return new vscode.Location(document.uri, localRange(document, r.range));
        return undefined;
      }

      if (ref.kind === "task-result" && ref.name) {
        const task = symbols.tasks.find((x) => x.name === ref.name);
        if (!task) return undefined;

        const onResultSegment =
          ref.resultName !== undefined &&
          ref.resultNameStart !== undefined &&
          ref.resultNameEnd !== undefined &&
          offset >= ref.resultNameStart &&
          offset <= ref.resultNameEnd;

        if (onResultSegment && task.taskRefName) {
          const record = this.workspaceIndex.lookupTaskRecord(task.taskRefName);
          const result = record?.parsed.symbols.results.find((r) => r.name === ref.resultName);
          if (record && result?.range) {
            return new vscode.Location(record.uri, toVscodeRange(record.parsed, result.range));
          }
          return undefined;
        }

        // On the task-name segment: jump to this pipeline's own spec.tasks[] entry.
        if (task.range) return new vscode.Location(document.uri, localRange(document, task.range));
        return undefined;
      }

      return undefined;
    }

    return undefined;
  }

  private resolveIdentityDefinition(parsed: ParsedTektonDoc, offset: number): vscode.Location | undefined {
    const target = resolveRenameTarget(parsed, offset);
    if (!target) return undefined;

    if (target.kind === "task-param") {
      const taskRecord = this.workspaceIndex.lookupTaskRecord(target.taskRefName);
      const param = taskRecord?.parsed.symbols.params.find((p) => p.name === target.paramName);
      if (!taskRecord || !param?.range) return undefined;
      return new vscode.Location(taskRecord.uri, toVscodeRange(taskRecord.parsed, param.range));
    }

    const resolved = resolveIdentityRecord(this.workspaceIndex, target);
    const nameRange = resolved?.record.parsed.symbols.metadataNameRange;
    if (!resolved || !nameRange) return undefined;
    return new vscode.Location(resolved.record.uri, toVscodeRange(resolved.record.parsed, nameRange));
  }
}
