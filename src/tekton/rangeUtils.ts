import * as vscode from "vscode";
import { ParsedTektonDoc } from "./model";

/**
 * Converts an offset in `parsed`'s source text into a `vscode.Position`,
 * via its `yaml` `LineCounter` — see {@link toVscodeRange}; the single-offset
 * counterpart, for building an *insertion* point (e.g. a quick fix editing a
 * cross-file match) rather than a range over existing content.
 */
export function toVscodePosition(parsed: ParsedTektonDoc, offset: number): vscode.Position {
  const pos = parsed.lineCounter.linePos(offset);
  return new vscode.Position(pos.line - 1, pos.col - 1);
}

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
