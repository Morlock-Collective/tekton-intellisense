import * as vscode from "vscode";
import { findEnclosingMap, parseTektonDocument, trimTrailingNewline } from "../tekton/model";
import { indentAt, insertBlockAfter } from "./editUtils";
import { quoteYamlString } from "./snippetText";
import { isSeq } from "yaml";

const OPERATORS = ["in", "notin"];

/**
 * Adds a `when:` expression to the pipeline task entry enclosing the
 * cursor. Requires the cursor to be positioned inside a spec.tasks[] (or
 * spec.finally[]) entry.
 */
export async function addConditionalCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = parseTektonDocument(document.getText());
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Aid: this doesn't look like a Tekton resource.");
    return;
  }

  const offset = document.offsetAt(editor.selection.active);
  const taskEntry = findEnclosingMap(parsed.doc, offset);
  if (!taskEntry || !taskEntry.get("name", true)) {
    vscode.window.showWarningMessage(
      "Tekton Aid: place the cursor inside a spec.tasks[] entry (one with a `name:` key) to add a when expression."
    );
    return;
  }

  const inputExpr = await vscode.window.showInputBox({
    prompt: "Input to evaluate, e.g. $(params.deploy-env)",
    value: "$(params.",
  });
  if (!inputExpr) return;

  const operator = (await vscode.window.showQuickPick(OPERATORS, { placeHolder: "Operator" })) ?? "in";

  const valuesInput = await vscode.window.showInputBox({
    prompt: "Comma-separated values to compare against",
    placeHolder: "production, staging",
  });
  if (!valuesInput) return;

  const values = valuesInput
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const quotedValues = values.map((v) => quoteYamlString(v));
  const itemLines = [
    `- input: ${quoteYamlString(inputExpr)}`,
    `  operator: ${operator}`,
    `  values: [${quotedValues.join(", ")}]`,
  ];

  const existingWhen = taskEntry.get("when", true);
  const taskIndent = taskEntry.range
    ? indentAt(document, document.positionAt(taskEntry.range[0]))
    : indentAt(document, editor.selection.active);

  if (isSeq(existingWhen) && existingWhen.range) {
    const lastItem = existingWhen.items[existingWhen.items.length - 1] as
      | { range?: [number, number, number] }
      | undefined;
    const anchorOffset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : existingWhen.range[1]);
    const pos = document.positionAt(anchorOffset);
    await insertBlockAfter(editor, pos, itemLines, taskIndent + "  ");
    return;
  }

  // No existing when: — insert after the task entry's `name:` line, at the task's indentation.
  const nameNode = taskEntry.get("name", true) as { range?: [number, number, number] } | undefined;
  const anchorOffset = trimTrailingNewline(parsed.text, nameNode?.range ? nameNode.range[1] : taskEntry.range?.[0] ?? offset);
  const pos = document.positionAt(anchorOffset);
  await insertBlockAfter(editor, pos, ["when:", ...itemLines.map((l) => "  " + l)], taskIndent);
}
