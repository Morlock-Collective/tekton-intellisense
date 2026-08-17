# Tekton Intellisense

A VS Code extension that makes hand-authoring [Tekton](https://tekton.dev)
`Pipeline`/`Task`/`PipelineRun`/`TaskRun` and Tekton Triggers
`EventListener`/`Trigger`/`TriggerTemplate`/`TriggerBinding` YAML slightly less
miserable.

It is Helm-"aware" to some extent: charts that keep Tekton resources under `templates/` with
`{{ ... }}` actions are parsed by masking template actions rather than requiring a rendered chart, 
so line/column positions in diagnostics always point at your actual source file. This may be an area
of future improvement.

## Features

- **Reference highlighting** — the name inside `$(params.x)`,
  `$(workspaces.x.path)`, `$(results.x.path)`, `$(tasks.x.results.y)` is
  decorated distinctly from plain YAML, and so is the `name:` field at the
  point of declaration (for `params`/`workspaces`/`results`/`tasks`).
- **Reference validation** — every `$(...)` reference is checked against the
  document's declared `spec.params`, `spec.workspaces`, `spec.results`, and
  (for Pipelines) `spec.tasks`/`spec.finally` names. Unknown or misspelled
  names get a warning with a "did you mean" suggestion (Levenshtein
  distance) and a quick fix to apply it.
- **Duplicate-name validation** — duplicated `name` fields in `params`, `workspaces` or `results`, as well as `tasks` and `finally` lists, are checked against.
- **Task-level workspace binding validation** — Works the same way as parameter validation.
- **Schema validation** — unknown/missing keys and wrong types or enum values are checked against
  Tekton's own schemas (`schemas/`), on top of the reference checks above. Works on Helm-templated
  files too, without flagging a masked `{{ ... }}` value as the wrong type.
- **Schema-aware completion** — suggests valid keys wherever the cursor is (e.g. `script`/`image`
  inside a step), not just inside `$(...)`.
- **Missing-`runAfter` hint** — an informative hint if omitting runAfter when 
  referencing the result from an earlier task (if the user wants to make the order explicit).
- **Tekton Triggers support** — `EventListener`/`Trigger`/`TriggerTemplate`/
  `TriggerBinding`/`ClusterTriggerBinding` get the same reference validation,
  highlighting, hover, Go to Definition, Find All References, and Rename as
  Pipelines/Tasks: `$(tt.params.NAME)` inside a TriggerTemplate's
  `resourcetemplates` validates against its own declared params, and an
  EventListener/Trigger's `bindings[].ref`/`template.ref`/`triggerRef`
  resolve cross-file the same way `taskRef`/`pipelineRef` do.
  `$(body...)`/`$(header...)`/`$(extensions...)` in a TriggerBinding's
  `value:` are recognized and highlighted but never validated — there's no
  declared schema for the incoming webhook payload to check them against.
- **Context-aware completion** — typing `$(params.` (or `workspaces.`,
  `results.`, `tasks.`, `context.`) suggests what's valid there:
  declared names for the current document, filtered by resource kind, narrowing to leaf
  fields once a name is chosen (`workspaces.x.path|claim|volume|bound`,
  `context.pipelineRun.name|namespace|uid`, ...). `$(tasks.X.results.` is
  resolved against the Task `X`'s `taskRef` points at — including
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
  reference to its declaration; for `$(tasks.X.results.Y)`, `Y` resolves
  cross-file to the referenced Task's declared result. 
  References to a Task's result or a Task/Pipeline's own
  identity (`taskRef`/`pipelineRef`) search the whole workspace, and — since
  this is read-only — show every matching candidate when a name is
  ambiguous rather than guessing at one.
- **Rename (F2)** — params, workspaces, and pipeline task aliases rename
  within their own file. A Task's declared result and a Task/Pipeline's own
  identity (`metadata.name`, referenced by `taskRef`/`pipelineRef`) rename
  **workspace-wide by default**, invocable from either the declaration or
  any reference to it. If a reference is _ambigous_, renames will only apply 
  locally at the point of declaration, and renames cannot be performed at
  the point of use, unless the reference is _unambigous_.
- **Commands** (Command Palette or editor context menu) resolve *where* to
  insert from the document's structure rather than cursor position,
  wherever that's well-defined; where it genuinely isn't (which task, which
  step — there can be several), the cursor is a fast path and a picker is
  the fallback:
  - `Tekton: Add Parameter` — always appends last in the params list, and
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
  - `Tekton: Bind All Parameters to Environment Variables` — same target
    picker, but offers every not-yet-bound param at once via a pre-checked
    multi-select, with env var names auto-derived and deduplicated. Faster
    than one-at-a-time when a step needs most of a Task's params as env
    vars, the common case.
  - `Tekton: Edit Task Script` — when in the context of a script block, use this
    to edit the contexts of the script in a separate file, letting you take advantage
    of whatever tooling you have for that script language. The file extension is inferred
    from the shebang used in the script.

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Then open this folder in VS Code and press F5 to launch an Extension
Development Host. The domain/parsing logic under `src/tekton/` and
`src/commands/snippetText.ts` has no `vscode` dependency where it doesn't
need one, so most of it is sanity-checked directly with Node — see
`test-fixtures/check.js`, which also end-to-end-simulates each editing
command's output and round-trips it through the real `yaml` parser rather
than relying on eyeballing the editor:

```bash
npm run lint    # eslint
npm test        # compiles, then runs test-fixtures/check.js (exits non-zero on failure)
```

## Status

Early, unstable, and still mostly LLM-trash, but functional and better than nothing.

## References

- [Tekton Pipelines variables](https://tekton.dev/docs/pipelines/variables/)
- [Tekton Pipeline API](https://tekton.dev/docs/pipelines/pipelines/)
- [Tekton Task API](https://tekton.dev/docs/pipelines/tasks/)
- [Tekton Triggers](https://tekton.dev/docs/triggers/)
- [Helm template functions](https://helm.sh/docs/chart_template_guide/function_list/)
