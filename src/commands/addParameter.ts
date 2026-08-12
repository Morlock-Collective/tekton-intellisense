import * as vscode from "vscode";
import { findSeqIn, parseTektonDocument, resolveParamsTarget, trimTrailingNewline } from "../tekton/model";
import { insertBlockAfter, indentAt } from "./editUtils";
import { quoteYamlString } from "./snippetText";

const PARAM_TYPES = ["string", "array", "object"];

/**
 * Adds a new parameter, appended last in the correct list — cursor position
 * is never consulted. Where that list lives, and what shape an entry takes,
 * depends on the resource: Pipelines/Tasks/ClusterTasks/StepActions declare
 * params (name/type/description/default) directly under spec; a
 * PipelineRun/TaskRun either *provides* param values (name/value) when
 * using a `..Ref`, or declares params like a Pipeline/Task when it embeds
 * one inline via `pipelineSpec`/`taskSpec`.
 */
export async function addParameterCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = parseTektonDocument(document.getText());
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Intellisense: this doesn't look like a Tekton resource.");
    return;
  }

  const target = resolveParamsTarget(parsed);
  if (!target) {
    vscode.window.showWarningMessage(
      `Tekton Intellisense: don't know where to add a parameter for a ${parsed.symbols.kind} resource.`
    );
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: "New parameter name",
    validateInput: (v) => (/^[a-zA-Z0-9_-]+$/.test(v) ? undefined : "invalid parameter name"),
  });
  if (!name) return;

  let itemLines: string[];

  if (target.shape === "declaration") {
    const type = (await vscode.window.showQuickPick(PARAM_TYPES, { placeHolder: "Parameter type" })) ?? "string";
    const description = await vscode.window.showInputBox({ prompt: "Description (leave blank for none)" });
    const defaultValue = await vscode.window.showInputBox({ prompt: "Default value (leave blank for none)" });

    itemLines = [`- name: ${name}`, `  type: ${type}`];
    if (description) itemLines.push(`  description: ${quoteYamlString(description)}`);
    if (defaultValue) {
      if (type === "string") {
        itemLines.push(`  default: ${quoteYamlString(defaultValue)}`);
      } else if (type === "array") {
        const items = defaultValue.split(",").map((v) => quoteYamlString(v.trim()));
        itemLines.push(`  default: [${items.join(", ")}]`);
      } else {
        itemLines.push(`  default: {}`);
      }
    }
  } else {
    const value = await vscode.window.showInputBox({ prompt: `Value for "${name}"` });
    if (value === undefined) return;
    itemLines = [`- name: ${name}`, `  value: ${quoteYamlString(value)}`];
  }

  const seq = findSeqIn(target.ownerMap, "params");

  if (seq?.range) {
    const lastItem = seq.items[seq.items.length - 1] as { range?: [number, number, number] } | undefined;
    const anchorOffset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : seq.range[1]);
    const itemIndent = lastItem ? indentAt(document, document.positionAt(seq.range[0])) : target.keyIndent + "  ";
    await insertBlockAfter(editor, document.positionAt(anchorOffset), itemLines, itemIndent);
    return;
  }

  // No `params:` key yet in the owning map — create it, appended after the map's last existing key.
  const lines = ["params:", ...itemLines.map((l) => "  " + l)];
  const anchorOffset = trimTrailingNewline(parsed.text, target.ownerMapEnd);
  await insertBlockAfter(editor, document.positionAt(anchorOffset), lines, target.keyIndent);
}
