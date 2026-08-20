import { Document, LineCounter, parseAllDocuments, Scalar, YAMLMap, YAMLSeq, isMap, isSeq, isScalar } from "yaml";
import { maskHelmTemplates, MaskedAction } from "./helmMask";

export type TektonKind =
  | "Pipeline"
  | "Task"
  | "ClusterTask"
  | "PipelineRun"
  | "TaskRun"
  | "StepAction"
  | "EventListener"
  | "Trigger"
  | "TriggerTemplate"
  | "TriggerBinding"
  | "ClusterTriggerBinding"
  | "Unknown";

const TEKTON_KINDS: ReadonlySet<TektonKind> = new Set([
  "Pipeline",
  "Task",
  "ClusterTask",
  "PipelineRun",
  "TaskRun",
  "StepAction",
]);

const TRIGGERS_KINDS: ReadonlySet<TektonKind> = new Set([
  "EventListener",
  "Trigger",
  "TriggerTemplate",
  "TriggerBinding",
  "ClusterTriggerBinding",
]);

export interface NamedSymbol {
  name: string;
  /** offset range of the `name` scalar itself, for "go to definition"-ish uses */
  range?: [number, number];
}

/** A plain scalar name reference (e.g. `ref: some-name`), distinct from a `$(...)` reference. */
export interface RefName {
  name: string;
  range?: [number, number];
}

export interface TaskSymbol extends NamedSymbol {
  /** the taskRef.name this pipeline task entry points at, if any (may differ from the entry's local `name`) */
  taskRefName?: string;
  /** offset range of the taskRef.name scalar itself, for rename edits */
  taskRefNameRange?: [number, number];
  /** this task entry's own `workspaces: [{name, workspace}]` bindings, mapping the task's local workspace names to the Pipeline's declared ones */
  workspaceBindings: TaskWorkspaceBinding[];
  /** this task entry's own `runAfter: [name, ...]` — bare scalar task-alias names, not `$(...)` syntax or a `{ref: name}` map */
  runAfter: RefName[];
  /** this task entry's own `params: [{name, value}]` bindings — `name` should match a param declared by whatever `taskRefName` points at (only meaningful when using `taskRef`; an inline `taskSpec`'s params bind to its own same-document declarations instead) */
  paramBindings: RefName[];
}

