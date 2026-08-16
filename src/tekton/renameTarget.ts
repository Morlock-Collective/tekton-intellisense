import { ParsedTektonDoc, stepActionRefs, TaskSymbol, TASK_LIKE_KINDS, TRIGGER_BINDING_LIKE_KINDS } from "./model";
import { findParamRefs } from "./paramRefs";

/**
 * What's being renamed, and the range of the specific token under the
 * cursor (for `prepareRename` to anchor the rename widget). The kind
 * determines scope: param/workspace/task-alias are private to the document
 * they're declared in; result and the `*-identity` kinds can be referenced
 * from other files and need workspace-wide handling — see rename.ts.
 */
export type RenameTarget =
  | { kind: "param" | "workspace" | "task-alias"; name: string; range: [number, number] }
  | { kind: "result"; name: string; range: [number, number] }
  | { kind: "task-result"; taskAlias: string; resultName: string; range: [number, number]; taskEntry: TaskSymbol }
  /**
   * A binding to a *different* resource's declared param: a Pipeline task
   * entry's `params: [{name, value}]` (taskAlias set, scoped to that one
   * entry) or a TaskRun's own top-level `spec.params` when using `taskRef`
   * (taskAlias absent — the whole document is the one binding). Distinct
   * from plain `"param"`, which is always a same-document declaration.
   */
  | { kind: "task-param"; paramName: string; range: [number, number]; taskRefName: string; taskAlias?: string }
  | { kind: "task-identity"; name: string; range: [number, number] }
  | { kind: "pipeline-identity"; name: string; range: [number, number] }
  | { kind: "template-identity"; name: string; range: [number, number] }
  | { kind: "binding-identity"; name: string; range: [number, number] }
  | { kind: "trigger-identity"; name: string; range: [number, number] };

function inRange(range: [number, number] | undefined, offset: number): boolean {
  return !!range && offset >= range[0] && offset <= range[1];
}

/**
 * Figures out what renameable entity (if any) sits at `offset` — a
 * declaration's `name:` field, a `$(...)` reference to one, a Task's own
 * `metadata.name`, or a `taskRef.name` pointing at one. Returns undefined
 * when nothing at `offset` is renameable, which callers should treat as
 * "disable rename here" (VS Code's `prepareRename` contract).
 */
