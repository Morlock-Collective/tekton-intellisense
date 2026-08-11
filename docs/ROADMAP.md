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

## Known limitations (v0.1)

- Task-level `workspaces: [{name, workspace: <pipeline-workspace-name>}]`
  bindings aren't validated yet — only `$(...)` substitutions are. This is
  a distinct reference kind (a plain field value, not a template
  expression) and needs its own check.
- Cross-file validation isn't attempted: a Pipeline referencing
  `$(tasks.foo.results.bar)` is checked for task `foo` existing in the same
  Pipeline, but `bar` is not checked against `foo`'s actual Task definition
  (which usually lives in a separate file/chart).
- No hover/definition-provider yet (e.g. jump from a `$(params.x)` ref to
  its declaration).
- No settings for custom Tekton API group/version allow-list (assumes any
  `tekton.dev/*`).

## Next up

- [ ] Validate task-level `workspaces[].workspace` bindings against
      `spec.workspaces` (Pipeline) — same misspelling-suggestion UX.
- [ ] Hover provider: hovering a `$(params.x)` shows its declared type/
      description/default.
- [ ] Definition/references provider for params/workspaces/results.
- [ ] Workspace-wide indexing so a Task's declared `results`/`params` can
      be resolved when referenced from a separate Pipeline file (common in
      Helm charts where Tasks and Pipelines live in different templates).
- [ ] Diagnostic + quick fix for tasks missing `runAfter` when they
      reference another task's result (implicit vs. explicit ordering).
- [ ] Publish to the VS Code Marketplace / Open VSX.
