import * as vscode from "vscode";
import { NamedSymbol, ParamSymbol, ParsedTektonDoc, parseTektonFile, RefName, TektonSymbols, findCelExpressions } from "./model";
import { paramRefsIn, ParamRef } from "./paramRefs";
import { closestMatch } from "./levenshtein";
import { findDuplicateGroups } from "./duplicates";
import { findMissingRunAfter } from "./runAfterCheck";
import { TektonWorkspaceIndex } from "./workspaceIndex";
import { validateAgainstSchema } from "./schemaValidation";
import { celIssuesInSource } from "./celExpr";

export const DIAGNOSTIC_SOURCE = "tekton-intellisense";

function offsetToPosition(doc: vscode.TextDocument, offset: number): vscode.Position {
  return doc.positionAt(offset);
}

/**
 * The "Unknown X. Did you mean Y? / Declared Xs: ..." message + Levenshtein
 * suggestion shared by every "this name doesn't match any declared one"
 * check below that draws its candidate list from the *current* document
 * (as opposed to `checkTriggerRefs`'s cross-file version, whose "declared
 * elsewhere" framing doesn't fit this same phrasing, or `checkTaskParamBindings`'s
 * "for taskRef X" variant, which needs an extra clause mid-sentence).
 * `label` is the singular noun used in "Unknown {label}"; `pluralLabel` the
 * one used in "Declared {pluralLabel}:" -- almost always `label + "s"`, but
 * kept as separate parameters since `$(tt.params.X)` says "Unknown param"
 * (not "parameter") while still listing "Declared params".
 */
function unknownNameProblem(label: string, pluralLabel: string, name: string, names: string[]): { message: string; suggestion?: string } {
  const suggestion = closestMatch(name, names);
  return {
    message: suggestion
      ? `Unknown ${label} "${name}". Did you mean "${suggestion}"?`
      : `Unknown ${label} "${name}". Declared ${pluralLabel}: ${names.join(", ") || "(none)"}.`,
    suggestion,
  };
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

      const { message, suggestion } = unknownNameProblem("workspace", "workspaces", binding.workspaceName, names);
      const range = new vscode.Range(
        offsetToPosition(document, binding.workspaceNameRange[0]),
        offsetToPosition(document, binding.workspaceNameRange[1])
      );
      const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
      diagnostic.source = DIAGNOSTIC_SOURCE;
      if (suggestion) diagnostic.code = `suggest:${suggestion}`;
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

/**
 * Flags a `params: [{name, value}]` binding — a Pipeline task entry's own
 * (scoped to that entry) or a TaskRun's own top-level one — whose `name`
 * doesn't match any param the referenced Task/ClusterTask actually
 * declares. Only checked once the taskRef itself resolves — an unresolved
 * taskRef isn't flagged by any check today, so guessing at its params here
 * too would just be noise on top of a problem this can't itself describe.
 */
function checkTaskParamBindings(document: vscode.TextDocument, symbols: TektonSymbols, workspaceIndex: TektonWorkspaceIndex): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  const flagUnknown = (paramName: string, range: [number, number] | undefined, taskRefName: string, declared: ParamSymbol[]) => {
    if (!range) return;
    const names = declared.map((p) => p.name);
    if (names.includes(paramName)) return;

    const suggestion = closestMatch(paramName, names);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(offsetToPosition(document, range[0]), offsetToPosition(document, range[1])),
      suggestion
        ? `Unknown parameter "${paramName}" for taskRef "${taskRefName}". Did you mean "${suggestion}"?`
        : `Unknown parameter "${paramName}" for taskRef "${taskRefName}". Declared params: ${names.join(", ") || "(none)"}.`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    if (suggestion) diagnostic.code = `suggest:${suggestion}`;
    diagnostics.push(diagnostic);
  };

  for (const task of symbols.tasks) {
    if (!task.taskRefName) continue;
    const resolved = workspaceIndex.lookupTask(task.taskRefName);
    if (!resolved) continue;
    for (const pb of task.paramBindings) flagUnknown(pb.name, pb.range, task.taskRefName, resolved.params);
  }

  if (symbols.kind === "TaskRun" && symbols.taskRefName) {
    const resolved = workspaceIndex.lookupTask(symbols.taskRefName);
    if (resolved) {
      for (const p of symbols.params) flagUnknown(p.name, p.range, symbols.taskRefName, resolved.params);
    }
  }

  return diagnostics;
}

