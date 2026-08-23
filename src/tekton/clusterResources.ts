/**
 * Fetches Tekton resources that live on a cluster rather than in the
 * workspace -- the common "shared catalog of Tasks in another namespace"
 * pattern on Kubernetes/OpenShift. Shells out to `kubectl`/`oc` (whichever
 * the user configured) via `execFile`, never a shell (`exec`), so nothing
 * here is exposed to shell-injection risk regardless of what a namespace
 * name or command path contains. Authentication is entirely the user's
 * own kubeconfig/session — this module never touches credentials itself.
 *
 * Deliberately has no `vscode` dependency (state/caching/scheduling lives
 * in `clusterIndex.ts`), so the fetch-and-parse logic here is testable
 * directly with an injected fake `runner`, the same convention as every
 * other pure module in this project.
 */
import { execFile } from "child_process";
import { stringify as yamlStringify } from "yaml";
import { TektonKind } from "./model";

export const CLUSTER_RESOURCE_KINDS = [
  "Task",
  "ClusterTask",
  "Pipeline",
  "StepAction",
  "TriggerTemplate",
  "TriggerBinding",
  "ClusterTriggerBinding",
] as const;

export type ClusterResourceKind = (typeof CLUSTER_RESOURCE_KINDS)[number];

export function isClusterResourceKind(value: unknown): value is ClusterResourceKind {
  return typeof value === "string" && (CLUSTER_RESOURCE_KINDS as readonly string[]).includes(value);
}

interface ResourceInfo {
  /** the CRD's plural.group form, e.g. "tasks.tekton.dev" -- fully qualified so this can't collide with some unrelated CRD that happens to share a short plural name */
  qualifiedPlural: string;
  /** ClusterTask/ClusterTriggerBinding aren't namespaced -- fetched once, cluster-wide, regardless of which (or how many) source namespaces asked for them */
  clusterScoped: boolean;
}

const RESOURCE_INFO: Record<ClusterResourceKind, ResourceInfo> = {
  Task: { qualifiedPlural: "tasks.tekton.dev", clusterScoped: false },
  ClusterTask: { qualifiedPlural: "clustertasks.tekton.dev", clusterScoped: true },
  Pipeline: { qualifiedPlural: "pipelines.tekton.dev", clusterScoped: false },
  StepAction: { qualifiedPlural: "stepactions.tekton.dev", clusterScoped: false },
  TriggerTemplate: { qualifiedPlural: "triggertemplates.triggers.tekton.dev", clusterScoped: false },
  TriggerBinding: { qualifiedPlural: "triggerbindings.triggers.tekton.dev", clusterScoped: false },
  ClusterTriggerBinding: { qualifiedPlural: "clustertriggerbindings.triggers.tekton.dev", clusterScoped: true },
};

export interface ClusterSource {
  namespace: string;
  kinds: ClusterResourceKind[];
}

export interface ClusterResourceConfig {
  /** `kubectl`, `oc`, or a full path to either -- never shell-interpreted, just the argv[0] passed to `execFile`. */
  command: string;
  sources: ClusterSource[];
}

export interface FetchedResource {
  kind: TektonKind;
  /** undefined for a cluster-scoped kind (ClusterTask/ClusterTriggerBinding) */
  namespace: string | undefined;
  name: string;
  /** the resource re-serialized as YAML, for feeding through the normal `parseTektonDocument` pipeline -- see `clusterIndex.ts` */
  yamlText: string;
}

export interface ClusterFetchError {
  namespace: string;
  kind: ClusterResourceKind;
  message: string;
}

export interface ClusterFetchResult {
  resources: FetchedResource[];
  errors: ClusterFetchError[];
  /**
   * Set instead of attempting any per-source fetch at all, when the
   * configured command couldn't even be spawned (see
   * {@link commandUnavailableMessage}) — one clear, actionable message
   * instead of the same "ENOENT" repeated once per (namespace, kind) pair,
   * which is what happened before this existed: `execFile` never goes
   * through a shell, so a `kubectl` that's really only a shell alias or
   * function (works fine typed at a prompt) fails to spawn at all, and the
   * raw ENOENT gave no hint why.
   */
  commandError?: string;
}

/** `(command, args, timeoutMs) -> stdout`, swappable for tests. The real one below never involves a shell. */
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout);
        return;
      }
      const wrapped = new Error((stderr || "").trim() || err.message) as NodeJS.ErrnoException;
      // execFile's own error.code is string | number | undefined (an exit code is a number; a
      // spawn failure like ENOENT is a string) -- only the string form is ever a spawn-failure code.
      if (typeof err.code === "string") wrapped.code = err.code;
      reject(wrapped);
    });
  });

