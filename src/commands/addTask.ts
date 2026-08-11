import * as vscode from "vscode";
import { findSeqIn, parseTektonDocument, resolvePipelineSpecOwner, trimTrailingNewline } from "../tekton/model";
import { indentAt, insertBlockAfter } from "./editUtils";

/**
 * Adds a new task entry to spec.tasks (or spec.finally) — appended after
 * the last existing entry when the list exists, or the list created fresh
 * otherwise. Cursor position is never consulted: the owning Pipeline
 * (either a Pipeline document itself, or a PipelineRun's inline
 * pipelineSpec) is resolved purely from the document's structure, the same
 * way addParameter resolves where a parameter belongs.
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

  const owner = resolvePipelineSpecOwner(parsed);
  if (!owner) {
    vscode.window.showWarningMessage(
      `Tekton Aid: don't know where to add a task for a ${parsed.symbols.kind} resource.`
    );
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
    validateInput: (v) => (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) ? undefined : "must be a valid Kubernetes name"),
  });
  if (!taskRef) return;

  const listKey = (await vscode.window.showQuickPick(["tasks", "finally"], {
    placeHolder: "Add to spec.tasks or spec.finally?",
  })) ?? "tasks";

  const itemLines = [`- name: ${taskName}`, `  taskRef:`, `    name: ${taskRef}`, `  runAfter: []`, `  params: []`];

  const seq = findSeqIn(owner.ownerMap, listKey);

  if (seq?.range) {
    const lastItem = seq.items[seq.items.length - 1] as { range?: [number, number, number] } | undefined;
    const anchorOffset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : seq.range[1]);
    const itemIndent = lastItem ? indentAt(document, document.positionAt(seq.range[0])) : owner.keyIndent + "  ";
    await insertBlockAfter(editor, document.positionAt(anchorOffset), itemLines, itemIndent);
    return;
  }

  // No spec.tasks/finally list yet — create it, appended after the owning map's last existing key.
  const lines = [`${listKey}:`, ...itemLines.map((l) => "  " + l)];
  const anchorOffset = trimTrailingNewline(parsed.text, owner.ownerMapEnd);
  await insertBlockAfter(editor, document.positionAt(anchorOffset), lines, owner.keyIndent);
}
