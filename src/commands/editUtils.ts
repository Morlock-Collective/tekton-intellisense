import * as vscode from "vscode";
import { isMap, isScalar, isSeq, YAMLMap } from "yaml";
import { findEnclosingStepEntry, ParsedTektonDoc, stepAndSidecarEntryMaps, trimTrailingNewline } from "../tekton/model";
import { blockAfterText } from "./snippetText";

/** Returns the leading whitespace of the line at `position`. */
export function indentAt(document: vscode.TextDocument, position: vscode.Position): string {
  const line = document.lineAt(position.line).text;
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : "";
}

/** Converts a param/workspace name into a conventional SCREAMING_SNAKE_CASE env var name. */
export function toEnvVarName(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
  return snake || "VALUE";
}

/**
 * Inserts `lines` as a new block on its own fresh line(s) after `position`
 * — every line, including the first, is prefixed with `indent`. `position`
 * is always AST-derived (end of the last list item, end of a map's last
 * key, ...), never the cursor — every editing command resolves *where*
 * something belongs from the document's structure, not where the cursor
 * happens to be.
 *
 * Each entry in `lines` should carry only its *relative* indentation (e.g.
 * `"- name: x"` then `"  type: string"`, not the absolute column) — this
 * function adds `indent` uniformly so getting nesting right only requires
 * getting the relative indents right once.
 *
 * A plain `TextEditor#edit` insert, deliberately NOT `insertSnippet` —
 * `insertSnippet` reindents every line after the first to match the
 * *current* line's own indentation (there's a `keepWhitespace` option to
 * suppress this, but it's newer than this extension's minimum supported
 * VS Code version). `position` routinely lands at the end of a deeply
 * nested last item (e.g. a task entry whose own last field is a
 * cluster-resolver's `params:` list several levels deeper than the task
 * entry itself) — reindenting to THAT line's indentation, on top of the
 * absolute indentation already baked into `lines` here, produced
 * doubly-indented, invalid output. A plain edit inserts exactly the text
 * computed here, nothing more.
 */
export async function insertBlockAfter(
  editor: vscode.TextEditor,
  position: vscode.Position,
  lines: string[],
  indent: string
): Promise<void> {
  const text = blockAfterText(lines, indent);
  const applied = await editor.edit((editBuilder) => editBuilder.insert(position, text));
  if (!applied) return;
  const endOffset = editor.document.offsetAt(position) + text.length;
  const endPosition = editor.document.positionAt(endOffset);
  editor.selection = new vscode.Selection(endPosition, endPosition);
  editor.revealRange(new vscode.Range(endPosition, endPosition));
}

function stepEntryLabel(entry: YAMLMap, index: number): string {
  const nameNode = entry.get("name", true);
  return isScalar(nameNode) && typeof nameNode.value === "string" ? nameNode.value : `(step ${index + 1})`;
}

/**
 * Resolves the step/sidecar a command should target: the one under the
 * cursor if there is one, otherwise a picker over the document's
 * step/sidecar entries. Shared by every command whose target is
 * inherently ambiguous (there can be several steps/sidecars) rather than
 * derivable from document structure alone.
 */
export async function pickStepOrSidecarEntry(
  editor: vscode.TextEditor,
  parsed: ParsedTektonDoc,
  placeHolder: string,
  emptyMessage: string
): Promise<YAMLMap | undefined> {
  const offset = editor.document.offsetAt(editor.selection.active);
  const atCursor = findEnclosingStepEntry(parsed, offset);
  if (atCursor) return atCursor;

  const entries = stepAndSidecarEntryMaps(parsed);
  if (entries.length === 0) {
    vscode.window.showWarningMessage(emptyMessage);
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(
    entries.map((entry, i) => ({ label: stepEntryLabel(entry, i), entry })),
    { placeHolder }
  );
  return chosen?.entry;
}

/** Param names already bound in `container`'s `env:` list via a plain `$(params.NAME)` value — used to avoid offering (or re-adding) a binding that already exists. */
export function alreadyBoundParamNames(container: YAMLMap): Set<string> {
  const bound = new Set<string>();
  const env = container.get("env", true);
  if (!isSeq(env)) return bound;
  for (const item of env.items) {
    if (!isMap(item)) continue;
    const valueNode = item.get("value", true);
    const value = isScalar(valueNode) && typeof valueNode.value === "string" ? valueNode.value : undefined;
    const match = value && /^\$\(params\.([^.)]+)\)$/.exec(value.trim());
    if (match) bound.add(match[1]);
  }
  return bound;
}

/** Every env var name already present in `container`'s `env:` list, for collision avoidance when generating new ones. */
export function existingEnvNames(container: YAMLMap): Set<string> {
  const names = new Set<string>();
  const env = container.get("env", true);
  if (!isSeq(env)) return names;
  for (const item of env.items) {
    if (!isMap(item)) continue;
    const nameNode = item.get("name", true);
    if (isScalar(nameNode) && typeof nameNode.value === "string") names.add(nameNode.value);
  }
  return names;
}

/** `base`, or `base_2`/`base_3`/... if already taken — mutates `used` to reserve whichever name it returns, so a batch of calls against the same set never collides with itself either. */
export function uniqueEnvName(base: string, used: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${n++}`;
  }
  used.add(candidate);
  return candidate;
}

export interface EnvBinding {
  envName: string;
  paramName: string;
}

/**
 * Appends one or more `{name, value}` env entries into `container`'s
 * `env:` list, creating the list if it doesn't exist yet. Shared by
 * `bindParamToEnv` (one binding) and `bindAllParamsToEnv` (however many
 * the user picked) — inserting N bindings is just N repetitions of the
 * same two-line shape, so there's nothing binding-count-specific about
 * the splicing itself.
 */
export async function insertEnvBindings(
  editor: vscode.TextEditor,
  parsed: ParsedTektonDoc,
  container: YAMLMap,
  bindings: EnvBinding[]
): Promise<void> {
  if (bindings.length === 0 || !container.range) return;
  const document = editor.document;
  const entryLines = bindings.flatMap(({ envName, paramName }) => [`- name: ${envName}`, `  value: $(params.${paramName})`]);

  const existingEnv = container.get("env", true);
  if (isSeq(existingEnv) && existingEnv.range) {
    const lastItem = existingEnv.items[existingEnv.items.length - 1] as { range?: [number, number, number] } | undefined;
    const rawAnchor = lastItem?.range ? lastItem.range[1] : existingEnv.range[1];
    const anchorOffset = trimTrailingNewline(parsed.text, rawAnchor);
    const indent = indentAt(document, document.positionAt(existingEnv.range[0]));
    await insertBlockAfter(editor, document.positionAt(anchorOffset), entryLines, indent);
    return;
  }

  // No existing env: list in this step/sidecar — create it, appended after the entry's last existing key.
  const indent = indentAt(document, document.positionAt(container.range[0]));
  const anchorOffset = trimTrailingNewline(parsed.text, container.range[1]);
  await insertBlockAfter(editor, document.positionAt(anchorOffset), ["env:", ...entryLines.map((l) => "  " + l)], indent + "  ");
}
