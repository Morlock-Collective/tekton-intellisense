import * as vscode from "vscode";
import { findEnclosingTaskEntry, parseTektonDocument, pipelineTaskEntryMaps, trimTrailingNewline } from "../tekton/model";
import { indentAt, insertBlockAfter } from "./editUtils";
import { quoteYamlString } from "./snippetText";
import { isScalar, isSeq, YAMLMap } from "yaml";

const OPERATORS = ["in", "notin"];

function taskEntryLabel(entry: YAMLMap, index: number): string {
  const nameNode = entry.get("name", true);
  return isScalar(nameNode) && typeof nameNode.value === "string" ? nameNode.value : `(task ${index + 1})`;
}

/**
 * Adds a `when:` expression to a pipeline task entry. If the cursor is
 * inside one, that's the target; otherwise (or if it's ambiguous which
 * task-list entry the cursor is actually in) a picker resolves it directly
 * against the document's task entries rather than guessing from position.
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
  let taskEntry = findEnclosingTaskEntry(parsed, offset);

  if (!taskEntry) {
    const entries = pipelineTaskEntryMaps(parsed);
    if (entries.length === 0) {
      vscode.window.showWarningMessage("Tekton Aid: this Pipeline has no tasks to add a when expression to.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((entry, i) => ({ label: taskEntryLabel(entry, i), entry })),
      { placeHolder: "Which task should get the when expression?" }
    );
    if (!picked) return;
    taskEntry = picked.entry;
  }

  if (!taskEntry.range) return;

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

  if (isSeq(existingWhen) && existingWhen.range) {
    // Match the existing list's own indentation rather than computing one by
    // formula — the file's actual indentation convention is the only thing
    // guaranteed to line up with items already there.
    const lastItem = existingWhen.items[existingWhen.items.length - 1] as
      | { range?: [number, number, number] }
      | undefined;
    const anchorOffset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : existingWhen.range[1]);
    const pos = document.positionAt(anchorOffset);
    const itemIndent = indentAt(document, document.positionAt(existingWhen.range[0]));
    await insertBlockAfter(editor, pos, itemLines, itemIndent);
    return;
  }

  // No existing when: — insert a new `when:` key after the task entry's
  // `name:` line, indented to match the task's *other* keys (taskRef,
  // runAfter, ...), one level deeper than the task's own `- ` marker.
  const nameNode = taskEntry.get("name", true) as { range?: [number, number, number] } | undefined;
  const anchorOffset = trimTrailingNewline(parsed.text, nameNode?.range ? nameNode.range[1] : taskEntry.range[0]);
  const pos = document.positionAt(anchorOffset);
  const taskIndent = indentAt(document, document.positionAt(taskEntry.range[0]));
  await insertBlockAfter(editor, pos, ["when:", ...itemLines.map((l) => "  " + l)], taskIndent + "  ");
}
