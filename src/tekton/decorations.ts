import * as vscode from "vscode";
import { ParsedTektonDoc } from "./model";
import { findParamRefs } from "./paramRefs";

/**
 * Colors are chosen from the workbench color registry (not language-grammar
 * scopes) so they render consistently regardless of which color theme is
 * active — every theme resolves these to a sensible value, whereas TextMate
 * scopes like `variable.parameter` are only as visible as a given theme
 * bothers to make them (often nearly invisible).
 */
const declarationDecoration = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("symbolIcon.variableForeground"),
  fontWeight: "bold",
  textDecoration: "underline solid 1px",
});

const referenceDecoration = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("textLink.foreground"),
  fontWeight: "bold",
});

function rangeFor(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

/**
 * Highlights the `name:` value at every param/workspace/result/task
 * declaration site, and the name portion of every `$(...)` reference —
 * using matching-but-distinct styles so a declaration ("this is defined
 * here") reads differently from a use ("this points at a declaration").
 */
export function updateDecorations(editor: vscode.TextEditor, parsed: ParsedTektonDoc | undefined): void {
  if (!parsed) {
    editor.setDecorations(declarationDecoration, []);
    editor.setDecorations(referenceDecoration, []);
    return;
  }

  const document = editor.document;

  const declRanges: vscode.Range[] = [];
  const addDeclarations = (symbols: { range?: [number, number] }[]) => {
    for (const s of symbols) {
      if (s.range) declRanges.push(rangeFor(document, s.range[0], s.range[1]));
    }
  };
  addDeclarations(parsed.symbols.params);
  addDeclarations(parsed.symbols.workspaces);
  addDeclarations(parsed.symbols.results);
  addDeclarations(parsed.symbols.tasks);
  addDeclarations(parsed.symbols.bindingParams);
  addDeclarations(parsed.symbols.triggers);

  const refRanges: vscode.Range[] = [];
  for (const ref of findParamRefs(parsed.text)) {
    if (ref.nameStart !== undefined && ref.nameEnd !== undefined) {
      refRanges.push(rangeFor(document, ref.nameStart, ref.nameEnd));
    }
    if (ref.resultNameStart !== undefined && ref.resultNameEnd !== undefined) {
      refRanges.push(rangeFor(document, ref.resultNameStart, ref.resultNameEnd));
    }
  }

  editor.setDecorations(declarationDecoration, declRanges);
  editor.setDecorations(referenceDecoration, refRanges);
}

export function clearDecorations(editor: vscode.TextEditor): void {
  editor.setDecorations(declarationDecoration, []);
  editor.setDecorations(referenceDecoration, []);
}

export function disposeDecorations(): void {
  declarationDecoration.dispose();
  referenceDecoration.dispose();
}
