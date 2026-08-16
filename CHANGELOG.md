# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bind All Parameters to Environment Variables** command — binds every
  declared parameter not already bound to a step/sidecar's `env:` list in
  one pass, via a pre-checked multi-select picker, instead of invoking
  `Bind Parameter to Environment Variable` once per parameter. Auto-derived
  env var names are deduplicated against each other and against the
  step's existing `env:` entries.

### Changed

- `Bind Parameter to Environment Variable`'s step/sidecar-resolution and
  `env:`-list-splicing logic is now shared with the new bulk command
  instead of being duplicated.

## [0.2.1] - 2026-08-16

### Fixed

- A Helm-templated document wrapped in a standalone top-level
  `{{- if ... }}` / `{{- end }}` block (a common way to conditionally
  include an entire resource) failed to parse at all, so the extension
  never activated for the file. Masking a directive that's alone on its
  own line now produces a YAML comment instead of a bare placeholder
  scalar, which YAML's parser was folding into an invalid multi-line
  implicit map key together with whatever content followed.
- Step/sidecar-scoped features (`Edit Task Script`, `Bind Parameter to
  Environment Variable`) didn't see steps inside a Pipeline task entry's
  inline `taskSpec:` — only a standalone `Task`/`TaskRun`'s own steps were
  recognized.

## [0.2.0] - 2026-08-16

### Added

- Diagnostic flagging an EventListener trigger entry (or standalone
  `Trigger`) whose bound `TriggerTemplate` declares a required parameter
  (no `default`) that none of its bound `TriggerBinding`s — inline or
  `ref`-based — actually provide. Previously only discoverable by watching
  a TriggerRun fail at runtime.

## [0.1.0] - 2026-08-16

Initial feature set.

### Added

- Domain model for `Pipeline`/`Task`/`ClusterTask`/`PipelineRun`/
  `TaskRun`/`StepAction`, extracting declared params/workspaces/results/
  tasks with precise source ranges.
- Highlighting for `$(...)` reference sites and their declarations.
- Reference validation: unknown/misspelled `$(params.x)` /
  `$(workspaces.x)` / `$(results.x)` / `$(tasks.x.results.y)` get a
  warning with a Levenshtein "did you mean" suggestion and a quick fix.
- Duplicate-name diagnostics for `spec.params`/`workspaces`/`results`/
  `tasks`/`finally`.
- Task-level `workspaces: [{name, workspace}]` binding validation against
  a Pipeline's declared workspaces.
- Missing-`runAfter` hint (with quick fix) when a task references another
  task's result without listing it in `runAfter`.
- Context-aware `$(...)` completion — declared names filtered by document
  kind and reference segment, including cross-file `$(tasks.X.results.Y)`
  resolution against the actual Task `X`'s `taskRef` points at.
- Hover info for declarations and references (params, workspaces, results,
  tasks, `$(context.*)`).
- Go to Definition and Find All References, cross-file for a Task's
  result and for Task/Pipeline identity (`taskRef`/`pipelineRef`).
- Rename (F2), workspace-wide by default, with explicit handling for
  ambiguous names shared by more than one file.
- Editing commands: `Add Parameter`, `Add Task to Pipeline`, `Add When
  Expression to Task`, `Bind Parameter to Environment Variable` — all
  resolve *where* to insert from document structure, falling back to a
  picker only where the target is genuinely ambiguous.
- Full Tekton Triggers support — `EventListener`/`Trigger`/
  `TriggerTemplate`/`TriggerBinding`/`ClusterTriggerBinding` get the same
  diagnostics/highlighting/hover/navigation/rename treatment as Pipelines
  and Tasks.
- Trigger completions: `$(tt.params.`, `$(uid)`, and
  `$(body`/`$(header`/`$(extensions`/`$(context` namespaces; completion
  for `bindings[].ref`/`template.ref`/`triggerRef` and (extending the same
  treatment) `taskRef.name`/`pipelineRef.name`.
- **Edit Task Script** command — detects a step/sidecar's `script:` block
  via its shebang, pops it out into a real scratch file with the matching
  extension so it opens with full native language tooling (hover,
  completion, etc. from whatever extension is installed), and writes edits
  back into the YAML on save.
- Helm chart awareness: `{{ ... }}` template actions are masked in place
  (same-length placeholders) rather than requiring a rendered chart, so
  diagnostics and navigation still point at exact source positions.
- esbuild bundling, cutting the packaged extension from hundreds of loose
  files down to a single bundle.
- MIT license, repository metadata, extension icon.

### Fixed

- Extension activation was broken outright (bad `package.json`
  contribution point, a broken grammar injection selector, packaging
  issues).
- Five further bugs found in a dedicated review pass (alongside adding
  ESLint).
- `Add Parameter` indentation, and made it context-aware and
  cursor-independent.
- Multi-line inserts only indented their first line correctly.
- Helm masking collapsed line numbers when a `{{ }}` action itself spanned
  multiple lines, shifting every diagnostic after it.
- Cross-file name collisions in the workspace index could silently evict
  an unrelated file's entry.
- A shared debounce timer for diagnostic refreshes could drop a refresh
  when two files were edited within the debounce window.
- Free-text input (descriptions, default values, `when` expressions) went
  unescaped into snippet syntax and generated YAML strings.
- Ambiguous cross-file rename could silently rewrite the wrong file.
- Cursor-position detection for the enclosing task/step could be fooled by
  a nested `params:`/`env:` item that also happens to have a `name` key.
- Appending to an existing `when:`/`runAfter:` list could produce YAML the
  parser rejected, from computing indentation by formula instead of
  matching the list's own.
- Hover and Go to Definition never resolved `taskRef`/`pipelineRef`
  plain-scalar identity references — only rename/references did.

### Changed

- Renamed the extension from "tekton-aid" to "tekton-intellisense".
