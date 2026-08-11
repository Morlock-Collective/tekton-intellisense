import * as vscode from "vscode";
import { parseTektonDocument, TektonSymbols } from "./model";
import { findParamRefs, ParamRef } from "./paramRefs";
import { closestMatch } from "./levenshtein";

export const DIAGNOSTIC_SOURCE = "tekton-aid";

function offsetToPosition(doc: vscode.TextDocument, offset: number): vscode.Position {
  return doc.positionAt(offset);
}

function checkRef(
  ref: ParamRef,
  symbols: TektonSymbols
): { message: string; suggestion?: string } | undefined {
  switch (ref.kind) {
    case "param": {
      const names = symbols.params.map((p) => p.name);
      if (ref.name && !names.includes(ref.name)) {
        const suggestion = closestMatch(ref.name, names);
        return {
          message: suggestion
            ? `Unknown parameter "${ref.name}". Did you mean "${suggestion}"?`
            : `Unknown parameter "${ref.name}". Declared params: ${names.join(", ") || "(none)"}.`,
          suggestion,
        };
      }
      return undefined;
    }
    case "workspace": {
      const names = symbols.workspaces.map((w) => w.name);
      if (ref.name && !names.includes(ref.name)) {
        const suggestion = closestMatch(ref.name, names);
        return {
          message: suggestion
            ? `Unknown workspace "${ref.name}". Did you mean "${suggestion}"?`
            : `Unknown workspace "${ref.name}". Declared workspaces: ${names.join(", ") || "(none)"}.`,
          suggestion,
        };
      }
      return undefined;
    }
    case "result": {
      // Only meaningful within Task-like docs that declare their own results.
      if (symbols.kind !== "Task" && symbols.kind !== "ClusterTask" && symbols.kind !== "StepAction") {
        return undefined;
      }
      const names = symbols.results.map((r) => r.name);
      if (ref.name && !names.includes(ref.name)) {
        const suggestion = closestMatch(ref.name, names);
        return {
          message: suggestion
            ? `Unknown result "${ref.name}". Did you mean "${suggestion}"?`
            : `Unknown result "${ref.name}". Declared results: ${names.join(", ") || "(none)"}.`,
          suggestion,
        };
      }
      return undefined;
    }
    case "task-result": {
      if (symbols.kind !== "Pipeline") return undefined;
      const names = symbols.tasks.map((t) => t.name);
      if (ref.name && !names.includes(ref.name)) {
        const suggestion = closestMatch(ref.name, names);
        return {
          message: suggestion
            ? `Unknown task "${ref.name}" referenced from tasks.${ref.name}.results.${ref.resultName}. Did you mean "${suggestion}"?`
            : `Unknown task "${ref.name}" referenced from tasks.${ref.name}.results.${ref.resultName}.`,
          suggestion,
        };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export function computeDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  const config = vscode.workspace.getConfiguration("tektonAid");
  if (!config.get<boolean>("enableDiagnostics", true)) return [];

  const source = document.getText();
  const parsed = parseTektonDocument(source);
  if (!parsed) return [];

  const refs = findParamRefs(parsed.text);
  const diagnostics: vscode.Diagnostic[] = [];

  for (const ref of refs) {
    const problem = checkRef(ref, parsed.symbols);
    if (!problem) continue;

    const start =
      ref.nameStart !== undefined ? offsetToPosition(document, ref.nameStart) : offsetToPosition(document, ref.start);
    const end =
      ref.nameEnd !== undefined ? offsetToPosition(document, ref.nameEnd) : offsetToPosition(document, ref.end);

    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(start, end),
      problem.message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    if (problem.suggestion) {
      diagnostic.code = `suggest:${problem.suggestion}`;
    }
    diagnostics.push(diagnostic);
  }

  return diagnostics;
}