export interface TaskWorkspaceBinding {
  /** the name this task calls the workspace within its own steps' $(workspaces.X...) refs */
  localName: string;
  /** the `workspace:` field's value — should match a spec.workspaces[].name declared by the Pipeline */
  workspaceName?: string;
  /** offset range of the `workspace:` value scalar itself, for diagnostics */
  workspaceNameRange?: [number, number];
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

/** TriggerBinding/ClusterTriggerBinding's spec.params entries — a *providing* list (name/value), not a declaring one like ParamSymbol. */
export interface TriggerBindingParamSymbol extends NamedSymbol {
  value?: string;
  valueRange?: [number, number];
}

/** EventListener.spec.triggers[] entry. Parallel to TaskSymbol: a named entry that points at other resources by name. */
export interface TriggerEntrySymbol extends NamedSymbol {
  bindingRefs: RefName[];
  /** names from bindings[] entries that provide a value inline (`{name, value}`) instead of via `ref` — no separate resource to resolve, but still a param the bound TriggerTemplate can consider satisfied */
  inlineParamNames: string[];
  templateRefName?: string;
  templateRefNameRange?: [number, number];
  /** points at a standalone Trigger instead of inline bindings+template, if set */
  triggerRefName?: string;
  triggerRefNameRange?: [number, number];
  interceptorNames: string[];
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
  /** a standalone Trigger's own spec.template.ref — the TriggerTemplate it points at */
  templateRefName?: string;
  templateRefNameRange?: [number, number];
  /** a standalone Trigger's own spec.bindings[].ref entries */
  bindingRefs: RefName[];
  /** a standalone Trigger's own spec.bindings[] entries that provide a value inline instead of via ref — see TriggerEntrySymbol.inlineParamNames */
  inlineParamNames: string[];
  params: ParamSymbol[];
  workspaces: WorkspaceSymbol[];
  results: ResultSymbol[];
  /** pipeline.spec.tasks / spec.finally entries */
  tasks: TaskSymbol[];
  /** TriggerBinding/ClusterTriggerBinding's spec.params entries */
  bindingParams: TriggerBindingParamSymbol[];
  /** EventListener.spec.triggers entries */
  triggers: TriggerEntrySymbol[];
}

export const TASK_LIKE_KINDS: ReadonlySet<TektonKind> = new Set(["Task", "ClusterTask", "StepAction"]);
export const TRIGGER_BINDING_LIKE_KINDS: ReadonlySet<TektonKind> = new Set(["TriggerBinding", "ClusterTriggerBinding"]);

export interface ParsedTektonDoc {
  doc: Document.Parsed;
  lineCounter: LineCounter;
  /** full source text of the *file*, not just this resource — a file can hold several `---`-separated Tekton resources, each getting its own {@link ParsedTektonDoc} sharing this same text/lineCounter. See {@link range}. */
  text: string;
  /** this resource's own `[start, end)` offset span within {@link text} — the part of a multi-document file that belongs to it, as opposed to a sibling document before/after a `---` marker. Whole-file scans (e.g. `$(...)` ref search) must intersect this to avoid attributing another resource's references to this one. */
  range: [number, number];
  symbols: TektonSymbols;
  isHelmTemplated: boolean;
  /** every masked `{{ ... }}` action across the whole file (shared across every resource in it, same as {@link text}) -- `scriptEmbed.ts` uses this to recognize a masked action that landed inside a script block, so it can show something meaningful in place of the masked filler and restore the original template text on write-back. */
  maskedActions: MaskedAction[];
}

const TEKTON_API_PREFIX = "tekton.dev/";
const TRIGGERS_API_PREFIX = "triggers.tekton.dev/";

function isTektonApiVersion(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(TEKTON_API_PREFIX);
}

function isTriggersApiVersion(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(TRIGGERS_API_PREFIX);
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

/** The scalar's own quoting/block style (`Scalar.PLAIN`/`QUOTE_SINGLE`/`QUOTE_DOUBLE`/`BLOCK_LITERAL`/`BLOCK_FOLDED`) — callers that need to map an offset in the decoded value back to raw source (e.g. `celExpr.ts`) need this, since block styles decode very differently from quoted/plain ones. */
function scalarStyle(node: unknown): Scalar.Type | undefined {
  return isScalar(node) ? (node.type as Scalar.Type | undefined) : undefined;
}

/** Reads a `<key>: { name: ... }` ref field (taskRef, pipelineRef, an interceptor's `ref`) directly under `map`. */
function refNameAndRange(map: YAMLMap | undefined, key: string): { name?: string; range?: [number, number] } {
  const ref = mapOf(map?.get(key, true));
  const nameNode = ref?.get("name", true);
  return { name: scalarString(nameNode), range: scalarRange(nameNode) };
}

/** Reads a `<key>: { ref: <name> }` field (an EventListener/Trigger's `template`), where `ref` is a bare scalar rather than nested under `.name`. */
function scalarRefField(map: YAMLMap | undefined, key: string): { name?: string; range?: [number, number] } {
  const sub = mapOf(map?.get(key, true));
  const refNode = sub?.get("ref", true);
  return { name: scalarString(refNode), range: scalarRange(refNode) };
}

/** Reads a sequence of bare scalar names directly (not nested under a key) — e.g. a task entry's `runAfter: [name, ...]`. */
function scalarNameList(seq: YAMLSeq | undefined): RefName[] {
  const out: RefName[] = [];
  if (!seq) return out;
  for (const item of seq.items) {
    if (isScalar(item) && typeof item.value === "string" && item.range) {
      out.push({ name: item.value, range: [item.range[0], item.range[1]] });
    }
  }
  return out;
}

/** Reads a sequence of `{ ref: <name> }` entries (EventListener/Trigger's `bindings`) — embedded name/value bindings have no `ref` and are silently skipped, since there's no cross-file identity to resolve for those. */
function scalarRefList(seq: YAMLSeq | undefined): RefName[] {
  const out: RefName[] = [];
  if (!seq) return out;
  for (const item of seq.items) {
    const m = mapOf(item);
    const refNode = m?.get("ref", true);
    const name = scalarString(refNode);
    if (name) out.push({ name, range: scalarRange(refNode) });
  }
  return out;
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

function taskWorkspaceBindings(seq: YAMLSeq | undefined): TaskWorkspaceBinding[] {
  const out: TaskWorkspaceBinding[] = [];
  forEachNamedItem(seq, (m, localName) => {
    const workspaceNode = m.get("workspace", true);
    out.push({ localName, workspaceName: scalarString(workspaceNode), workspaceNameRange: scalarRange(workspaceNode) });
  });
  return out;
}

/** Reads a `params: [{name, value}]` sequence's `name` fields with their ranges — the same shape as a declaring list, but only `name` matters here (a binding, not a declaration). */
function taskParamBindings(seq: YAMLSeq | undefined): RefName[] {
  const out: RefName[] = [];
  forEachNamedItem(seq, (_m, name, range) => {
    out.push({ name, range });
  });
  return out;
}

function taskEntries(seq: YAMLSeq | undefined): TaskSymbol[] {
  const out: TaskSymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    const taskRef = refNameAndRange(m, "taskRef");
    const workspaceBindings = taskWorkspaceBindings(seqOf(m.get("workspaces", true)));
    const runAfter = scalarNameList(seqOf(m.get("runAfter", true)));
    const paramBindings = taskParamBindings(seqOf(m.get("params", true)));
    out.push({ name, range, taskRefName: taskRef.name, taskRefNameRange: taskRef.range, workspaceBindings, runAfter, paramBindings });
  });
  return out;
}

function triggerBindingParamEntries(seq: YAMLSeq | undefined): TriggerBindingParamSymbol[] {
  const out: TriggerBindingParamSymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    const valueNode = m.get("value", true);
    out.push({ name, range, value: scalarString(valueNode), valueRange: scalarRange(valueNode) });
  });
  return out;
}

