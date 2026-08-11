import * as vscode from "vscode";
import { computeDiagnostics, DIAGNOSTIC_SOURCE } from "./tekton/diagnostics";
import { TektonRefCodeActionProvider } from "./tekton/codeActions";
import { parseTektonDocument } from "./tekton/model";
import { TektonStatusBar } from "./tekton/statusBar";
import { updateDecorations, clearDecorations, disposeDecorations } from "./tekton/decorations";
import { bindParamToEnvCommand } from "./commands/bindParamToEnv";
import { addTaskCommand } from "./commands/addTask";
import { addConditionalCommand } from "./commands/addConditional";
import { addParameterCommand } from "./commands/addParameter";

const YAML_LIKE = /\.(ya?ml)$/i;

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBar: TektonStatusBar;

function looksLikeYaml(document: vscode.TextDocument): boolean {
  // Rely on the file extension rather than languageId: other extensions (Helm,
  // Kubernetes tooling) sometimes claim ownership of *.yaml with a different
  // languageId (e.g. "helm"), and Tekton detection shouldn't depend on which
  // language-mode extension happened to win that association.
  return document.languageId === "yaml" || document.languageId === "helm" || YAML_LIKE.test(document.fileName);
}

function refreshDiagnostics(document: vscode.TextDocument): void {
  if (!looksLikeYaml(document)) return;
  try {
    diagnosticCollection.set(document.uri, computeDiagnostics(document));
  } catch (err) {
    // Never let a parsing edge case break the editing session.
    console.error("tekton-aid: failed to compute diagnostics", err);
  }
}

function refreshActiveEditorState(editor: vscode.TextEditor | undefined): void {
  if (!editor || !looksLikeYaml(editor.document)) {
    statusBar.update(undefined, false);
    void vscode.commands.executeCommand("setContext", "tektonAid.active", false);
    if (editor) clearDecorations(editor);
    return;
  }
  const parsed = parseTektonDocument(editor.document.getText());
  statusBar.update(parsed?.symbols.kind, parsed?.isHelmTemplated ?? false);
  void vscode.commands.executeCommand("setContext", "tektonAid.active", !!parsed);
  updateDecorations(editor, parsed);
}

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  statusBar = new TektonStatusBar();
  context.subscriptions.push(diagnosticCollection, statusBar);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (document: vscode.TextDocument) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      refreshDiagnostics(document);
      if (vscode.window.activeTextEditor?.document === document) {
        refreshActiveEditorState(vscode.window.activeTextEditor);
      }
    }, 250);
  };

  refreshActiveEditorState(vscode.window.activeTextEditor);
  if (vscode.window.activeTextEditor) {
    refreshDiagnostics(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      refreshDiagnostics(doc);
      if (vscode.window.activeTextEditor?.document === doc) {
        refreshActiveEditorState(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refreshActiveEditorState(editor);
      if (editor) refreshDiagnostics(editor.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnosticCollection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tektonAid")) {
        for (const editor of vscode.window.visibleTextEditors) {
          refreshDiagnostics(editor.document);
        }
        refreshActiveEditorState(vscode.window.activeTextEditor);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: "**/*.{yaml,yml}" },
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
  statusBar?.dispose();
  disposeDecorations();
}
