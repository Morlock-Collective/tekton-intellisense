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
  /** offset range of the taskRef.name scalar itself, for rename edits */
  taskRefNameRange?: [number, number];
}

export interface ParamSymbol extends NamedSymbol {
  type?: string;
  description?: string;
  /** stringified default value (arrays/objects are JSON-rendered) */
  default?: string;
}

export interface WorkspaceSymbol extends NamedSymbol {
  description?: string;
  optional?: boolean;
}

export interface ResultSymbol extends NamedSymbol {
  type?: string;
  description?: string;
}

export interface TektonSymbols {
  kind: TektonKind;
  apiVersion: string | undefined;
  /** metadata.name of the resource itself — e.g. what a Task is called for taskRef purposes */
  metadataName: string | undefined;
  /** offset range of the metadata.name scalar itself, for rename edits */
  metadataNameRange?: [number, number];
  /** PipelineRun.spec.pipelineRef.name — the Pipeline this run points at */
  pipelineRefName?: string;
  /** offset range of that pipelineRef.name scalar, for rename edits */
  pipelineRefNameRange?: [number, number];
  /** TaskRun.spec.taskRef.name — the Task this run points at (distinct from TaskSymbol.taskRefName, which is per pipeline-task-entry) */
  taskRefName?: string;
  /** offset range of that taskRef.name scalar, for rename edits */
  taskRefNameRange?: [number, number];
  params: ParamSymbol[];
  workspaces: WorkspaceSymbol[];
  results: ResultSymbol[];
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

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

function scalarRange(node: unknown): [number, number] | undefined {
  return isScalar(node) && node.range ? [node.range[0], node.range[1]] : undefined;
}

/** Reads a `<key>: { name: ... }` ref field (taskRef, pipelineRef) directly under `map`. */
function refNameAndRange(map: YAMLMap | undefined, key: string): { name?: string; range?: [number, number] } {
  const ref = mapOf(map?.get(key, true));
  const nameNode = ref?.get("name", true);
  return { name: scalarString(nameNode), range: scalarRange(nameNode) };
}

function scalarBoolean(node: unknown): boolean | undefined {
  return isScalar(node) && typeof node.value === "boolean" ? node.value : undefined;
}

/** Renders a default value node (scalar, sequence, or mapping) as display text. */
function displayValue(node: unknown): string | undefined {
  if (node === undefined) return undefined;
  if (isScalar(node)) return node.value == null ? undefined : String(node.value);
  if (isSeq(node) || isMap(node)) {
    try {
      return JSON.stringify(node.toJSON());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Iterates {name: ...} entries in a YAML sequence of maps, keeping source ranges for the name scalar. */
function forEachNamedItem(seq: YAMLSeq | undefined, cb: (m: YAMLMap, name: string, range?: [number, number]) => void): void {
  if (!seq) return;
  for (const item of seq.items) {
    const m = mapOf(item);
    if (!m) continue;
    const nameNode = m.get("name", true);
    if (!isScalar(nameNode) || typeof nameNode.value !== "string") continue;
    cb(m, nameNode.value, nameNode.range ? [nameNode.range[0], nameNode.range[1]] : undefined);
  }
}

function paramEntries(seq: YAMLSeq | undefined): ParamSymbol[] {
  const out: ParamSymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    out.push({
      name,
      range,
      type: scalarString(m.get("type", true)),
      description: scalarString(m.get("description", true)),
      default: displayValue(m.get("default", true)),
    });
  });
  return out;
}

function workspaceEntries(seq: YAMLSeq | undefined): WorkspaceSymbol[] {
  const out: WorkspaceSymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    out.push({
      name,
      range,
      description: scalarString(m.get("description", true)),
      optional: scalarBoolean(m.get("optional", true)),
    });
  });
  return out;
}

function resultEntries(seq: YAMLSeq | undefined): ResultSymbol[] {
  const out: ResultSymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    out.push({
      name,
      range,
      type: scalarString(m.get("type", true)),
      description: scalarString(m.get("description", true)),
    });
  });
  return out;
}

function taskEntries(seq: YAMLSeq | undefined): TaskSymbol[] {
  const out: TaskSymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    const taskRef = refNameAndRange(m, "taskRef");
    out.push({ name, range, taskRefName: taskRef.name, taskRefNameRange: taskRef.range });
  });
  return out;
}

/**
 * Parses a Tekton YAML document (optionally Helm-templated) and extracts the
 * symbol table used for reference validation. Returns undefined if the text
 * doesn't look like a Tekton resource at all, so callers can skip
 * unnecessary work on unrelated YAML files.
 */
