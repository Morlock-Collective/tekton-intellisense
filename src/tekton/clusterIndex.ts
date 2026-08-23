/**
 * Cache of cluster-fetched Tekton resources (see `clusterResources.ts` for
 * the actual `kubectl`/`oc` fetching), exposing the same lookup shape
 * `workspaceIndex.ts` uses so `TektonWorkspaceIndex` can fall back to it
 * without any of its callers (diagnostics, completion, hover, Go to
 * Definition) needing to know cluster resources exist at all.
 *
 * A fetched resource has no real workspace file, but Go to Definition
 * still needs somewhere to jump to -- each gets a synthetic, read-only
 * `tekton-cluster:` document (via `ClusterResourceContentProvider`) built
 * by re-serializing the fetched resource as YAML and running it through
 * the exact same `parseTektonDocument` every real file goes through, so
 * its `IndexedResource` is indistinguishable in shape from a workspace
 * one -- only `uri.scheme` marks it as external (see `rename.ts`'s guard
 * against editing one).
 */
import * as vscode from "vscode";
import { parseTektonDocument, TektonKind, IndexGroup, groupFor } from "./model";
import { IndexedResource } from "./workspaceIndex";
import {
  fetchClusterResources,
  isClusterResourceKind,
  ClusterResourceConfig,
  ClusterSource,
  FetchedResource,
} from "./clusterResources";

export const CLUSTER_URI_SCHEME = "tekton-cluster";

function clusterResourceUri(kind: TektonKind, namespace: string | undefined, name: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CLUSTER_URI_SCHEME, path: `/${namespace ?? "_cluster"}/${kind}/${name}.yaml` });
}

/** True when `uri` identifies a cluster-fetched, read-only resource rather than a real workspace file -- what `rename.ts` checks to refuse editing one. */
export function isClusterResourceUri(uri: vscode.Uri): boolean {
  return uri.scheme === CLUSTER_URI_SCHEME;
}

/** Serves each cached resource's YAML back to VS Code when something (Go to Definition, hover's "peek") opens its synthetic URI. */
export class ClusterResourceContentProvider implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    this.texts.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  clear(): void {
    for (const key of this.texts.keys()) this.emitter.fire(vscode.Uri.parse(key));
    this.texts.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return (
      this.texts.get(uri.toString()) ??
      "# Tekton Intellisense: this cluster resource is no longer cached -- run \"Tekton: Refresh Cluster Resources\".\n"
    );
  }
}

function readConfig(): ClusterResourceConfig & { refreshIntervalHours: number; authCommand: string } {
  const cfg = vscode.workspace.getConfiguration("tektonIntellisense.clusterResources");
  const rawSources = cfg.get<{ namespace?: string; kinds?: string[] }[]>("sources", []) ?? [];
  const sources: ClusterSource[] = rawSources
    .map((s) => ({ namespace: (s.namespace ?? "").trim(), kinds: (s.kinds ?? []).filter(isClusterResourceKind) }))
    .filter((s) => s.namespace.length > 0 && s.kinds.length > 0);

  return {
    command: (cfg.get<string>("command", "kubectl") || "kubectl").trim(),
    sources,
    refreshIntervalHours: cfg.get<number>("refreshIntervalHours", 24),
    authCommand: cfg.get<string>("authCommand", ""),
  };
}

/**
 * Workspace-shaped index of cluster-fetched resources -- same `IndexGroup`
 * lookup surface as `TektonWorkspaceIndex`, rebuilt wholesale on every
 * refresh (no incremental diffing; a full re-fetch is cheap enough and far
 * simpler than trying to patch a stale cache in place). Nothing here
 * persists across a VS Code window restart: a fresh window does one fetch
 * at startup, then honors `refreshIntervalHours`/manual refresh for as
 * long as it stays open -- see the ROADMAP entry for why that's a
 * deliberate simplification, not an oversight.
 */
