/**
 * Contextual "what key goes here" completion against the schemas in
 * `schemas/` (see `jsonSchemas.ts`) -- e.g. suggesting `script` while
 * inside a step's own map, the way a language server with real schema
 * awareness would. vscode-free like `schemaValidation.ts`; the
 * `completions.ts` caller turns what this returns into
 * `vscode.CompletionItem`s.
 *
 * Deliberately works from indentation and raw text, not the parsed YAML
 * AST, to figure out "which map is the cursor in" and "what keys does it
 * already have" -- a completion request fires mid-edit, and the two
 * situations that matter most (a blank line about to get a new key; a
 * partial key already typed, like "p" before accepting "params") are
 * exactly the ones the AST can't answer reliably. A bare word with no
 * colon yet, on its own line immediately followed by next line's real
 * content, is valid YAML plain-scalar folding syntax -- `p` directly above
 * `workspaces:` parses as one continued key, `"p workspaces"`, not two
 * separate things, however obviously wrong that reads to a human mid-edit.
 * Reading structure from indentation instead sidesteps that: it never
 * needs the cursor's own in-progress line to have parsed as anything in
 * particular. Once the target map and its existing keys are known, the
 * *schema* side is still walked structurally (`properties`/`items`,
 * resolving `$ref`s) -- schemas are static, nothing about them is
 * mid-edit.
 */

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

/** Walks `schema` through `path` (`properties`/`items`, `$ref`-resolving at every step) to find the sub-schema describing the node at that path. A numeric segment always goes through `items` regardless of its actual value -- these schemas describe every array entry uniformly, there's no tuple-typing to distinguish by index. */
function schemaAt(root: JsonSchemaObject, path: PathSegment[]): JsonSchemaObject | undefined {
  let node: JsonSchemaObject | undefined = resolveRef(root, root);
  for (const segment of path) {
    if (!node) return undefined;
    node = typeof segment === "number" ? resolveRef(node.items, root) : resolveRef(node.properties?.[segment], root);
  }
  return node;
}

/** A YAML plain scalar key: word chars, dots, hyphens, underscores, followed by `:`. Deliberately not `findParamRefs`-style permissive -- structural lines only, not arbitrary quoted/flow-style keys, which this heuristic scanner doesn't need to handle for schema-key completion's purposes. */
const KEY_LINE = /^([A-Za-z0-9_.-]+):/;

interface StackEntry {
  /** column this entry's own key starts at (post `- ` for a list-item's first key, matching where its *sibling* keys within the same map would also start) */
  indent: number;
  segment: PathSegment;
  /** offset right after the line that introduced this entry -- where its own children's block begins */
  blockStart: number;
}

interface LineInfo {
  start: number;
  /** column of this line's own structural content -- past a `- ` marker, if any */
  indent: number;
  /** the key this line declares, if it looks like `[- ]key:` -- absent for blank lines, comments, plain scalars, list items with no key, ... */
  key: string | undefined;
  /** true when this line opens a new array element (starts with `- `), regardless of whether it also declares its own first key */
  opensListItem: boolean;
  blockStart: number;
}

function analyzeLine(text: string, lineStart: number, lineEnd: number): LineInfo | undefined {
  const raw = text.slice(lineStart, lineEnd);
  if (!raw.trim()) return undefined; // blank

  const dash = /^(\s*)-(\s+)/.exec(raw);
  if (dash) {
    const indent = dash[0].length;
    const key = KEY_LINE.exec(raw.slice(indent))?.[1];
    return { start: lineStart, indent, key, opensListItem: true, blockStart: lineEnd + 1 };
  }

  const indent = /^\s*/.exec(raw)![0].length;
  const key = KEY_LINE.exec(raw.slice(indent))?.[1];
  if (key === undefined) return undefined; // not a recognizable structural line (a plain scalar, a comment, ...)
  return { start: lineStart, indent, key, opensListItem: false, blockStart: lineEnd + 1 };
}

/** Every line's `[start, end)` (end exclusive of the newline itself), in order. */
function lineRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, text.length]);
  return ranges;
}

/**
 * The key/index path from the document root down to whichever map/array
 * encloses `offset`, built by tracking indentation like a Python-style
 * indent/dedent stack across every line before the cursor's own -- an
 * entry stays on the stack as long as later lines are indented at least
 * as deep as it, and gets popped the moment something shallower appears
 * (that shallower line closing its block). What's left on the stack once
 * a line at or above the cursor's own indentation is reached is exactly
 * its ancestor chain.
 */