/**
 * Flags a Pipeline task entry's (or TaskRun's own) `taskRef` when the
 * referenced Task/ClusterTask declares a required param (no `default`)
 * that this entry's `params:` binding doesn't provide by name. Unlike a
 * typo'd binding name ({@link checkTaskParamBindings}), Tekton doesn't
 * reject this until the PipelineRun/TaskRun actually runs, so it's easy to
 * only discover by watching one fail. Mirrors
 * {@link checkTriggerTemplateParamWiring}'s shape one level down.
 *
 * Skipped entirely (rather than guessed at) when the taskRef doesn't
 * resolve at all — no check today flags an unresolved taskRef, so
 * computing a "missing params" list against content we don't actually
 * have would just be noise on top of it. Also a no-op for a Pipeline task
 * entry using an inline `taskSpec` instead of `taskRef` — its params bind
 * to its own same-document declaration, a different case with its own
 * required/provided set that doesn't need cross-file resolution.
 *
 * One diagnostic per missing param, not one aggregating the whole list —
 * `diagnostic.code` carries a single `taskRefName`/`paramName` pair
 * (`add-task-param:<taskRefName>:<paramName>`) so `codeActions.ts` can
 * offer quick fixes (add the binding here, or add a default on the Task's
 * own declaration) for that one param specifically.
 */
function checkTaskParamWiring(document: vscode.TextDocument, symbols: TektonSymbols, workspaceIndex: TektonWorkspaceIndex): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  const checkWiring = (taskRefName: string, taskRefNameRange: [number, number] | undefined, providedNames: string[]) => {
    if (!taskRefNameRange) return;
    const resolved = workspaceIndex.lookupTask(taskRefName);
    if (!resolved) return;

    const provided = new Set(providedNames);
    const missing = resolved.params.filter((p) => p.default === undefined && !provided.has(p.name));

    for (const param of missing) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(offsetToPosition(document, taskRefNameRange[0]), offsetToPosition(document, taskRefNameRange[1])),
        `Task "${taskRefName}" requires param "${param.name}" with no default, but this taskRef doesn't provide it.`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = `add-task-param:${taskRefName}:${param.name}`;
      diagnostics.push(diagnostic);
    }
  };

  for (const task of symbols.tasks) {
    if (!task.taskRefName) continue;
    checkWiring(task.taskRefName, task.taskRefNameRange, task.paramBindings.map((pb) => pb.name));
  }

  if (symbols.kind === "TaskRun" && symbols.taskRefName) {
    checkWiring(symbols.taskRefName, symbols.taskRefNameRange, symbols.params.map((p) => p.name));
  }

  return diagnostics;
}

/**
 * Surfaces {@link findMissingRunAfter} as Information-severity diagnostics
 * — deliberately not Warning/Error, since Tekton executes these correctly
 * either way; this is a readability suggestion, not a defect. Carries a
 * quick fix (`codeActions.ts`) that adds the missing entry.
 */
function checkMissingRunAfter(document: vscode.TextDocument, parsed: ParsedTektonDoc): vscode.Diagnostic[] {
  return findMissingRunAfter(parsed).map(({ taskName, taskNameRange, missingTaskRef }) => {
    const range = new vscode.Range(
      offsetToPosition(document, taskNameRange[0]),
      offsetToPosition(document, taskNameRange[1])
    );
    const diagnostic = new vscode.Diagnostic(
      range,
      `Task "${taskName}" references $(tasks.${missingTaskRef}.results...) but doesn't list "${missingTaskRef}" in runAfter. Tekton infers the run order from that reference either way — adding it just makes the ordering explicit.`,
      vscode.DiagnosticSeverity.Information
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = `add-runafter:${missingTaskRef}`;
    return diagnostic;
  });
}

/**
 * Flags an EventListener trigger entry's (or standalone Trigger's own)
 * `bindings[].ref` / `template.ref` / `triggerRef` when the name doesn't
 * resolve to anything in the workspace index — same warning + "did you
 * mean" treatment as {@link checkTaskWorkspaceBindings}, just resolved
 * cross-file via the workspace index instead of this document's own
 * declarations.
 */
function checkTriggerRefs(document: vscode.TextDocument, symbols: TektonSymbols, workspaceIndex: TektonWorkspaceIndex): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  const flagUnknown = (
    range: [number, number] | undefined,
    name: string | undefined,
    label: string,
    lookupAll: (name: string) => unknown[],
    allNames: () => string[]
  ) => {
    if (!name || !range || lookupAll(name).length > 0) return;
    const suggestion = closestMatch(name, allNames());
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(offsetToPosition(document, range[0]), offsetToPosition(document, range[1])),
      suggestion
        ? `Unknown ${label} "${name}". Did you mean "${suggestion}"?`
        : `Unknown ${label} "${name}" — no such resource found in the workspace.`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    if (suggestion) diagnostic.code = `suggest:${suggestion}`;
    diagnostics.push(diagnostic);
  };

  const checkTriggerLike = (
    bindingRefs: RefName[],
    templateRefName?: string,
    templateRefNameRange?: [number, number],
    triggerRefName?: string,
    triggerRefNameRange?: [number, number]
  ) => {
    for (const ref of bindingRefs) {
      flagUnknown(
        ref.range,
        ref.name,
        "TriggerBinding",
        (n) => workspaceIndex.lookupAllTriggerBindingRecords(n),
        () => workspaceIndex.allTriggerBindingNames()
      );
    }
    flagUnknown(
      templateRefNameRange,
      templateRefName,
      "TriggerTemplate",
      (n) => workspaceIndex.lookupAllTriggerTemplateRecords(n),
      () => workspaceIndex.allTriggerTemplateNames()
    );
    flagUnknown(
      triggerRefNameRange,
      triggerRefName,
      "Trigger",
      (n) => workspaceIndex.lookupAllTriggerRecords(n),
      () => workspaceIndex.allTriggerNames()
    );
  };

  if (symbols.kind === "EventListener") {
    for (const trigger of symbols.triggers) {
      checkTriggerLike(
        trigger.bindingRefs,
        trigger.templateRefName,
        trigger.templateRefNameRange,
        trigger.triggerRefName,
        trigger.triggerRefNameRange
      );
    }
  } else if (symbols.kind === "Trigger") {
    checkTriggerLike(symbols.bindingRefs, symbols.templateRefName, symbols.templateRefNameRange);
  }

  return diagnostics;
}