/** Names from a bindings[] sequence's inline entries (`{name, value}`, no `ref`) — the shorthand form that provides a param directly without a separate TriggerBinding resource. */
function inlineBindingParamNames(seq: YAMLSeq | undefined): string[] {
  const out: string[] = [];
  if (!seq) return out;
  for (const item of seq.items) {
    const m = mapOf(item);
    if (!m || m.get("ref", true) !== undefined) continue;
    const name = scalarString(m.get("name", true));
    if (name) out.push(name);
  }
  return out;
}

function interceptorNames(seq: YAMLSeq | undefined): string[] {
  const out: string[] = [];
  if (!seq) return out;
  for (const item of seq.items) {
    const ref = refNameAndRange(mapOf(item), "ref");
    if (ref.name) out.push(ref.name);
  }
  return out;
}

/** A `cel` interceptor's `filter` or one `overlays[].expression` value — see {@link findCelExpressions}. */
export interface CelExprLocation {
  value: string;
  range: [number, number];
  /** the scalar's own quoting/block style — see `scalarStyle` */
  style: Scalar.Type | undefined;
}

/** `interceptors[]` items whose `ref.name` is `cel`, pulling out `filter` and each `overlays[].expression`. */
function celExpressionsFromInterceptors(seq: YAMLSeq | undefined): CelExprLocation[] {
  const out: CelExprLocation[] = [];
  if (!seq) return out;
  for (const item of seq.items) {
    const m = mapOf(item);
    if (!m) continue;
    const ref = refNameAndRange(m, "ref");
    if (ref.name !== "cel") continue;

    for (const p of seqOf(m.get("params", true))?.items ?? []) {
      const pm = mapOf(p);
      if (!pm) continue;
      const paramName = scalarString(pm.get("name", true));
      const valueNode = pm.get("value", true);

      if (paramName === "filter") {
        const value = scalarString(valueNode);
        const range = scalarRange(valueNode);
        if (value !== undefined && range) out.push({ value, range, style: scalarStyle(valueNode) });
      } else if (paramName === "overlays") {
        for (const o of seqOf(valueNode)?.items ?? []) {
          const exprNode = mapOf(o)?.get("expression", true);
          const value = scalarString(exprNode);
          const range = scalarRange(exprNode);
          if (value !== undefined && range) out.push({ value, range, style: scalarStyle(exprNode) });
        }
      }
    }
  }
  return out;
}

