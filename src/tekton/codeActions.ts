import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "./diagnostics";

/** Offers a quick fix that applies the "Did you mean X?" suggestion encoded in diagnostic.code. */
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
      if (!code?.startsWith("suggest:")) continue;

      const suggestion = code.slice("suggest:".length);
      const action = new vscode.CodeAction(`Change to "${suggestion}"`, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diagnostic.range, suggestion);
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      actions.push(action);
    }

    return actions;
  }
}
