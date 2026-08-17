/**
 * Loads the draft-07 JSON Schema (see `schemas/README.md` for scope and
 * provenance) matching a document's own `(apiVersion, kind)` pair, for use
 * by both {@link "./schemaValidation"} (structural diagnostics) and
 * {@link "./schemaCompletions"} (property-name completion). Deliberately
 * vscode-free and takes the schemas directory as an explicit parameter
 * rather than inferring it from `__dirname` — that differs between the
 * bundled extension (`dist/extension.js`, schemas sitting one level up) and
 * the unbundled `tsc` output `test-fixtures/check.js` runs against
 * (`out/tekton/jsonSchemas.js`, schemas two levels up), and guessing which
 * one it's currently running as is more fragile than just asking the
 * caller, who always knows.
 */
import * as fs from "fs";
import * as path from "path";
import { TektonKind } from "./model";

interface SchemaFile {
  apiVersion: string;
  kind: TektonKind;
  relativePath: string;
}

/**
 * Every (apiVersion, kind) pair `schemas/` covers. Not every recognized
 * `TektonKind` has an entry -- ClusterTask has no schema at all (see
 * `schemas/README.md`), and a document using an apiVersion this list
 * doesn't list (e.g. a lingering `tekton.dev/v1beta1` Task, cut from
 * `schemas/` when `v1` became the only version this extension treats as
 * current) is likewise left unvalidated rather than guessed at.
 */
const SCHEMA_FILES: readonly SchemaFile[] = [
  { apiVersion: "tekton.dev/v1", kind: "Pipeline", relativePath: "v1/pipeline.json" },
  { apiVersion: "tekton.dev/v1", kind: "PipelineRun", relativePath: "v1/pipelinerun.json" },
  { apiVersion: "tekton.dev/v1", kind: "Task", relativePath: "v1/task.json" },
  { apiVersion: "tekton.dev/v1", kind: "TaskRun", relativePath: "v1/taskrun.json" },
  // StepAction graduated to v1, but a v1beta1 document is still a valid/current thing to see in
  // the wild (see schemas/README.md) -- both versions route to the same schema file, whose own
  // apiVersion enum accepts both.
  { apiVersion: "tekton.dev/v1", kind: "StepAction", relativePath: "v1beta1/stepaction.json" },
  { apiVersion: "tekton.dev/v1beta1", kind: "StepAction", relativePath: "v1beta1/stepaction.json" },
  { apiVersion: "triggers.tekton.dev/v1beta1", kind: "TriggerBinding", relativePath: "v1beta1/triggerbinding.json" },
  { apiVersion: "triggers.tekton.dev/v1beta1", kind: "ClusterTriggerBinding", relativePath: "v1beta1/clustertriggerbinding.json" },
  { apiVersion: "triggers.tekton.dev/v1beta1", kind: "TriggerTemplate", relativePath: "v1beta1/triggertemplate.json" },
  { apiVersion: "triggers.tekton.dev/v1beta1", kind: "Trigger", relativePath: "v1beta1/trigger.json" },
  { apiVersion: "triggers.tekton.dev/v1beta1", kind: "EventListener", relativePath: "v1beta1/eventlistener.json" },
];

/**
 * These schemas were extracted from Kubernetes-generated OpenAPI (see
 * `schemas/README.md`), which never sets `additionalProperties: false` --
 * CRD structural schemas traditionally prune unknown fields silently (or
 * preserve them, under `x-kubernetes-preserve-unknown-fields`) rather than
 * rejecting them outright, so admission validates the fields it knows
 * about and simply doesn't notice a typo'd extra one. That's the opposite
 * of what this extension wants: catching a `scirpt:` typo *is* the point.
 * Recursively closes every object schema that declares `properties` and
 * doesn't already say something else on purpose -- an explicit
 * `additionalProperties` (e.g. a `labels`-style string-keyed map, which
 * must stay open) or `x-kubernetes-preserve-unknown-fields: true` (a
 * genuinely free-form value, e.g. a param's `default`) both mean "leave
 * this one alone," at that node only; nested sub-schemas are still walked
 * and tightened normally either way.
 */
function tightenAdditionalProperties(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if (
    obj.properties &&
    typeof obj.properties === "object" &&
    !("additionalProperties" in obj) &&
    obj["x-kubernetes-preserve-unknown-fields"] !== true
  ) {
    obj.additionalProperties = false;
  }

  if (obj.properties && typeof obj.properties === "object") {
    for (const v of Object.values(obj.properties as Record<string, unknown>)) tightenAdditionalProperties(v);
  }
  if (obj.definitions && typeof obj.definitions === "object") {
    for (const v of Object.values(obj.definitions as Record<string, unknown>)) tightenAdditionalProperties(v);
  }
  if (typeof obj.additionalProperties === "object") tightenAdditionalProperties(obj.additionalProperties);
  if (Array.isArray(obj.items)) obj.items.forEach(tightenAdditionalProperties);
  else if (obj.items) tightenAdditionalProperties(obj.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[key])) (obj[key] as unknown[]).forEach(tightenAdditionalProperties);
  }
}

function schemaKey(apiVersion: string, kind: TektonKind): string {
  return `${apiVersion}::${kind}`;
}

const LOOKUP = new Map<string, string>(SCHEMA_FILES.map((f) => [schemaKey(f.apiVersion, f.kind), f.relativePath]));

/**
 * Caches parsed schema JSON by (schemasDir, apiVersion, kind) -- schema
 * files never change at runtime (they ship with the extension), so a
 * process-lifetime cache is safe and avoids re-reading/re-parsing the same
 * file on every diagnostics/completion pass.
 */
const schemaCache = new Map<string, object | null>();

/**
 * Loads and parses the schema for `kind`/`apiVersion`, if one is known and
 * readable, from under `schemasDir` (see the module doc comment for why
 * that's a parameter, not inferred). Returns undefined for a kind/version
 * this extension has no schema for, or if the file can't be read/parsed --
 * either way, callers should treat that as "nothing to validate against,"
 * not an error.
 */
export function loadSchema(schemasDir: string, apiVersion: string | undefined, kind: TektonKind): object | undefined {
  if (!apiVersion) return undefined;
  const relativePath = LOOKUP.get(schemaKey(apiVersion, kind));
  if (!relativePath) return undefined;

  const cacheKey = `${schemasDir}::${relativePath}`;
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey) ?? undefined;

  let schema: object | null = null;
  try {
    schema = JSON.parse(fs.readFileSync(path.join(schemasDir, relativePath), "utf8")) as object;
    tightenAdditionalProperties(schema);
  } catch {
    schema = null;
  }
  schemaCache.set(cacheKey, schema);
  return schema ?? undefined;
}
