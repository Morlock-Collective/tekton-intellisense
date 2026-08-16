import * as vscode from "vscode";
import { parseTektonFile, findResourceAt } from "../tekton/model";
import { alreadyBoundParamNames, existingEnvNames, insertEnvBindings, pickStepOrSidecarEntry, toEnvVarName, uniqueEnvName } from "./editUtils";

/**
 * Binds every declared parameter not already bound to a container `env:`
 * entry in one pass, instead of one `bindParamToEnv` invocation per
 * parameter. Env var names are auto-derived (`toEnvVarName`, deduped
 * against collisions); a multi-select picker lets the user drop the ones
 * they don't want before inserting rather than typing each one out —
 * everything pre-checked, so accepting all of them is a single Enter and
 * dropping a few is a handful of clicks, both faster than adding them
 * individually.
 */
export async function bindAllParamsToEnvCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = findResourceAt(parseTektonFile(document.getText()), document.offsetAt(editor.selection.active));
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Intellisense: this doesn't look like a Tekton resource.");
    return;
  }
  if (parsed.symbols.params.length === 0) {
    vscode.window.showWarningMessage("Tekton Intellisense: no params declared in this document's spec.params.");
    return;
  }

  const container = await pickStepOrSidecarEntry(
    editor,
    parsed,
    "Which step/sidecar should get the environment variables?",
    "Tekton Intellisense: this document has no steps or sidecars to bind env vars into."
  );
  if (!container) return;

  const alreadyBound = alreadyBoundParamNames(container);
  const candidates = parsed.symbols.params.filter((p) => !alreadyBound.has(p.name));
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      "Tekton Intellisense: every declared param is already bound to an environment variable in this step/sidecar."
    );
    return;
  }

  const picks = await vscode.window.showQuickPick(
    candidates.map((p) => ({ label: p.name, description: toEnvVarName(p.name), picked: true })),
    { canPickMany: true, placeHolder: "Which parameters should be bound to environment variables?" }
  );
  if (!picks || picks.length === 0) return;

  const usedNames = existingEnvNames(container);
  const bindings = picks.map((p) => ({ envName: uniqueEnvName(toEnvVarName(p.label), usedNames), paramName: p.label }));

  await insertEnvBindings(editor, parsed, container, bindings);
}
