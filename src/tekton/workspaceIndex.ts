import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc, TASK_LIKE_KINDS, TektonSymbols } from "./model";

const YAML_GLOB = "**/*.{yaml,yml}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";

export interface IndexedResource {
  uri: vscode.Uri;
  parsed: ParsedTektonDoc;
}

/** name -> (uri string -> indexed resource), so two files sharing a name never clobber each other's entry — see {@link TektonWorkspaceIndex}. */
type NameIndex = Map<string, Map<string, IndexedResource>>;

/**
 * A lightweight workspace-wide index of Task/ClusterTask/StepAction and
 * Pipeline resources, each keyed by their own `metadata.name` (i.e. the
 * name a `taskRef`/`pipelineRef` points at — usually different from the
 * local `name:` a Pipeline gives that task in `spec.tasks[]`). This is what
 * lets completions for `$(tasks.X.results.Y)` resolve `Y` against the
 * actual Task `X` refers to, and rename resolve cross-file references for
 * both Tasks and Pipelines, even when defined in a different file — the
 * common case in Helm charts that split resources across templates.
 *
 * Deliberately simple: no persistence, no incremental AST diffing, just a
 * name -> symbols map rebuilt per changed file, kept current via a file
 * watcher plus live re-indexing of open (possibly unsaved) documents.
 *
 * Tasks and Pipelines are kept in two separate name indexes (not merged
 * into one map keyed by name) — a Task and a Pipeline coincidentally
 * sharing a name isn't actually ambiguous, since `taskRef` and
 * `pipelineRef` are resolved independently, and merging them would invent
 * a collision that doesn't exist.
 */
export class TektonWorkspaceIndex implements vscode.Disposable {
  // Two different files declaring the same metadata.name (e.g. a
  // vendored/catalog Task like "git-clone" present in more than one chart)
  // is a real, non-hypothetical occurrence — each name index is keyed two
  // levels deep (name -> uri -> record) specifically so re-indexing or
  // removing one file only ever touches its own entry, never another
  // file's entry that happens to share the same name.
  private readonly byTaskName: NameIndex = new Map();
  private readonly byPipelineName: NameIndex = new Map();
  private readonly taskNameByUri = new Map<string, string>();
  private readonly pipelineNameByUri = new Map<string, string>();
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
    this.removeFromIndex(this.byTaskName, this.taskNameByUri, key);
    this.removeFromIndex(this.byPipelineName, this.pipelineNameByUri, key);

    const parsed = parseTektonDocument(text);
    if (!parsed?.symbols.metadataName) return;

    if (TASK_LIKE_KINDS.has(parsed.symbols.kind)) {
      this.addToIndex(this.byTaskName, this.taskNameByUri, key, parsed.symbols.metadataName, uri, parsed);
    } else if (parsed.symbols.kind === "Pipeline") {
      this.addToIndex(this.byPipelineName, this.pipelineNameByUri, key, parsed.symbols.metadataName, uri, parsed);
    }
  }

  private addToIndex(
    nameIndex: NameIndex,
    nameByUri: Map<string, string>,
    uriKey: string,
    name: string,
    uri: vscode.Uri,
    parsed: ParsedTektonDoc
  ): void {
    let byUri = nameIndex.get(name);
    if (!byUri) {
      byUri = new Map();
      nameIndex.set(name, byUri);
    }
    byUri.set(uriKey, { uri, parsed });
    nameByUri.set(uriKey, name);
  }

  /** Removes whatever entry `uriKey` currently owns from `nameIndex`, without touching any other file's entry under the same name. */
  private removeFromIndex(nameIndex: NameIndex, nameByUri: Map<string, string>, uriKey: string): void {
    const prevName = nameByUri.get(uriKey);
    if (!prevName) return;
    const byUri = nameIndex.get(prevName);
    if (byUri) {
      byUri.delete(uriKey);
      if (byUri.size === 0) nameIndex.delete(prevName);
    }
    nameByUri.delete(uriKey);
  }

  private remove(uri: vscode.Uri): void {
    const key = uri.toString();
    this.removeFromIndex(this.byTaskName, this.taskNameByUri, key);
    this.removeFromIndex(this.byPipelineName, this.pipelineNameByUri, key);
  }

  private lookupRecord(nameIndex: NameIndex, name: string): IndexedResource | undefined {
    const byUri = nameIndex.get(name);
    if (!byUri || byUri.size === 0) return undefined;
    // Multiple files can legitimately declare the same metadata.name (a
    // vendored/catalog resource present in more than one chart). There's no
    // "which file is the user in" context here to disambiguate by
    // proximity, so pick deterministically by URI rather than by
    // insertion order — otherwise which one "wins" would flip-flop on
    // every unrelated edit depending on re-indexing order.
    const firstKey = [...byUri.keys()].sort()[0];
    return byUri.get(firstKey);
  }

  /** Looks up a Task/ClusterTask/StepAction's declared symbols by its metadata.name (i.e. what a taskRef points at). */
  lookupTask(name: string): TektonSymbols | undefined {
    return this.lookupTaskRecord(name)?.parsed.symbols;
  }

  /** Like {@link lookupTask}, but also returns the URI and full parse (incl. lineCounter) needed to build a cross-file Location. */
  lookupTaskRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord(this.byTaskName, name);
  }

  /**
   * All Task/ClusterTask/StepAction files declaring `name`, not just the
   * one {@link lookupTaskRecord} deterministically picks. Callers that are
   * about to *rewrite* this name across the workspace (rename) need to know
   * when it's ambiguous, not just get a plausible single answer — renaming
   * as though only one file used the name, when a second file shares it,
   * would silently orphan whatever referenced that second file.
   */
  lookupAllTaskRecords(name: string): IndexedResource[] {
    const byUri = this.byTaskName.get(name);
    return byUri ? [...byUri.values()] : [];
  }

  /** Looks up a Pipeline's declared symbols by its metadata.name (i.e. what a pipelineRef points at). */
  lookupPipeline(name: string): TektonSymbols | undefined {
    return this.lookupPipelineRecord(name)?.parsed.symbols;
  }

  /** Like {@link lookupPipeline}, but also returns the URI and full parse needed to build a cross-file Location. */
  lookupPipelineRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord(this.byPipelineName, name);
  }

  /** All Pipeline files declaring `name` — see {@link lookupAllTaskRecords}, same reasoning, for Pipelines. */
  lookupAllPipelineRecords(name: string): IndexedResource[] {
    const byUri = this.byPipelineName.get(name);
    return byUri ? [...byUri.values()] : [];
  }

  dispose(): void {
    for (const timer of this.reindexTimers.values()) clearTimeout(timer);
    this.reindexTimers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
