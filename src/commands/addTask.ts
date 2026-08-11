import * as vscode from "vscode";
import { findSpecSeq, parseTektonDocument } from "../tekton/model";
import { indentAt, insertIndentedSnippet } from "./editUtils";
import { isSeq } from "yaml";

/**
 * Adds a new task entry to spec.tasks (or spec.finally), appending after the
 * last existing entry when the list exists, or creating the list under spec
 * when it doesn't.
 */
export async function addTaskCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = parseTektonDocument(document.getText());
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Aid: this doesn't look like a Tekton resource.");
    return;
  }
  if (parsed.symbols.kind !== "Pipeline") {
    vscode.window.showWarningMessage("Tekton Aid: Add Task only applies to Pipeline resources.");
    return;
  }

  const taskName = await vscode.window.showInputBox({
    prompt: "New task name",
    validateInput: (v) => (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) ? undefined : "must be a valid Kubernetes name"),
  });
  if (!taskName) return;

  const taskRef = await vscode.window.showInputBox({
    prompt: "taskRef name (Task this step runs)",
    value: taskName,
  });
  if (!taskRef) return;

  const listKey = (await vscode.window.showQuickPick(["tasks", "finally"], {
    placeHolder: "Add to spec.tasks or spec.finally?",
  })) ?? "tasks";

  const template = [
    `- name: ${taskName}`,
    `  taskRef:`,
    `    name: ${taskRef}`,
    `  runAfter: []`,
    `  params: []`,
    ``,
  ].join("\n");

  const seq = findSpecSeq(parsed.doc, listKey);

  if (seq && isSeq(seq) && seq.range) {
    const lastItem = seq.items[seq.items.length - 1] as { range?: [number, number, number] } | undefined;
    const anchorOffset = lastItem?.range ? lastItem.range[1] : seq.range[1];
    const pos = document.positionAt(anchorOffset);
    const seqIndent = indentAt(document, document.positionAt(seq.range[0]));
    await insertIndentedSnippet(editor, pos, "\n" + seqIndent + template.trimEnd(), "");
    return;
  }

  // No spec.tasks/finally list yet — create one at the cursor's indentation.
  const indent = indentAt(document, editor.selection.active);
  await insertIndentedSnippet(editor, editor.selection.active, `${listKey}:\n  ${template.trimEnd()}\n`, indent);
}
