# Roadmap / Work Log

## Problem

Authoring Tekton Pipelines by hand is painful mostly because of tooling gaps,
not because YAML-as-a-pipeline-format is inherently bad:

- `$(params.foo)`-style references are just strings to the editor — typos
  aren't caught until a `PipelineRun` fails at runtime.
- No highlighting distinguishes a variable reference from a plain string.
- Adding a task, a conditional, or wiring a param to an env var means
  hand-typing boilerplate every time.
- Charts that template Tekton resources with Helm break naive YAML tooling
  outright (`{{ }}` isn't valid YAML), so linting is often disabled for
  `templates/*.yaml` entirely.

## Approach

Not a graphical pipeline editor. Keep YAML as the source of truth and make
the text editor domain-aware, the way a language server makes a programming
language easier to write correctly. Ship small, composable QoL features and
grow the domain model (params → workspaces → results → tasks → identity)
incrementally.

For implementation detail beyond what's below, `git log` has the full
reasoning behind each change.

## Done

**Domain model** (`src/tekton/model.ts`) — recognizes
Pipeline/Task/ClusterTask/PipelineRun/TaskRun/StepAction via
`apiVersion: tekton.dev/*`; extracts params/workspaces/results/tasks
(name, type, description, default, source ranges); resolves where a given
kind of content belongs (`spec` directly vs. an inline `pipelineSpec`/
`taskSpec`) so editing commands don't need cursor position to know where
to insert. Helm charts are handled by masking `{{ }}` actions in place
(`helmMask.ts`) rather than requiring a rendered chart, preserving
line/column offsets — including across a `{{ }}` action that itself spans
multiple lines, which naive masking would otherwise shift.

**`$(...)` reference parsing** (`paramRefs.ts`) — classifies every
reference (`params`, `workspaces`, `results`, `tasks.X.results.Y`,
`context.*`, legacy `inputs`/`outputs`) with precise sub-ranges for each
segment.

**Diagnostics** — unknown/misspelled `$(...)` references, duplicate names
within `spec.params`/`workspaces`/`results`/`tasks`, task-level
`workspaces[].workspace` bindings that don't match a declared workspace,
all with Levenshtein "did you mean" suggestions and a quick fix. A
separate `Information`-severity check flags a task that references
another task's result without listing it in `runAfter` — not a
correctness issue (Tekton infers the order regardless) but a readability
gap, with a quick fix to add the entry.

**Highlighting** — declaration sites and reference sites are decorated
using workbench `ThemeColor`s rather than TextMate grammar scopes, since
scope colors are only as visible as a given theme bothers to style them.

**Completion** — context-aware for `$(...)` paths: top-level namespace
filtered by document kind, then declared names, then leaf fields
(`workspaces.x.path|claim|volume|bound`, `context.pipelineRun.name|...`).
`$(tasks.X.results.` resolves against the actual Task `X`'s `taskRef`
points at, including cross-file, via `workspaceIndex.ts` — a workspace-wide
index of Task/Pipeline resources keyed by `metadata.name`, kept current by
a file watcher and live re-indexing of unsaved buffers.

**Hover / Go to Definition / Find All References** — hover shows a
declaration's own metadata (type/description/default/etc.) from either the
declaration or a reference to it. Definition and References both resolve
cross-file for a Task's result and for Task/Pipeline identity
(`taskRef`/`pipelineRef`), via the same `workspaceIndex`. Find References
is deliberately more permissive than rename on an ambiguous name (merges
every matching candidate instead of picking one), since showing an extra
location costs a glance, not a rewrite.

**Rename (F2)** — params, workspaces, and pipeline task aliases rename
within their own file. A Task's declared result and a Task/Pipeline's own
identity (`metadata.name`, referenced by `taskRef`/`pipelineRef`) rename
workspace-wide by default, invocable from either the declaration or any
reference. Ambiguous names (two files sharing a `metadata.name` — a
vendored Task present in more than one chart is a real case, not a
hypothetical) are handled explicitly: renaming the declaration itself
still works (unambiguous by construction) but skips cross-file
propagation with a warning; renaming *from* an ambiguous reference is
rejected outright, since there's no way to know which declaration it
means.

**Editing commands** (Command Palette / context menu) — all four resolve
*where* to insert from the document's structure rather than cursor
position, wherever that's well-defined (`Add Parameter`, `Add Task`);
where it genuinely isn't (`Add When Expression`, `Bind Parameter to Env
Var` — there can be multiple tasks/steps), the cursor is a fast path and a
picker is the fallback.

**Tekton Triggers** (`triggers.tekton.dev/*`) — EventListener, Trigger,
TriggerTemplate, TriggerBinding, and ClusterTriggerBinding get the same
domain-model/diagnostics/highlighting/hover/navigation/rename treatment as
Pipelines/Tasks, extending rather than duplicating that machinery:
TriggerTemplate reuses the existing `params` shape outright; the workspace
index generalized from two hardcoded Task/Pipeline name maps to one
keyed-by-group map so TriggerTemplate/TriggerBinding-family/Trigger could
be added as three more groups instead of three more copy-pasted ones;
rename/references' per-identity-kind orchestration (declaration edit,
collision/ambiguity warnings, cross-file scan) was factored into one
shared function each, used by all 5 identity kinds now instead of just
Task/Pipeline. TriggerBinding's `value:` expressions
(`$(body...)`/`$(header...)`/`$(extensions...)`) are recognized and
highlighted but never validated — see Known limitations. Completions and
an EventListener/Trigger↔TriggerTemplate param-wiring check are follow-up
work, not part of this pass — see Next up.

## Notable bugs found and fixed along the way

- Multi-line inserts only indented their first line correctly; the trailing
  newline of the last existing list item was sometimes already consumed by
  its own AST range and sometimes not, causing glued or doubled lines
  depending on which. Fixed by two explicit insertion primitives
  (`insertAtCursor`/`insertBlockAfter`) and `trimTrailingNewline()`.
- `helmMask.ts` collapsed line numbers when a `{{ }}` action itself spanned
  multiple lines, shifting every diagnostic after it in the file.
- `workspaceIndex.ts` keyed Tasks flatly by name; two files sharing a name
  could silently evict each other's entry on edit, breaking cross-file
  resolution for an untouched file.
- The diagnostic-refresh debounce in `extension.ts` used one shared timer
  for all documents, silently dropping a refresh when two files were
  edited within the debounce window.
- Free-text input (descriptions, default values, `when` expressions) went
  unescaped into `vscode.SnippetString` (live `$1`/`${1:x}` syntax) and into
  generated YAML double-quoted strings (unescaped quotes/backslashes,
  unquoted values containing YAML-significant characters).
- Ambiguous cross-file rename resolved via the wrong lookup (the
  deterministic single-answer one meant for completions/hover) and could
  silently rewrite an unrelated file while leaving the actual reference
  that was clicked unchanged. Fixed by rejecting outright whenever
  resolution starts from a reference and the name is ambiguous.
- The old "which task/step is the cursor in" detection (innermost map
  containing the cursor) could mistake a task's own `params:` item or a
  step's own `env:` item for the task/step itself, since both incidentally
  have a `name` key too.
- Appending to an existing `when:`/`runAfter:` list computed indentation by
  formula instead of matching the list's own existing indentation,
  producing YAML the parser rejected outright in one case.
- `hover.ts`/`definitions.ts` never actually handled `taskRef`/`pipelineRef`
  plain-scalar identity references — only rename/references did (via
  `resolveRenameTarget`). Hovering or Go to Definition on a `taskRef.name`
  silently did nothing. Found while wiring up the equivalent trigger
  identity refs and fixed for all 5 identity kinds at once, since both
  providers now resolve through the same `resolveRenameTarget`.

## Known limitations (v0.1)

- The workspace index resolves Tasks/Pipelines by `metadata.name`; a
  Helm-templated name (e.g. `{{ include "chart.fullname" . }}-build`) masks
  to a non-matching placeholder, so cross-file resolution comes up empty
  unless the reference is a literal string too — reasonable, since a
  templated name needs a templated reference to match it anyway.
- No settings for a custom Tekton API group/version allow-list (assumes any
  `tekton.dev/*`).
- `Add Parameter` doesn't special-case an existing `params: []` (flow-style,
  empty) list — appends a block-style item after it rather than converting
  the `[]` to block style. Rare in practice.
- `Add Parameter`'s binding shape (PipelineRun/TaskRun using `..Ref`)
  always emits the value as a quoted string, so an `array`/`object`-typed
  param can't be filled in through the prompt — a single free-text input
  can't represent that shape safely either way.
- TriggerBinding's `$(body...)`/`$(header...)`/`$(extensions...)`
  expressions can't be validated for existence — their shape depends on the
  external webhook payload, which isn't declared anywhere in the Tekton
  YAML. They're recognized and highlighted but never flagged "unknown,"
  the same treatment `$(context.*)` already gets.
- Interceptor/ClusterInterceptor aren't recognized document kinds — they're
  normally cluster-installed (`github`/`cel`/`slack`/...), not hand-authored
  per chart. An interceptor's `ref.name` is an unvalidated string.

## Next up

- [ ] Publish to the VS Code Marketplace / Open VSX.
- [ ] Completions for `$(tt.params.`/`$(uid)`/`$(body...)` etc., and
      EventListener/Trigger ref-name completion (`bindings[].ref`,
      `template.ref`, `triggerRef`) — the latter is a new completion-trigger
      shape (a plain YAML scalar, not `$(...)`) that ordinary Pipeline/Task
      authoring has the same gap for (`taskRef.name`, `pipelineRef.name`),
      worth solving once rather than per resource kind.
- [ ] Cross-resource check: does every *required* TriggerTemplate param (no
      default) actually get provided by name from at least one of an
      EventListener/Trigger's bound TriggerBindings.