export function parseTektonDocument(source: string): ParsedTektonDoc | undefined {
  const { text, masked: isHelmTemplated } = maskHelmTemplates(source);

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
  const metadataName = scalarString(metadataNameNode);
  const metadataNameRange = scalarRange(metadataNameNode);

  const spec = mapOf(root.get("spec", true));

  const pipelineRef = kind === "PipelineRun" ? refNameAndRange(spec, "pipelineRef") : undefined;
  const ownTaskRef = kind === "TaskRun" ? refNameAndRange(spec, "taskRef") : undefined;

  const params = paramEntries(seqOf(spec?.get("params", true)));
  const workspaces = workspaceEntries(seqOf(spec?.get("workspaces", true)));
  const results = resultEntries(seqOf(spec?.get("results", true)));

  const tasks = [
    ...taskEntries(seqOf(spec?.get("tasks", true))),
    ...taskEntries(seqOf(spec?.get("finally", true))),
  ];

  return {
    doc,
    lineCounter,
    text,
    isHelmTemplated,
    symbols: {
      kind,
      apiVersion: apiVersionValue,
      metadataName,
      metadataNameRange,
      pipelineRefName: pipelineRef?.name,
      pipelineRefNameRange: pipelineRef?.range,
      taskRefName: ownTaskRef?.name,
      taskRefNameRange: ownTaskRef?.range,
      params,
      workspaces,
      results,
      tasks,
    },
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

/** Looks up a sequence directly under an arbitrary map (not necessarily spec) — e.g. an inline pipelineSpec/taskSpec's own `params`. */
export function findSeqIn(map: YAMLMap, key: string): YAMLSeq | undefined {
  return seqOf(map.get(key, true));
}

/** Indentation of the line containing `offset`, assuming `offset` marks the first non-whitespace column of that line (true for YAML key/scalar node ranges). */
function indentAtOffset(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(lineStart, offset);
}

/**
 * A YAML node's range sometimes extends past its own trailing newline (e.g.
 * the last item in a block sequence) and sometimes doesn't, depending on
 * what follows in the document. Appending new content right at such an
 * offset is therefore unreliable — it can either swallow the separator
 * newline (gluing the new content onto the next line) or duplicate it
 * (leaving a blank line). Trimming the trailing newline off first makes
 * "insert right after this node" land consistently right after its last
 * real character, letting whatever newline already follows in the source
 * do its job unmolested.
 *
 * Trims at most one line ending (a lone `\n`, or a `\r\n` pair treated as a
 * unit) — not a whole run of them. A node's range can only ever have
 * swallowed the *one* newline that terminates its own last line; anything
 * beyond that is a blank line the user put there on purpose, and should be
 * left alone rather than silently eaten.
 */
export function trimTrailingNewline(text: string, offset: number): number {
  if (offset > 0 && text[offset - 1] === "\n") {
    offset--;
    if (offset > 0 && text[offset - 1] === "\r") offset--;
  }
  return offset;
}

/** Indentation of a map's first key — a reliable stand-in for "how this map's children are indented" when adding a new sibling key. */
function firstChildKeyIndent(text: string, map: YAMLMap): string | undefined {
  const key = map.items[0]?.key;
  return isScalar(key) && key.range ? indentAtOffset(text, key.range[0]) : undefined;
}

/** Indentation of a specific named key within a map, if present. */
function namedKeyIndent(text: string, map: YAMLMap, name: string): string | undefined {
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === name && pair.key.range) {
      return indentAtOffset(text, pair.key.range[0]);
    }
  }
  return undefined;
}

export interface SpecListOwner {
  /** the map that should directly contain the list key (e.g. `tasks:`, `params:`) */
  ownerMap: YAMLMap;
  /** offset marking the end of ownerMap's content — where a brand-new key should be appended */
  ownerMapEnd: number;
  /** indentation the list key itself should sit at within ownerMap */
  keyIndent: string;
}

/**
 * Figures out which map directly owns a spec-level list, independent of
 * cursor position: either `spec` itself, for document kinds in `ownKinds`,
 * or an inline nested spec (`pipelineSpec`/`taskSpec`) for a Run kind that
 * embeds one — since an inline spec is a full definition in every way that
 * matters here. Returns undefined when neither applies (e.g. a
 * PipelineRun using `pipelineRef` rather than an inline `pipelineSpec`).
 */
function resolveSpecOwner(
  parsed: ParsedTektonDoc,
  ownKinds: ReadonlySet<TektonKind>,
  inlineKeyFor: (kind: TektonKind) => string | undefined
): SpecListOwner | undefined {
  const { doc, text, symbols } = parsed;
  const spec = findSpecMap(doc);
  if (!spec?.range) return undefined;

  const root = isMap(doc.contents) ? doc.contents : undefined;
  const specKeyIndent = (root && namedKeyIndent(text, root, "spec")) ?? "";

  if (ownKinds.has(symbols.kind)) {
    const keyIndent = firstChildKeyIndent(text, spec) ?? specKeyIndent + "  ";
    return { ownerMap: spec, ownerMapEnd: spec.range[1], keyIndent };
  }

  const inlineKey = inlineKeyFor(symbols.kind);
  if (inlineKey) {
    const inline = mapOf(spec.get(inlineKey, true));
    if (inline?.range) {
      const inlineKeyIndent = namedKeyIndent(text, spec, inlineKey) ?? specKeyIndent + "  ";
      const keyIndent = firstChildKeyIndent(text, inline) ?? inlineKeyIndent + "  ";
      return { ownerMap: inline, ownerMapEnd: inline.range[1], keyIndent };
    }
  }

  return undefined;
}

