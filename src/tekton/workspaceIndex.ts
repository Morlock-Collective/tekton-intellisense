import * as vscode from "vscode";
import { parseTektonFile, ParsedTektonDoc, TASK_LIKE_KINDS, TRIGGER_BINDING_LIKE_KINDS, TektonKind, TektonSymbols } from "./model";
import { YAML_GLOB, EXCLUDE_GLOB, readWorkspaceFileText } from "./workspaceScan";

export interface IndexedResource {
  uri: vscode.Uri;
  parsed: ParsedTektonDoc;
}

/**
 * name -> (resourceKey -> record). Two levels deep, not flat by name, so
 * that two resources declaring the same `metadata.name` (a vendored Task
 * present in more than one chart, say — or two sibling documents in one
 * multi-document file) don't clobber each other: re-indexing or removing
 * one resource only ever touches its own entry. `resourceKey` identifies
 * one `---`-separated document within a file (see {@link resourceKey}), not
 * just the file itself — a single file can contribute more than one entry
 * per group (two Tasks in one file) or across groups (a Task and a Pipeline
 * in one file).
 */
type NameIndex = Map<string, Map<string, IndexedResource>>;

type IndexGroup = "task" | "pipeline" | "triggerTemplate" | "triggerBinding" | "trigger";

/**
 * Which document kinds share one name index. Kinds resolved by the same bare
 * name share a group (Task/ClusterTask/StepAction via taskRef,
 * TriggerBinding/ClusterTriggerBinding via a binding ref); Task and Pipeline
 * don't, since taskRef/pipelineRef resolve independently even if a name
 * coincidentally collides between them.
 */
const GROUP_KINDS: Record<IndexGroup, ReadonlySet<TektonKind>> = {
  task: TASK_LIKE_KINDS,
  pipeline: new Set(["Pipeline"]),
  triggerTemplate: new Set(["TriggerTemplate"]),
  triggerBinding: TRIGGER_BINDING_LIKE_KINDS,
  trigger: new Set(["Trigger"]),
};

function groupFor(kind: TektonKind): IndexGroup | undefined {
  for (const group of Object.keys(GROUP_KINDS) as IndexGroup[]) {
    if (GROUP_KINDS[group].has(kind)) return group;
  }
  return undefined;
}

interface GroupState {
  byName: NameIndex;
  nameByResourceKey: Map<string, string>;
}

function newGroupState(): GroupState {
  return { byName: new Map(), nameByResourceKey: new Map() };
}

/** Identifies one `---`-separated document within a file — the unit this index actually tracks, since a single file can hold several resources. */
function resourceKey(uriKey: string, docIndex: number): string {
  return `${uriKey}#${docIndex}`;
}

/**
 * Workspace-wide index of resources referenced by `metadata.name` across
 * files: Task/ClusterTask/StepAction and Pipeline (via taskRef/pipelineRef),
 * and TriggerTemplate/TriggerBinding-family/Trigger (via an EventListener or
 * Trigger's bindings/template/triggerRef). Lets completions resolve
 * `$(tasks.X.results.Y)` against the actual Task `X` refers to, and
 * rename/references resolve cross-file, even when defined in a different
 * file (the common Helm-chart layout).
 *
 * No persistence, no incremental AST diffing — just a name -> symbols map
 * rebuilt per changed file, kept current via a file watcher plus live
 * re-indexing of open (possibly unsaved) documents.
 */
export class TektonWorkspaceIndex implements vscode.Disposable {
  private readonly groups: Record<IndexGroup, GroupState> = {
    task: newGroupState(),
    pipeline: newGroupState(),
    triggerTemplate: newGroupState(),
    triggerBinding: newGroupState(),
    trigger: newGroupState(),
  };
  private readonly disposables: vscode.Disposable[] = [];
  private reindexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Every resourceKey a given file (by uriKey) currently owns, across all groups — so a re-index or removal can wipe exactly its own previous entries, however many documents it holds, without touching any other file's. */
  private resourceKeysByUri = new Map<string, string[]>();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /**
   * Fires whenever a file's entries in this index change (indexed, re-indexed, or removed) — not
   * on every text edit, only once the index itself has actually caught up with one. A rename that
   * edits a resource's own file (its declaration) and a file referencing it by name applies both
   * edits at once, but this index only catches up with the declaration's new name once its own
   * file is re-indexed, which is debounced separately from (and slightly slower than) diagnostics'
   * own refresh debounce. Without this, a referencing file's diagnostics can recompute against the
   * *old* index entry moments after the rename, flag the (already-renamed, on-screen-correct)
   * reference as unknown, and then never recompute again until something else happens to touch
   * that file — extension.ts listens for this to re-run diagnostics once the index is consistent
   * again, instead of requiring a save (or another edit) to notice.
   */
  readonly onDidChangeIndex = this.changeEmitter.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(YAML_GLOB);
    this.disposables.push(
      this.changeEmitter,
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
    // Only ever called with a uri that already matched YAML_GLOB (the watcher, or initialScan),
    // so unlike indexDocument's callers (onDidOpenTextDocument fires for any file), there's no
    // need to re-check the filename here -- readWorkspaceFileText undefined just means the file
    // was deleted between the watcher event and this read, not worth surfacing as an error.
    const text = await readWorkspaceFileText(uri);
    if (text !== undefined) this.index(uri, text);
  }

  private indexDocument(document: vscode.TextDocument): void {
    if (!/\.(ya?ml)$/i.test(document.fileName)) return;
    this.index(document.uri, document.getText());
  }

