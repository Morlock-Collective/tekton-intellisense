import * as vscode from "vscode";
import { findEnclosingMap, parseTektonDocument, trimTrailingNewline } from "../tekton/model";
import { indentAt, insertAtCursor, insertBlockAfter, toEnvVarName } from "./editUtils";
import { isSeq } from "yaml";

/**
 * Binds a declared pipeline/task parameter to a container `env:` entry at
 * the cursor. If the cursor is inside a step/sidecar that already has an
 * `env:` list, the entry is appended there; otherwise an `env:` list is
 * created at the same indentation as the container's other keys.
 */
export async function bindParamToEnvCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = parseTektonDocument(document.getText());
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Aid: this doesn't look like a Tekton resource.");
    return;
  }
  if (parsed.symbols.params.length === 0) {
    vscode.window.showWarningMessage("Tekton Aid: no params declared in this document's spec.params.");
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

  const offset = document.offsetAt(editor.selection.active);
  const container = findEnclosingMap(parsed.doc, offset);

  if (container) {
    const existingEnv = container.get("env", true);
    if (isSeq(existingEnv)) {
      // Append a new entry to the existing env sequence.
      const lastItem = existingEnv.items[existingEnv.items.length - 1] as
        | { range?: [number, number, number] }
        | undefined;
      const rawAnchor = lastItem?.range ? lastItem.range[1] : existingEnv.range?.[1];
      if (rawAnchor !== undefined) {
        const anchorOffset = trimTrailingNewline(parsed.text, rawAnchor);
        const pos = document.positionAt(anchorOffset);
        const indent = indentAt(document, document.positionAt(existingEnv.range![0]));
        await insertBlockAfter(editor, pos, [`- name: ${envName}`, `  value: $(params.${picked})`], indent);
        return;
      }
    }
  }

  // No existing env: list found in the enclosing container — insert a fresh one at cursor.
  const indent = indentAt(document, editor.selection.active);
  await insertAtCursor(
    editor,
    editor.selection.active,
    ["env:", `  - name: ${envName}`, `    value: $(params.${picked})`],
    indent
  );
}
