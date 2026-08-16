import * as vscode from "vscode";
import { computeDiagnostics, DIAGNOSTIC_SOURCE } from "./tekton/diagnostics";
import { TektonRefCodeActionProvider } from "./tekton/codeActions";
import { parseTektonDocument } from "./tekton/model";
import { TektonStatusBar } from "./tekton/statusBar";
import { updateDecorations, clearDecorations, disposeDecorations } from "./tekton/decorations";
import { TektonWorkspaceIndex } from "./tekton/workspaceIndex";
import { TektonRefCompletionProvider } from "./tekton/completions";
import { TektonHoverProvider } from "./tekton/hover";
import { TektonDefinitionProvider } from "./tekton/definitions";
import { TektonReferenceProvider } from "./tekton/references";
import { TektonRenameProvider } from "./tekton/rename";
import { bindParamToEnvCommand } from "./commands/bindParamToEnv";
import { addTaskCommand } from "./commands/addTask";
import { addConditionalCommand } from "./commands/addConditional";
import { addParameterCommand } from "./commands/addParameter";
import { disposeEditTaskScript, editTaskScriptCommand, registerScriptWriteback } from "./commands/editTaskScript";

const YAML_LIKE = /\.(ya?ml)$/i;

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBar: TektonStatusBar;

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function looksLikeYaml(document: vscode.TextDocument): boolean {
  // Rely on the file extension rather than languageId: other extensions (Helm,
  // Kubernetes tooling) sometimes claim ownership of *.yaml with a different
  // languageId (e.g. "helm"), and Tekton detection shouldn't depend on which
  // language-mode extension happened to win that association.
  return document.languageId === "yaml" || document.languageId === "helm" || YAML_LIKE.test(document.fileName);
}

function refreshDiagnostics(document: vscode.TextDocument, workspaceIndex: TektonWorkspaceIndex): void {
  if (!looksLikeYaml(document)) return;
  try {
    diagnosticCollection.set(document.uri, computeDiagnostics(document, workspaceIndex));
  } catch (err) {
    // Never let a parsing edge case break the editing session.
    console.error("tekton-intellisense: failed to compute diagnostics", err);
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
  const workspaceIndex = new TektonWorkspaceIndex();
  context.subscriptions.push(diagnosticCollection, statusBar, workspaceIndex);

  const scheduleRefresh = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const existing = refreshTimers.get(key);
    if (existing) clearTimeout(existing);
    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        refreshDiagnostics(document, workspaceIndex);
        if (vscode.window.activeTextEditor?.document === document) {
          refreshActiveEditorState(vscode.window.activeTextEditor);
        }
      }, 250)
    );
  };

  refreshActiveEditorState(vscode.window.activeTextEditor);
  if (vscode.window.activeTextEditor) {
    refreshDiagnostics(vscode.window.activeTextEditor.document, workspaceIndex);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      refreshDiagnostics(doc, workspaceIndex);
      if (vscode.window.activeTextEditor?.document === doc) {
        refreshActiveEditorState(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refreshActiveEditorState(editor);
      if (editor) refreshDiagnostics(editor.document, workspaceIndex);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnosticCollection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tektonAid")) {
        for (const editor of vscode.window.visibleTextEditors) {
          refreshDiagnostics(editor.document, workspaceIndex);
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
    vscode.languages.registerCompletionItemProvider(
      { pattern: "**/*.{yaml,yml}" },
      new TektonRefCompletionProvider(workspaceIndex),
      ...TektonRefCompletionProvider.triggerCharacters
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ pattern: "**/*.{yaml,yml}" }, new TektonHoverProvider(workspaceIndex))
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { pattern: "**/*.{yaml,yml}" },
      new TektonDefinitionProvider(workspaceIndex)
    )
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider({ pattern: "**/*.{yaml,yml}" }, new TektonReferenceProvider(workspaceIndex))
  );

  context.subscriptions.push(
    vscode.languages.registerRenameProvider({ pattern: "**/*.{yaml,yml}" }, new TektonRenameProvider(workspaceIndex))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tekton-intellisense.bindParamToEnv", bindParamToEnvCommand),
    vscode.commands.registerCommand("tekton-intellisense.addTask", addTaskCommand),
    vscode.commands.registerCommand("tekton-intellisense.addConditional", addConditionalCommand),
    vscode.commands.registerCommand("tekton-intellisense.addParameter", addParameterCommand),
    vscode.commands.registerCommand("tekton-intellisense.editTaskScript", editTaskScriptCommand)
  );

  registerScriptWriteback(context);
}

export function deactivate(): void {
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  diagnosticCollection?.dispose();
  statusBar?.dispose();
  disposeDecorations();
  disposeEditTaskScript();
}