export class ClusterResourceIndex implements vscode.Disposable {
  private readonly groups: Record<IndexGroup, Map<string, IndexedResource[]>> = {
    task: new Map(),
    pipeline: new Map(),
    triggerTemplate: new Map(),
    triggerBinding: new Map(),
    trigger: new Map(),
  };
  private readonly contentProvider = new ClusterResourceContentProvider();
  private readonly outputChannel = vscode.window.createOutputChannel("Tekton Intellisense: Cluster Resources");
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  private lastFetchedAt: number | undefined;
  private lastErrorCount = 0;

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(CLUSTER_URI_SCHEME, this.contentProvider),
      this.outputChannel,
      this.changeEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("tektonIntellisense.clusterResources")) {
          this.rescheduleTimer();
          void this.refresh(false);
        }
      })
    );
    this.rescheduleTimer();
    void this.refresh(false);
  }

  private rescheduleTimer(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    const hours = readConfig().refreshIntervalHours;
    if (hours > 0) {
      this.refreshTimer = setInterval(() => void this.refresh(false), hours * 60 * 60 * 1000);
    }
  }

  /** Fetches and rebuilds the whole index. Concurrent calls (e.g. a config change landing mid-fetch) coalesce onto the same in-flight fetch rather than racing. `manual` only changes how the outcome is reported -- an explicit command gets a message either way, a background refresh only logs (see the output channel) so it never surfaces as an unprompted popup. */
  async refresh(manual: boolean): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(manual);
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async doRefresh(manual: boolean): Promise<void> {
    const config = readConfig();
    if (config.sources.length === 0) {
      this.rebuild([]);
      this.lastFetchedAt = Date.now();
      if (manual) void vscode.window.showInformationMessage("Tekton Intellisense: no cluster resource sources configured.");
      return;
    }

    const { resources, errors } = await fetchClusterResources(config);
    this.rebuild(resources);
    this.lastFetchedAt = Date.now();
    this.lastErrorCount = errors.length;

    for (const err of errors) {
      this.outputChannel.appendLine(`[${new Date().toISOString()}] ${err.kind} in "${err.namespace}": ${err.message}`);
    }

    if (manual) {
      if (errors.length === 0) {
        void vscode.window.showInformationMessage(`Tekton Intellisense: refreshed cluster resources — ${resources.length} found.`);
      } else {
        void vscode.window
          .showWarningMessage(
            `Tekton Intellisense: refreshed cluster resources with ${errors.length} error(s) — ${resources.length} found anyway.`,
            "Show Output"
          )
          .then((choice) => {
            if (choice === "Show Output") this.outputChannel.show();
          });
      }
    }

    this.changeEmitter.fire();
  }

  private rebuild(resources: FetchedResource[]): void {
    for (const group of Object.values(this.groups)) group.clear();
    this.contentProvider.clear();

    for (const resource of resources) {
      const group = groupFor(resource.kind);
      if (!group) continue;
      const parsed = parseTektonDocument(resource.yamlText);
      if (!parsed) continue;

      const uri = clusterResourceUri(resource.kind, resource.namespace, resource.name);
      this.contentProvider.set(uri, resource.yamlText);

      const record: IndexedResource = { uri, parsed };
      const existing = this.groups[group].get(resource.name);
      if (existing) existing.push(record);
      else this.groups[group].set(resource.name, [record]);
    }
  }

  lookupRecord(group: IndexGroup, name: string): IndexedResource | undefined {
    return this.groups[group].get(name)?.[0];
  }

  lookupAllRecords(group: IndexGroup, name: string): IndexedResource[] {
    return this.groups[group].get(name) ?? [];
  }

  allNames(group: IndexGroup): string[] {
    return [...this.groups[group].keys()];
  }

  /** For a status/troubleshooting surface -- when the cache last actually refreshed (successfully or not) and whether that refresh had errors. Undefined `lastFetchedAt` means no fetch has completed yet (still in flight, or sources aren't configured). */
  get status(): { lastFetchedAt: number | undefined; lastErrorCount: number } {
    return { lastFetchedAt: this.lastFetchedAt, lastErrorCount: this.lastErrorCount };
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}
