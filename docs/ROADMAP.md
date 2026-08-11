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

Not a graphical pipeline editor. Instead: keep YAML as the source of truth
and make the text editor domain-aware, the way a language server makes a
programming language easier to write correctly. Ship small, composable QoL
features and grow the domain model (params → workspaces → results → tasks →
...) incrementally.

## Milestone 1 — Foundation (done)

- [x] Extension scaffold (TypeScript, `package.json`, activation on YAML).
- [x] Helm-template masking (`src/tekton/helmMask.ts`) so `{{ }}` actions
      don't break YAML parsing, preserving byte offsets for accurate
      diagnostic positions.
- [x] Tekton document model (`src/tekton/model.ts`): recognizes
      Pipeline/Task/ClusterTask/PipelineRun/TaskRun/StepAction via
      `apiVersion: tekton.dev/*`, extracts declared params/workspaces/
      results/tasks with source ranges.
- [x] `$(...)` reference parser + classifier
      (`src/tekton/paramRefs.ts`): params, (legacy) inputs/outputs.params,
      workspaces, results, tasks.X.results.Y, context.*.
- [x] Diagnostics: unknown param/workspace/result/task-result references,
      Levenshtein-based "did you mean" suggestions, quick fix code action.
- [x] TextMate grammar injection for `$(...)` reference highlighting.
- [x] Commands: bind param → env var, add task, add when-expression, add
      parameter — all AST-position-aware (insert after the last existing
      list item, or create the list at cursor indentation).

## Milestone 1.1 — Activation fix + declaration highlighting (done)

The first cut never actually activated in a real window (only ever run via
F5 debug host) and had two packaging bugs (`contributes.languages`
re-declaring the built-in `yaml` id; an invalid TextMate injection selector)
that would have kept it dark even once installed. Fixed both, switched
diagnostics/completions/code-actions from `languageId === "yaml"` to a file
pattern selector so other extensions claiming `*.yaml` under a different
language id don't block us, and added a `tektonAid.active` status-bar/context
signal so activation is visibly confirmed.

Also replaced the TextMate-scope-based reference highlighting with editor
decorations using workbench `ThemeColor`s (`symbolIcon.variableForeground`,
`textLink.foreground`) — grammar scope colors are only as visible as a given
theme bothers to style them (turned out nearly invisible in practice), while
workbench colors resolve to a real value under every theme. Declaration
sites (`name:` fields) are now highlighted too, distinctly from reference
sites, so the field acting as an identifier is obvious regardless of key
ordering in the mapping.

## Milestone 1.2 — Context-aware completions (done)

- [x] `src/tekton/completions.ts`: a `CompletionItemProvider` that inspects
      the unclosed `$(...)` back from the cursor, splits it into typed path
      segments, and offers exactly the completions valid at that depth: top-
      level namespaces filtered by document kind (no `tasks.` in a Task, no
      `results.` in a Pipeline), then declared names, then leaf fields
      (`workspaces.x.path|claim|volume|bound`, `results.x.path`,
      `context.pipelineRun.name|namespace|uid`, ...).
- [x] `src/tekton/workspaceIndex.ts`: a workspace-wide index of
      Task/ClusterTask/StepAction resources keyed by `metadata.name`, kept
      current via a file-system watcher plus live re-indexing of open
      (unsaved) buffers. This is what resolves `$(tasks.X.results.Y)` — `Y`
      is completed against the *actual* Task `X`'s `taskRef` points at, even
      when that Task lives in a different file, which is the normal
      Helm-chart layout (Tasks and Pipelines in separate templates).

## Known limitations (v0.1)

- Task-level `workspaces: [{name, workspace: <pipeline-workspace-name>}]`
  bindings aren't validated yet — only `$(...)` substitutions are. This is
  a distinct reference kind (a plain field value, not a template
  expression) and needs its own check.
- The workspace index resolves Tasks by `metadata.name`; a Helm-templated
  name (e.g. `{{ include "chart.fullname" . }}-build`) masks to a non-
  matching placeholder, so cross-file result completion silently comes up
  empty for such charts unless the taskRef itself is also a literal string.
- No hover/definition-provider yet (e.g. jump from a `$(params.x)` ref to
  its declaration, or hover to see a param's declared type/default).
- No settings for custom Tekton API group/version allow-list (assumes any
  `tekton.dev/*`).

## Next up

- [ ] Validate task-level `workspaces[].workspace` bindings against
      `spec.workspaces` (Pipeline) — same misspelling-suggestion UX.
- [ ] Hover provider: hovering a `$(params.x)` shows its declared type/
      description/default.
- [ ] Definition/references provider for params/workspaces/results, and for
      `$(tasks.X...)` → jump to the Task definition resolved via
      `workspaceIndex`.
- [ ] Diagnostic + quick fix for tasks missing `runAfter` when they
      reference another task's result (implicit vs. explicit ordering).
- [ ] Publish to the VS Code Marketplace / Open VSX.