  private index(uri: vscode.Uri, text: string): void {
    const uriKey = uri.toString();
    this.removeUri(uriKey);

    const newKeys: string[] = [];
    parseTektonFile(text).forEach((parsed, docIndex) => {
      if (!parsed.symbols.metadataName) return;
      const group = groupFor(parsed.symbols.kind);
      if (!group) return;
      const rk = resourceKey(uriKey, docIndex);
      this.addToIndex(this.groups[group], rk, parsed.symbols.metadataName, uri, parsed);
      newKeys.push(rk);
    });
    if (newKeys.length > 0) this.resourceKeysByUri.set(uriKey, newKeys);
    this.changeEmitter.fire();
  }

  private addToIndex(group: GroupState, rk: string, name: string, uri: vscode.Uri, parsed: ParsedTektonDoc): void {
    let byKey = group.byName.get(name);
    if (!byKey) {
      byKey = new Map();
      group.byName.set(name, byKey);
    }
    byKey.set(rk, { uri, parsed });
    group.nameByResourceKey.set(rk, name);
  }

  /** Removes whatever entry `rk` currently owns from `group`, without touching any other resource's entry under the same name. */
  private removeFromIndex(group: GroupState, rk: string): void {
    const prevName = group.nameByResourceKey.get(rk);
    if (!prevName) return;
    const byKey = group.byName.get(prevName);
    if (byKey) {
      byKey.delete(rk);
      if (byKey.size === 0) group.byName.delete(prevName);
    }
    group.nameByResourceKey.delete(rk);
  }

  /** Removes every resourceKey `uriKey` currently owns, across every group and however many documents it held. */
  private removeUri(uriKey: string): void {
    const prevKeys = this.resourceKeysByUri.get(uriKey);
    if (!prevKeys) return;
    for (const group of Object.values(this.groups)) {
      for (const rk of prevKeys) this.removeFromIndex(group, rk);
    }
    this.resourceKeysByUri.delete(uriKey);
  }

  private remove(uri: vscode.Uri): void {
    this.removeUri(uri.toString());
    this.changeEmitter.fire();
  }

  private lookupRecord(group: IndexGroup, name: string): IndexedResource | undefined {
    const byUri = this.groups[group].byName.get(name);
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

  private lookupAllRecords(group: IndexGroup, name: string): IndexedResource[] {
    const byUri = this.groups[group].byName.get(name);
    return byUri ? [...byUri.values()] : [];
  }

  private allNames(group: IndexGroup): string[] {
    return [...this.groups[group].byName.keys()];
  }

  /** Looks up a Task/ClusterTask/StepAction's declared symbols by its metadata.name (i.e. what a taskRef points at). */
  lookupTask(name: string): TektonSymbols | undefined {
    return this.lookupTaskRecord(name)?.parsed.symbols;
  }

  /** Like {@link lookupTask}, but also returns the URI and full parse (incl. lineCounter) needed to build a cross-file Location. */
  lookupTaskRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord("task", name);
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
    return this.lookupAllRecords("task", name);
  }

  /** Looks up a Pipeline's declared symbols by its metadata.name (i.e. what a pipelineRef points at). */
  lookupPipeline(name: string): TektonSymbols | undefined {
    return this.lookupPipelineRecord(name)?.parsed.symbols;
  }

  /** Like {@link lookupPipeline}, but also returns the URI and full parse needed to build a cross-file Location. */
  lookupPipelineRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord("pipeline", name);
  }

  /** All Pipeline files declaring `name` — see {@link lookupAllTaskRecords}, same reasoning, for Pipelines. */
  lookupAllPipelineRecords(name: string): IndexedResource[] {
    return this.lookupAllRecords("pipeline", name);
  }

  /** Looks up a TriggerTemplate by its metadata.name (i.e. what a `template.ref` points at). */
  lookupTriggerTemplateRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord("triggerTemplate", name);
  }

  /** All TriggerTemplate files declaring `name` — see {@link lookupAllTaskRecords}, same reasoning. */
  lookupAllTriggerTemplateRecords(name: string): IndexedResource[] {
    return this.lookupAllRecords("triggerTemplate", name);
  }

  /** Looks up a TriggerBinding/ClusterTriggerBinding by its metadata.name (i.e. what a `bindings[].ref` points at) — both kinds share one name index, since a binding ref resolves against either by the same bare name. */
  lookupTriggerBindingRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord("triggerBinding", name);
  }

  /** All TriggerBinding/ClusterTriggerBinding files declaring `name` — see {@link lookupAllTaskRecords}, same reasoning. */
  lookupAllTriggerBindingRecords(name: string): IndexedResource[] {
    return this.lookupAllRecords("triggerBinding", name);
  }

  /** Looks up a standalone Trigger by its metadata.name (i.e. what an EventListener's `triggerRef` points at). */
  lookupTriggerRecord(name: string): IndexedResource | undefined {
    return this.lookupRecord("trigger", name);
  }

  /** All Trigger files declaring `name` — see {@link lookupAllTaskRecords}, same reasoning. */
  lookupAllTriggerRecords(name: string): IndexedResource[] {
    return this.lookupAllRecords("trigger", name);
  }

  /** Every known Task/ClusterTask/StepAction name, for taskRef.name completion. */
  allTaskNames(): string[] {
    return this.allNames("task");
  }

  /** Every known Pipeline name, for pipelineRef.name completion. */
  allPipelineNames(): string[] {
    return this.allNames("pipeline");
  }

  /** Every known TriggerTemplate/TriggerBinding-family/Trigger name, for "did you mean" suggestions on an unresolved ref. */
  allTriggerTemplateNames(): string[] {
    return this.allNames("triggerTemplate");
  }
  allTriggerBindingNames(): string[] {
    return this.allNames("triggerBinding");
  }
  allTriggerNames(): string[] {
    return this.allNames("trigger");
  }

  dispose(): void {
    for (const timer of this.reindexTimers.values()) clearTimeout(timer);
    this.reindexTimers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
