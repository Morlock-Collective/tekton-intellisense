import * as vscode from "vscode";
import { blockAfterText } from "./snippetText";

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
 * Inserts `lines` as a new block on its own fresh line(s) after `position`
 * — every line, including the first, is prefixed with `indent`. `position`
 * is always AST-derived (end of the last list item, end of a map's last
 * key, ...), never the cursor — every editing command resolves *where*
 * something belongs from the document's structure, not where the cursor
 * happens to be.
 *
 * Each entry in `lines` should carry only its *relative* indentation (e.g.
 * `"- name: x"` then `"  type: string"`, not the absolute column) — this
 * function adds `indent` uniformly so getting nesting right only requires
 * getting the relative indents right once.
 *
 * Built via `SnippetString#appendText`, not the constructor, so the text is
 * escaped as literal content — `lines` routinely embeds free-text user
 * input (a description, a default value), and `$1`/`${1:x}`/`$NAME` are
 * live snippet syntax to `vscode.SnippetString`. Without escaping, a
 * description as ordinary as "cost is $5" would be silently reinterpreted
 * as a tabstop instead of inserted as written.
 */
export async function insertBlockAfter(
  editor: vscode.TextEditor,
  position: vscode.Position,
  lines: string[],
  indent: string
): Promise<void> {
  const snippet = new vscode.SnippetString().appendText(blockAfterText(lines, indent));
  await editor.insertSnippet(snippet, position);
}