export function resolveRenameTarget(parsed: ParsedTektonDoc, offset: number): RenameTarget | undefined {
  const { symbols, text } = parsed;

  // A TaskRun using `taskRef` (not an inline taskSpec) has its own spec.params as a *binding* to
  // the referenced Task's declared params, not a declaration of its own -- same relationship as a
  // Pipeline task entry's params[] below, just without a wrapping task-entry alias.
  const taskRunBindingRef = symbols.kind === "TaskRun" ? symbols.taskRefName : undefined;
  for (const p of symbols.params) {
    if (!inRange(p.range, offset)) continue;
    if (taskRunBindingRef) return { kind: "task-param", paramName: p.name, range: p.range!, taskRefName: taskRunBindingRef };
    return { kind: "param", name: p.name, range: p.range! };
  }
  for (const w of symbols.workspaces) {
    if (inRange(w.range, offset)) return { kind: "workspace", name: w.name, range: w.range! };
  }
  for (const r of symbols.results) {
    if (inRange(r.range, offset)) return { kind: "result", name: r.name, range: r.range! };
  }
  for (const t of symbols.tasks) {
    if (inRange(t.range, offset)) return { kind: "task-alias", name: t.name, range: t.range! };
    if (t.taskRefName && inRange(t.taskRefNameRange, offset)) {
      return { kind: "task-identity", name: t.taskRefName, range: t.taskRefNameRange! };
    }
    if (t.taskRefName) {
      for (const pb of t.paramBindings) {
        if (inRange(pb.range, offset)) {
          return { kind: "task-param", paramName: pb.name, range: pb.range!, taskRefName: t.taskRefName, taskAlias: t.name };
        }
      }
    }
    for (const wb of t.workspaceBindings) {
      if (wb.workspaceName && inRange(wb.workspaceNameRange, offset)) {
        return { kind: "workspace", name: wb.workspaceName, range: wb.workspaceNameRange! };
      }
    }
    for (const ra of t.runAfter) {
      if (inRange(ra.range, offset)) return { kind: "task-alias", name: ra.name, range: ra.range! };
    }
  }
  if (symbols.metadataName && TASK_LIKE_KINDS.has(symbols.kind) && inRange(symbols.metadataNameRange, offset)) {
    return { kind: "task-identity", name: symbols.metadataName, range: symbols.metadataNameRange! };
  }
  if (symbols.metadataName && symbols.kind === "Pipeline" && inRange(symbols.metadataNameRange, offset)) {
    return { kind: "pipeline-identity", name: symbols.metadataName, range: symbols.metadataNameRange! };
  }
  if (symbols.pipelineRefName && inRange(symbols.pipelineRefNameRange, offset)) {
    return { kind: "pipeline-identity", name: symbols.pipelineRefName, range: symbols.pipelineRefNameRange! };
  }
  if (symbols.taskRefName && inRange(symbols.taskRefNameRange, offset)) {
    return { kind: "task-identity", name: symbols.taskRefName, range: symbols.taskRefNameRange! };
  }
  for (const ref of stepActionRefs(parsed)) {
    if (inRange(ref.range, offset)) return { kind: "task-identity", name: ref.name, range: ref.range! };
  }

  for (const trigger of symbols.triggers) {
    for (const ref of trigger.bindingRefs) {
      if (inRange(ref.range, offset)) return { kind: "binding-identity", name: ref.name, range: ref.range! };
    }
    if (trigger.templateRefName && inRange(trigger.templateRefNameRange, offset)) {
      return { kind: "template-identity", name: trigger.templateRefName, range: trigger.templateRefNameRange! };
    }
    if (trigger.triggerRefName && inRange(trigger.triggerRefNameRange, offset)) {
      return { kind: "trigger-identity", name: trigger.triggerRefName, range: trigger.triggerRefNameRange! };
    }
  }
  if (symbols.metadataName && symbols.kind === "TriggerTemplate" && inRange(symbols.metadataNameRange, offset)) {
    return { kind: "template-identity", name: symbols.metadataName, range: symbols.metadataNameRange! };
  }
  if (symbols.metadataName && TRIGGER_BINDING_LIKE_KINDS.has(symbols.kind) && inRange(symbols.metadataNameRange, offset)) {
    return { kind: "binding-identity", name: symbols.metadataName, range: symbols.metadataNameRange! };
  }
  if (symbols.metadataName && symbols.kind === "Trigger" && inRange(symbols.metadataNameRange, offset)) {
    return { kind: "trigger-identity", name: symbols.metadataName, range: symbols.metadataNameRange! };
  }
  if (symbols.templateRefName && inRange(symbols.templateRefNameRange, offset)) {
    return { kind: "template-identity", name: symbols.templateRefName, range: symbols.templateRefNameRange! };
  }
  for (const ref of symbols.bindingRefs) {
    if (inRange(ref.range, offset)) return { kind: "binding-identity", name: ref.name, range: ref.range! };
  }

  for (const ref of findParamRefs(text)) {
    if (offset < ref.start || offset > ref.end) continue;

    if (ref.kind === "param" && ref.name && ref.nameStart !== undefined && ref.nameEnd !== undefined) {
      return { kind: "param", name: ref.name, range: [ref.nameStart, ref.nameEnd] };
    }
    if (ref.kind === "workspace" && ref.name && ref.nameStart !== undefined && ref.nameEnd !== undefined) {
      return { kind: "workspace", name: ref.name, range: [ref.nameStart, ref.nameEnd] };
    }
    if (ref.kind === "result" && ref.name && ref.nameStart !== undefined && ref.nameEnd !== undefined) {
      return { kind: "result", name: ref.name, range: [ref.nameStart, ref.nameEnd] };
    }
    if (ref.kind === "task-result" && ref.name) {
      const onResultSegment =
        ref.resultName !== undefined &&
        ref.resultNameStart !== undefined &&
        ref.resultNameEnd !== undefined &&
        offset >= ref.resultNameStart &&
        offset <= ref.resultNameEnd;

      if (onResultSegment) {
        const taskEntry = symbols.tasks.find((t) => t.name === ref.name);
        if (!taskEntry) return undefined;
        return {
          kind: "task-result",
          taskAlias: ref.name,
          resultName: ref.resultName!,
          range: [ref.resultNameStart!, ref.resultNameEnd!],
          taskEntry,
        };
      }
      if (ref.nameStart !== undefined && ref.nameEnd !== undefined) {
        return { kind: "task-alias", name: ref.name, range: [ref.nameStart, ref.nameEnd] };
      }
    }
    return undefined;
  }

  return undefined;
}