/**
 * Runs `<command> version --client` purely to check whether `command` can
 * be spawned at all, before attempting any real (namespace, kind) fetch —
 * returns a message when it can't, undefined when it can (or when it ran
 * but failed for some *other* reason, e.g. an ancient client that doesn't
 * recognize `--client`; that's not this check's business, the real
 * per-source fetches will surface their own more specific errors).
 */
async function commandUnavailableMessage(runner: CommandRunner, command: string, timeoutMs: number): Promise<string | undefined> {
  try {
    await runner(command, ["version", "--client"], timeoutMs);
    return undefined;
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") return undefined;
    return (
      `"${command}" isn't a runnable command (not found on PATH). ` +
      `If it works when you type it in a terminal, it's likely a shell alias or function — ` +
      `those only exist inside an interactive shell, not for a program spawning it directly. ` +
      `Set tektonIntellisense.clusterResources.command to the real executable's path instead ` +
      `(try "which ${command}" or "type ${command}" in your terminal to find it).`
    );
  }
}

/** Server-managed bookkeeping fields that are noise in a read-only "what does this look like" preview -- the user never wrote them and can't edit them anyway. */
const NOISY_TOP_LEVEL_FIELDS = ["status"];
const NOISY_METADATA_FIELDS = ["managedFields", "resourceVersion", "uid", "generation", "creationTimestamp"];

function stripServerFields(resource: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...resource };
  for (const field of NOISY_TOP_LEVEL_FIELDS) delete rest[field];

  const metadata = rest.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    const restMeta = { ...metadata };
    for (const field of NOISY_METADATA_FIELDS) delete restMeta[field];
    rest.metadata = restMeta;
  }
  return rest;
}

async function fetchOne(
  runner: CommandRunner,
  command: string,
  namespace: string,
  kind: ClusterResourceKind,
  timeoutMs: number
): Promise<FetchedResource[]> {
  const info = RESOURCE_INFO[kind];
  const args = ["get", info.qualifiedPlural, "-o", "json"];
  if (!info.clusterScoped) args.push("-n", namespace);

  const stdout = await runner(command, args, timeoutMs);
  const parsed: unknown = JSON.parse(stdout);
  const items: unknown[] = Array.isArray((parsed as { items?: unknown[] })?.items)
    ? (parsed as { items: unknown[] }).items
    : [parsed];

  const out: FetchedResource[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const metadata = record.metadata as Record<string, unknown> | undefined;
    const name = typeof metadata?.name === "string" ? metadata.name : undefined;
    if (!name) continue;
    out.push({
      kind,
      namespace: info.clusterScoped ? undefined : ((metadata?.namespace as string | undefined) ?? namespace),
      name,
      yamlText: yamlStringify(stripServerFields(record)),
    });
  }
  return out;
}

/**
 * Fetches every (namespace, kind) pair `config.sources` names, deduping a
 * cluster-scoped kind across sources that all asked for it. One source
 * failing (bad namespace, no RBAC, cluster unreachable) doesn't block the
 * rest -- each is fetched independently and its own failure collected in
 * `errors` rather than rejecting the whole call.
 */
export async function fetchClusterResources(
  config: ClusterResourceConfig,
  opts: { timeoutMs?: number; runner?: CommandRunner } = {}
): Promise<ClusterFetchResult> {
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? 15000;

  const commandError = await commandUnavailableMessage(runner, config.command, timeoutMs);
  if (commandError) return { resources: [], errors: [], commandError };

  const resources: FetchedResource[] = [];
  const errors: ClusterFetchError[] = [];
  const seen = new Set<string>();
  const fetches: Promise<void>[] = [];

  for (const source of config.sources) {
    for (const kind of source.kinds) {
      const dedupeKey = RESOURCE_INFO[kind].clusterScoped ? `cluster:${kind}` : `${source.namespace}:${kind}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      fetches.push(
        fetchOne(runner, config.command, source.namespace, kind, timeoutMs)
          .then((found) => {
            resources.push(...found);
          })
          .catch((err: unknown) => {
            errors.push({ namespace: source.namespace, kind, message: err instanceof Error ? err.message : String(err) });
          })
      );
    }
  }

  await Promise.all(fetches);
  return { resources, errors };
}
