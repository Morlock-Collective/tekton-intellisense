import * as vscode from "vscode";
import { isSeq } from "yaml";
import { DIAGNOSTIC_SOURCE } from "./diagnostics";
import { findEnclosingTaskEntry, parseTektonFile, findResourceAt, trimTrailingNewline } from "./model";
import { blockAfterText } from "../commands/snippetText";
import { indentAt } from "../commands/editUtils";

/** Offers quick fixes encoded in a diagnostic's `code`: "suggest:X" applies a Did-you-mean rename; "add-runafter:X" adds X to the enclosing task's runAfter. */
export class TektonRefCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
      const code = typeof diagnostic.code === "string" ? diagnostic.code : undefined;
      if (!code) continue;

      if (code.startsWith("suggest:")) {
        actions.push(this.suggestFix(document, diagnostic, code.slice("suggest:".length)));
      } else if (code.startsWith("add-runafter:")) {
        const action = this.addRunAfterFix(document, diagnostic, code.slice("add-runafter:".length));
        if (action) actions.push(action);
      }
    }

    return actions;
  }

  private suggestFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, suggestion: string): vscode.CodeAction {
    const action = new vscode.CodeAction(`Change to "${suggestion}"`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, diagnostic.range, suggestion);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    return action;
  }

  private addRunAfterFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, taskName: string): vscode.CodeAction | undefined {
    const offset = document.offsetAt(diagnostic.range.start);
    const parsed = findResourceAt(parseTektonFile(document.getText()), offset);
    if (!parsed) return undefined;

    const entryMap = findEnclosingTaskEntry(parsed, offset);
    if (!entryMap?.range) return undefined;

    const action = new vscode.CodeAction(`Add "${taskName}" to runAfter`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    const runAfterNode = entryMap.get("runAfter", true);
    if (isSeq(runAfterNode) && runAfterNode.range) {
      const lastItem = runAfterNode.items[runAfterNode.items.length - 1] as { range?: [number, number, number] } | undefined;
      const rawAnchor = lastItem?.range ? lastItem.range[1] : runAfterNode.range[1];
      const anchorOffset = trimTrailingNewline(parsed.text, rawAnchor);
      const itemIndent = indentAt(document, document.positionAt(runAfterNode.range[0]));
      action.edit.insert(document.uri, document.positionAt(anchorOffset), blockAfterText([`- ${taskName}`], itemIndent));
      return action;
    }

    // No runAfter: yet — create it, appended after the task's last existing key.
    const anchorOffset = trimTrailingNewline(parsed.text, entryMap.range[1]);
    const taskIndent = indentAt(document, document.positionAt(entryMap.range[0]));
    action.edit.insert(
      document.uri,
      document.positionAt(anchorOffset),
      blockAfterText(["runAfter:", `  - ${taskName}`], taskIndent + "  ")
    );
    return action;
  }
}
