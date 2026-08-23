/**
 * Commands for configuring/refreshing/authenticating to cluster-shared
 * Tekton resources (see `tekton/clusterIndex.ts`).
 */
import * as vscode from "vscode";
import { ClusterResourceIndex } from "../tekton/clusterIndex";
import { CLUSTER_RESOURCE_KINDS } from "../tekton/clusterResources";

const CONFIG_SECTION = "tektonIntellisense.clusterResources";

interface SourceEntry {
  namespace: string;
  kinds: string[];
}

function configTarget(): vscode.ConfigurationTarget {
  // A cluster resource source is almost always specific to the project/environment currently open
  // (a given repo's own shared-tasks namespace), not something to carry into every other workspace
  // -- Workspace scope whenever one's open, Global only as a fallback for a single loose file.
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function readSources(): SourceEntry[] {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<SourceEntry[]>("sources", []) ?? [];
}

async function writeSources(sources: SourceEntry[]): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update("sources", sources, configTarget());
}

export async function refreshClusterResourcesCommand(clusterIndex: ClusterResourceIndex): Promise<void> {
  await clusterIndex.refresh(true);
}

/** Runs the configured `authCommand` in a dedicated terminal rather than headlessly -- cluster login is commonly interactive (an SSO browser flow, a password prompt), so the user needs to actually see and respond to it. */
export function authenticateClusterCommand(): void {
  const authCommand = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("authCommand", "").trim();
  if (!authCommand) {
    void vscode.window.showWarningMessage(
      `Tekton Intellisense: no auth command configured (${CONFIG_SECTION}.authCommand) — set one first, e.g. "oc login https://api.cluster.example.com:6443".`
    );
    return;
  }
  const terminal =
    vscode.window.terminals.find((t) => t.name === "Tekton Cluster Auth") ?? vscode.window.createTerminal("Tekton Cluster Auth");
  terminal.show();
  terminal.sendText(authCommand);
}

const ADD_NAMESPACE = "$(add) Add a namespace…";

/**
 * Guided editor for `tektonIntellisense.clusterResources.sources` — the
 * namespace × kind "matrix/table with checkboxes" the setting represents,
 * driven through a sequence of QuickPicks rather than VS Code's native
 * settings UI (which has no real matrix widget): pick or add a namespace,
 * then check off which kinds to fetch from it via a `canPickMany`
 * QuickPick — VS Code's actual checkbox-list control.
 */
export async function configureClusterResourcesCommand(): Promise<void> {
  const sources = readSources();

  const namespacePick = await vscode.window.showQuickPick(
    [
      ADD_NAMESPACE,
      ...sources.map((s) => `${s.namespace}  (${s.kinds.length ? s.kinds.join(", ") : "no kinds selected"})`),
    ],
    { placeHolder: "Which namespace's cluster resource sources do you want to configure?" }
  );
  if (!namespacePick) return;

  let namespace: string;
  let existingIndex: number;
  if (namespacePick === ADD_NAMESPACE) {
    const input = await vscode.window.showInputBox({
      prompt: "Kubernetes namespace to fetch shared Tekton resources from",
      validateInput: (v) => (v.trim() ? undefined : "namespace can't be empty"),
    });
    if (!input) return;
    namespace = input.trim();
    existingIndex = sources.findIndex((s) => s.namespace === namespace);
  } else {
    existingIndex = sources.findIndex((s) => namespacePick.startsWith(`${s.namespace}  (`));
    namespace = sources[existingIndex].namespace;
  }

  const currentKinds = new Set(existingIndex >= 0 ? sources[existingIndex].kinds : []);
  const kindPicks = await vscode.window.showQuickPick(
    CLUSTER_RESOURCE_KINDS.map((kind) => ({ label: kind, picked: currentKinds.has(kind) })),
    { canPickMany: true, placeHolder: `Which kinds should be fetched from namespace "${namespace}"?` }
  );
  if (!kindPicks) return; // cancelled -- leave existing config untouched

  const kinds = kindPicks.map((p) => p.label);
  const next = [...sources];
  if (kinds.length === 0) {
    if (existingIndex >= 0) next.splice(existingIndex, 1);
  } else if (existingIndex >= 0) {
    next[existingIndex] = { namespace, kinds };
  } else {
    next.push({ namespace, kinds });
  }

  await writeSources(next);
  void vscode.window.showInformationMessage(
    kinds.length === 0
      ? `Tekton Intellisense: removed namespace "${namespace}" from cluster resource sources.`
      : `Tekton Intellisense: namespace "${namespace}" now fetches ${kinds.join(", ")} — refreshing now.`
  );
}
