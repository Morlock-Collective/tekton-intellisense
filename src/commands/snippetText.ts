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
