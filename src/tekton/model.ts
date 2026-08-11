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
    const taskRef = mapOf(m.get("taskRef", true));
    out.push({ name, range, taskRefName: scalarString(taskRef?.get("name", true)) });
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
  const metadataName =
    isScalar(metadataNameNode) && typeof metadataNameNode.value === "string" ? metadataNameNode.value : undefined;

  const spec = mapOf(root.get("spec", true));

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

export interface ParamsTarget {
  /** the map that should directly contain a `params:` key */
  ownerMap: YAMLMap;
  /** offset marking the end of ownerMap's content — where a brand-new `params:` key should be appended */
  ownerMapEnd: number;
  /** indentation a `params:` key itself should sit at within ownerMap */
  keyIndent: string;
  /** Pipeline/Task/etc declare params (name+type+description+default); PipelineRun/TaskRun *provide* them (name+value) unless they embed an inline spec */
  shape: "declaration" | "binding";
}

const PARAM_DECLARING_KINDS: ReadonlySet<TektonKind> = new Set(["Pipeline", "Task", "ClusterTask", "StepAction"]);

/**
 * Figures out where a new parameter belongs, independent of cursor
 * position: Pipelines/Tasks declare params directly under spec; a
 * PipelineRun/TaskRun either provides param *values* under spec (when using
 * a `..Ref`) or declares params like a Pipeline/Task does, when it embeds
 * one inline via `pipelineSpec`/`taskSpec`.
 */
export function resolveParamsTarget(parsed: ParsedTektonDoc): ParamsTarget | undefined {
  const { doc, text, symbols } = parsed;
  const spec = findSpecMap(doc);
  if (!spec?.range) return undefined;

  const root = isMap(doc.contents) ? doc.contents : undefined;
  const specKeyIndent = (root && namedKeyIndent(text, root, "spec")) ?? "";

  if (PARAM_DECLARING_KINDS.has(symbols.kind)) {
    const keyIndent = firstChildKeyIndent(text, spec) ?? specKeyIndent + "  ";
    return { ownerMap: spec, ownerMapEnd: spec.range[1], keyIndent, shape: "declaration" };
  }

  const inlineKey = symbols.kind === "PipelineRun" ? "pipelineSpec" : symbols.kind === "TaskRun" ? "taskSpec" : undefined;
  if (!inlineKey) return undefined;

  const inline = mapOf(spec.get(inlineKey, true));
  if (inline?.range) {
    const inlineKeyIndent = namedKeyIndent(text, spec, inlineKey) ?? specKeyIndent + "  ";
    const keyIndent = firstChildKeyIndent(text, inline) ?? inlineKeyIndent + "  ";
    return { ownerMap: inline, ownerMapEnd: inline.range[1], keyIndent, shape: "declaration" };
  }

  const keyIndent = firstChildKeyIndent(text, spec) ?? specKeyIndent + "  ";
  return { ownerMap: spec, ownerMapEnd: spec.range[1], keyIndent, shape: "binding" };
}