/**
 * Every `cel` interceptor expression (`filter` + `overlays[].expression`) in
 * `parsed` — from an EventListener's inline `spec.triggers[].interceptors`,
 * or a standalone Trigger's own `spec.interceptors`. Re-walks the AST
 * directly (rather than riding on `TektonSymbols`, which only tracks
 * interceptor *names*) since callers need the expression text and its
 * source range, not just that a `cel` interceptor is present.
 */
export function findCelExpressions(parsed: ParsedTektonDoc): CelExprLocation[] {
  const root = mapOf(parsed.doc.contents);
  const spec = mapOf(root?.get("spec", true));
  if (!spec) return [];

  if (parsed.symbols.kind === "EventListener") {
    const out: CelExprLocation[] = [];
    for (const item of seqOf(spec.get("triggers", true))?.items ?? []) {
      out.push(...celExpressionsFromInterceptors(seqOf(mapOf(item)?.get("interceptors", true))));
    }
    return out;
  }

  if (parsed.symbols.kind === "Trigger") {
    return celExpressionsFromInterceptors(seqOf(spec.get("interceptors", true)));
  }

  return [];
}

function triggerEntries(seq: YAMLSeq | undefined): TriggerEntrySymbol[] {
  const out: TriggerEntrySymbol[] = [];
  forEachNamedItem(seq, (m, name, range) => {
    const templateRef = scalarRefField(m, "template");
    const triggerRefNode = m.get("triggerRef", true);
    const bindingsSeq = seqOf(m.get("bindings", true));
    out.push({
      name,
      range,
      bindingRefs: scalarRefList(bindingsSeq),
      inlineParamNames: inlineBindingParamNames(bindingsSeq),
      templateRefName: templateRef.name,
      templateRefNameRange: templateRef.range,
      triggerRefName: scalarString(triggerRefNode),
      triggerRefNameRange: scalarRange(triggerRefNode),
      interceptorNames: interceptorNames(seqOf(m.get("interceptors", true))),
    });
  });
  return out;
}

/**
 * Extracts one document's Tekton symbol table, or undefined if its root
 * doesn't look like a recognized Tekton/Triggers resource at all (including
 * a blank document, e.g. a stray trailing `---`) — callers use that to skip
 * non-Tekton documents within an otherwise-relevant multi-document file.
 */
function extractSymbols(doc: Document.Parsed): TektonSymbols | undefined {
  const root = mapOf(doc.contents);
  if (!root) return undefined;

  const apiVersion = root.get("apiVersion", true);
  const apiVersionValue = isScalar(apiVersion) ? apiVersion.value : undefined;
  const kindNode = root.get("kind", true);
  const kindValue = isScalar(kindNode) ? kindNode.value : undefined;

  const isTekton = isTektonApiVersion(apiVersionValue);
  const isTriggers = isTriggersApiVersion(apiVersionValue);
  if (!isTekton && !isTriggers) {
    return undefined;
  }

  const validKinds = isTekton ? TEKTON_KINDS : TRIGGERS_KINDS;
  const kind: TektonKind = validKinds.has(kindValue as TektonKind) ? (kindValue as TektonKind) : "Unknown";

  const metadata = mapOf(root.get("metadata", true));
  const metadataNameNode = metadata?.get("name", true);
  const metadataName = scalarString(metadataNameNode);
  const metadataNameRange = scalarRange(metadataNameNode);

  const spec = mapOf(root.get("spec", true));

  const pipelineRef = kind === "PipelineRun" ? refNameAndRange(spec, "pipelineRef") : undefined;
  const ownTaskRef = kind === "TaskRun" ? refNameAndRange(spec, "taskRef") : undefined;
  const ownTemplateRef = kind === "Trigger" ? scalarRefField(spec, "template") : undefined;
  const ownBindingsSeq = kind === "Trigger" ? seqOf(spec?.get("bindings", true)) : undefined;
  const ownBindingRefs = kind === "Trigger" ? scalarRefList(ownBindingsSeq) : [];
  const ownInlineParamNames = kind === "Trigger" ? inlineBindingParamNames(ownBindingsSeq) : [];

  const params = paramEntries(seqOf(spec?.get("params", true)));
  const workspaces = workspaceEntries(seqOf(spec?.get("workspaces", true)));
  const results = resultEntries(seqOf(spec?.get("results", true)));

  const tasks = [
    ...taskEntries(seqOf(spec?.get("tasks", true))),
    ...taskEntries(seqOf(spec?.get("finally", true))),
  ];

  const bindingParams = TRIGGER_BINDING_LIKE_KINDS.has(kind)
    ? triggerBindingParamEntries(seqOf(spec?.get("params", true)))
    : [];
  const triggers = kind === "EventListener" ? triggerEntries(seqOf(spec?.get("triggers", true))) : [];

  return {
    kind,
    apiVersion: apiVersionValue,
    metadataName,
    metadataNameRange,
    pipelineRefName: pipelineRef?.name,
    pipelineRefNameRange: pipelineRef?.range,
    taskRefName: ownTaskRef?.name,
    taskRefNameRange: ownTaskRef?.range,
    templateRefName: ownTemplateRef?.name,
    templateRefNameRange: ownTemplateRef?.range,
    bindingRefs: ownBindingRefs,
    inlineParamNames: ownInlineParamNames,
    params,
    workspaces,
    results,
    tasks,
    bindingParams,
    triggers,
  };
}

