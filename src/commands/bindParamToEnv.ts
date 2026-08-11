import * as vscode from "vscode";
import { findEnclosingMap, parseTektonDocument } from "../tekton/model";
import { indentAt, insertIndentedSnippet, toEnvVarName } from "./editUtils";
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
      const anchorOffset = lastItem?.range ? lastItem.range[1] : existingEnv.range?.[1];
      if (anchorOffset !== undefined) {
        const pos = document.positionAt(anchorOffset);
        const indent = indentAt(document, document.positionAt(existingEnv.range![0]));
        await insertIndentedSnippet(
          editor,
          pos,
          `\n${indent}- name: ${envName}\n${indent}  value: $(params.${picked})`,
          ""
        );
        return;
      }
    }
  }

  // No existing env: list found in the enclosing container — insert a fresh one at cursor.
  const indent = indentAt(document, editor.selection.active);
  await insertIndentedSnippet(
    editor,
    editor.selection.active,
    `env:\n  - name: ${envName}\n    value: $(params.${picked})\n`,
    indent
  );
}
