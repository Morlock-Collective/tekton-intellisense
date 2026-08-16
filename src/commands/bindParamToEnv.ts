import * as vscode from "vscode";
import { parseTektonFile, findResourceAt } from "../tekton/model";
import { insertEnvBindings, pickStepOrSidecarEntry, toEnvVarName } from "./editUtils";

/**
 * Binds a declared parameter to a container `env:` entry. If the cursor is
 * inside a step/sidecar, that's the target; otherwise (or if it's
 * ambiguous which step the cursor is actually in) a picker resolves it
 * directly against the document's step/sidecar entries rather than
 * guessing from position.
 */
export async function bindParamToEnvCommand(): Promise<void> {
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

  const picked = await vscode.window.showQuickPick(
    parsed.symbols.params.map((p) => p.name),
    { placeHolder: "Which parameter should be bound to an environment variable?" }
  );
  if (!picked) return;

  const defaultEnvName = toEnvVarName(picked);
  const envName = await vscode.window.showInputBox({
    prompt: "Environment variable name",
    value: defaultEnvName,
    validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? undefined : "must be a valid environment variable name"),
  });
  if (!envName) return;

  const container = await pickStepOrSidecarEntry(
    editor,
    parsed,
    "Which step/sidecar should get the environment variable?",
    "Tekton Intellisense: this document has no steps or sidecars to bind an env var into."
  );
  if (!container) return;

  await insertEnvBindings(editor, parsed, container, [{ envName, paramName: picked }]);
}
