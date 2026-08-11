import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc, TASK_LIKE_KINDS, TektonSymbols } from "./model";

const YAML_GLOB = "**/*.{yaml,yml}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";

export interface IndexedTask {
  uri: vscode.Uri;
  parsed: ParsedTektonDoc;
}

/**
 * A lightweight workspace-wide index of Task/ClusterTask/StepAction
 * resources, keyed by their metadata.name (i.e. the name a taskRef points
 * at — usually different from the local `name:` a Pipeline gives that task
 * in spec.tasks[]). This is what lets completions for
 * `$(tasks.X.results.Y)` resolve Y against the actual Task X refers to,
 * even when that Task is defined in a different file — the common case in
 * Helm charts that split Tasks and Pipelines across templates.
 *
 * Deliberately simple: no persistence, no incremental AST diffing, just a
 * name -> symbols map rebuilt per changed file, kept current via a file
 * watcher plus live re-indexing of open (possibly unsaved) documents.
 */
export class TektonWorkspaceIndex implements vscode.Disposable {
  private readonly byTaskName = new Map<string, IndexedTask>();
  private readonly taskNameByUri = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private reindexTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(YAML_GLOB);
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => void this.indexFileFromDisk(uri)),
      watcher.onDidCreate((uri) => void this.indexFileFromDisk(uri)),
      watcher.onDidDelete((uri) => this.remove(uri)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.indexDocument(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleReindex(e.document))
    );

    for (const doc of vscode.workspace.textDocuments) {
      this.indexDocument(doc);
    }
    void this.initialScan();
  }

  private async initialScan(): Promise<void> {
    const files = await vscode.workspace.findFiles(YAML_GLOB, EXCLUDE_GLOB, 5000);
    await Promise.all(files.map((uri) => this.indexFileFromDisk(uri)));
  }

  private scheduleReindex(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.reindexTimers.get(key);
    if (existing) clearTimeout(existing);
    this.reindexTimers.set(
      key,
      setTimeout(() => {
        this.reindexTimers.delete(key);
        this.indexDocument(document);
      }, 400)
    );
  }

  private async indexFileFromDisk(uri: vscode.Uri): Promise<void> {
    // Prefer the live (possibly unsaved) buffer if the file is open.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      this.indexDocument(open);
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.index(uri, Buffer.from(bytes).toString("utf8"));
    } catch {
      // File may have been deleted between the watcher event and the read; ignore.
    }
  }

  private indexDocument(document: vscode.TextDocument): void {
    if (!/\.(ya?ml)$/i.test(document.fileName)) return;
    this.index(document.uri, document.getText());
  }

  private index(uri: vscode.Uri, text: string): void {
    const key = uri.toString();
    const prevName = this.taskNameByUri.get(key);
    if (prevName) this.byTaskName.delete(prevName);
    this.taskNameByUri.delete(key);

    const parsed = parseTektonDocument(text);
    if (!parsed || !TASK_LIKE_KINDS.has(parsed.symbols.kind) || !parsed.symbols.metadataName) return;

    this.byTaskName.set(parsed.symbols.metadataName, { uri, parsed });
    this.taskNameByUri.set(key, parsed.symbols.metadataName);
  }

  private remove(uri: vscode.Uri): void {
    const key = uri.toString();
    const prevName = this.taskNameByUri.get(key);
    if (prevName) this.byTaskName.delete(prevName);
    this.taskNameByUri.delete(key);
  }

  /** Looks up a Task/ClusterTask/StepAction's declared symbols by its metadata.name (i.e. what a taskRef points at). */
  lookupTask(name: string): TektonSymbols | undefined {
    return this.byTaskName.get(name)?.parsed.symbols;
  }

  /** Like {@link lookupTask}, but also returns the URI and full parse (incl. lineCounter) needed to build a cross-file Location. */
  lookupTaskRecord(name: string): IndexedTask | undefined {
    return this.byTaskName.get(name);
  }

  dispose(): void {
    for (const timer of this.reindexTimers.values()) clearTimeout(timer);
    this.reindexTimers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
