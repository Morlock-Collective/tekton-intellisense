/**
 * Pure text composition for the two insertion shapes editing commands need.
 * Kept `vscode`-free (like model.ts/paramRefs.ts/duplicates.ts) so the
 * indentation math — the exact thing that was buggy before — is directly
 * testable via plain Node instead of only observable inside a live editor.
 */

/**
 * Text starting exactly where the cursor already is: the first line
 * continues in place (no indent added), every line after it starts fresh,
 * prefixed with `indent`. Each entry in `lines` should carry only its own
 * *relative* indentation.
 */
export function atCursorText(lines: string[], indent: string): string {
  return lines.map((line, i) => (i === 0 ? line : indent + line)).join("\n");
}

/**
 * Text for a new block appended after existing content: every line,
 * including the first, is prefixed with `indent`, and the whole thing
 * starts with a newline so it lands on its own fresh line.
 */
export function blockAfterText(lines: string[], indent: string): string {
  return "\n" + lines.map((line) => indent + line).join("\n");
}

/**
 * Renders `value` as a double-quoted YAML scalar, escaping backslashes,
 * quotes, and control characters so it stays valid regardless of content.
 * Editing commands build YAML text out of free-form user input (a
 * description, a param value, a `when` expression) — without this, a value
 * containing so much as a `"`, a YAML-significant character like `:`, or a
 * pasted-in newline (`showInputBox` accepts multi-line clipboard content
 * even though it only ever displays one line) would break the generated
 * line, or worse silently truncate the rest of the document at parse time.
 */
export function quoteYamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
