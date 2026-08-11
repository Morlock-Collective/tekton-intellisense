import * as vscode from "vscode";

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
 * Inserts a multi-line LSP snippet template (may contain $1, ${1:default}, etc.)
 * at `position`, prefixing every line after the first with `indent` so the
 * result lines up with the surrounding YAML.
 */
export async function insertIndentedSnippet(
  editor: vscode.TextEditor,
  position: vscode.Position,
  template: string,
  indent: string
): Promise<void> {
  const indented = template.split("\n").join("\n" + indent);
  await editor.insertSnippet(new vscode.SnippetString(indented), position);
}