export interface TextEdit {
  range: [number, number];
  newText: string;
}

/**
 * Every same-document occurrence of a param/workspace/task-alias, ready to
 * rename: the declaration, any `$(...)` reference to it, and two plain
 * (non-`$(...)`) YAML field cases `findParamRefs` alone never sees — for a
 * workspace, every task's own `workspaces: [{name, workspace}]` binding
 * pointing at it; for a task alias, every *other* task's `runAfter:
 * [name, ...]` entry naming it.
 */
export function sameDocumentEdits(
  parsed: ParsedTektonDoc,
  kind: "param" | "workspace" | "task-alias",
  name: string,
  newName: string
): TextEdit[] {
  const { symbols, text } = parsed;
  const edits: TextEdit[] = [];

  const declList = kind === "param" ? symbols.params : kind === "workspace" ? symbols.workspaces : symbols.tasks;
  const decl = declList.find((s) => s.name === name);
  if (decl?.range) edits.push({ range: decl.range, newText: newName });

  const refKind = kind === "task-alias" ? "task-result" : kind;
  for (const ref of findParamRefs(text)) {
    if (ref.kind !== refKind || ref.name !== name) continue;
    if (ref.nameStart === undefined || ref.nameEnd === undefined) continue;
    edits.push({ range: [ref.nameStart, ref.nameEnd], newText: newName });
  }

  if (kind === "workspace") {
    for (const t of symbols.tasks) {
      for (const wb of t.workspaceBindings) {
        if (wb.workspaceName === name && wb.workspaceNameRange) {
          edits.push({ range: wb.workspaceNameRange, newText: newName });
        }
      }
    }
  }

  if (kind === "task-alias") {
    for (const t of symbols.tasks) {
      for (const ra of t.runAfter) {
        if (ra.name === name && ra.range) edits.push({ range: ra.range, newText: newName });
      }
    }
  }

  return edits;
}

/** Every same-document occurrence of a Task's own result — its declaration plus any $(results.NAME.path) self-references. */
export function sameDocumentResultEdits(parsed: ParsedTektonDoc, resultName: string, newName: string): TextEdit[] {
  const { symbols, text } = parsed;
  const edits: TextEdit[] = [];

  const decl = symbols.results.find((r) => r.name === resultName);
  if (decl?.range) edits.push({ range: decl.range, newText: newName });

  for (const ref of findParamRefs(text)) {
    if (ref.kind !== "result" || ref.name !== resultName) continue;
    if (ref.nameStart === undefined || ref.nameEnd === undefined) continue;
    edits.push({ range: [ref.nameStart, ref.nameEnd], newText: newName });
  }

  return edits;
}

/** Every `$(tasks.<taskAlias>.results.<resultName>)` reference in `parsed` pointing at one specific local task alias. */
export function taskResultReferenceEdits(parsed: ParsedTektonDoc, taskAlias: string, resultName: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const ref of findParamRefs(parsed.text)) {
    if (ref.kind !== "task-result" || ref.name !== taskAlias || ref.resultName !== resultName) continue;
    if (ref.resultNameStart === undefined || ref.resultNameEnd === undefined) continue;
    edits.push({ range: [ref.resultNameStart, ref.resultNameEnd], newText: newName });
  }
  return edits;
}

