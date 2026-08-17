# JSON Schemas

Draft JSON Schema (draft-07) definitions for the Tekton/Triggers resource
kinds this extension recognizes, for eventual use as the basis of real
schema-driven validation/completion/hover — not wired into the extension
yet. See `docs/ROADMAP.md` for background on why: there's no official or
third-party source to just pull these from (see below), so they have to be
authored/maintained here.

## Scope: only the API versions this extension actually treats as current

- `v1/` — Pipeline, PipelineRun, Task, TaskRun. Their `v1beta1` counterparts
  are deliberately not kept alongside them: `v1` is the stable API for all
  four, and `model.ts` only ever emits/expects `tekton.dev/v1` for these
  kinds, so a `v1beta1` schema here would validate documents this extension
  doesn't itself consider current.
- `v1beta1/` — StepAction, CustomRun, ResolutionRequest: `v1beta1` is genuinely
  their current API version (StepAction hasn't been confirmed promoted to
  `v1` across the board as of this writing; CustomRun and ResolutionRequest
  aren't expected to be). Also every Triggers kind (TriggerBinding,
  ClusterTriggerBinding, TriggerTemplate, Trigger, EventListener) — the
  `triggers.tekton.dev` API group has no `v1` at all yet, so `v1beta1` is
  simply current for the whole group.

## Provenance

The `v1`/`v1beta1` Pipeline/Task-family schemas (pre-existing in this
folder) read like they were generated from the actual Go API types
(`pkg/apis/pipeline/*/*_types.go` in tektoncd/pipeline) — field
descriptions match the Go doc comments verbatim, down to
`x-kubernetes-list-type` annotations from `+listType` markers.

The Triggers-family schemas were hand-authored the same way, but by
reading the source directly rather than running codegen: cross-referenced
against `pkg/apis/triggers/v1beta1/*_types.go` in tektoncd/triggers
(`trigger_binding_types.go`, `trigger_template_types.go`,
`trigger_types.go`, `event_listener_types.go`, `param.go`, plus
`interceptor_types.go`/`cluster_trigger_binding_types.go` for the
`InterceptorKind`/`TriggerBindingKind` enums) as of August 2026. Tekton's
own CRD manifests (`config/300-*.yaml`) can't be used as a source for this
the way a more conventional operator's might: they set
`x-kubernetes-preserve-unknown-fields: true` at the schema root and carry
no real structural schema of their own — Tekton validates admission via Go
webhook code, not CRD-embedded OpenAPI, which is *why* nothing like this
already exists anywhere to just pull in (tektoncd/pipeline#4688 asked for
exactly that, upstream, and was closed stale with nothing produced; no
third-party CRD-schema catalog — e.g. datreeio/CRDs-catalog — carries
`tekton.dev`/`triggers.tekton.dev` entries either).

Deliberately simplified relative to full fidelity, scoped to what's
actually useful for *this extension's* purposes rather than a byte-perfect
Kubernetes API mirror:
- `EventListener.spec.resources.kubernetesResource.spec` (a raw
  `corev1.PodSpec` overlay) and `.customResource` (an arbitrary resource
  manifest) are typed as open objects, not expanded field-by-field.
- `TriggerTemplate.spec.resourcetemplates[]` entries and
  `InterceptorParams.value` are typed as open objects/any-JSON, matching
  their actual Go types (`runtime.RawExtension` /
  `apiextensionsv1.JSON` — genuinely unstructured).

## Corrections to the pre-existing drafts

`v1beta1/resolutionrequest.json`'s `apiVersion` enum was
`tekton.dev/v1beta1`; ResolutionRequest is actually
`resolution.tekton.dev/v1beta1` (a separate API group from core
Pipelines/Triggers), confirmed against Tekton's own docs. Fixed in place.
`v1beta1/customrun.json`'s `tekton.dev/v1beta1` was checked the same way
and is correct as-is.

## Known gaps

- No `v1alpha1` versions for any kind — this extension doesn't recognize
  `v1alpha1` documents at all (see `model.ts`'s `TEKTON_KINDS`/
  `TRIGGERS_KINDS`), so there'd be nothing to validate them against anyway.
- Interceptor/ClusterInterceptor aren't schema'd — `model.ts` doesn't
  recognize them as document kinds either (see `docs/ROADMAP.md`'s known
  limitations); an interceptor's `ref.name` is an unvalidated string
  throughout this extension today, schemas or not.
