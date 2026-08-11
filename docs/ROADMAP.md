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

## Milestone 1.3 — Hover provider (done)

- [x] `src/tekton/hover.ts`: hovering either a declaration site (a `name:`
      value in `spec.params`/`workspaces`/`results`/`tasks`) or a reference
      site (anywhere inside a `$(...)` expression) shows the same
      information — type, description, default for params; description/
      optional for workspaces; description/type for results. Hovering a
      `$(tasks.X...)` reference or its declaration shows the resolved
      `taskRef` and, via the workspace index, that Task's actual declared
      results (or an explicit "not indexed" note if it can't be resolved).
      Hovering `$(context.*)` shows a short built-in description pulled
      from `src/tekton/contextVariables.ts`, which is now the single shared
      source of context-variable data for both hover and completions (was
      duplicated between the two before this).
- [x] `model.ts` extraction was widened to keep `type`/`description`/
      `default` for params, `description`/`optional` for workspaces, and
      `type`/`description` for results — this is the data the hover cards
      render, and it's picked up for free by anything else that reads
      symbols (completions already show it as item detail).

## Milestone 1.4 — Definition + references providers (done)

- [x] `src/tekton/definitions.ts`: "Go to Definition" on a `$(...)`
      reference jumps to its declaring `name:` field. For
      `$(tasks.X.results.Y)`, jumping from `X` goes to this Pipeline's own
      `spec.tasks[]` entry; jumping from `Y` resolves cross-file through
      `workspaceIndex` straight to the actual Task's `results[].name` —
      even in a file that was never opened, since the index now keeps each
      indexed Task's full parse (including its `yaml` `LineCounter`) rather
      than just its symbol table, which is what lets an offset in that
      file's source be turned into a precise `Range` without needing a
      `TextDocument` for it.
- [x] `src/tekton/references.ts`: "Find All References" from either a
      declaration or a use collects every `$(...)` reference to that name
      in the current document (plus the declaration itself, when VS Code's
      `includeDeclaration` is set).
- [x] `workspaceIndex.lookupTask()` kept its existing signature (still
      returns just `TektonSymbols`, for completions/hover); added
      `lookupTaskRecord()` alongside it returning `{ uri, parsed }` for the
      cross-file Location math definitions needs.

## Milestone 1.5 — Duplicate-name validation (done)

- [x] `src/tekton/duplicates.ts`: a small, `vscode`-free
      `findDuplicateGroups()` helper (same pattern as `levenshtein.ts` —
      pure logic, testable via plain Node, wired into `vscode.Diagnostic`
      only at the edges). Wired into `diagnostics.ts` to flag repeated
      names within `spec.params`, `spec.workspaces`, `spec.results`, and
      `spec.tasks`/`finally` (task names must be unique across both lists
      combined). Every occurrence past the first is flagged as an
      **error** (not a warning, unlike the "did you mean" checks) — unlike
      a misspelled reference, this is something the Kubernetes API server
      rejects outright at apply time, so there's no ambiguity about intent
      to preserve.

## Milestone 1.6 — Contextual authoring, take one: Add Parameter (done)

Fixed a real correctness bug in the editing commands, then used the fix to
redesign `Add Parameter` around the document's AST instead of the cursor.

- [x] **Bug**: multi-line inserts only applied the surrounding indent to the
      *first* line of an embedded multi-line template — every line after it
      kept only its own hardcoded relative indent, landing one nesting
      level too shallow. Root-caused to `insertIndentedSnippet` being fed
      pre-joined multi-line strings inline inside other template literals,
      where only the outermost prefix got applied. Replaced it with two
      unambiguous primitives in `src/commands/editUtils.ts` —
      `insertAtCursor` (first line stays put, every line after gets
      `indent`) and `insertBlockAfter` (every line, including the first,
      gets `indent`) — backed by pure, Node-testable text composition in
      `src/commands/snippetText.ts`. Every command that builds a multi-line
      insert now passes an array of *relatively* indented lines instead of
      a hand-spliced string, so getting the nesting right no longer depends
      on manually keeping two indent computations in sync.
- [x] **Bug** (found via the Node simulation added while fixing the above):
      a YAML node's range sometimes already includes its own trailing
      newline (observed on the last item in a block sequence) and
      sometimes doesn't, depending on what follows in the source. Inserting
      right at such an offset was therefore inconsistent — either gluing
      the new content onto the very next line with no separator, or
      duplicating the newline into a blank line. Fixed by
      `model.ts#trimTrailingNewline`, applied at every AST-derived anchor
      offset before inserting.
- [x] **Cursor independence**: `Add Parameter` no longer looks at the
      cursor at all. `model.ts#resolveParamsTarget` locates the correct
      owning map from the document's kind and structure alone, then the
      command always appends after the last existing entry (or creates the
      key fresh, right after the owning map's last existing key) —
      "added last in the list" now literally means last, regardless of
      where the cursor happened to be.
- [x] **Context sensitivity**: `resolveParamsTarget` distinguishes what an
      "add parameter" even means per resource kind. Pipeline/Task/
      ClusterTask/StepAction *declare* params (name/type/description/
      default) directly under `spec`. PipelineRun/TaskRun normally
      *provide* param values (name/value) under `spec` — but if they embed
      an inline Pipeline/Task via `pipelineSpec`/`taskSpec` rather than a
      `..Ref`, the command switches to declaration shape and targets the
      inline spec's own `params`, since that's a Pipeline/Task definition
      in every way that matters here.
- [x] Verified with an end-to-end Node simulation
      (`test-fixtures/check.js`) covering all seven shape/location
      combinations — existing/fresh param list × Pipeline, Task,
      PipelineRun (ref and inline), TaskRun (ref and inline) — each
      re-parsed with the raw `yaml` package afterward to confirm the result
      is valid YAML containing the new entry, not just eyeballed.

The same two bug classes (indentation, trailing-newline anchors) were also
present in `addTask.ts`, `addConditional.ts`, and `bindParamToEnv.ts` and
got the same fix, but those three commands still resolve *where* to insert
via the cursor (`findEnclosingMap` at the cursor offset) rather than a
`resolveParamsTarget`-style AST-only rule — that redesign is scoped to Add
Parameter for now; extending it to the others is natural follow-up work,
not yet done.

## Known limitations (v0.1)

- Task-level `workspaces: [{name, workspace: <pipeline-workspace-name>}]`
  bindings aren't validated yet — only `$(...)` substitutions are. This is
  a distinct reference kind (a plain field value, not a template
  expression) and needs its own check.
- The workspace index resolves Tasks by `metadata.name`; a Helm-templated
  name (e.g. `{{ include "chart.fullname" . }}-build`) masks to a non-
  matching placeholder, so cross-file result completion/definition silently
  comes up empty for such charts unless the taskRef itself is also a
  literal string — reasonable, since a templated name needs a templated
  reference to match it anyway.
- "Find All References" is scoped to the current document. Reverse lookup
  ("which Pipelines use this Task's `digest` result") would need indexing
  every Pipeline's `$(tasks.*.results.*)` usages, not just Task
  declarations — a second index alongside `workspaceIndex`, not yet built.
- No settings for custom Tekton API group/version allow-list (assumes any
  `tekton.dev/*`).
- `Add Parameter` doesn't special-case an existing `params: []` (flow-style,
  empty) list — it treats the list as present-but-empty and appends a
  block-style item right after it, which produces a second, disconnected
  `params:`-shaped block rather than converting the `[]` to block style.
  Rare in practice (nothing else in this extension writes `params: []` for
  `spec.params` itself — only `addTask`'s task-entry skeleton does, for a
  different list), but worth fixing properly rather than leaving silently.
- `addTask`/`addConditional`/`bindParamToEnv` got the same indentation and
  trailing-newline-anchor bug fixes as `addParameter`, but still resolve
  their insertion point from the cursor rather than the document's AST —
  see Milestone 1.6 above.
- `Add Parameter`'s binding shape (PipelineRun/TaskRun using a `..Ref`)
  always emits the value as a quoted YAML string. A param declared with
  `type: array` or `type: object` needs an array/object-shaped value, which
  a single free-text prompt can't represent safely — quoting a string is
  the correct behavior for the common case and doesn't regress anything
  (the old, unquoted version couldn't represent array/object values
  correctly either), but the UX doesn't yet ask for the param's declared
  type to adapt the prompt.

## Milestone 1.7 — Code review pass (done)

Set up ESLint (`eslint.config.js`, flat config, `typescript-eslint`
recommended + `no-floating-promises`/`eqeqeq`/`curly`) — clean on the
existing codebase bar one intentional `== null` idiom, allowed via
`eqeqeq`'s `null: "ignore"` option rather than rewritten awkwardly. Added
`npm run lint` and fixed `npm test` (previously pointed at a
`test/runTest.js` that was never implemented — an artifact of the initial
scaffold nobody had run; now runs `test-fixtures/check.js`, and that script
now actually exits non-zero on failure instead of only printing PASS/FAIL
with no enforcement).

Then a manual file-by-file review turned up several real bugs beyond
anything already tracked as a documented limitation:

- [x] **`helmMask.ts` could scramble line numbers.** A `{{ }}` action
      spanning multiple lines (legal Go-template syntax — e.g. a multi-line
      argument list) was replaced by a single-line run of `x` characters,
      collapsing every line after it by however many newlines the action
      contained. Every diagnostic/hover/decoration position past such an
      action in a Helm-templated file would land on the wrong line. Fixed
      by preserving embedded newlines in the replacement. Also deleted the
      `if (len <= 2)` branch that duplicated its own `else` (the "different
      handling" the docstring described had apparently never actually been
      implemented) and the unused `looksLikeHelmTemplate` export.
- [x] **`workspaceIndex.ts` let one file's edits delete another file's
      entry.** The Task index was keyed flatly by `metadata.name`; two
      files declaring the same name (a vendored/catalog Task like
      `git-clone` present in more than one chart is a completely normal
      occurrence, not a hypothetical) would silently overwrite each other,
      and — worse — a momentarily-invalid edit to *either* file (e.g. mid-
      keystroke) would wipe the *other* file's entry out of the index via
      the shared name key, breaking `$(tasks.X.results.Y)` resolution for
      a completely untouched file. Reproduced with a standalone script
      before and after the fix. Fixed by keying two levels deep (name →
      uri → record) so each file's entry can only ever be touched by edits
      to that same file.
- [x] **`extension.ts`'s diagnostic-refresh debounce was shared across all
      documents.** A single `debounce` timer variable meant editing two
      Tekton files within the same 250ms window silently dropped the
      refresh for whichever one wasn't edited last — its diagnostics could
      go stale until its next edit. Reproduced with a standalone timer
      script. Fixed with a per-document timer map (same pattern
      `workspaceIndex.ts` already used for its own reindex debouncing),
      and pending timers are now cleared on `deactivate()`.
- [x] **Editing commands didn't escape anything going into
      `vscode.SnippetString`.** Free-text input (a parameter description, a
      default value, a `when` expression) was spliced directly into
      snippet text passed to the `SnippetString` constructor, which treats
      `$1`, `${1:x}`, and `$NAME` as live tabstop/placeholder/variable
      syntax — a description as ordinary as "cost is $5" would have been
      silently reinterpreted instead of inserted literally. Fixed by
      building every snippet via `SnippetString#appendText`, whose
      documented contract is that the string is escaped, instead of the
      constructor — one fix in `editUtils.ts` covers all four commands,
      since they all funnel through `insertAtCursor`/`insertBlockAfter`.
- [x] **Editing commands also didn't escape anything going into generated
      YAML string scalars.** Separately from the snippet-syntax issue,
      values embedded in double-quoted YAML strings (`description: "..."`,
      `input: "..."`) weren't escaped for embedded `"` or `\`, and some
      free-text values (`Add Parameter`'s binding-shape value, `when`
      condition values) weren't quoted at all — either would produce
      invalid or silently-wrong YAML for realistic input (a value
      containing a colon, or pasted multi-line clipboard content, which
      `showInputBox` accepts even though it only displays one line). Added
      `snippetText.ts#quoteYamlString`, verified via round-trip through the
      real `yaml` parser for a battery of tricky inputs (quotes,
      backslashes, colons, `$`, embedded newlines, tabs), and applied it
      everywhere a free-text value is inserted. Also added the same
      Kubernetes-name `validateInput` that `addParameter`'s `name` field
      and `addTask`'s `taskName` field already had to `addTask`'s `taskRef`
      and `bindParamToEnv`'s `envName` — both are meant to be identifiers,
      not free text, so validating them at the source is more correct than
      merely escaping them.

## Milestone 1.8 — Rename (F2) (done)

- [x] `src/tekton/renameTarget.ts`: pure (`vscode`-free, Node-testable)
      detection of what's renameable at a given offset —
      `resolveRenameTarget()` — plus pure edit-computation helpers
      (`sameDocumentEdits`, `sameDocumentResultEdits`,
      `taskResultReferenceEdits`, `taskRefIdentityEdits`) that return plain
      `{range, newText}` edits rather than `vscode.TextEdit`, so the actual
      renaming logic is testable the same way the rest of the domain model
      is (`test-fixtures/check.js` applies the computed edits to real
      fixture text and re-parses the result, not just inspecting the edit
      list in isolation).
- [x] `src/tekton/rename.ts`: the `vscode.RenameProvider` wiring `F2` up
      to that logic. Scope is deliberately split by whether a name can be
      referenced from outside its own file:
      - **Same-document only** (param, workspace, pipeline task alias):
        rename the declaration and every `$(...)` reference to it in the
        current file. Renaming into a name already used by another entity
        of the same kind in the same document is rejected outright — that
        collision is unambiguous and Kubernetes schema validation would
        reject it anyway (same reasoning as the duplicate-name diagnostic).
      - **Cross-file, workspace-wide by default** (a Task's own declared
        `results`, and a Task's own identity — `metadata.name`, referenced
        by `taskRef.name`): renaming updates every file in the workspace
        that references it, not just the current one, resolved through the
        existing `workspaceIndex`.
      - Invoking rename from *either side* of a cross-file relationship
        works identically — F2 on a Task's own `results: - name: X`
        declaration and F2 on some Pipeline's `$(tasks.Y.results.X)`
        reference to it both resolve to the same canonical operation
        (rename the declaration, its self-references, and every
        referencing Pipeline's reference), via `workspaceIndex`'s existing
        `lookupTaskRecord()`.
- [x] **The duplicated-name trap, handled explicitly rather than papered
      over.** Two different Task files can legitimately share a
      `metadata.name` (a vendored/catalog Task like `git-clone` present in
      more than one chart), and Tekton itself can't tell them apart by
      name alone — so neither can this extension. Blindly rewriting every
      `taskRef.name`/`$(tasks.*.results.*)` reference to a shared name
      would silently repoint references that were actually meant for
      whichever file *didn't* get renamed. `workspaceIndex` gained
      `lookupAllTaskRecords()` (returning every match, not just the one
      `lookupTaskRecord()` deterministically picks) specifically so the
      rename provider can detect this before acting: when a name is
      ambiguous, the local declaration still renames, but cross-file
      reference updates are skipped with an explicit warning explaining
      why, rather than guessing. Renaming *into* an already-used Task name
      is allowed (warned, not blocked) rather than renaming *out of*
      ambiguity, which is unavoidably guesswork resolved the same way
      Tekton itself resolves it.
- [x] Verified via `test-fixtures/check.js`: same-document rename from a
      reference site (not just the declaration), cross-file result rename
      in both directions, a Task referenced by *two* pipeline tasks under
      different local aliases (both `taskRef.name`s must update, an
      unrelated third one must not), and the data precondition the
      ambiguity guard depends on (two fixture Task files genuinely sharing
      a `metadata.name`).

## Milestone 1.9 — Track pipelineRef, close the identity-rename symmetry (done)

Milestone 1.8 explicitly deferred Pipeline-identity rename because
`pipelineRef.name` wasn't tracked as a symbol at all. Closed that gap, and
along with it a matching gap on the Task side: `TaskRun.spec.taskRef.name`
(a single top-level field) wasn't tracked either — only a *Pipeline's*
per-task-entry `taskRef.name` was. Both are structurally identical "this
document points at another resource by name" fields, so both got the same
treatment in one pass rather than leaving the second half-done:

- [x] `model.ts`: `TektonSymbols` gained `pipelineRefName`/
      `pipelineRefNameRange` (populated for `PipelineRun`) and
      `taskRefName`/`taskRefNameRange` (populated for `TaskRun`) —
      deliberately named to collide with, but stay distinct from,
      `TaskSymbol.taskRefName` (which is per pipeline-task-list-entry);
      access is always through either `symbols.taskRefName` or
      `taskEntry.taskRefName`, never ambiguous at the call site. Extracted
      via a new shared `refNameAndRange()` helper, which also simplified
      the existing per-task-entry `taskRef` extraction.
- [x] `renameTarget.ts`: new `"pipeline-identity"` target kind, detected on
      a Pipeline's own `metadata.name` and on a PipelineRun's
      `pipelineRef.name` alike. `taskRefIdentityEdits()` now also matches a
      TaskRun's own top-level `taskRef` (previously only Pipeline
      task-entries); new `pipelineRefIdentityEdits()` mirrors it for
      PipelineRuns.
- [x] `workspaceIndex.ts`: generalized from a Task-only index to a
      `NameIndex` type reused for both Tasks and Pipelines
      (`byTaskName`/`byPipelineName`, kept as two separate maps — a Task
      and a Pipeline coincidentally sharing a name isn't actually
      ambiguous, since `taskRef` and `pipelineRef` resolve independently,
      and merging them would invent a collision that doesn't exist). Added
      `lookupPipeline`/`lookupPipelineRecord`/`lookupAllPipelineRecords`,
      symmetric with the existing Task lookups. `IndexedTask` renamed to
      `IndexedResource` now that it's not Task-specific.
- [x] `rename.ts`: added the `"pipeline-identity"` case (rename a
      Pipeline's `metadata.name`, update every `pipelineRef.name` across
      the workspace, with the same ambiguity guard as the Task-identity
      case). Generalized `findPipelineFiles()` into `findWorkspaceDocs(kinds)`
      so the Task-identity case's cross-file scan could be extended to
      cover `TaskRun` files too, not just Pipelines' per-task `taskRef`
      entries — a TaskRun's own `taskRef` is exactly as real a reference as
      a Pipeline task's.
- [x] Verified via `test-fixtures/check.js`: renaming a Pipeline from a
      PipelineRun's `pipelineRef.name` (not the declaration) updates both
      files correctly, and `taskrun-ref.yaml`'s own top-level `taskRef`
      renames correctly (a structurally distinct code path from the
      existing Pipeline-task-entry `taskRef` case, so it needed its own
      test, not just reuse of the existing one).

## Next up

- [ ] Extend the `resolveParamsTarget`-style AST-only targeting to
      `addTask`/`addConditional`/`bindParamToEnv`, replacing their
      cursor-based fallbacks the same way `addParameter` just was.
- [ ] Validate task-level `workspaces[].workspace` bindings against
      `spec.workspaces` (Pipeline) — same misspelling-suggestion UX.
- [ ] Cross-file "Find All References" from a Task's result declaration
      back to every Pipeline task-result usage across the workspace, and
      from a Task/Pipeline's own identity to every referencing
      `taskRef`/`pipelineRef` — `rename.ts`'s `findWorkspaceDocs()` would
      extend naturally to this.
- [ ] Diagnostic + quick fix for tasks missing `runAfter` when they
      reference another task's result (implicit vs. explicit ordering).
- [ ] Publish to the VS Code Marketplace / Open VSX.
