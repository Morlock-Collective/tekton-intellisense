import * as vscode from "vscode";
import { findSpecSeq, parseTektonDocument } from "../tekton/model";
import { indentAt, insertIndentedSnippet } from "./editUtils";
import { isSeq } from "yaml";

const PARAM_TYPES = ["string", "array", "object"];

/** Adds a new entry to spec.params, appending after the last existing param when present. */
export async function addParameterCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = parseTektonDocument(document.getText());
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Aid: this doesn't look like a Tekton resource.");
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: "New parameter name",
    validateInput: (v) => (/^[a-zA-Z0-9_-]+$/.test(v) ? undefined : "invalid parameter name"),
  });
  if (!name) return;

  const type = (await vscode.window.showQuickPick(PARAM_TYPES, { placeHolder: "Parameter type" })) ?? "string";

  const defaultValue = await vscode.window.showInputBox({
    prompt: "Default value (leave blank for none)",
  });

  const lines = [`- name: ${name}`, `  type: ${type}`, `  description: ""`];
  if (defaultValue) {
    if (type === "string") {
      lines.push(`  default: "${defaultValue}"`);
    } else if (type === "array") {
      const items = defaultValue.split(",").map((v) => v.trim());
      lines.push(`  default: [${items.join(", ")}]`);
    } else {
      lines.push(`  default: {}`);
    }
  }
  const template = lines.join("\n");

  const seq = findSpecSeq(parsed.doc, "params");

  if (seq && isSeq(seq) && seq.range) {
    const lastItem = seq.items[seq.items.length - 1] as { range?: [number, number, number] } | undefined;
    const anchorOffset = lastItem?.range ? lastItem.range[1] : seq.range[1];
    const pos = document.positionAt(anchorOffset);
    const seqIndent = indentAt(document, document.positionAt(seq.range[0]));
    await insertIndentedSnippet(editor, pos, "\n" + seqIndent + template, "");
    return;
  }

  const indent = indentAt(document, editor.selection.active);
  await insertIndentedSnippet(editor, editor.selection.active, `params:\n  ${template}\n`, indent);
}
