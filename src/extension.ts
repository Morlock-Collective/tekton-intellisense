import * as vscode from "vscode";
import { computeDiagnostics, DIAGNOSTIC_SOURCE } from "./tekton/diagnostics";
import { TektonRefCodeActionProvider } from "./tekton/codeActions";
import { bindParamToEnvCommand } from "./commands/bindParamToEnv";
import { addTaskCommand } from "./commands/addTask";
import { addConditionalCommand } from "./commands/addConditional";
import { addParameterCommand } from "./commands/addParameter";

let diagnosticCollection: vscode.DiagnosticCollection;

function refreshDiagnostics(document: vscode.TextDocument): void {
  if (document.languageId !== "yaml") return;
  try {
    diagnosticCollection.set(document.uri, computeDiagnostics(document));
  } catch (err) {
    // Never let a parsing edge case break the editing session.
    console.error("tekton-aid: failed to compute diagnostics", err);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  context.subscriptions.push(diagnosticCollection);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (document: vscode.TextDocument) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => refreshDiagnostics(document), 250);
  };

  if (vscode.window.activeTextEditor) {
    refreshDiagnostics(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) refreshDiagnostics(editor.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnosticCollection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tektonAid")) {
        for (const editor of vscode.window.visibleTextEditors) {
          refreshDiagnostics(editor.document);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: "yaml" },
      new TektonRefCodeActionProvider(),
      TektonRefCodeActionProvider.metadata
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tekton-aid.bindParamToEnv", bindParamToEnvCommand),
    vscode.commands.registerCommand("tekton-aid.addTask", addTaskCommand),
    vscode.commands.registerCommand("tekton-aid.addConditional", addConditionalCommand),
    vscode.commands.registerCommand("tekton-aid.addParameter", addParameterCommand)
  );
}

export function deactivate(): void {
  diagnosticCollection?.dispose();
}
