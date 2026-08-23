# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Cluster-shared resources: reference a Task/Pipeline/etc. defined only on the cluster (`tektonIntellisense.clusterResources.*` settings, `Tekton: Configure/Refresh Cluster Resources`, `Tekton: Authenticate to Cluster`) — resolves for completion/hover/Go to Definition/diagnostics, read-only; a refresh triggered by a settings change reports success/failure visibly rather than only logging it, a configured `command` that can't be found at all (a shell alias, commonly) gets one clear message instead of a raw `ENOENT`, `command` accepts a wrapper-plus-subcommand line like `microk8s kubectl`, and a `taskRef`/`pipelineRef`/step `ref` written using Tekton's `resolver: cluster` shape (not just a plain `{name: ...}`) is recognized too
- Unknown `taskRef`/`pipelineRef` names are now flagged with a "did you mean" suggestion, matching the check Trigger-family refs already had
- A task entry's (or TaskRun's own) `params: [{name, value}]` binding now suggests the resolved task's actual declared param names, excluding ones already bound — previously not hooked up at all, for any taskRef shape, and still not for a completely blank `name: ` (the most common case) until reworked to check the enclosing `params:` list's own range instead of the individual binding's
- Param, result, pipeline task/finally entry, step, and sidecar names are now checked against Tekton's own naming rules (e.g. no spaces, must start with a letter/underscore) — the schemas never caught this, since that validation lives in Tekton's admission webhook, not the CRD's OpenAPI schema
- `Tekton: Add Task to Pipeline` can now add a cluster-resolved task (Tekton's `resolver: cluster` shape) instead of only a local `taskRef: { name: ... }`, with the namespace picked from `tektonIntellisense.clusterResources.sources` or typed in, and left unspecified (falling back to the cluster resolver's own configured default) if you don't want to pin one

### Fixed
- `Tekton: Add Task to Pipeline` inserted the new task entry at the indentation of the *last existing task entry's own deepest last field* instead of the task list's own indentation, whenever that field was itself deeply nested (e.g. a cluster-resolver taskRef's own `params:` list) — producing invalid, wildly over-indented YAML. Root cause was `insertSnippet`'s automatic reindentation of multi-line snippet text to the current line; switched every structural insertion command to a plain text edit instead, which inserts exactly the (already correctly indented) text computed for it

## [0.8.0] - 2026-08-20

### Fixed
- CEL validation/highlighting now work for `filter`/`expression` written as a block scalar (`|` or `>`), not just quoted/plain strings
- Edit Task Script no longer cuts a script off at an embedded Helm template line (`{{- if }}`/`{{- end }}`/...); the template shows as a same-language comment (with the real template text visible for context) in the scratch file and restores exactly, unchanged, on save

## [0.7.0] - 2026-08-18

### Added
- Syntax validation for `cel` interceptor expressions (`filter`, `overlays[].expression`), via a hand-rolled parser against CEL's grammar
- CEL validation also flags a ternary whose branches are literally-typed and disagree (`cond ? true : 234`)
- CEL expression syntax highlighting (string/number/operator/property/function), via a semantic tokens provider

## [0.6.0] - 2026-08-17

### Added
- Schema-driven structural diagnostics: unknown/missing keys and wrong types/enums, validated against Tekton's own schemas
- Contextual key completion from the same schemas (e.g. suggesting `script`/`image` inside a step)
- `tektonIntellisense.enableSchemaValidation` setting (default on)
- Auto-indent after a line ending in `:` or a bare `-`, for `yaml`-language files that don't already get this from another extension (own Enter-key command, not `setLanguageConfiguration` -- see Fixed)

## [0.5.0] - 2026-08-17

### Added
- Diagnostic for a Pipeline task entry's (or TaskRun's) taskRef when the referenced Task requires a param (no default) that isn't provided
- Quick fixes for that diagnostic: add the missing param binding, add a default value to the Task's own declaration instead, or (when more than one is missing) add all of them at once

## [0.4.0] - 2026-08-17

### Added
- Multi-document YAML support — every `---`-separated resource in a file is now recognized (diagnostics, highlighting, hover, completion, go to definition, rename, find references, editing commands), not just the first

### Fixed
- A bunch of the renaming operations not working consistently, including workspaces, taskRef parameters, trigger template parameters, trigger binding names, etc.

## [0.3.0] - 2026-08-16

### Added
- "Bind All Parameters to Environment Variables" command
- Rename support for a step's `ref` (StepAction identity), cross-file
- Rename support for a Task's declared param against a `taskRef`'d binding's name, cross-file

### Fixed
- Workspace rename didn't update or work from task-level `workspace:` bindings
- Task-alias rename didn't update or work from other tasks' `runAfter:` entries
- The plain-scalar identity system (`taskRef`/`pipelineRef`/`template.ref`/`bindings[].ref`/`triggerRef`/a step's `ref`) and plain-field bindings (`workspace:`, `runAfter:`, a task's `params:`) were never highlighted, only `$(...)` syntax
- Find All References missed a step's `ref` (same narrow doc-kind scan rename had before its earlier fix) and didn't support task-param bindings at all

## [0.2.1] - 2026-08-16

### Fixed
- Helm-templated docs with a top-level `{{- if }}`/`{{- end }}` weren't recognized
- Steps inside a Pipeline task's inline `taskSpec` were invisible to step-scoped commands

## [0.2.0] - 2026-08-16

### Added
- Diagnostic for a TriggerTemplate's required params not covered by its bound TriggerBindings

## [0.1.0] - 2026-08-16

### Added
- Param/workspace/result/task domain model with reference highlighting and validation
- Duplicate-name and task-workspace-binding diagnostics
- Missing-`runAfter` hint with quick fix
- Context-aware `$(...)` completion, including cross-file task-result resolution
- Hover, Go to Definition, Find All References (cross-file)
- Rename (F2), workspace-wide with ambiguous-name handling
- Editing commands: Add Parameter, Add Task, Add When Expression, Bind Parameter to Env
- Full Tekton Triggers support (EventListener/Trigger/TriggerTemplate/TriggerBinding/ClusterTriggerBinding)
- Trigger completions and ref-name completion
- Edit Task Script command (edit a step's script in a real file with native tooling)
- Helm chart awareness via in-place template masking
- esbuild bundling

### Fixed
- Extension activation, packaging, and several early correctness bugs

### Changed
- Renamed from "tekton-aid" to "tekton-intellisense"
