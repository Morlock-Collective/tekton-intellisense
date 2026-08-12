import * as vscode from "vscode";
import { findEnclosingStepEntry, parseTektonDocument, stepAndSidecarEntryMaps, trimTrailingNewline } from "../tekton/model";
import { indentAt, insertBlockAfter, toEnvVarName } from "./editUtils";
import { isScalar, isSeq, YAMLMap } from "yaml";

function stepEntryLabel(entry: YAMLMap, index: number): string {
  const nameNode = entry.get("name", true);
  return isScalar(nameNode) && typeof nameNode.value === "string" ? nameNode.value : `(step ${index + 1})`;
}

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
  const parsed = parseTektonDocument(document.getText());
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

  const offset = document.offsetAt(editor.selection.active);
  let container = findEnclosingStepEntry(parsed, offset);

  if (!container) {
    const entries = stepAndSidecarEntryMaps(parsed);
    if (entries.length === 0) {
      vscode.window.showWarningMessage("Tekton Intellisense: this document has no steps or sidecars to bind an env var into.");
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      entries.map((entry, i) => ({ label: stepEntryLabel(entry, i), entry })),
      { placeHolder: "Which step/sidecar should get the environment variable?" }
    );
    if (!chosen) return;
    container = chosen.entry;
  }

  if (!container.range) return;

  const existingEnv = container.get("env", true);
  if (isSeq(existingEnv) && existingEnv.range) {
    const lastItem = existingEnv.items[existingEnv.items.length - 1] as
      | { range?: [number, number, number] }
      | undefined;
    const rawAnchor = lastItem?.range ? lastItem.range[1] : existingEnv.range[1];
    const anchorOffset = trimTrailingNewline(parsed.text, rawAnchor);
    const indent = indentAt(document, document.positionAt(existingEnv.range[0]));
    await insertBlockAfter(editor, document.positionAt(anchorOffset), [`- name: ${envName}`, `  value: $(params.${picked})`], indent);
    return;
  }

  // No existing env: list in this step/sidecar — create it, appended after the entry's last existing key.
  const indent = indentAt(document, document.positionAt(container.range[0]));
  const anchorOffset = trimTrailingNewline(parsed.text, container.range[1]);
  await insertBlockAfter(
    editor,
    document.positionAt(anchorOffset),
    ["env:", "  - name: " + envName, "    value: $(params." + picked + ")"],
    indent + "  "
  );
}
