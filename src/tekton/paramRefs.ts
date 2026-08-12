/**
 * Finds and classifies Tekton variable references of the form `$(...)`.
 * References: https://tekton.dev/docs/pipelines/variables/,
 * https://tekton.dev/docs/triggers/triggerbindings/ (`body`/`header`/`extensions`/`context`,
 * JSONPath-ish with `[0]`/`[0:2]` and `\.`-escaped dots), and
 * https://tekton.dev/docs/triggers/triggertemplates/ (`tt.params`/`uid`).
 */

// $( ... ) where the body is dots/word-chars/hyphens/brackets/stars/colons/backslashes
// (colons and backslashes are only meaningful in TriggerBinding's body/header/extensions
// paths — slicing like [0:2], and escaped dots like foo\.bar), no nested parens.
const REF_PATTERN = /\$\(([a-zA-Z0-9_.\-\[\]*:\\]+)\)/g;

export type RefKind =
  | "param"
  | "workspace"
  | "result"
  | "task-result"
  | "context"
  | "tt-param"
  | "uid"
  | "trigger-body"
  | "trigger-header"
  | "trigger-extension"
  | "unknown";

export interface ParamRef {
  /** full match, e.g. "$(params.foo)" */
  raw: string;
  /** offset of the full match start in the (possibly masked) document text */
  start: number;
  /** offset of the full match end */
  end: number;
  kind: RefKind;
  /** the primary name being referenced (param name, workspace name, task name, ...) */
  name?: string;
  /** for task-result refs: the result name on the referenced task */
  resultName?: string;
  /** offset range of just `name` within raw, for precise diagnostic squiggles */
  nameStart?: number;
  nameEnd?: number;
  /** for task-result refs: offset range of just `resultName` within raw */
  resultNameStart?: number;
  resultNameEnd?: number;
}

function stripIndex(part: string): string {
  return part.replace(/\[[^\]]*\]$/, "");
}

function classify(inner: string, matchStart: number): ParamRef {
  const raw = `$(${inner})`;
  const end = matchStart + raw.length;
  const parts = inner.split(".");
  const head = parts[0];

  // $(context.pipeline.name), $(context.pipelineRun.uid), $(context.task.name), ...
  if (head === "context") {
    return { raw, start: matchStart, end, kind: "context" };
  }

  // $(params.NAME) / $(params.NAME[*]) / $(params.NAME[0])
  if (head === "params" && parts.length >= 2) {
    const name = stripIndex(parts[1]);
    const nameOffsetInInner = "params.".length;
    return {
      raw,
      start: matchStart,
      end,
      kind: "param",
      name,
      nameStart: matchStart + 2 + nameOffsetInInner,
      nameEnd: matchStart + 2 + nameOffsetInInner + name.length,
    };
  }

  // legacy: $(inputs.params.NAME) / $(outputs.resources.NAME...)
  if ((head === "inputs" || head === "outputs") && parts[1] === "params" && parts.length >= 3) {
    const name = stripIndex(parts[2]);
    const prefix = `${head}.params.`;
    return {
      raw,
      start: matchStart,
      end,
      kind: "param",
      name,
      nameStart: matchStart + 2 + prefix.length,
      nameEnd: matchStart + 2 + prefix.length + name.length,
    };
  }

  // $(workspaces.NAME.path|claimName|volume|bound)
  if (head === "workspaces" && parts.length >= 2) {
    const name = stripIndex(parts[1]);
    const nameOffsetInInner = "workspaces.".length;
    return {
      raw,
      start: matchStart,
      end,
      kind: "workspace",
      name,
      nameStart: matchStart + 2 + nameOffsetInInner,
      nameEnd: matchStart + 2 + nameOffsetInInner + name.length,
    };
  }

  // $(results.NAME.path) -- a Task referring to its own declared result
  if (head === "results" && parts.length >= 2) {
    const name = stripIndex(parts[1]);
    const nameOffsetInInner = "results.".length;
    return {
      raw,
      start: matchStart,
      end,
      kind: "result",
      name,
      nameStart: matchStart + 2 + nameOffsetInInner,
      nameEnd: matchStart + 2 + nameOffsetInInner + name.length,
    };
  }

  // $(tasks.TASKNAME.results.RESULTNAME) -- a Pipeline referring to another task's result
  if (head === "tasks" && parts.length >= 4 && parts[2] === "results") {
    const name = stripIndex(parts[1]);
    const resultName = stripIndex(parts[3]);
    const nameOffsetInInner = "tasks.".length;
    const resultOffsetInInner = `tasks.${parts[1]}.results.`.length;
    return {
      raw,
      start: matchStart,
      end,
      kind: "task-result",
      name,
      resultName,
      nameStart: matchStart + 2 + nameOffsetInInner,
      nameEnd: matchStart + 2 + nameOffsetInInner + name.length,
      resultNameStart: matchStart + 2 + resultOffsetInInner,
      resultNameEnd: matchStart + 2 + resultOffsetInInner + resultName.length,
    };
  }

  // $(tt.params.NAME) -- inside a TriggerTemplate's resourcetemplates, referring to its own declared params
  if (head === "tt" && parts[1] === "params" && parts.length >= 3) {
    const name = stripIndex(parts[2]);
    const prefix = "tt.params.";
    return {
      raw,
      start: matchStart,
      end,
      kind: "tt-param",
      name,
      nameStart: matchStart + 2 + prefix.length,
      nameEnd: matchStart + 2 + prefix.length + name.length,
    };
  }

  // $(uid) -- a TriggerTemplate builtin, a random value like generateName
  if (head === "uid" && parts.length === 1) {
    return { raw, start: matchStart, end, kind: "uid" };
  }

  // $(body...) / $(header...) / $(extensions...) -- TriggerBinding value expressions extracting
  // from the incoming event. Arbitrary-depth JSONPath with no declared schema to check against, so
  // unlike the other kinds above, `name` here is the whole remaining path, not a single segment —
  // and it's read directly off `inner` (not `parts`) so `\.`-escaped dots in the path survive intact.
  if (head === "body" || head === "header" || head === "extensions") {
    const kind: RefKind = head === "body" ? "trigger-body" : head === "header" ? "trigger-header" : "trigger-extension";
    const dotIndex = inner.indexOf(".");
    if (dotIndex === -1) {
      return { raw, start: matchStart, end, kind };
    }
    const pathStart = dotIndex + 1;
    return {
      raw,
      start: matchStart,
      end,
      kind,
      name: inner.slice(pathStart),
      nameStart: matchStart + 2 + pathStart,
      nameEnd: matchStart + 2 + inner.length,
    };
  }

  return { raw, start: matchStart, end, kind: "unknown" };
}

export function findParamRefs(text: string): ParamRef[] {
  const refs: ParamRef[] = [];
  let m: RegExpExecArray | null;
  REF_PATTERN.lastIndex = 0;
  while ((m = REF_PATTERN.exec(text)) !== null) {
    refs.push(classify(m[1], m.index));
  }
  return refs;
}