/** Every `params: [{name, value}]` binding in `parsed`'s task entry named `taskAlias` whose `name` matches one specific param — the plain-field counterpart to {@link taskResultReferenceEdits}. */
export function taskParamReferenceEdits(parsed: ParsedTektonDoc, taskAlias: string, paramName: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const taskEntry = parsed.symbols.tasks.find((t) => t.name === taskAlias);
  if (!taskEntry) return edits;
  for (const pb of taskEntry.paramBindings) {
    if (pb.name === paramName && pb.range) edits.push({ range: pb.range, newText: newName });
  }
  return edits;
}

/**
 * Every `taskRef: { name: <name> }` and step `ref: { name: <name> }` in
 * `parsed` pointing at one specific Task/StepAction identity — a
 * Pipeline's per-task-entry `taskRef`, a TaskRun's own top-level
 * `spec.taskRef`, and any step's own `ref` (pointing at a shared
 * StepAction), which are structurally different fields but the same kind
 * of reference (see {@link stepActionRefs}).
 */
export function taskRefIdentityEdits(parsed: ParsedTektonDoc, name: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const t of parsed.symbols.tasks) {
    if (t.taskRefName === name && t.taskRefNameRange) {
      edits.push({ range: t.taskRefNameRange, newText: newName });
    }
  }
  if (parsed.symbols.kind === "TaskRun" && parsed.symbols.taskRefName === name && parsed.symbols.taskRefNameRange) {
    edits.push({ range: parsed.symbols.taskRefNameRange, newText: newName });
  }
  for (const ref of stepActionRefs(parsed)) {
    if (ref.name === name && ref.range) edits.push({ range: ref.range, newText: newName });
  }
  return edits;
}

/** Every `pipelineRef: { name: <name> }` in `parsed` (a PipelineRun's top-level spec.pipelineRef) pointing at one specific Pipeline identity. */
export function pipelineRefIdentityEdits(parsed: ParsedTektonDoc, name: string, newName: string): TextEdit[] {
  if (parsed.symbols.kind === "PipelineRun" && parsed.symbols.pipelineRefName === name && parsed.symbols.pipelineRefNameRange) {
    return [{ range: parsed.symbols.pipelineRefNameRange, newText: newName }];
  }
  return [];
}

/** Every `bindings[].ref: <name>` in `parsed` (an EventListener trigger entry's, or a standalone Trigger's own) pointing at one specific TriggerBinding/ClusterTriggerBinding identity. */
export function bindingRefIdentityEdits(parsed: ParsedTektonDoc, name: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const trigger of parsed.symbols.triggers) {
    for (const ref of trigger.bindingRefs) {
      if (ref.name === name && ref.range) edits.push({ range: ref.range, newText: newName });
    }
  }
  if (parsed.symbols.kind === "Trigger") {
    for (const ref of parsed.symbols.bindingRefs) {
      if (ref.name === name && ref.range) edits.push({ range: ref.range, newText: newName });
    }
  }
  return edits;
}

/** Every `template.ref: <name>` in `parsed` (an EventListener trigger entry's, or a standalone Trigger's own) pointing at one specific TriggerTemplate identity. */
export function templateRefIdentityEdits(parsed: ParsedTektonDoc, name: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const trigger of parsed.symbols.triggers) {
    if (trigger.templateRefName === name && trigger.templateRefNameRange) {
      edits.push({ range: trigger.templateRefNameRange, newText: newName });
    }
  }
  if (parsed.symbols.kind === "Trigger" && parsed.symbols.templateRefName === name && parsed.symbols.templateRefNameRange) {
    edits.push({ range: parsed.symbols.templateRefNameRange, newText: newName });
  }
  return edits;
}

/** Every `triggerRef: <name>` in `parsed` (an EventListener trigger entry's) pointing at one specific standalone Trigger identity. */
export function triggerRefIdentityEdits(parsed: ParsedTektonDoc, name: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const trigger of parsed.symbols.triggers) {
    if (trigger.triggerRefName === name && trigger.triggerRefNameRange) {
      edits.push({ range: trigger.triggerRefNameRange, newText: newName });
    }
  }
  return edits;
}
