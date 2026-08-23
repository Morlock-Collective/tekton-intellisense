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

Three rename gaps closed after the README's claims turned out not to
match reality for anything outside `$(...)` syntax: a task's `workspaces:
[{name, workspace}]` binding and another task's `runAfter: [name, ...]`
entry are both plain YAML fields, not `$(...)` refs, and neither
`resolveRenameTarget` nor `sameDocumentEdits` accounted for them at all —
fixed by teaching both about these fields directly. Separately, a step's
own `ref: { name }` (pointing at a shared `StepAction`) now renames too,
reusing the existing `task-identity` machinery since a StepAction already
shares Task/ClusterTask's identity namespace. And a Task's declared param
now renames across a `taskRef`'d binding's `name:` field (a Pipeline task
entry's own, or a TaskRun's), mirroring how a Task's declared *result*
already cross-file-renamed via `$(tasks.X.results.Y)` — just for a plain
field instead of `$(...)` syntax. Deliberately not covered: a Pipeline
task entry using an inline `taskSpec` (its params bind to its own
same-document declaration, a different case) and PipelineRun/Pipeline
params (the identical gap one level up — see Next up).

**Editing commands** (Command Palette / context menu) — all resolve
*where* to insert from the document's structure rather than cursor
position, wherever that's well-defined (`Add Parameter`, `Add Task`);
where it genuinely isn't (`Add When Expression`, `Bind Parameter to Env
Var` — there can be multiple tasks/steps), the cursor is a fast path and a
picker is the fallback.

**Bind All Parameters to Environment Variables** — `bindParamToEnv`
one-at-a-time was a bottleneck when a step genuinely needs most of a
Task's declared params as env vars, the common case while first wiring up
a step. Picks a step/sidecar (same cursor-first/picker pattern), excludes
params already bound there (detected via an existing `$(params.NAME)`
value, not just by env var name), then offers the rest through a
multi-select QuickPick pre-checked so accepting all of them is a single
Enter and dropping a few is a handful of clicks — both faster than adding
them individually. Env var names are auto-derived and deduplicated against
both each other and whatever's already in that step's `env:` list
(`FOO_2`, `FOO_3`, ...), so two params that happen to derive to the same
name (`image-tag`/`imageTag` → `IMAGE_TAG`) don't silently collide.
`bindParamToEnv`'s own step-resolution and env-splicing logic moved to
`editUtils.ts` so both commands share it exactly rather than drifting.

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
highlighted but never validated — see Known limitations. An
EventListener/Trigger↔TriggerTemplate param-wiring check is follow-up
work, not part of this pass — see Next up.

**Trigger completions** — `$(tt.params.` (against the TriggerTemplate's own
declared params) and top-level `$(tt`/`$(uid`/`$(body`/`$(header`/
`$(extensions`/`$(context` namespace completion, reusing the existing
`$(...)`-triggered provider now made kind-aware (it no longer offers
Pipeline/Task namespaces like `params`/`tasks` inside a Trigger-family
document). `bindings[].ref`, `template.ref`, and `triggerRef` — plain YAML
scalars, not `$(...)` — get completion too, resolved workspace-wide via
`workspaceIndex.ts` the same way their "unknown ref" diagnostic already is;
the same treatment was extended to the pre-existing `taskRef.name`/
`pipelineRef.name` gap while in there. Body/header/extensions/context paths
past the top-level namespace aren't completed — same reason they aren't
diagnosed as unknown (no declared schema for the incoming webhook payload).

**Edit Task Script** (`scriptEmbed.ts`, `commands/editTaskScript.ts`) — a
step/sidecar's `script: |` block gets its shebang sniffed to infer a
language (bash/sh/zsh/dash/ksh, python(2/3), node, ruby/perl/php/lua), then
the "Tekton: Edit Task Script" command (Command Palette / editor context
menu, cursor-first with a step/sidecar picker fallback — same pattern as
`bindParamToEnv`/`addConditional`) pops its dedented content out into a
real scratch file with the matching extension under the OS temp directory.
Opened normally as an ordinary editor tab, it gets full native language
support from whatever extension is installed (Pylance, etc.) — no
bridging, no headlessly querying another extension's providers. Saving the
scratch file re-indents its content back into the YAML block (re-resolved
by the step's own name, not a captured position, since the host document
may have changed since the scratch file was opened), surfaces the host
document at that position, and closes the scratch tab.

`$(...)` Tekton refs are masked to same-length placeholders before writing
the scratch file's *analysis* content, mirroring `helmMask.ts`'s approach
to `{{ }}` — except for shellscript, where `$(...)` is valid native bash
command substitution and masking it would replace legitimate syntax with
something less likely to parse. Masking never touches what's written
back on save, though — `rawContent` (always unmasked) is round-tripped,
so a script that still inlines `$(params.X)` keeps working exactly as
written; a version bridging live IntelliSense directly into the YAML
editor via a virtual/scratch document queried headlessly was attempted
first and abandoned — every request needed a language server's first-ever
look at a brand-new document, which in practice just meant permanently
empty results, not occasionally slow ones. Reused the same
shebang-detection/dedent/offset-math groundwork afterward, since that part
was never what was broken. The `os.tmpdir()` scratch location took three
attempts to settle on (see Notable bugs below) and is now confirmed
working on both Linux and Windows.

**Embedded Helm templates inside a script block** — a standalone Helm
control-flow line (`{{- if }}`, `{{- end }}`, ...) written *inside* a
`script: |` block, at less indentation than the rest of the script (a
common authoring style), broke the block scalar exactly like it would
break any other YAML structure: everything past that line silently fell
out of the block, and the underlying document actually failed to parse
(`YAMLParseError`s recovered from best-effort, producing genuine
corruption — a bogus sibling key like `"echo more": null` on the step
map). helmMask.ts now re-indents such a line to the *lesser* of its
immediate before/after neighbors' own indentation, instead of always
preserving its original column — not a required exact match between the
two (a control line sitting between a nested `if`'s body and the
script's own base indentation legitimately has two differently-indented
real neighbors; since both are assumed to already be part of the same
enclosing block, the smaller of the two is still safely at or beyond
that block's true indentation). Masking can only ever *redistribute* the
characters already on that line (adding or removing any would shift
every offset after it), so this safely declines whenever there isn't
room, falling back to the old behavior rather than guessing.
`MaskedAction` exposes exactly what got masked and where, so a caller
like `scriptEmbed.ts` can find one that landed inside its own block
scalar.

With the block now parsing as one continuous whole, `scriptEmbed.ts`
shows each embedded template as a single-line comment in whatever syntax
the script's own language uses (`#`, `//`, or `--`) — with the *actual*
template text visible right there for context, not a generic
placeholder, since that's far more useful to read while editing. What
write-back actually keys off, though, is an invisible id encoded right
before that visible text (fixed-width binary, one of two zero-width
characters per bit, bounded by two more invisible marker characters —
built via `String.fromCharCode` in the source rather than written as
literal characters, which would be unreviewable by eye and at risk of
an editor/formatter normalizing or stripping them on save). That
indirection is what lets a marker line be edited or annotated by the
user — even the visible template text itself — without corrupting what
actually gets restored: `restoreTemplateGaps` only ever writes back the
gap's real, stored `original`, found by decoding whichever line still
carries that invisible id, never whatever visible text surrounds it.
Matching by counting marker occurrences instead of by id was an earlier
version's bug, caught by testing a deliberate mid-block deletion:
removing an earlier marker silently shifted every later one onto the
wrong template. A marker line deleted entirely still simply isn't
restored, matching ordinary editing semantics.

Since editing a marker's visible text has no effect on the host (only
the invisible id does), the save handler also applies
`refreshTemplateGapMarkers` to the scratch file itself right after
write-back, snapping every marker back to its true rendering — writing
straight to disk rather than through a `WorkspaceEdit` against the
just-saved, about-to-be-closed buffer, so the correction is what's
actually there next time the block is reopened. Without this, a stale
edit to a marker (it has no effect either way, so nothing signals it's
wrong) would just sit in the scratch file indefinitely across sessions,
looking like it meant something.

Each `MaskedAction.original` captures its line's own original
indentation (not just the bare `{{ ... }}` text), and write-back
splices it back in completely unmodified — restoring a gap is a no-op
on that text, never a second, unrequested edit of its own (an earlier
version normalized it to the script's own indentation instead, which
looked plausible but rewrote a line the user never touched).

**TriggerTemplate param-wiring check** (`diagnostics.ts`) — flags an
EventListener trigger entry (or standalone Trigger) whose bound
TriggerTemplate declares a required param (no `default`) that none of its
bound TriggerBindings actually provide by name. Unlike a typo'd reference,
Tekton doesn't reject this until the resourcetemplate is instantiated at
runtime, so it's otherwise easy to only discover by watching a TriggerRun
fail. Accounts for `bindings[]` entries that provide a value inline
(`{name, value}`, no `ref:`) as well as `ref`-based ones — a real, fairly
common shorthand that `model.ts` previously only tracked for `ref`-based
entries (rename/hover/definition legitimately don't need the inline form,
since there's no separate resource to navigate to, but this check does
need to count what they provide). Skipped entirely, not guessed at, when
the template or any bound TriggerBinding doesn't resolve at all —
`checkTriggerRefs` already flags that separately.

**Multi-document YAML support** — a single file with more than one
`---`-separated resource (a common kubectl-apply/kustomize-build bundling
pattern) is now fully supported, not just tolerated: `parseTektonFile()`
(via `parseAllDocuments`) returns one `ParsedTektonDoc` per recognized
resource in the file, all sharing one `text`/`lineCounter` but each with its
own `range` marking which slice of the file is actually theirs. Every
whole-file scan (`$(...)` ref search, `findParamRefs`) is scoped through
`paramRefsIn()` to a single resource's own range, so siblings in the same
file never leak references into each other. Every position-based feature
(hover, go to definition, completions, rename, code actions, the editing
commands) resolves "which resource is the cursor actually in" via
`findResourceAt()`; features with no single cursor to consult (diagnostics,
highlighting, cross-file scans in `workspaceScan.ts`) run across every
resource in the file instead. `workspaceIndex.ts`'s live index now keys
each entry by resource (`uri#docIndex`), not by file, so two resources of
the same kind sharing one file are tracked independently — including the
existing same-name ambiguity handling, which now also covers two resources
sharing a name *within* one file, the same way it already covered two
files sharing a name.

**Task param-wiring check** (`diagnostics.ts`) — flags a Pipeline task
entry's (or TaskRun's own) `taskRef` when the referenced Task/ClusterTask
declares a required param (no `default`) that the entry's `params:`
binding doesn't provide by name. Same shape as the pre-existing
TriggerTemplate param-wiring check, one level down — Tekton doesn't reject
a missing required param until the PipelineRun/TaskRun actually runs, so
it's easy to only discover by watching one fail. Skipped entirely when the
taskRef doesn't resolve at all (no check flags that on its own today) or
for a Pipeline task entry using an inline `taskSpec` instead of `taskRef`
(binds to its own same-document declaration, a different case). Emits one
diagnostic per missing param (not one aggregating the whole list), each
carrying a `taskRefName`/`paramName` pair in its `code` so
`codeActions.ts` can offer quick fixes: add the binding right here
(pre-filled with a placeholder value to fill in), add a `default:` to the
Task's own declaration instead — satisfying every binding at once rather
than just this one, cross-file and even when that file isn't open
(positions built from the resolved record's own `lineCounter`, not the
current document's) — or, once a task entry is missing more than one,
add all of them in a single edit instead of one quick fix apiece
(diagnostics sharing the same taskRef range are grouped for this, not
just sharing a `taskRefName`, since two different entries in one document
could reference the same Task).

**Schema-driven structural diagnostics and key completion**
(`jsonSchemas.ts`, `schemaValidation.ts`, `schemaCompletions.ts`) — the
first two-thirds of the JSON Schema investigation from earlier (see
`schemas/README.md`): validates each resource against its matching
schema via `ajv`, and offers "what key goes here" completion by walking
the AST and the schema in parallel. Complementary to the hand-rolled
domain model, not a replacement — schema validation catches wrong shape
(`scirpt:`, a required key missing, an enum typo) that no amount of
cross-reference checking would; the existing checks catch dangling
references (an unknown param/workspace/taskRef) that a static schema
can't express at all.

Two things needed fixing before either was usable: the
Kubernetes-generated schemas never set `additionalProperties: false`
themselves (CRDs traditionally prune or preserve unknown fields rather
than rejecting them), so `jsonSchemas.ts` tightens every object schema
that doesn't already say otherwise before compiling it — otherwise a
typo'd key would just silently pass. And Helm-masked values (`{{ ... }}`
collapses to `null` when a directive stands alone on its own line, or to
a same-length run of `x`s inline) produced real false positives (a
`labels: {{ include ... }}` map masking to a bare scalar, tripping a
"must be object" error) until `schemaValidation.ts` learned to recognize
and suppress exactly that shape, on a Helm-templated document only.

Key completion piggybacks on the exact same path/schema-walking logic:
`findEnclosingMap` finds the map the cursor is in, `pathTo` records how
it got there from the document root, `schemaAt` walks the schema through
that same path. The one asymmetry worth noting: a *blank* line (the
common "cursor here, about to type a new key" trigger) has no committed
structure for YAML to have parsed at all until either more content
commits it or the enclosing block closes, so `findEnclosingMap` finds
nothing right at such an offset even when a human reading the file would
have no doubt which map it belongs to — worked around by backscanning to
the nearest real content's own position and asking there instead, which
recovers the single most common case (typing at the end of an existing
block) at the cost of not being able to tell "still this block" from
"starting a new, more deeply nested one" from a blank line alone.

**CEL expression validation** (`celExpr.ts`) — flags syntactically broken
`cel` interceptor expressions (`filter`, each `overlays[].expression`) in
EventListener triggers and standalone Trigger resources, via a real
recursive-descent parser against CEL's published grammar
(google/cel-spec). Not semantic validation — param types aren't known
statically (Tekton doesn't type `body`/`header` beyond "some JSON"), so
this never rejects on type grounds, only on shapes no CEL program can
have regardless of types. Chosen over the one CEL-aware npm package
(`cel-js`) after confirming its public API exposes only string error
messages with no token/offset information, which would leave every
diagnostic anchored at the whole expression regardless of the ~160KB it'd
add to the bundle — a hand-rolled parser costs nothing extra and reports
the exact token that didn't fit.

An earlier version of this was a pile of character-level heuristics
(bracket balance, string termination, then a bolted-on "can't start/end
on an operator" check added after live testing found a gap: a trailing
`==` with nothing after it went unflagged). That approach kept finding
new gaps one report at a time — a real parser closes the whole class at
once (e.g. two adjacent operands with no operator between them, which
the heuristic never checked at all since a generic adjacency rule risks
a false positive against CEL's `in` operator). Maps issues back to
precise source ranges by re-slicing the raw text at the scalar's decoded
value and verifying the match — falling back to the whole-scalar range
only for the rare case (escaped quotes, block scalars) it can't map
exactly, rather than ever guessing a wrong position.

**CEL syntax highlighting** (`celSemanticTokens.ts`) — colors the same
`filter`/`overlays[].expression` strings, via a
`DocumentSemanticTokensProvider` rather than a TextMate grammar
injection (the mechanism `syntaxes/tekton-refs.injection.json` uses for
`$(...)` refs). A grammar couldn't scope itself safely here: the CEL
expression sits under a bare `value:` key, one of the most generic,
ubiquitous keys in Tekton YAML, so a regex-based grammar would end up
highlighting unrelated strings. The semantic tokens provider instead
rides on the exact same structural knowledge already built for
validation (`findCelExpressions` + `celExpr.ts`'s real lexer), so
there's no scoping ambiguity — every highlighted range is a genuine CEL
expression location, nothing pattern-matched. Uses only VS Code's
*standard* semantic token types (string/number/keyword/operator/
variable/function/property), so themes color them with no extra
`semanticTokenScopes` contribution needed.

Both validation and highlighting need to map an offset in the CEL
expression's *decoded* value back to the raw source, to anchor a
diagnostic or a highlight token precisely. That mapping (`celExpr.ts`'s
`mapValueIntoSource`) originally only handled plain/quoted scalars
(verify the decoded value is a literal substring right after any opening
quote, same "verify not assume" pattern as everywhere else in this
codebase). A `filter`/`expression` written as a block scalar (`expression:
|` or `expression: >`) decodes completely differently — falling outside
that check entirely, so every issue silently fell back to the whole-
scalar range and highlighting (which can't use that same fallback for
multiple overlapping tokens) produced nothing at all. Fixed by giving
block scalars their own per-line reconstruction, mirroring
`scriptEmbed.ts#buildScriptBlock`'s technique: dedent each content line,
rebuild what the decoded value *should* be, and only trust the mapping
if that reconstruction matches the real decoded value byte-for-byte.
`|` (literal) is exact. `>` (folded) only attempts the common shape —
one paragraph, no blank lines — since YAML's actual folding rules have
further exceptions (blank lines, over-indented lines) this doesn't
attempt to replicate; anything more exotic safely falls back to the
old whole-scalar/no-highlighting behavior rather than mapping to a
wrong position.

Two more checks ride on the parser without becoming real type-checking:
`true`/`false`/`null` are lexed as their own literal token type rather
than as identifiers, matching CEL's actual grammar — so `2.true` is
rejected the same way `2.foo(` would be (a member name has to be a real
identifier), no type inference involved. And each precedence level
optionally returns a "this reduced to exactly one literal token, nothing
else" result bubbled up from `parsePrimary`, which lets the ternary
production compare its two branches' literal kinds when *both* happen to
be bare literals (`cond ? true : 234` — bool vs number, rejected) while
backing off the moment either branch is anything else (a param, a member
access, a call) rather than guessing at a type it can't know.

**Cluster-shared resources** (`clusterResources.ts`, `clusterIndex.ts`) —
referencing a Task/Pipeline/StepAction/Trigger-family resource that lives
outside the workspace entirely, in another namespace on the cluster, is
normal practice on Kubernetes/OpenShift (a shared "catalog" synced or
copied into every namespace, referenced by plain name). Configurable via
`tektonIntellisense.clusterResources.*`: `command` (`kubectl`/`oc`, path
or bare name), `sources` (the namespace × kind matrix to pull from —
edited directly in `settings.json`, or through `Tekton: Configure Cluster
Resources`'s `showQuickPick({canPickMany: true})` checkbox flow, since VS
Code's native settings GUI has no real matrix widget), `refreshIntervalHours`
(default 24, "generally only rechecked daily" — 0 disables automatic
refresh; `Tekton: Refresh Cluster Resources` always forces one
regardless), and `authCommand` (optional; `Tekton: Authenticate to
Cluster` runs it in an integrated terminal rather than headlessly, since
cluster login is commonly interactive — an SSO browser flow, a password
prompt).

Fetching is `execFile` only, never `exec`/shell interpolation, so nothing
here is exposed to shell-injection risk regardless of what a namespace
name or configured command path contains. One source failing (bad
namespace, no RBAC, cluster unreachable) doesn't block the others — each
is fetched independently, a background (interval-timer) refresh's errors
go to an output channel rather than an unprompted popup, while a manual
refresh — and a refresh triggered by changing the `clusterResources`
settings themselves, whether through `Tekton: Configure Cluster
Resources` or by hand in `settings.json` — reports success/failure
visibly. The two were originally treated the same (silent), which meant
configuring a source with a typo'd namespace, wrong RBAC, or no
`kubectl` on `PATH` looked identical to it working — nothing in the UI
said otherwise; fixed by treating "the user just changed this setting"
the same as an explicit manual refresh, since both are deliberate
actions that deserve a visible outcome. Authentication itself is left
entirely to the user's own kubeconfig/session; this extension never
touches credentials.

Also found by live testing: a `kubectl` that only exists as a shell
alias or function (works fine typed at a prompt) fails with a raw
`spawn kubectl ENOENT`, once per (namespace, kind) pair, and nothing in
the message hints why — `execFile` never goes through a shell, so it
genuinely can't see an alias/function that only exists inside one.
`fetchClusterResources` now runs `<command> version --client` once as a
pre-flight check before attempting any real fetch; on an actual ENOENT
(and only that — a command that exists but fails `version --client`
for some unrelated reason, an old client or a wrapper script with its
own exit code, isn't treated as "missing," the real fetches still get
a chance to run) it short-circuits to one message suggesting the
alias/function possibility directly, rather than the same unexplained
ENOENT repeated per source.

`command` also accepts a wrapper-plus-subcommand line, not just a bare
executable — `microk8s kubectl` being the concrete case that came up,
but the same shape covers similar tools generally.
`splitCommandLine` tokenizes it (double-quoting a token that itself
contains spaces, e.g. a Windows install path — no other shell syntax,
since this deliberately never goes through a real shell) into an
executable plus fixed leading arguments, prepended to every actual
invocation. Both the pre-flight check and the real per-source fetches
go through the same `runCommandLine` helper, so this isn't a special
case either had to handle separately.

A fetched resource has no real workspace file, but Go to Definition still
needs somewhere to jump to — each gets a synthetic, read-only
`tekton-cluster:` document (its own `TextDocumentContentProvider`), built
by re-serializing the fetched resource as YAML (stripped of server-only
bookkeeping like `status`/`resourceVersion`/`managedFields`) and running
it through the exact same `parseTektonDocument` every real file goes
through — so its `IndexedResource` is indistinguishable in shape from a
workspace one anywhere else in the codebase, and only `uri.scheme` marks
it as external.

That's what keeps the integration surface narrow: `TektonWorkspaceIndex`'s
lookup methods gained a cluster-index fallback (a local, in-workspace
declaration always wins on a name collision — no surprise shadowing of
what's actually in front of the user), and since diagnostics, completion,
hover, and Go to Definition all already go through those same methods,
none of them needed any change at all beyond that. `TektonRenameProvider`
got exactly one new guard — reject a rename outright, clear error
message, whenever the resolved record turns out to be cluster-fetched —
applied both to renaming such a document directly and to renaming a local
reference that resolves to one; its various cross-file "is this name
ambiguous" checks were also corrected to count only local files, so a
coincidental name collision with a cluster resource doesn't wrongly block
an otherwise-unambiguous same-workspace rename. Hover's identity card
gains one line for a cluster-fetched result: which namespace it came
from, and that it's read-only.

**Unknown taskRef/pipelineRef validation** (`diagnostics.ts`) — a Pipeline
task entry's (or TaskRun's own) `taskRef`, and a PipelineRun's own
`pipelineRef`, are now flagged with a "did you mean" suggestion when the
name doesn't resolve to anything, the same check `checkTriggerRefs`
already did for TriggerBinding/TriggerTemplate/Trigger refs. Found while
testing cluster-shared resources (above) — surfaced by that work, but not
actually specific to it: it turned out there had never been a check here
at all, for purely local, no-cluster-involved workspaces either. Two
other checks' doc comments referenced this ("an unresolved taskRef isn't
flagged by any check today") as their reason for silently skipping an
unresolved taskRef rather than guessing at its params — both updated to
point at the new check instead, now that the gap they were describing is
closed. Extracted the shared "does this identity resolve, and if not
what's the closest match" logic into one `flagUnknownIdentityRef` helper
used by both checks, rather than duplicating it a second time.

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
- Only literal block scalars (`script: |`) are supported for "Edit Task
  Script" — folded (`>`) and quoted/plain scripts are left alone, since
  the dedent math needs consistent per-line indentation to strip.

## Next up

- [ ] PipelineRun/Pipeline param rename: a PipelineRun's own `spec.params`
      binding (when using `pipelineRef`) should cross-file-rename against
      its Pipeline's declared param, same shape as the Task-param rename
      just added one level down.
- [ ] Schema-driven hover: structural diagnostics and key completion (see
      "Done" below) are wired up; hover on a key showing its schema
      description is the remaining piece of the original three-part ask.
- [ ] Recognize Tekton's `resolver: cluster` remote-resolution `taskRef`/
      `pipelineRef` shape specifically. Cluster resources (below) currently
      match against a plain `taskRef: {name: ...}` regardless of resolver
      syntax, which covers the common "synced copy in every namespace"
      pattern without needing to parse resolver params — but doesn't
      recognize the resolver shape itself as a reference at all yet.
- [ ] Cluster resources don't persist across a VS Code window restart —
      each new window does one fetch at startup, deliberately (see "Done"
      below for why). Worth reconsidering if that first-fetch latency ever
      turns out to matter in practice.

Publishing to the VS Code Marketplace / Open VSX is being done manually by
the maintainer once a release is judged stable — not tracked here.
