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
  you haven't opened. "Find All References" from a declaration or a use
  collects every `$(...)` reference to it in the current document.
- **Commands** (Command Palette or editor context menu):
  - `Tekton: Bind Parameter to Environment Variable` — pick a declared
    param, name the env var, and it's inserted into the `env:` list of the
    step/sidecar under your cursor (creating the list if needed).
  - `Tekton: Add Task to Pipeline` — appends a new `spec.tasks[]` (or
    `spec.finally[]`) entry with a `taskRef`/`runAfter`/`params` skeleton.
  - `Tekton: Add When Expression to Task` — adds a `when:` condition to the
    `spec.tasks[]` entry under your cursor.
  - `Tekton: Add Parameter` — appends a new `spec.params[]` entry, prompting
    for name/type/default.

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
`helmMask.ts`), so it can be sanity-checked directly with Node — see
`test-fixtures/check.js`:

```bash
npm run compile && node test-fixtures/check.js
```

## Status

Early and actively growing — see `docs/ROADMAP.md` for
what's implemented and what's next.

## References

- [Tekton Pipelines variables](https://tekton.dev/docs/pipelines/variables/)
- [Tekton Pipeline API](https://tekton.dev/docs/pipelines/pipelines/)
- [Tekton Task API](https://tekton.dev/docs/pipelines/tasks/)
- [Helm template functions](https://helm.sh/docs/chart_template_guide/function_list/)