/**
 * Parses a Tekton YAML file — possibly holding several `---`-separated
 * documents, each its own Kubernetes resource (a common Helm-chart-output
 * and kustomize-build layout) — into one {@link ParsedTektonDoc} per
 * document that looks like a recognized Tekton/Triggers resource. A
 * document that doesn't (a blank one from a trailing `---`, or unrelated
 * YAML mixed into the same file) is silently skipped, same as
 * {@link parseTektonDocument} returning undefined for a whole non-Tekton
 * file. Every returned entry shares one `text`/`lineCounter` spanning the
 * whole file — offsets are never renumbered per-document — but carries its
 * own {@link ParsedTektonDoc.range} so callers can tell which resource a
 * given offset belongs to (see {@link findResourceAt}).
 */
export function parseTektonFile(source: string): ParsedTektonDoc[] {
  const { text, masked: isHelmTemplated, actions: maskedActions } = maskHelmTemplates(source);

  const lineCounter = new LineCounter();
  let docs: Document.Parsed[];
  try {
    docs = parseAllDocuments(text, { lineCounter, keepSourceTokens: false });
  } catch {
    return [];
  }

  const out: ParsedTektonDoc[] = [];
  for (const doc of docs) {
    const symbols = extractSymbols(doc);
    if (!symbols) continue;
    const range: [number, number] = doc.range ? [doc.range[0], doc.range[2]] : [0, text.length];
    out.push({ doc, lineCounter, text, range, isHelmTemplated, symbols, maskedActions });
  }
  return out;
}

/**
 * Parses a Tekton YAML document (optionally Helm-templated) and extracts the
 * symbol table used for reference validation. Returns undefined if the text
 * doesn't look like a Tekton resource at all, so callers can skip
 * unnecessary work on unrelated YAML files. Only ever considers the *first*
 * document in the file — callers that need to handle a multi-document file
 * fully should use {@link parseTektonFile} instead; this remains for the
 * (still common) single-resource-per-file case and for call sites that
 * genuinely only care about "is this file Tekton at all".
 */
export function parseTektonDocument(source: string): ParsedTektonDoc | undefined {
  return parseTektonFile(source)[0];
}

/**
 * Which of `docs` (as returned by {@link parseTektonFile}) `offset` falls
 * within — i.e. which resource a cursor position or edit anchor belongs to
 * in a possibly multi-document file. Falls back to the closest document
 * starting at-or-before `offset` (covering a position that lands in the
 * inter-document whitespace/`---` marker itself), then simply the first
 * document, so this always resolves to something as long as `docs` is
 * non-empty — every position-based feature needs exactly one document to
 * operate against, never "none, because the cursor sits between two".
 */
