import * as vscode from "vscode";
import { ParsedTektonDoc } from "./model";

/**
 * Converts an offset range in `parsed`'s source text into a `vscode.Range`,
 * via its `yaml` `LineCounter` — works for any parsed document, including
 * ones that were never opened as a `vscode.TextDocument` (a cross-file
 * match found by scanning the workspace), not just the current one.
 */
export function toVscodeRange(parsed: ParsedTektonDoc, range: [number, number]): vscode.Range {
  const start = parsed.lineCounter.linePos(range[0]);
  const end = parsed.lineCounter.linePos(range[1]);
  return new vscode.Range(start.line - 1, start.col - 1, end.line - 1, end.col - 1);
}
