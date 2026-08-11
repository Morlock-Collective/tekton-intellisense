import * as vscode from "vscode";
import { NamedSymbol, TektonSymbols, parseTektonDocument } from "./model";
import { findParamRefs, RefKind } from "./paramRefs";

type DeclarableKind = "param" | "workspace" | "result" | "task-result";

function isDeclarableKind(kind: RefKind): kind is DeclarableKind {
  return kind === "param" || kind === "workspace" || kind === "result" || kind === "task-result";
}

function declListFor(symbols: TektonSymbols, kind: DeclarableKind): NamedSymbol[] {
  switch (kind) {
    case "param":
      return symbols.params;
    case "workspace":
      return symbols.workspaces;
    case "result":
      return symbols.results;
    case "task-result":
      return symbols.tasks;
  }
}

function inRange(range: [number, number] | undefined, offset: number): boolean {
  return !!range && offset >= range[0] && offset <= range[1];
}

function toRange(document: vscode.TextDocument, range: [number, number]): vscode.Range {
  return new vscode.Range(document.positionAt(range[0]), document.positionAt(range[1]));
}

/**
 * "Find All References" for params/workspaces/results/tasks, scoped to the
 * current document (Tekton resources are almost always authored one-per-
 * file, and cross-file reverse lookup — "which Pipelines use this Task's
 * result" — would need indexing every Pipeline's task-result usages, not
 * just Tasks; left for a later pass, see docs/ROADMAP.md).
 */
export class TektonReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext
  ): vscode.Location[] | undefined {
    const parsed = parseTektonDocument(document.getText());
    if (!parsed) return undefined;

    const offset = document.offsetAt(position);
    const { symbols } = parsed;

    let targetKind: DeclarableKind | undefined;
    let targetName: string | undefined;

    for (const kind of ["param", "workspace", "result", "task-result"] as const) {
      const found = declListFor(symbols, kind).find((s) => inRange(s.range, offset));
      if (found) {
        targetKind = kind;
        targetName = found.name;
        break;
      }
    }

    if (!targetKind) {
      for (const ref of findParamRefs(parsed.text)) {
        if (offset < ref.start || offset > ref.end) continue;
        if (isDeclarableKind(ref.kind) && ref.name) {
          targetKind = ref.kind;
          targetName = ref.name;
        }
        break;
      }
    }

    if (!targetKind || !targetName) return undefined;

    const locations: vscode.Location[] = [];

    if (context.includeDeclaration) {
      const decl = declListFor(symbols, targetKind).find((s) => s.name === targetName);
      if (decl?.range) locations.push(new vscode.Location(document.uri, toRange(document, decl.range)));
    }

    for (const ref of findParamRefs(parsed.text)) {
      if (ref.kind !== targetKind || ref.name !== targetName) continue;
      if (ref.nameStart === undefined || ref.nameEnd === undefined) continue;
      locations.push(new vscode.Location(document.uri, toRange(document, [ref.nameStart, ref.nameEnd])));
    }

    return locations;
  }
}
