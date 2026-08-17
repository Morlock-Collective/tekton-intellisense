/**
 * Contextual "what key goes here" completion against the schemas in
 * `schemas/` (see `jsonSchemas.ts`) -- e.g. suggesting `script` while
 * inside a step's own map, the way a language server with real schema
 * awareness would. vscode-free like `schemaValidation.ts`; the
 * `completions.ts` caller turns what this returns into
 * `vscode.CompletionItem`s.
 *
 * Works by walking the YAML AST from the document root down to whichever
 * map contains the cursor, recording the key/index path taken, then
 * walking the *schema* through that same path -- `properties`/`items`,
 * resolving `$ref`s against the schema's own `definitions` as they come up
 * -- to find the sub-schema describing that one map's shape. Whatever
 * properties it declares that the map doesn't already have are the
 * completions.
 */
import { Document, isMap, isScalar, isSeq, YAMLMap } from "yaml";
import { findEnclosingMap } from "./model";

type PathSegment = string | number;

interface JsonSchemaObject {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, unknown>;
  items?: unknown;
  definitions?: Record<string, unknown>;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

function asSchemaObject(node: unknown): JsonSchemaObject | undefined {
  return node && typeof node === "object" ? (node as JsonSchemaObject) : undefined;
}

/** Resolves a `{ "$ref": "#/definitions/X" }` node against `root`'s own `definitions` -- the only kind of `$ref` these schemas ever use (see `schemas/README.md`). Returns `node` itself unchanged if it isn't a $ref. */
function resolveRef(node: unknown, root: JsonSchemaObject): JsonSchemaObject | undefined {
  const schema = asSchemaObject(node);
  if (!schema?.$ref) return schema;
  const name = schema.$ref.replace(/^#\/definitions\//, "");
  return asSchemaObject(root.definitions?.[name]);
}

/** The key/index path from `root` down to `target` (reference equality), or undefined if `target` isn't actually reachable from `root` -- shouldn't happen for a map `findEnclosingMap` itself found within the same document. */
function pathTo(root: unknown, target: YAMLMap): PathSegment[] | undefined {
  if (root === target) return [];
  if (isMap(root)) {
    for (const pair of root.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
      const found = pathTo(pair.value, target);
      if (found) return [pair.key.value, ...found];
    }
  } else if (isSeq(root)) {
    for (let i = 0; i < root.items.length; i++) {
      const found = pathTo(root.items[i], target);
      if (found) return [i, ...found];
    }
  }
  return undefined;
}

/** Walks `schema` through `path` (`properties`/`items`, `$ref`-resolving at every step) to find the sub-schema describing the node at that path. */
function schemaAt(root: JsonSchemaObject, path: PathSegment[]): JsonSchemaObject | undefined {
  let node: JsonSchemaObject | undefined = resolveRef(root, root);
  for (const segment of path) {
    if (!node) return undefined;
    node = typeof segment === "number" ? resolveRef(node.items, root) : resolveRef(node.properties?.[segment], root);
  }
  return node;
}

export interface SchemaPropertyCompletion {
  name: string;
  description?: string;
  /** the property's own declared enum values, if it has a small fixed set (offered as a snippet choice by the caller) */
  enumValues?: string[];
  /** best-effort shape for the value this key introduces, so the caller can insert something more useful than a bare `key: ` for an object/array-typed one */
  valueShape: "object" | "array" | "scalar";
}

function shapeOf(schema: JsonSchemaObject, root: JsonSchemaObject): SchemaPropertyCompletion["valueShape"] {
  const resolved = resolveRef(schema, root) ?? schema;
  const type = Array.isArray(resolved.type) ? resolved.type[0] : resolved.type;
  if (type === "object" || resolved.properties) return "object";
  if (type === "array" || resolved.items) return "array";
  return "scalar";
}

/**
 * Steps `offset` back over whitespace to the end of the nearest real
 * (non-whitespace) content before it. A blank line -- the common "cursor
 * on a fresh line, about to type a new key" completion trigger -- has no
 * committed structure of its own for YAML to have parsed at all: nothing
 * about a bare blank line (however indented) tells the parser which block
 * it belongs to until either more content commits it or the block closes,
 * so `findEnclosingMap` finds nothing right at such an offset even though
 * a human reading the same file would have no doubt which map it's part
 * of. Retrying against the last real content's own position instead --
 * "whatever map that belonged to" -- recovers exactly that human reading
 * for the single most common trigger shape (typing at the end of an
 * existing block), at the cost of not being able to distinguish "still
 * this block" from "starting a new, more deeply nested one" for a blank
 * line with no real content simply to compare it against; that's an
 * inherent limit of asking an indentation-sensitive parser about content
 * that doesn't exist yet, not something worth a heavier fix here.
 */
function backscanToRealContent(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
}

/**
 * Every property `rootSchema` declares for the map enclosing `offset` that
 * isn't already present in it, or an empty array when the cursor isn't
 * inside a map this schema actually describes (e.g. outside any resource,
 * or inside a part of the tree the schema leaves open-ended via
 * `x-kubernetes-preserve-unknown-fields`/no declared `properties` at all).
 */
export function schemaPropertyCompletions(doc: Document.Parsed, text: string, rootSchema: object, offset: number): SchemaPropertyCompletion[] {
  const enclosing = findEnclosingMap(doc, offset) ?? findEnclosingMap(doc, backscanToRealContent(text, offset));
  if (!enclosing) return [];

  const root = asSchemaObject(rootSchema);
  if (!root) return [];

  const path = isMap(doc.contents) ? pathTo(doc.contents, enclosing) : undefined;
  if (!path) return [];

  const sub = schemaAt(root, path);
  if (!sub?.properties) return [];

  const existing = new Set(
    enclosing.items
      .map((pair) => (isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : undefined))
      .filter((k): k is string => k !== undefined)
  );

  const out: SchemaPropertyCompletion[] = [];
  for (const [name, propSchemaNode] of Object.entries(sub.properties)) {
    if (existing.has(name)) continue;
    const propSchema = resolveRef(propSchemaNode, root) ?? asSchemaObject(propSchemaNode);
    const enumValues = propSchema?.enum?.every((v) => typeof v === "string") ? (propSchema.enum as string[]) : undefined;
    out.push({
      name,
      description: propSchema?.description,
      enumValues,
      valueShape: propSchema ? shapeOf(propSchema, root) : "scalar",
    });
  }
  return out;
}
