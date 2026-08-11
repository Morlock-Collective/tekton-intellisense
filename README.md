# Tekton Aid

A VS Code extension that makes hand-authoring [Tekton](https://tekton.dev)
`Pipeline`/`Task`/`PipelineRun`/`TaskRun` YAML less miserable — not by
replacing the editor with a graphical designer, but by making the text
editor smarter about the domain: it knows what a `$(params.foo)` reference
is, whether `foo` actually exists, and how to insert the boilerplate you
retype constantly.

It is Helm-aware: charts that keep Tekton resources under `templates/` with
`{{ ... }}` actions are parsed by masking template actions in place (see
`src/tekton/helmMask.ts`) rather than requiring a rendered chart, so
line/column positions in diagnostics always point at your actual source
file.

## Features

- **Reference highlighting** — the name inside `$(params.x)`,
  `$(workspaces.x.path)`, `$(results.x.path)`, `$(tasks.x.results.y)` is
  decorated distinctly from plain YAML, and so is the `name:` field at the
  point of declaration (in `spec.params`/`workspaces`/`results`/`tasks`
  entries) — so it's obvious which key is the identifier even when `name`
  isn't the first field.
- **Reference validation** — every `$(...)` reference is checked against the
  document's declared `spec.params`, `spec.workspaces`, `spec.results`, and
  (for Pipelines) `spec.tasks`/`spec.finally` names. Unknown or misspelled
  names get a warning with a "did you mean" suggestion (Levenshtein
  distance) and a quick fix to apply it.
- **Duplicate-name validation** — a repeated name within `spec.params`,
  `spec.workspaces`, `spec.results`, or `spec.tasks`/`finally` is flagged as
  an error on every occurrence — the kind of thing the Kubernetes API
  server rejects at apply time anyway.
- **Task-level workspace binding validation** — a pipeline task's
  `workspaces: [{name, workspace}]` entries get the same "did you mean"
  treatment as `$(...)` references when `workspace:` doesn't match any of
  the Pipeline's declared `spec.workspaces[]` — a plain field value, not
  template syntax, but the same typo-invisible-until-runtime failure mode.
- **Missing-`runAfter` hint** — a task referencing another task's result
  via `$(tasks.X.results.Y)` gets its ordering inferred automatically by
  Tekton either way, so this is an `Information`-level suggestion, not a
  warning: if `X` isn't also listed in that task's own `runAfter`, a quick
  fix adds it, making a dependency that's otherwise only visible by
  cross-referencing param values explicit in the one place a reader would
  look first.
- **Context-aware completion** — typing `$(params.` (or `workspaces.`,
  `results.`, `tasks.`, `context.`) suggests exactly what's valid there:
  declared names for the current document, filtered by resource kind (no
  `tasks.` inside a Task, no `results.` inside a Pipeline), narrowing to leaf
  fields once a name is chosen (`workspaces.x.path|claim|volume|bound`,
  `context.pipelineRun.name|namespace|uid`, ...). `$(tasks.X.results.` is
  resolved against the *actual* Task `X`'s `taskRef` points at — including
  across files, via a lightweight workspace-wide index kept current by a
  file watcher (`src/tekton/workspaceIndex.ts`) — the normal case in Helm
  charts that split Tasks and Pipelines into separate templates.
- **Hover info** — hovering a declaration (`name:` in `spec.params`/
  `workspaces`/`results`/`tasks`) or any `$(...)` reference to it shows the
  same card: type/description/default for params, description/optional for
  workspaces, description/type for results. Hovering `$(tasks.X...)` or its
  declaration shows the resolved `taskRef` and that Task's actual results
  (cross-file, via the same workspace index completions use). Hovering
  `$(context.*)` shows what the built-in variable means.
- **Go to Definition / Find All References** — jump from a `$(...)`
  reference straight to its declaration; for `$(tasks.X.results.Y)`, `Y`
  resolves cross-file to the actual Task's declared result, even in a file
  you haven't opened. "Find All References" collects every `$(...)`
  reference to a param/workspace/task-alias within the current document;
  for a Task's own result or a Task/Pipeline's own identity
  (`taskRef`/`pipelineRef`), it searches the whole workspace — and unlike
  rename, is happy to show references from more than one same-named
  candidate rather than picking one, since showing an extra location
  costs a glance, not a rewrite.
- **Rename (F2)** — params, workspaces, and pipeline task aliases rename
  within their own file, declaration and every `$(...)` reference together.
  A Task's declared result, a Task's own identity (`metadata.name`,
  referenced by a Pipeline task's `taskRef.name` *or* a TaskRun's own
  `taskRef`), and a Pipeline's own identity (`metadata.name`, referenced by
  a PipelineRun's `pipelineRef`) all rename **workspace-wide by default** —
  invoke it from either the declaration or any reference to it, anywhere in
  the workspace, and everything updates together. If a name is ambiguous
  (two different Task or Pipeline files sharing a `metadata.name` — a
  vendored/catalog Task in more than one chart, not a hypothetical), what
  happens depends on where you invoked it from: on the declaration itself
  it's unambiguous by construction, so that file renames and cross-file
  reference updates are skipped with an explicit warning; from a
  *reference* pointing at an ambiguous name, the rename is rejected
  outright, since there's no principled way to know which same-named
  declaration the reference actually means.
- **Commands** (Command Palette or editor context menu) — all four resolve
  *where* to insert from the document's structure, not the cursor
  position, wherever that's well-defined; where it genuinely isn't (which
  task, which step — there can be several), the cursor is a fast path and a
  picker is the fallback, never "insert wherever the cursor happens to be":
  - `Tekton: Add Parameter` — always appends last in the correct list, and
    is resource-aware: Pipeline/Task/ClusterTask/StepAction get a
    declaration (name/type/description/default) under `spec.params`; a
    PipelineRun/TaskRun using a `..Ref` gets a value binding (name/value)
    instead, unless it embeds an inline Pipeline/Task via
    `pipelineSpec`/`taskSpec`, in which case it gets a declaration there.
  - `Tekton: Add Task to Pipeline` — appends a new `spec.tasks[]` (or
    `spec.finally[]`) entry with a `taskRef`/`runAfter`/`params` skeleton,
    to a Pipeline or a PipelineRun's inline `pipelineSpec`.
  - `Tekton: Add When Expression to Task` — adds a `when:` condition to a
    task entry: the one under your cursor if there is one, otherwise pick
    from a list of the Pipeline's tasks.
  - `Tekton: Bind Parameter to Environment Variable` — pick a declared
    param, name the env var, and it's inserted into a step/sidecar's `env:`
    list (creating it if needed): the one under your cursor if there is
    one, otherwise pick from a list of the Task's steps/sidecars.

## Why not a graphical editor?

Pipelines-as-YAML is the actual interface Tekton, Helm, GitOps tooling, and
code review all operate on. A graphical editor adds a translation layer and
a second source of truth. This extension instead makes the text itself
easier to get right — closer to how a good LSP makes a programming language
easier to write, not by hiding the code.

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Then open this folder in VS Code and press F5 to launch an Extension
Development Host. There's no `vscode` API dependency in the core parsing
logic (`src/tekton/model.ts`, `paramRefs.ts`, `levenshtein.ts`,
`helmMask.ts`, `duplicates.ts`, `commands/snippetText.ts`), so it can be
sanity-checked directly with Node — see `test-fixtures/check.js`, which
also end-to-end-simulates each editing command's output and round-trips it
through the real `yaml` parser rather than relying on eyeballing the
editor:

```bash
npm run lint    # eslint
npm test        # compiles, then runs test-fixtures/check.js (exits non-zero on failure)
```

## Status

Early and actively growing — see `docs/ROADMAP.md` for
what's implemented and what's next.

## References

- [Tekton Pipelines variables](https://tekton.dev/docs/pipelines/variables/)
- [Tekton Pipeline API](https://tekton.dev/docs/pipelines/pipelines/)
- [Tekton Task API](https://tekton.dev/docs/pipelines/tasks/)
- [Helm template functions](https://helm.sh/docs/chart_template_guide/function_list/)