const PARAM_DECLARING_KINDS: ReadonlySet<TektonKind> = new Set(["Pipeline", "Task", "ClusterTask", "StepAction"]);
const RUN_INLINE_SPEC_KEY = (kind: TektonKind): string | undefined =>
  kind === "PipelineRun" ? "pipelineSpec" : kind === "TaskRun" ? "taskSpec" : undefined;

export interface ParamsTarget extends SpecListOwner {
  /** Pipeline/Task/etc declare params (name+type+description+default); PipelineRun/TaskRun *provide* them (name+value) unless they embed an inline spec */
  shape: "declaration" | "binding";
}

/**
 * Figures out where a new parameter belongs, independent of cursor
 * position: Pipelines/Tasks declare params directly under spec; a
 * PipelineRun/TaskRun either provides param *values* under spec (when using
 * a `..Ref`) or declares params like a Pipeline/Task does, when it embeds
 * one inline via `pipelineSpec`/`taskSpec`.
 */
export function resolveParamsTarget(parsed: ParsedTektonDoc): ParamsTarget | undefined {
  const declared = resolveSpecOwner(parsed, PARAM_DECLARING_KINDS, RUN_INLINE_SPEC_KEY);
  if (declared) return { ...declared, shape: "declaration" };

  // PipelineRun/TaskRun using ..Ref (no inline spec) — params are *provided* directly under spec.
  const bound = resolveSpecOwner(parsed, new Set(["PipelineRun", "TaskRun"]), () => undefined);
  return bound ? { ...bound, shape: "binding" } : undefined;
}

/**
 * Figures out where Pipeline-level lists (`tasks`, `finally`) belong: a
 * Pipeline's own spec, or a PipelineRun's inline `pipelineSpec`. Returns
 * undefined for anything else (a PipelineRun using `pipelineRef` has no
 * tasks list of its own to add to; neither does a Task-shaped document).
 */
export function resolvePipelineSpecOwner(parsed: ParsedTektonDoc): SpecListOwner | undefined {
  return resolveSpecOwner(parsed, new Set(["Pipeline"]), (kind) => (kind === "PipelineRun" ? "pipelineSpec" : undefined));
}

/**
 * Figures out where Task-level lists (`steps`, `sidecars`) belong: a
 * Task/ClusterTask/StepAction's own spec, or a TaskRun's inline `taskSpec`.
 */
export function resolveTaskSpecOwner(parsed: ParsedTektonDoc): SpecListOwner | undefined {
  return resolveSpecOwner(parsed, TASK_LIKE_KINDS, (kind) => (kind === "TaskRun" ? "taskSpec" : undefined));
}

/**
 * Every `spec.tasks[]`/`spec.finally[]` entry as its raw YAMLMap node
 * (Pipeline or PipelineRun-inline-pipelineSpec aware, via
 * {@link resolvePipelineSpecOwner}). Unlike {@link findEnclosingMap}, which
 * finds whatever map is innermost at an offset, this only ever returns
 * actual task-list entries — a params-list item (`- name: x`) inside a
 * task also has a `name` key and would otherwise be mistaken for one.
 */
export function pipelineTaskEntryMaps(parsed: ParsedTektonDoc): YAMLMap[] {
  const owner = resolvePipelineSpecOwner(parsed);
  if (!owner) return [];
  const maps: YAMLMap[] = [];
  for (const key of ["tasks", "finally"]) {
    const seq = findSeqIn(owner.ownerMap, key);
    if (!seq) continue;
    for (const item of seq.items) {
      if (isMap(item)) maps.push(item);
    }
  }
  return maps;
}

/** The `spec.tasks[]`/`spec.finally[]` entry enclosing `offset`, if any. */
export function findEnclosingTaskEntry(parsed: ParsedTektonDoc, offset: number): YAMLMap | undefined {
  return pipelineTaskEntryMaps(parsed).find((m) => m.range && offset >= m.range[0] && offset <= m.range[2]);
}

/**
 * Every `spec.steps[]`/`spec.sidecars[]` entry as its raw YAMLMap node
 * (Task/ClusterTask/StepAction or TaskRun-inline-taskSpec aware, via
 * {@link resolveTaskSpecOwner}). Same precision concern as
 * {@link pipelineTaskEntryMaps}: a step's own nested maps (`resources`,
 * `env`, ...) shouldn't be mistaken for the step itself.
 */
export function stepAndSidecarEntryMaps(parsed: ParsedTektonDoc): YAMLMap[] {
  const owner = resolveTaskSpecOwner(parsed);
  if (!owner) return [];
  const maps: YAMLMap[] = [];
  for (const key of ["steps", "sidecars"]) {
    const seq = findSeqIn(owner.ownerMap, key);
    if (!seq) continue;
    for (const item of seq.items) {
      if (isMap(item)) maps.push(item);
    }
  }
  return maps;
}

/** The `spec.steps[]`/`spec.sidecars[]` entry enclosing `offset`, if any. */
export function findEnclosingStepEntry(parsed: ParsedTektonDoc, offset: number): YAMLMap | undefined {
  return stepAndSidecarEntryMaps(parsed).find((m) => m.range && offset >= m.range[0] && offset <= m.range[2]);
}
