# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- "Bind All Parameters to Environment Variables" command
- Rename support for a step's `ref` (StepAction identity), cross-file

### Fixed
- Workspace rename didn't update or work from task-level `workspace:` bindings
- Task-alias rename didn't update or work from other tasks' `runAfter:` entries

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
