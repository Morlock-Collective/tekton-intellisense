/**
 * Structural validation (unknown keys, missing required keys, wrong
 * types/enums) against the schemas in `schemas/` (see `jsonSchemas.ts`
 * and `schemas/README.md`), run against the already-Helm-masked-and-parsed
 * document every other feature in this extension already builds --
 * catching mistakes no amount of cross-reference checking would (a
 * `- scirpt: |` typo is syntactically a fine YAML key, just not one Tekton
 * recognizes). vscode-free like `paramRefs.ts`/`duplicates.ts`; the
 * `diagnostics.ts` caller wraps the plain issues this returns into
 * `vscode.Diagnostic`s.
 */
import Ajv, { ErrorObject, ValidateFunction } from "ajv";
import { Document, isNode } from "yaml";
import { ParsedTektonDoc } from "./model";
import { loadSchema } from "./jsonSchemas";

export interface SchemaIssue {
  range: [number, number];
  message: string;
}

// logger: false silences ajv's "unknown format ... ignored" warnings for formats these schemas
// use that ajv doesn't itself validate (date-time, int32, int64, byte, ...) -- harmless (the
// field just isn't format-checked), but noisy enough on every schema load to drown out real
// extension-host console output otherwise.
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true, logger: false });
const validatorCache = new Map<object, ValidateFunction>();

function compiledValidator(schema: object): ValidateFunction | undefined {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  try {
    const validate = ajv.compile(schema);
    validatorCache.set(schema, validate);
    return validate;
  } catch {
    // A malformed schema file shouldn't take validation down for every other document.
    return undefined;
  }
}

/** Splits a JSON Pointer ("/spec/params/0/type") into `Document#getIn`-ready segments, unescaping `~1`/`~0` and turning array-index segments into numbers. */
function pointerSegments(instancePath: string): (string | number)[] {
  if (!instancePath) return [];
  return instancePath
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

/** The source range of the node at `segments`, or of the document root if `segments` is empty (a root-level error) -- undefined only if the AST doesn't actually have a node there, which schema errors should never point at. */
function rangeAt(doc: Document.Parsed, segments: (string | number)[]): [number, number] | undefined {
  const node = segments.length === 0 ? doc.contents : doc.getIn(segments, true);
  return isNode(node) && node.range ? [node.range[0], node.range[1]] : undefined;
}

/** For an "additionalProperties" error, the specific extra key's own range (not its value's, and not the whole parent map's) -- `instancePath` only ever points at the parent map for this keyword. */
function additionalPropertyRange(doc: Document.Parsed, parentSegments: (string | number)[], propertyName: string): [number, number] | undefined {
  const parent = parentSegments.length === 0 ? doc.contents : doc.getIn(parentSegments, true);
  if (!isNode(parent) || !("items" in parent)) return undefined;
  for (const item of (parent as { items: unknown[] }).items) {
    const pair = item as { key?: unknown };
    if (isNode(pair.key) && "value" in pair.key && (pair.key as { value?: unknown }).value === propertyName && pair.key.range) {
      return [pair.key.range[0], pair.key.range[1]];
    }
  }
  return undefined;
}

function rangeForError(doc: Document.Parsed, error: ErrorObject): [number, number] | undefined {
  const segments = pointerSegments(error.instancePath);
  if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    return additionalPropertyRange(doc, segments, error.params.additionalProperty) ?? rangeAt(doc, segments);
  }
  return rangeAt(doc, segments);
}

/**
 * True when the value a schema error actually complained about is either
 * an all-`x` string (`helmMask.ts`'s exact placeholder shape for a masked
 * inline `{{ ... }}` action -- e.g. `serviceAccountName: {{ .Values.sa }}`
 * masks to a same-length run of `x`s an enum check then rejects) or
 * `null`/`undefined` (a *standalone* directive -- `{{- include "chart.labels"
 * . }}` alone on its own line masks to a same-length comment instead, per
 * `helmMask.ts`, leaving the key with no value node at all, i.e. implicit
 * `null`). Either way this isn't a real structural mistake; it's this
 * extension not knowing what the template will actually render to --
 * exactly the class of false positive a full Helm render step would avoid,
 * at the cost of losing 1:1 source positions. Only worth checking at all
 * for a Helm-templated document -- an all-`x` string (or an explicit
 * `null`) is a legitimate, if unusual, value otherwise, and this shouldn't
 * suppress a real report of one.
 */
function looksTemplateMasked(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && /^[\sx]*$/.test(value);
}

function humanMessage(error: ErrorObject): string {
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    return `Missing required property "${error.params.missingProperty}".`;
  }
  if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    return `Unknown property "${error.params.additionalProperty}".`;
  }
  const at = error.instancePath ? `"${error.instancePath.slice(1).split("/").pop()}" ` : "";
  return `${at}${error.message ?? "does not match the schema"}.`.replace(/^" /, "");
}

/**
 * Validates `parsed`'s own resource against its matching schema (by
 * `symbols.kind`/`symbols.apiVersion`) under `schemasDir`, returning one
 * issue per structural violation with a source range as close to the
 * actual mistake as the error type allows: the specific extra key for an
 * unknown property, the value itself for a type/enum mismatch, or the
 * enclosing object for a missing required property (there's no node for a
 * key that isn't there). Returns an empty array, not an error, when no
 * schema is known for this resource's kind/apiVersion -- see
 * {@link loadSchema}.
 */
export function validateAgainstSchema(schemasDir: string, parsed: ParsedTektonDoc): SchemaIssue[] {
  const schema = loadSchema(schemasDir, parsed.symbols.apiVersion, parsed.symbols.kind);
  if (!schema) return [];

  const validate = compiledValidator(schema);
  if (!validate) return [];

  const data = parsed.doc.toJSON();
  if (validate(data)) return [];

  const issues: SchemaIssue[] = [];
  for (const error of validate.errors ?? []) {
    if (parsed.isHelmTemplated && looksTemplateMasked(error.data)) continue;
    const range = rangeForError(parsed.doc, error) ?? parsed.range;
    issues.push({ range, message: humanMessage(error) });
  }
  return issues;
}
