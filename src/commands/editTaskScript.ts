/**
 * "Edit Task Script": pops a step/sidecar's `script:` block content out
 * into a real scratch file with the right extension, so it opens as an
 * ordinary editor tab with full native language support — no bridging,
 * no headless querying, just a normal file the user edits normally — then
 * writes the (reindented) result back into the YAML on save.
 */
import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { parseTektonFile } from "../tekton/model";
import {
  EmbeddedScriptBlock,
  findEmbeddedScriptBlocks,
  LANGUAGE_EXTENSIONS,
  refreshTemplateGapMarkers,
  reindentScriptContent,
  restoreTemplateGaps,
} from "../tekton/scriptEmbed";

/**
 * Scratch files live under the OS temp directory — confirmed (on Linux;
 * not yet checked on Windows) to get full IntelliSense with no workspace
 * involved at all, unlike two earlier attempts: `context.globalStorageUri`
 * (nested under VS Code's own app-config directory) got syntax
 * highlighting but no real completions/hover from Pylance even with the
 * extension installed and working fine elsewhere; workspace membership
 * (`<folder>/.vscode/tekton-script-edits`) worked but pollutes the user's
 * project for no benefit once this turned out to work just as well.
 */
const scratchDir = vscode.Uri.file(path.join(os.tmpdir(), "tekton-intellisense-script-edits"));
let scratchDirEnsured: Thenable<void> | undefined;

interface ScratchRegistration {
  hostUri: vscode.Uri;
  containerName: string | undefined;
  languageId: string;
}

/** scratch file URI (as a string) -> which host document/block it writes back to. */
const registrations = new Map<string, ScratchRegistration>();

async function ensureScratchDir(): Promise<void> {
  if (!scratchDirEnsured) {
    scratchDirEnsured = vscode.workspace.fs.createDirectory(scratchDir).then(
      () => undefined,
      () => undefined // best-effort; a failed write below is what actually surfaces the problem
    );
  }
  await scratchDirEnsured;
}

/** Short, stable, filesystem-safe hash so scratch filenames stay short but don't collide across different host files sharing a basename. */
function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function sanitizeForFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "script";
}

/** Opens (writing fresh content only if not already open — an already-open scratch file may have unsaved user edits) the scratch file for `block`. */
async function getOrCreateScratchFile(hostUri: vscode.Uri, block: EmbeddedScriptBlock): Promise<vscode.Uri> {
  await ensureScratchDir();

  const ext = LANGUAGE_EXTENSIONS[block.languageId] ?? "txt";
  const hostBase = sanitizeForFilename(hostUri.path.split("/").pop() ?? "task");
  const container = sanitizeForFilename(block.containerName ?? "script");
  // Stable per (host file, step name) so re-invoking the command on the same step reopens the
  // same tab instead of piling up new ones; namespaced by a hash of the full host URI so two
  // different files that happen to share a basename and step name don't collide.
  const uri = vscode.Uri.joinPath(scratchDir, `${hostBase}__${container}__${shortHash(hostUri.toString())}.${ext}`);

  const alreadyOpen = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
  if (!alreadyOpen) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(block.rawContent, "utf8"));
  }

  registrations.set(uri.toString(), { hostUri, containerName: block.containerName, languageId: block.languageId });
  return uri;
}

function containerLabel(block: EmbeddedScriptBlock): string {
  return block.containerName ?? "(unnamed)";
}

/**
 * Pops the script block under the cursor (or, if the cursor isn't inside
 * one, a picker over every recognized block in the document) out into a
 * scratch file and opens it. Edits are written back to the YAML on save —
 * see {@link registerScriptWriteback}.
 */
export async function editTaskScriptCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const docs = parseTektonFile(document.getText());
  if (docs.length === 0) {
    vscode.window.showWarningMessage("Tekton Intellisense: this doesn't look like a Tekton resource.");
    return;
  }

  // Blocks are gathered across every resource in the file (not just the one under the cursor) --
  // a script block's own offset range is what actually identifies it, so there's no reason to
  // restrict the picker fallback to one resource in a multi-document file.
  const blocks = docs.flatMap(findEmbeddedScriptBlocks);
  if (blocks.length === 0) {
    vscode.window.showWarningMessage(
      "Tekton Intellisense: no script: block here with a recognized shebang (#!/usr/bin/env bash, python3, node, ...)."
    );
    return;
  }

  const offset = document.offsetAt(editor.selection.active);
  let block = blocks.find((b) => offset >= b.hostRange[0] && offset <= b.hostRange[1]);

  if (!block) {
    const picked = await vscode.window.showQuickPick(
      blocks.map((b) => ({ label: containerLabel(b), description: b.languageId, block: b })),
      { placeHolder: "Which step/sidecar's script do you want to edit?" }
    );
    if (!picked) return;
    block = picked.block;
  }

  try {
    const scratchUri = await getOrCreateScratchFile(document.uri, block);
    const scratchDocument = await vscode.workspace.openTextDocument(scratchUri);
    await vscode.window.showTextDocument(scratchDocument, { preview: false });
  } catch (err) {
    console.error("tekton-intellisense: failed to open script scratch file", err);
    vscode.window.showErrorMessage("Tekton Intellisense: couldn't open a scratch file for this script — see console for details.");
  }
}

