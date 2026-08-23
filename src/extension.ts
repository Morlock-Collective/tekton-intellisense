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
import { CelSemanticTokensProvider, celSemanticTokensLegend } from "./tekton/celSemanticTokens";
import { ClusterResourceIndex } from "./tekton/clusterIndex";
import {
  authenticateClusterCommand,
  configureClusterResourcesCommand,
  refreshClusterResourcesCommand,
} from "./commands/clusterResourceCommands";

const YAML_LIKE = /\.(ya?ml)$/i;

/**
 * This extension owns no language of its own -- it only injects a grammar
 * into "source.yaml"/"text.html.markdown" for `$(...)` highlighting (see
 * `package.json`'s `contributes.grammars`) -- so auto-indent-on-Enter
 * behavior normally comes entirely from whichever extension registered the
 * "yaml" language mode a given file is under. In practice, plain "yaml"
 * documents don't get "increase indent after a mapping key" for free:
 * `vscode.languages.setLanguageConfiguration("yaml", { onEnterRules })`
 * alone (tried first, see git history) never actually took effect --
 * confirmed live, not just suspected -- so whatever's already registered
 * for "yaml" apparently wins outright rather than the two being combined.
 * Overriding the Enter key directly, scoped to `editorLangId == yaml`
 * (see `package.json`'s `contributes.keybindings`), sidesteps that
 * uncertainty entirely: this command decides the indentation itself,
 * unconditionally, rather than hoping to be consulted.
 */
const INCREASE_INDENT_BEFORE_TEXT = [
  // A mapping key with nothing (or only a comment) after its colon, e.g. "spec:" or
  // "- name:" -- the value is expected on the next, more deeply indented line.
  /^\s*(-\s+)?[^\s:#][^:#]*:\s*(#.*)?$/,
  // A fresh sequence item marker with nothing after it yet, e.g. "- " about to get its own
  // "name: ..." on the same line, or a nested block on the next.
  /^\s*-\s*$/,
];

/** What pressing Enter at `position` should insert: a newline, the current line's own indentation carried down (standard auto-indent), and one more level on top of that when the text before the cursor matches one of `INCREASE_INDENT_BEFORE_TEXT`. */
function enterInsertion(document: vscode.TextDocument, position: vscode.Position): string {
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.slice(0, position.character);
  const currentIndent = /^[ \t]*/.exec(line)![0];
  const increase = INCREASE_INDENT_BEFORE_TEXT.some((re) => re.test(beforeCursor));
  return "\n" + currentIndent + (increase ? "  " : "");
}

/** Registered on Enter for editorLangId == yaml (see `package.json`) -- see the module-level doc comment above for why this exists instead of a plain `setLanguageConfiguration` call. Falls back to plain newline insertion if there's no active editor (shouldn't happen given the keybinding's own `when` clause, but `editor.edit` needs one regardless). */
async function smartEnterCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const document = editor.document;
  const insertions = editor.selections.map((selection) => enterInsertion(document, selection.active));
  await editor.edit((builder) => {
    editor.selections.forEach((selection, i) => {
      builder.delete(selection);
      builder.insert(selection.active, insertions[i]);
    });
  });
}

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
  const clusterIndex = new ClusterResourceIndex();
  workspaceIndex.setClusterIndex(clusterIndex);
  context.subscriptions.push(diagnosticCollection, statusBar, workspaceIndex, clusterIndex);

  context.subscriptions.push(vscode.commands.registerCommand("tekton-intellisense.smartEnter", smartEnterCommand));

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
      new TektonRefCompletionProvider(workspaceIndex, schemasDir),
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
    vscode.languages.registerDocumentSemanticTokensProvider(
      { pattern: "**/*.{yaml,yml}" },
      new CelSemanticTokensProvider(),
      celSemanticTokensLegend
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tekton-intellisense.bindParamToEnv", bindParamToEnvCommand),
    vscode.commands.registerCommand("tekton-intellisense.bindAllParamsToEnv", bindAllParamsToEnvCommand),
    vscode.commands.registerCommand("tekton-intellisense.addTask", () => addTaskCommand(workspaceIndex)),
    vscode.commands.registerCommand("tekton-intellisense.addConditional", addConditionalCommand),
    vscode.commands.registerCommand("tekton-intellisense.addParameter", addParameterCommand),
    vscode.commands.registerCommand("tekton-intellisense.editTaskScript", editTaskScriptCommand),
    vscode.commands.registerCommand("tekton-intellisense.refreshClusterResources", () => refreshClusterResourcesCommand(clusterIndex)),
    vscode.commands.registerCommand("tekton-intellisense.configureClusterResources", configureClusterResourcesCommand),
    vscode.commands.registerCommand("tekton-intellisense.authenticateCluster", authenticateClusterCommand)
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