export function findResourceAt(docs: ParsedTektonDoc[], offset: number): ParsedTektonDoc | undefined {
  for (const d of docs) {
    if (offset >= d.range[0] && offset <= d.range[1]) return d;
  }
  let best: ParsedTektonDoc | undefined;
  for (const d of docs) {
    if (d.range[0] <= offset && (!best || d.range[0] > best.range[0])) best = d;
  }
  return best ?? docs[0];
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

/**
 * Indentation of the line containing `offset`, assuming `offset` marks the
 * first non-whitespace column of that line. True for a YAML *key*'s own
 * range, or a sequence's range (which starts at its first item's `-`) —
 * NOT true for a list-item *map*'s range, which starts past the `- `
 * marker, on its first key; callers with one of those need to strip to
 * whitespace-only instead (see `commands/editUtils.ts#indentAt`, which
 * does, via `vscode.TextDocument.lineAt`).
 */
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
 * {@link resolvePipelineSpecOwner}). Unlike a generic "innermost map at this
 * offset" search, this only ever returns actual task-list entries — a
 * params-list item (`- name: x`) inside a task also has a `name` key and
 * would otherwise be mistaken for one.
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

function stepAndSidecarEntriesOf(ownerMap: YAMLMap): YAMLMap[] {
  const maps: YAMLMap[] = [];
  for (const key of ["steps", "sidecars"]) {
    const seq = findSeqIn(ownerMap, key);
    if (!seq) continue;
    for (const item of seq.items) {
      if (isMap(item)) maps.push(item);
    }
  }
  return maps;
}

/**
 * Every `spec.steps[]`/`spec.sidecars[]` entry as its raw YAMLMap node —
 * a Task/ClusterTask/StepAction or TaskRun-inline-taskSpec's own (via
 * {@link resolveTaskSpecOwner}), *and* any Pipeline task entry's own inline
 * `taskSpec:` (a Pipeline task can embed a full Task definition instead of
 * a `taskRef`, and its steps/sidecars are just as real as a standalone
 * Task's — step/sidecar-scoped features like "Edit Task Script" and
 * `bindParamToEnv` shouldn't only work for the former). The two sources
 * are mutually exclusive by document kind, so no risk of double-counting.
 * Same precision concern as {@link pipelineTaskEntryMaps}: a step's own
 * nested maps (`resources`, `env`, ...) shouldn't be mistaken for the step
 * itself.
 */
export function stepAndSidecarEntryMaps(parsed: ParsedTektonDoc): YAMLMap[] {
  const maps: YAMLMap[] = [];

  const owner = resolveTaskSpecOwner(parsed);
  if (owner) {
    // A standalone StepAction *is* one step -- its spec has `image`/`script`/`command`/`env`/...
    // directly on it, unlike Task/ClusterTask/TaskRun-inline-taskSpec, which nest those same
    // fields one level down inside a `steps:`/`sidecars:` list entry. So for a StepAction, the
    // owning map (its own `spec`) is itself the one step-like entry, not a container to look
    // inside of for a `steps:`/`sidecars:` list that doesn't exist.
    if (parsed.symbols.kind === "StepAction") {
      maps.push(owner.ownerMap);
    } else {
      maps.push(...stepAndSidecarEntriesOf(owner.ownerMap));
    }
  }

  for (const taskEntry of pipelineTaskEntryMaps(parsed)) {
    const taskSpec = mapOf(taskEntry.get("taskSpec", true));
    if (taskSpec) maps.push(...stepAndSidecarEntriesOf(taskSpec));
  }

  return maps;
}

/** The `spec.steps[]`/`spec.sidecars[]` entry enclosing `offset`, if any. */
export function findEnclosingStepEntry(parsed: ParsedTektonDoc, offset: number): YAMLMap | undefined {
  return stepAndSidecarEntryMaps(parsed).find((m) => m.range && offset >= m.range[0] && offset <= m.range[2]);
}

/**
 * Every step's `ref: { name: X }` pointing at a shared `StepAction`, across
 * every step {@link stepAndSidecarEntryMaps} finds — a Step's own local
 * `name:` isn't tracked here, only this cross-resource reference. A
 * StepAction shares its identity namespace with Task/ClusterTask (see
 * `TASK_LIKE_KINDS`, and `workspaceIndex.ts`'s "task" group), so this is
 * the same kind of reference as a Pipeline task entry's `taskRef.name`,
 * just from inside a step instead.
 */
export function stepActionRefs(parsed: ParsedTektonDoc): RefName[] {
  const out: RefName[] = [];
  for (const step of stepAndSidecarEntryMaps(parsed)) {
    const ref = refNameAndRange(step, "ref");
    if (ref.name && ref.range) out.push({ name: ref.name, range: ref.range });
  }
  return out;
}
