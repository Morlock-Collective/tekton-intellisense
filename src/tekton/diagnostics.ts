import * as vscode from "vscode";
import { NamedSymbol, parseTektonDocument, TektonSymbols } from "./model";
import { findParamRefs, ParamRef } from "./paramRefs";
import { closestMatch } from "./levenshtein";
import { findDuplicateGroups } from "./duplicates";

export const DIAGNOSTIC_SOURCE = "tekton-aid";

function offsetToPosition(doc: vscode.TextDocument, offset: number): vscode.Position {
  return doc.positionAt(offset);
}

/**
 * Flags repeated names within a single declaration list (spec.params,
 * spec.workspaces, spec.results, spec.tasks+finally). Tekton/Kubernetes
 * schema validation rejects these outright at apply time, so this is a real
 * error, not a style nit — every occurrence past the first is flagged.
 */
function checkDuplicateNames(
  document: vscode.TextDocument,
  symbols: NamedSymbol[],
  label: string
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  for (const [name, occurrences] of findDuplicateGroups(symbols)) {
    for (const occurrence of occurrences) {
      if (!occurrence.range) continue;
      const range = new vscode.Range(
        offsetToPosition(document, occurrence.range[0]),
        offsetToPosition(document, occurrence.range[1])
      );
      const diagnostic = new vscode.Diagnostic(
        range,
        `Duplicate ${label} name "${name}" — declared ${occurrences.length} times.`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

/**
 * Flags a pipeline task's `workspaces: [{name, workspace}]` bindings whose
 * `workspace:` value doesn't match any of the Pipeline's own declared
 * `spec.workspaces[].name` entries. Distinct from the `$(...)` reference
 * checks below — this is a plain field value, not template syntax, but the
 * failure mode (a typo the schema won't catch until `PipelineRun` time) is
 * the same, so it gets the same warning + suggestion treatment.
 */
function checkTaskWorkspaceBindings(document: vscode.TextDocument, symbols: TektonSymbols): vscode.Diagnostic[] {
  if (symbols.kind !== "Pipeline") return [];

  const names = symbols.workspaces.map((w) => w.name);
  const diagnostics: vscode.Diagnostic[] = [];

  for (const task of symbols.tasks) {
    for (const binding of task.workspaceBindings) {
      if (!binding.workspaceName || !binding.workspaceNameRange) continue;
      if (names.includes(binding.workspaceName)) continue;

      const suggestion = closestMatch(binding.workspaceName, names);
      const range = new vscode.Range(
        offsetToPosition(document, binding.workspaceNameRange[0]),
        offsetToPosition(document, binding.workspaceNameRange[1])
      );
      const diagnostic = new vscode.Diagnostic(
        range,
        suggestion
          ? `Unknown workspace "${binding.workspaceName}". Did you mean "${suggestion}"?`
          : `Unknown workspace "${binding.workspaceName}". Declared workspaces: ${names.join(", ") || "(none)"}.`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      if (suggestion) diagnostic.code = `suggest:${suggestion}`;
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
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

  const diagnostics: vscode.Diagnostic[] = [
    ...checkDuplicateNames(document, parsed.symbols.params, "parameter"),
    ...checkDuplicateNames(document, parsed.symbols.workspaces, "workspace"),
    ...checkDuplicateNames(document, parsed.symbols.results, "result"),
    ...checkDuplicateNames(document, parsed.symbols.tasks, "task"),
    ...checkTaskWorkspaceBindings(document, parsed.symbols),
  ];

  const refs = findParamRefs(parsed.text);
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
