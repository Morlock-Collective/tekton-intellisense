import { Document, LineCounter, parseDocument, visit, YAMLMap, YAMLSeq, isMap, isSeq, isScalar } from "yaml";
import { maskHelmTemplates } from "./helmMask";

export type TektonKind =
  | "Pipeline"
  | "Task"
  | "ClusterTask"
  | "PipelineRun"
  | "TaskRun"
  | "StepAction"
  | "Unknown";

export interface NamedSymbol {
  name: string;
  /** offset range of the `name` scalar itself, for "go to definition"-ish uses */
  range?: [number, number];
}

export interface TaskSymbol extends NamedSymbol {
  /** the taskRef.name this pipeline task entry points at, if any (may differ from the entry's local `name`) */
  taskRefName?: string;
}

export interface TektonSymbols {
  kind: TektonKind;
  apiVersion: string | undefined;
  /** metadata.name of the resource itself — e.g. what a Task is called for taskRef purposes */
  metadataName: string | undefined;
  params: NamedSymbol[];
  workspaces: NamedSymbol[];
  results: NamedSymbol[];
  /** pipeline.spec.tasks / spec.finally entries */
  tasks: TaskSymbol[];
}

export const TASK_LIKE_KINDS: ReadonlySet<TektonKind> = new Set(["Task", "ClusterTask", "StepAction"]);

export interface ParsedTektonDoc {
  doc: Document.Parsed;
  lineCounter: LineCounter;
  text: string;
  symbols: TektonSymbols;
  isHelmTemplated: boolean;
}

const TEKTON_API_PREFIX = "tekton.dev/";

function isTektonApiVersion(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(TEKTON_API_PREFIX);
}

function seqOf(node: unknown): YAMLSeq | undefined {
  return isSeq(node) ? node : undefined;
}

function mapOf(node: unknown): YAMLMap | undefined {
  return isMap(node) ? node : undefined;
}

/** Extracts {name: ...} entries from a YAML sequence of maps, keeping source ranges for the name scalar. */
function namedEntries(seq: YAMLSeq | undefined): NamedSymbol[] {
  if (!seq) return [];
  const out: NamedSymbol[] = [];
  for (const item of seq.items) {
    const m = mapOf(item);
    if (!m) continue;
    const nameNode = m.get("name", true);
    if (isScalar(nameNode) && typeof nameNode.value === "string") {
      out.push({
        name: nameNode.value,
        range: nameNode.range ? [nameNode.range[0], nameNode.range[1]] : undefined,
      });
    }
  }
  return out;
}

function taskEntries(seq: YAMLSeq | undefined): TaskSymbol[] {
  if (!seq) return [];
  const out: TaskSymbol[] = [];
  for (const item of seq.items) {
    const m = mapOf(item);
    if (!m) continue;
    const nameNode = m.get("name", true);
    if (!isScalar(nameNode) || typeof nameNode.value !== "string") continue;
    const taskRef = mapOf(m.get("taskRef", true));
    const taskRefNameNode = taskRef?.get("name", true);
    const taskRefName = isScalar(taskRefNameNode) && typeof taskRefNameNode.value === "string" ? taskRefNameNode.value : undefined;
    out.push({
      name: nameNode.value,
      range: nameNode.range ? [nameNode.range[0], nameNode.range[1]] : undefined,
      taskRefName,
    });
  }
  return out;
}

/**
 * Parses a Tekton YAML document (optionally Helm-templated) and extracts the
 * symbol table used for reference validation. Returns undefined if the text
 * doesn't look like a Tekton resource at all, so callers can skip
 * unnecessary work on unrelated YAML files.
 */
export function parseTektonDocument(source: string): ParsedTektonDoc | undefined {
  const { text } = maskHelmTemplates(source);
  const isHelmTemplated = text !== source;

  const lineCounter = new LineCounter();
  let doc: Document.Parsed;
  try {
    doc = parseDocument(text, { lineCounter, keepSourceTokens: false });
  } catch {
    return undefined;
  }

  const root = mapOf(doc.contents);
  if (!root) return undefined;

  const apiVersion = root.get("apiVersion", true);
  const apiVersionValue = isScalar(apiVersion) ? apiVersion.value : undefined;
  const kindNode = root.get("kind", true);
  const kindValue = isScalar(kindNode) ? kindNode.value : undefined;

  if (!isTektonApiVersion(apiVersionValue)) {
    return undefined;
  }

  const kind: TektonKind =
    kindValue === "Pipeline" ||
    kindValue === "Task" ||
    kindValue === "ClusterTask" ||
    kindValue === "PipelineRun" ||
    kindValue === "TaskRun" ||
    kindValue === "StepAction"
      ? kindValue
      : "Unknown";

  const metadata = mapOf(root.get("metadata", true));
  const metadataNameNode = metadata?.get("name", true);
  const metadataName =
    isScalar(metadataNameNode) && typeof metadataNameNode.value === "string" ? metadataNameNode.value : undefined;

  const spec = mapOf(root.get("spec", true));

  const params = namedEntries(seqOf(spec?.get("params", true)));
  const workspaces = namedEntries(seqOf(spec?.get("workspaces", true)));
  const results = namedEntries(seqOf(spec?.get("results", true)));

  const tasks = [
    ...taskEntries(seqOf(spec?.get("tasks", true))),
    ...taskEntries(seqOf(spec?.get("finally", true))),
  ];

  return {
    doc,
    lineCounter,
    text,
    isHelmTemplated,
    symbols: { kind, apiVersion: apiVersionValue, metadataName, params, workspaces, results, tasks },
  };
}

/**
 * Finds the innermost YAMLMap node whose source range contains `offset`.
 * Used by editing commands to figure out "what am I inside of right now"
 * (e.g. a step container, a task entry) so inserts land in the right place.
 */
export function findEnclosingMap(doc: Document.Parsed, offset: number): YAMLMap | undefined {
  let result: YAMLMap | undefined;
  visit(doc, {
    Map(_key, node) {
      const range = node.range;
      if (range && offset >= range[0] && offset <= range[2]) {
        result = node;
      }
    },
  });
  return result;
}

/** Finds the innermost YAMLSeq node whose source range contains `offset`. */
export function findEnclosingSeq(doc: Document.Parsed, offset: number): YAMLSeq | undefined {
  let result: YAMLSeq | undefined;
  visit(doc, {
    Seq(_key, node) {
      const range = node.range;
      if (range && offset >= range[0] && offset <= range[2]) {
        result = node;
      }
    },
  });
  return result;
}

/** Locates the `spec.<key>` sequence node (e.g. spec.tasks, spec.params), if present. */
export function findSpecSeq(doc: Document.Parsed, key: string): YAMLSeq | undefined {
  const root = isMap(doc.contents) ? doc.contents : undefined;
  const spec = root ? mapOf(root.get("spec", true)) : undefined;
  return spec ? seqOf(spec.get(key, true)) : undefined;
}

/** Locates the `spec` map node itself. */
export function findSpecMap(doc: Document.Parsed): YAMLMap | undefined {
  const root = isMap(doc.contents) ? doc.contents : undefined;
  return root ? mapOf(root.get("spec", true)) : undefined;
}
