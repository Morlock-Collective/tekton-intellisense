import * as vscode from "vscode";
import { atCursorText, blockAfterText } from "./snippetText";

/** Returns the leading whitespace of the line at `position`. */
export function indentAt(document: vscode.TextDocument, position: vscode.Position): string {
  const line = document.lineAt(position.line).text;
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : "";
}

/** Converts a param/workspace name into a conventional SCREAMING_SNAKE_CASE env var name. */
export function toEnvVarName(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
  return snake || "VALUE";
}

/**
 * Inserts `lines` starting exactly at `position` — the first line continues
 * whatever's already on that line (no indent added), and every line after
 * it starts fresh, prefixed with `indent`. Use this when `position` is
 * already sitting at the correct column (e.g. right after a `- ` you just
 * typed, or a cursor the caller has already indent-checked).
 *
 * Each entry in `lines` should carry only its *relative* indentation (e.g.
 * `"- name: x"` then `"  type: string"`, not the absolute column) — this
 * function adds `indent` uniformly so getting nesting right only requires
 * getting the relative indents right once.
 */
export async function insertAtCursor(
  editor: vscode.TextEditor,
  position: vscode.Position,
  lines: string[],
  indent: string
): Promise<void> {
  await editor.insertSnippet(new vscode.SnippetString(atCursorText(lines, indent)), position);
}

/**
 * Inserts `lines` as a new block on its own fresh line(s) after `position`
 * — every line, including the first, is prefixed with `indent`. Use this
 * when appending after existing content (e.g. right after the last item in
 * a list, or the last key in a mapping) rather than at a cursor that's
 * already sitting on a blank/correctly-indented line.
 */
export async function insertBlockAfter(
  editor: vscode.TextEditor,
  position: vscode.Position,
  lines: string[],
  indent: string
): Promise<void> {
  await editor.insertSnippet(new vscode.SnippetString(blockAfterText(lines, indent)), position);
}