/**
 * Flags an EventListener trigger entry's (or standalone Trigger's own)
 * bound TriggerTemplate when it declares a required param (no `default`)
 * that none of the entry's bound TriggerBindings — inline or `ref`-based —
 * actually provide by name. Unlike a typo'd reference, Tekton doesn't
 * reject this until the resourcetemplate is instantiated at runtime, so
 * it's easy to only discover by watching a TriggerRun fail.
 *
 * Skipped entirely (rather than guessed at) when the template or any bound
 * TriggerBinding doesn't resolve at all — {@link checkTriggerRefs} already
 * flags that separately, and computing a "missing params" list against
 * content we don't actually have would just be noise on top of it. Also a
 * no-op for an EventListener entry that delegates via `triggerRef` instead
 * of inline `bindings`/`template` — `bindingRefs`/`templateRefName` are
 * naturally empty in that shape, and the standalone Trigger it points at
 * gets this same check directly in its own document.
 */
function checkTriggerTemplateParamWiring(
  document: vscode.TextDocument,
  symbols: TektonSymbols,
  workspaceIndex: TektonWorkspaceIndex
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  const checkWiring = (
    bindingRefs: RefName[],
    inlineParamNames: string[],
    templateRefName: string | undefined,
    templateRefNameRange: [number, number] | undefined
  ) => {
    if (!templateRefName || !templateRefNameRange) return;
    const template = workspaceIndex.lookupTriggerTemplateRecord(templateRefName);
    if (!template) return;

    const provided = new Set(inlineParamNames);
    for (const ref of bindingRefs) {
      const binding = workspaceIndex.lookupTriggerBindingRecord(ref.name);
      if (!binding) return; // an unresolved binding ref means we can't know the true provided set
      for (const p of binding.parsed.symbols.bindingParams) provided.add(p.name);
    }

    const missing = template.parsed.symbols.params.filter((p) => p.default === undefined && !provided.has(p.name));
    if (missing.length === 0) return;

    const names = missing.map((p) => `"${p.name}"`).join(", ");
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(offsetToPosition(document, templateRefNameRange[0]), offsetToPosition(document, templateRefNameRange[1])),
      `TriggerTemplate "${templateRefName}" requires param${missing.length > 1 ? "s" : ""} ${names} with no default, but the bound TriggerBinding(s) don't provide ${missing.length > 1 ? "them" : "it"}.`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostics.push(diagnostic);
  };

  if (symbols.kind === "EventListener") {
    for (const trigger of symbols.triggers) {
      checkWiring(trigger.bindingRefs, trigger.inlineParamNames, trigger.templateRefName, trigger.templateRefNameRange);
    }
  } else if (symbols.kind === "Trigger") {
    checkWiring(symbols.bindingRefs, symbols.inlineParamNames, symbols.templateRefName, symbols.templateRefNameRange);
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
      return ref.name && !names.includes(ref.name) ? unknownNameProblem("parameter", "params", ref.name, names) : undefined;
    }
    case "workspace": {
      const names = symbols.workspaces.map((w) => w.name);
      return ref.name && !names.includes(ref.name) ? unknownNameProblem("workspace", "workspaces", ref.name, names) : undefined;
    }
    case "result": {
      // Only meaningful within Task-like docs that declare their own results.
      if (symbols.kind !== "Task" && symbols.kind !== "ClusterTask" && symbols.kind !== "StepAction") {
        return undefined;
      }
      const names = symbols.results.map((r) => r.name);
      return ref.name && !names.includes(ref.name) ? unknownNameProblem("result", "results", ref.name, names) : undefined;
    }
    case "tt-param": {
      // Only meaningful within a TriggerTemplate, validating $(tt.params.NAME) against its own spec.params.
      if (symbols.kind !== "TriggerTemplate") return undefined;
      const names = symbols.params.map((p) => p.name);
      return ref.name && !names.includes(ref.name) ? unknownNameProblem("param", "params", ref.name, names) : undefined;
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

/**
 * Structural validation against the matching schema in `schemas/` (see
 * `schemaValidation.ts`) -- unknown/missing keys, wrong types and enums.
 * Complementary to every other check in this file, which all validate
 * cross-*reference* correctness (does this name resolve to something) that
 * a static schema can't express at all; this is the other half, catching
 * a mistake as simple as `scirpt:` that every other check would happily
 * ignore since it's a syntactically fine, just-unrecognized YAML key.
 */
function checkSchema(document: vscode.TextDocument, parsed: ParsedTektonDoc, schemasDir: string): vscode.Diagnostic[] {
  return validateAgainstSchema(schemasDir, parsed).map(({ range, message }) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(offsetToPosition(document, range[0]), offsetToPosition(document, range[1])),
      message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    return diagnostic;
  });
}

/**
 * Rudimentary structural checks on `cel` interceptor `filter`/`overlays[].expression`
 * strings — see `celExpr.ts` for why this is a tokenizer-level check rather
 * than a real CEL parser.
 */
function checkCelExpressions(document: vscode.TextDocument, parsed: ParsedTektonDoc): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  for (const loc of findCelExpressions(parsed)) {
    for (const { range, message } of celIssuesInSource(parsed.text, loc.range, loc.value)) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(offsetToPosition(document, range[0]), offsetToPosition(document, range[1])),
        `CEL expression: ${message}`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

/** Every diagnostic for one resource within a (possibly multi-document) file. */
function computeResourceDiagnostics(
  document: vscode.TextDocument,
  parsed: ParsedTektonDoc,
  workspaceIndex: TektonWorkspaceIndex,
  schemasDir: string
): vscode.Diagnostic[] {
  const config = vscode.workspace.getConfiguration("tektonIntellisense");
  const diagnostics: vscode.Diagnostic[] = [
    ...checkDuplicateNames(document, parsed.symbols.params, "parameter"),
    ...checkDuplicateNames(document, parsed.symbols.workspaces, "workspace"),
    ...checkDuplicateNames(document, parsed.symbols.results, "result"),
    ...checkDuplicateNames(document, parsed.symbols.tasks, "task"),
    ...checkDuplicateNames(document, parsed.symbols.bindingParams, "binding parameter"),
    ...checkTaskWorkspaceBindings(document, parsed.symbols),
    ...checkTaskParamBindings(document, parsed.symbols, workspaceIndex),
    ...checkTaskParamWiring(document, parsed.symbols, workspaceIndex),
    ...checkMissingRunAfter(document, parsed),
    ...checkTriggerRefs(document, parsed.symbols, workspaceIndex),
    ...checkTriggerTemplateParamWiring(document, parsed.symbols, workspaceIndex),
    ...checkCelExpressions(document, parsed),
    ...(config.get<boolean>("enableSchemaValidation", true) ? checkSchema(document, parsed, schemasDir) : []),
  ];

  for (const ref of paramRefsIn(parsed)) {
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

/** Computes diagnostics across every `---`-separated resource in the file, concatenated — a multi-document file gets each of its resources checked independently, on its own symbol table. */
export function computeDiagnostics(document: vscode.TextDocument, workspaceIndex: TektonWorkspaceIndex, schemasDir: string): vscode.Diagnostic[] {
  const config = vscode.workspace.getConfiguration("tektonIntellisense");
  if (!config.get<boolean>("enableDiagnostics", true)) return [];

  const docs = parseTektonFile(document.getText());
  return docs.flatMap((parsed) => computeResourceDiagnostics(document, parsed, workspaceIndex, schemasDir));
}
