import * as vscode from "vscode";
import { ParsedTektonDoc, parseTektonDocument } from "./model";
import { findParamRefs } from "./paramRefs";
import { TektonWorkspaceIndex } from "./workspaceIndex";

function localRange(document: vscode.TextDocument, range: [number, number]): vscode.Range {
  return new vscode.Range(document.positionAt(range[0]), document.positionAt(range[1]));
}

/** Converts an offset range in another (possibly unopened) document's source text into a Range, via its lineCounter. */
function remoteRange(parsed: ParsedTektonDoc, range: [number, number]): vscode.Range {
  const start = parsed.lineCounter.linePos(range[0]);
  const end = parsed.lineCounter.linePos(range[1]);
  return new vscode.Range(start.line - 1, start.col - 1, end.line - 1, end.col - 1);
}

/**
 * "Go to Definition" for $(...) references: jumps from a param/workspace/
 * result/task reference to its declaring `name:` field. For
 * $(tasks.X.results.Y), jumping from Y resolves cross-file to the actual
 * Task X's taskRef points at, via the same workspace index completions and
 * hover use.
 */
export class TektonDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const parsed = parseTektonDocument(document.getText());
    if (!parsed) return undefined;

    const offset = document.offsetAt(position);
    const { symbols } = parsed;

    for (const ref of findParamRefs(parsed.text)) {
      if (offset < ref.start || offset > ref.end) continue;

      if (ref.kind === "param" && ref.name) {
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
            return new vscode.Location(record.uri, remoteRange(record.parsed, result.range));
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
}