/** Closes every tab currently showing `uri`, if any. */
async function closeTabsFor(uri: vscode.Uri): Promise<void> {
  const matches = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
  if (matches.length > 0) await vscode.window.tabGroups.close(matches);
}

/** Writes `savedDocument`'s current text back into its registered host document's script block, re-indented to fit, then closes the scratch tab and jumps back to the host document at that block. */
async function writeBackToHost(savedDocument: vscode.TextDocument, registration: ScratchRegistration): Promise<void> {
  const hostDocument = await vscode.workspace.openTextDocument(registration.hostUri);
  const docs = parseTektonFile(hostDocument.getText());
  if (docs.length === 0) return;

  // Re-resolved fresh, not from a range captured when the scratch file was opened -- the host
  // document may have changed since (other edits, or simply reflowed offsets), so identity here
  // is the step's own name, not a position. Searched across every resource in the host file, same
  // as the picker in editTaskScriptCommand.
  const block = docs.flatMap(findEmbeddedScriptBlocks).find(
    (b) => b.containerName === registration.containerName && b.languageId === registration.languageId
  );
  if (!block) {
    vscode.window.showWarningMessage(
      `Tekton Intellisense: couldn't find the "${registration.containerName ?? "(unnamed)"}" script block to write these edits back to — has it been renamed, removed, or lost its shebang?`
    );
    return;
  }

  const savedContent = savedDocument.getText();

  // A block with no embedded Helm templates (the overwhelmingly common case) just gets a plain
  // reindent; one with templateGaps needs restoreTemplateGaps instead, to put each one's original
  // text back in place of its marker comment rather than ever writing that comment into the host.
  const indented =
    block.templateGaps.length > 0
      ? restoreTemplateGaps(savedContent, block.indent, block.templateGaps)
      : reindentScriptContent(savedContent, block.indent);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    registration.hostUri,
    new vscode.Range(hostDocument.positionAt(block.hostRange[0]), hostDocument.positionAt(block.hostRange[1])),
    indented
  );
  await vscode.workspace.applyEdit(edit);

  const hostEditor = await vscode.window.showTextDocument(hostDocument, { preview: false });
  const jumpTo = hostDocument.positionAt(block.hostRange[0]);
  hostEditor.selection = new vscode.Selection(jumpTo, jumpTo);
  hostEditor.revealRange(new vscode.Range(jumpTo, jumpTo), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  await closeTabsFor(savedDocument.uri);

  // A marker's visible text is purely for context -- editing it has zero effect on the host
  // (only the invisible id does), so left alone a stale edit would just sit in the scratch file
  // indefinitely, looking like it did something. Snap every marker back to its true rendering
  // now that the tab's closed, writing straight to disk (not a WorkspaceEdit against the
  // just-saved, about-to-be-discarded buffer) so the correction is what's actually there next
  // time this block is opened.
  if (block.templateGaps.length > 0) {
    const refreshed = refreshTemplateGapMarkers(savedContent, block.languageId, block.templateGaps);
    if (refreshed !== savedContent) {
      await vscode.workspace.fs.writeFile(savedDocument.uri, Buffer.from(refreshed, "utf8"));
    }
  }
}

/** Registers the save listener that writes a scratch file's edits back to its host document. Call once during activation. */
export function registerScriptWriteback(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((savedDocument) => {
      const registration = registrations.get(savedDocument.uri.toString());
      if (!registration) return;
      writeBackToHost(savedDocument, registration).catch((err) => {
        console.error("tekton-intellisense: failed to write script edits back to host document", err);
        vscode.window.showErrorMessage("Tekton Intellisense: failed to write script changes back — see console for details.");
      });
    })
  );
}

/**
 * Clears in-memory writeback bookkeeping, called from `deactivate()`. Deliberately doesn't touch
 * the scratch files on disk — a user could have unsaved edits open in one across a window reload,
 * and deleting out from under a dirty editor is a worse outcome than a few harmless leftover
 * files sitting around.
 */
export function disposeEditTaskScript(): void {
  registrations.clear();
}
