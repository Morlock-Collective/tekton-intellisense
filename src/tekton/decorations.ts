import * as vscode from "vscode";
import { ParsedTektonDoc, resolveParamsTarget, stepActionRefs, TASK_LIKE_KINDS, TektonKind, TRIGGER_BINDING_LIKE_KINDS } from "./model";
import { findParamRefs } from "./paramRefs";

/**
 * Colors are chosen from the workbench color registry (not language-grammar
 * scopes) so they render consistently regardless of which color theme is
 * active — every theme resolves these to a sensible value, whereas TextMate
 * scopes like `variable.parameter` are only as visible as a given theme
 * bothers to make them (often nearly invisible).
 */
const declarationDecoration = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("symbolIcon.variableForeground"),
  fontWeight: "bold",
  textDecoration: "underline solid 1px",
});

const referenceDecoration = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("textLink.foreground"),
  fontWeight: "bold",
});

function rangeFor(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

/** Whether `kind`'s own `metadata.name` is referenceable by name from elsewhere (taskRef/pipelineRef/template.ref/bindings[].ref/triggerRef) — see `resolveRenameTarget`'s `*-identity` cases, which this mirrors. */
function hasReferenceableIdentity(kind: TektonKind): boolean {
  return (
    TASK_LIKE_KINDS.has(kind) ||
    kind === "Pipeline" ||
    kind === "TriggerTemplate" ||
    TRIGGER_BINDING_LIKE_KINDS.has(kind) ||
    kind === "Trigger"
  );
}

/**
 * Highlights every renameable/referenceable name in the document: the
 * `name:` value at every declaration site (params/workspaces/results/task
 * aliases/a resource's own identity), and every place something points at
 * one by name — both `$(...)` syntax (`findParamRefs`) and the plain
 * YAML-field identity system (`taskRef`/`pipelineRef`/`template.ref`/
 * `bindings[].ref`/`triggerRef`/a step's own `ref`, plus a task entry's
 * `workspace:`/`runAfter:`/`params:` bindings) — using matching-but-distinct
 * styles so a declaration ("this is defined here") reads differently from
 * a use ("this points at a declaration"). Mirrors exactly what
 * `resolveRenameTarget` recognizes, so "is this renameable" and "is this
 * highlighted" never drift apart.
 */
export function updateDecorations(editor: vscode.TextEditor, parsed: ParsedTektonDoc | undefined): void {
  if (!parsed) {
    editor.setDecorations(declarationDecoration, []);
    editor.setDecorations(referenceDecoration, []);
    return;
  }

  const document = editor.document;
  const { symbols } = parsed;

  const declRanges: vscode.Range[] = [];
  const refRanges: vscode.Range[] = [];
  const addDecl = (range: [number, number] | undefined) => {
    if (range) declRanges.push(rangeFor(document, range[0], range[1]));
  };
  const addRef = (range: [number, number] | undefined) => {
    if (range) refRanges.push(rangeFor(document, range[0], range[1]));
  };

  // A TaskRun/PipelineRun using ..Ref provides param *values* (a reference to the referenced
  // resource's declared params), not a declaration of its own -- same distinction addParameter
  // and rename already make.
  const paramsAreBindings = resolveParamsTarget(parsed)?.shape === "binding";
  for (const p of symbols.params) (paramsAreBindings ? addRef : addDecl)(p.range);

  for (const w of symbols.workspaces) addDecl(w.range);
  for (const r of symbols.results) addDecl(r.range);
  for (const bp of symbols.bindingParams) addDecl(bp.range);

  for (const t of symbols.tasks) {
    addDecl(t.range);
    addRef(t.taskRefNameRange);
    for (const wb of t.workspaceBindings) addRef(wb.workspaceNameRange);
    for (const ra of t.runAfter) addRef(ra.range);
    for (const pb of t.paramBindings) addRef(pb.range);
  }

  for (const trigger of symbols.triggers) {
    addDecl(trigger.range);
    for (const ref of trigger.bindingRefs) addRef(ref.range);
    addRef(trigger.templateRefNameRange);
    addRef(trigger.triggerRefNameRange);
  }

  addRef(symbols.pipelineRefNameRange);
  addRef(symbols.taskRefNameRange);
  addRef(symbols.templateRefNameRange);
  for (const ref of symbols.bindingRefs) addRef(ref.range);
  for (const ref of stepActionRefs(parsed)) addRef(ref.range);

  if (symbols.metadataName && hasReferenceableIdentity(symbols.kind)) {
    addDecl(symbols.metadataNameRange);
  }

  for (const ref of findParamRefs(parsed.text)) {
    if (ref.nameStart !== undefined && ref.nameEnd !== undefined) {
      refRanges.push(rangeFor(document, ref.nameStart, ref.nameEnd));
    }
    if (ref.resultNameStart !== undefined && ref.resultNameEnd !== undefined) {
      refRanges.push(rangeFor(document, ref.resultNameStart, ref.resultNameEnd));
    }
  }

  editor.setDecorations(declarationDecoration, declRanges);
  editor.setDecorations(referenceDecoration, refRanges);
}

export function clearDecorations(editor: vscode.TextEditor): void {
  editor.setDecorations(declarationDecoration, []);
  editor.setDecorations(referenceDecoration, []);
}

export function disposeDecorations(): void {
  declarationDecoration.dispose();
  referenceDecoration.dispose();
}