function pathAt(text: string, offset: number, cursorIndent: number): { path: PathSegment[]; blockStart: number } {
  const stack: StackEntry[] = [];
  for (const [start, end] of lineRanges(text)) {
    if (start >= offset) break;
    const line = analyzeLine(text, start, end);
    if (!line) continue;

    if (line.opensListItem) {
      // The array level sits at the *dash's* own column, strictly shallower than `line.indent`
      // (the content column just past "- ", where the item's own first key sits if it has one) --
      // it has to be, or the key-level push just below would immediately pop it right back off
      // again (its own pop-loop clears anything at indent >= the key's own column).
      const dashIndent = /^\s*/.exec(text.slice(start, end))![0].length;
      while (stack.length && stack[stack.length - 1].indent >= dashIndent) stack.pop();
      // blockStart is this line's own start, not its end -- unlike a plain "key:" line, a list
      // item's first key can sit on the *same* line as its dash ("- name: build"), so the sibling
      // scan needs to see that line itself, not just what comes after it.
      stack.push({ indent: dashIndent, segment: 0, blockStart: start });
    }
    if (line.key !== undefined) {
      while (stack.length && stack[stack.length - 1].indent >= line.indent) stack.pop();
      stack.push({ indent: line.indent, segment: line.key, blockStart: line.blockStart });
    }
  }

  while (stack.length && stack[stack.length - 1].indent >= cursorIndent) stack.pop();
  const last = stack[stack.length - 1];
  return { path: stack.map((e) => e.segment), blockStart: last ? last.blockStart : 0 };
}

/** Every key already declared at exactly `indent` within the block starting at `blockStart` (i.e. direct siblings of whatever the cursor is about to add), skipping the cursor's own `[cursorLineStart, cursorLineEnd)` line and stopping once a shallower line closes the block. Scans the *whole* block, not just what precedes the cursor -- a key can just as easily already exist further down. */
function siblingKeysAt(text: string, blockStart: number, indent: number, cursorLineStart: number, cursorLineEnd: number): Set<string> {
  const keys = new Set<string>();
  for (const [start, end] of lineRanges(text)) {
    if (start < blockStart) continue;
    if (start >= cursorLineStart && start < cursorLineEnd) continue;
    const line = analyzeLine(text, start, end);
    if (!line) continue;
    if (line.indent < indent) break; // block closed
    if (line.indent !== indent) continue; // deeper nested content, not a direct sibling
    if (line.key !== undefined) keys.add(line.key);
  }
  return keys;
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

export interface SchemaCompletionResult {
  completions: SchemaPropertyCompletion[];
  /** the already-typed prefix on the cursor's own line (e.g. "p"), to be replaced by whichever completion is accepted -- not just inserted after, which would otherwise leave it behind (e.g. "p" + "workspaces: " -> "pworkspaces: "). */
  replaceRange: [number, number];
}

/**
 * Every property the schema declares for whatever map encloses `offset`
 * that isn't already present there, plus the range of the cursor's own
 * already-typed prefix (if any) so the caller can replace it rather than
 * insert alongside it. Returns undefined when the cursor isn't inside a
 * map this schema actually describes (e.g. outside any resource, or
 * inside a part of the tree the schema leaves open-ended via
 * `x-kubernetes-preserve-unknown-fields`/no declared `properties` at all).
 */
export function schemaPropertyCompletions(text: string, rootSchema: object, offset: number): SchemaCompletionResult | undefined {
  const root = asSchemaObject(rootSchema);
  if (!root) return undefined;

  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEndIdx = text.indexOf("\n", offset);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const cursorIndent = /^\s*/.exec(text.slice(lineStart, offset))![0].length;
  const replaceRange: [number, number] = [lineStart + cursorIndent, offset];

  const { path, blockStart } = pathAt(text, offset, cursorIndent);
  const sub = schemaAt(root, path);
  if (!sub?.properties) return undefined;

  const existing = siblingKeysAt(text, blockStart, cursorIndent, lineStart, lineEnd + 1);

  const completions: SchemaPropertyCompletion[] = [];
  for (const [name, propSchemaNode] of Object.entries(sub.properties)) {
    if (existing.has(name)) continue;
    const propSchema = resolveRef(propSchemaNode, root) ?? asSchemaObject(propSchemaNode);
    const enumValues = propSchema?.enum?.every((v) => typeof v === "string") ? (propSchema.enum as string[]) : undefined;
    completions.push({
      name,
      description: propSchema?.description,
      enumValues,
      valueShape: propSchema ? shapeOf(propSchema, root) : "scalar",
    });
  }
  return { completions, replaceRange };
}
