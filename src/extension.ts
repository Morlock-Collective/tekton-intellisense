import * as vscode from "vscode";
import * as path from "path";
import { computeDiagnostics, DIAGNOSTIC_SOURCE } from "./tekton/diagnostics";
import { TektonRefCodeActionProvider } from "./tekton/codeActions";
import { parseTektonFile, findResourceAt } from "./tekton/model";
import { TektonStatusBar } from "./tekton/statusBar";
import { updateDecorations, clearDecorations, disposeDecorations } from "./tekton/decorations";
import { TektonWorkspaceIndex } from "./tekton/workspaceIndex";
import { TektonRefCompletionProvider } from "./tekton/completions";
import { TektonHoverProvider } from "./tekton/hover";
import { TektonDefinitionProvider } from "./tekton/definitions";
import { TektonReferenceProvider } from "./tekton/references";
import { TektonRenameProvider } from "./tekton/rename";
import { bindParamToEnvCommand } from "./commands/bindParamToEnv";
import { bindAllParamsToEnvCommand } from "./commands/bindAllParamsToEnv";
import { addTaskCommand } from "./commands/addTask";
import { addConditionalCommand } from "./commands/addConditional";
import { addParameterCommand } from "./commands/addParameter";
import { disposeEditTaskScript, editTaskScriptCommand, registerScriptWriteback } from "./commands/editTaskScript";

const YAML_LIKE = /\.(ya?ml)$/i;

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBar: TektonStatusBar;
/** Absolute path to the bundled `schemas/` directory (see `jsonSchemas.ts`) -- set once in `activate` from `context.extensionPath`, which is reliable regardless of whether the extension is running bundled (`dist/extension.js`) or, in development, unbundled. */
let schemasDir: string;

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
let indexChangeTimer: ReturnType<typeof setTimeout> | undefined;

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
    diagnosticCollection.set(document.uri, computeDiagnostics(document, workspaceIndex, schemasDir));
  } catch (err) {
    // Never let a parsing edge case break the editing session.
    console.error("tekton-intellisense: failed to compute diagnostics", err);
  }
}

function refreshActiveEditorState(editor: vscode.TextEditor | undefined): void {
  if (!editor || !looksLikeYaml(editor.document)) {
    statusBar.update(undefined, false);
    void vscode.commands.executeCommand("setContext", "tektonIntellisense.active", false);
    if (editor) clearDecorations(editor);
    return;
  }
  const docs = parseTektonFile(editor.document.getText());
  // Status bar reflects whichever resource the cursor is currently in, for a multi-document file --
  // falling back to the first resource when the cursor isn't inside any of them (e.g. it hasn't moved
  // since the file was opened).
  const cursorOffset = editor.document.offsetAt(editor.selection.active);
  const active = findResourceAt(docs, cursorOffset);
  statusBar.update(active?.symbols.kind, active?.isHelmTemplated ?? false);
  void vscode.commands.executeCommand("setContext", "tektonIntellisense.active", docs.length > 0);
  updateDecorations(editor, docs);
}

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  schemasDir = path.join(context.extensionPath, "schemas");
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
    // The status bar shows whichever resource the cursor is currently inside, for a
    // multi-document file -- so it needs to track cursor movement between resources, not just
    // document/editor changes (decorations don't depend on the cursor, but recomputing them here
    // too is cheap and keeps this one listener simple).
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) refreshActiveEditorState(e.textEditor);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnosticCollection.delete(doc.uri)),
    // Cross-file diagnostics (an unresolved taskRef/pipelineRef/bindings[].ref/etc.) are checked
    // against the workspace index, which only catches up with a just-applied edit (e.g. a rename
    // that touches both a declaration and every file referencing it) once that file's own
    // re-indexing debounce fires -- slightly later than diagnostics' own refresh debounce. Without
    // this, a referencing file's diagnostics can recompute first, against the not-yet-updated
    // index, flag an already-correct reference as unknown, and then never recompute again until
    // something else happens to touch that file. Re-running diagnostics for every visible editor
    // once the index settles (debounced here too, so a burst of index changes -- the initial
    // workspace scan, or a multi-file rename -- coalesces into one pass) closes that gap.
    workspaceIndex.onDidChangeIndex(() => {
      if (indexChangeTimer) clearTimeout(indexChangeTimer);
      indexChangeTimer = setTimeout(() => {
        indexChangeTimer = undefined;
        for (const editor of vscode.window.visibleTextEditors) {
          refreshDiagnostics(editor.document, workspaceIndex);
        }
      }, 300);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tektonIntellisense")) {
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
      new TektonRefCodeActionProvider(workspaceIndex),
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
    vscode.commands.registerCommand("tekton-intellisense.bindAllParamsToEnv", bindAllParamsToEnvCommand),
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
  if (indexChangeTimer) clearTimeout(indexChangeTimer);
  diagnosticCollection?.dispose();
  statusBar?.dispose();
  disposeDecorations();
  disposeEditTaskScript();
}
