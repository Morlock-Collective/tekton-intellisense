import { ParsedTektonDoc, TaskSymbol, TASK_LIKE_KINDS } from "./model";
import { findParamRefs } from "./paramRefs";

/**
 * What's being renamed, and the range of the specific token under the
 * cursor (for `prepareRename` to anchor the rename widget). The kind
 * determines scope: param/workspace/task-alias are private to the document
 * they're declared in; result, task-identity, and pipeline-identity can be
 * referenced from other files and need workspace-wide handling — see
 * rename.ts.
 */
export type RenameTarget =
  | { kind: "param" | "workspace" | "task-alias"; name: string; range: [number, number] }
  | { kind: "result"; name: string; range: [number, number] }
  | { kind: "task-result"; taskAlias: string; resultName: string; range: [number, number]; taskEntry: TaskSymbol }
  | { kind: "task-identity"; name: string; range: [number, number] }
  | { kind: "pipeline-identity"; name: string; range: [number, number] };

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

  for (const p of symbols.params) {
    if (inRange(p.range, offset)) return { kind: "param", name: p.name, range: p.range! };
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

/** Every same-document occurrence (declaration + $(...) refs) of a param/workspace/task-alias, ready to rename. */
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

/**
 * Every `taskRef: { name: <name> }` in `parsed` pointing at one specific
 * Task identity — both a Pipeline's per-task-entry `taskRef` and a
 * TaskRun's own top-level `spec.taskRef`, which are structurally different
 * fields but the same kind of reference.
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
  return edits;
}

/** Every `pipelineRef: { name: <name> }` in `parsed` (a PipelineRun's top-level spec.pipelineRef) pointing at one specific Pipeline identity. */
export function pipelineRefIdentityEdits(parsed: ParsedTektonDoc, name: string, newName: string): TextEdit[] {
  if (parsed.symbols.kind === "PipelineRun" && parsed.symbols.pipelineRefName === name && parsed.symbols.pipelineRefNameRange) {
    return [{ range: parsed.symbols.pipelineRefNameRange, newText: newName }];
  }
  return [];
}
