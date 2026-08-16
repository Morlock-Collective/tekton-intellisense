/**
 * Detects a step/sidecar's `script:` block and sniffs its shebang to infer
 * a language, for the "Edit Task Script" command: pop the block's content
 * out into a real scratch file with the right extension, let the user edit
 * it in a normal editor tab (full native language support, since it's a
 * real file), and write it back on save.
 *
 * Deliberately has no `vscode` dependency, so it's testable the same way as
 * `model.ts`/`paramRefs.ts` — the vscode-dependent scratch-file/writeback
 * logic belongs in a later module built on top of this one.
 */
import { isScalar, Scalar } from "yaml";
import { ParsedTektonDoc, stepAndSidecarEntryMaps } from "./model";
import { findParamRefs } from "./paramRefs";

/** interpreter basename (after resolving `env`, stripping a version suffix) -> vscode language id */
const SHEBANG_LANGUAGE_MAP: Record<string, string> = {
  bash: "shellscript",
  sh: "shellscript",
  zsh: "shellscript",
  dash: "shellscript",
  ksh: "shellscript",
  python: "python",
  python2: "python",
  python3: "python",
  node: "javascript",
  nodejs: "javascript",
  ruby: "ruby",
  perl: "perl",
  php: "php",
  lua: "lua",
};

/** vscode language id -> file extension, for naming the scratch file so the right editor mode picks it up. */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  shellscript: "sh",
  python: "py",
  javascript: "js",
  ruby: "rb",
  perl: "pl",
  php: "php",
  lua: "lua",
};

/** `$(...)` is left alone in shellscript specifically: it's valid native bash command-substitution syntax, so masking it would replace legitimate syntax with something a shell parser is *more* likely to choke on, not less. */
const LANGUAGES_WHERE_TEKTON_REFS_NEED_MASKING = new Set(
  Object.values(SHEBANG_LANGUAGE_MAP).filter((id) => id !== "shellscript")
);

export interface ShebangLanguage {
  /** the resolved interpreter binary name, e.g. "bash", "python3" (after resolving `env` and stripping path) */
  interpreter: string;
  languageId: string;
}

/** Reads the first line of `content` as a `#!interpreter [arg]` shebang and maps it to a vscode language id, if recognized. */
export function detectShebangLanguage(content: string): ShebangLanguage | undefined {
  const firstLine = content.slice(0, content.indexOf("\n") === -1 ? content.length : content.indexOf("\n"));
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
  if (!m) return undefined;

  const envArg = m[2];
  let bin = (m[1].split("/").pop() ?? m[1]).trim();
  if (bin === "env" && envArg) {
    bin = envArg.split("/").pop() ?? envArg;
  }

  const languageId = SHEBANG_LANGUAGE_MAP[bin] ?? SHEBANG_LANGUAGE_MAP[bin.replace(/[0-9.]+$/, "")];
  if (!languageId) return undefined;
  return { interpreter: bin, languageId };
}

/** Replaces every `$(...)` in `content` with a same-length run of underscores, preserving every other offset exactly. */
function maskTektonRefs(content: string): string {
  const refs = findParamRefs(content);
  if (refs.length === 0) return content;

  let out = "";
  let last = 0;
  for (const ref of refs) {
    out += content.slice(last, ref.start) + "_".repeat(ref.end - ref.start);
    last = ref.end;
  }
  return out + content.slice(last);
}

/** Greatest `i` such that `starts[i] <= offset`, i.e. which line `offset` falls on given a sorted array of line-start offsets. */
function lineIndexForOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Re-indents `content` (e.g. edited scratch-file text) by `indent` columns on every line, for writing back into a block scalar. Always ends with exactly one trailing newline. */
export function reindentScriptContent(content: string, indent: number): string {
  const pad = " ".repeat(indent);
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.length > 0 ? pad + l : "")).join("\n") + "\n";
}

export interface EmbeddedScriptBlock extends ShebangLanguage {
  /** the step/sidecar's own `name:` value, if present — used to re-identify this same block later (e.g. when writing edits back), since the document may have changed since this was first found */
  containerName: string | undefined;
  /** dedented script body, with `$(...)` refs masked out where the target language doesn't tolerate them natively (see LANGUAGES_WHERE_TEKTON_REFS_NEED_MASKING) */
  content: string;
  /** dedented script body, unmasked — what should be written back if this block's content is replaced */
  rawContent: string;
  /** number of leading whitespace columns stripped from every content line; needed to re-indent edited content back into the block scalar */
  indent: number;
  /** host-document offset range of the block's content, i.e. excluding the `script: |` header line itself */
  hostRange: [number, number];
  /** Maps an offset within `content`/`rawContent` to the corresponding offset in the host document's source text. */
  toHostOffset(virtualOffset: number): number;
  /** Maps an offset in the host document's source text to the corresponding offset within `content`/`rawContent`, or undefined if it falls outside this block's content (e.g. in the header line, or in a line's indentation whitespace). */
  toVirtualOffset(hostOffset: number): number | undefined;
}

/**
 * Builds an {@link EmbeddedScriptBlock} for a `script:` scalar node, or
 * undefined if it's not a form this can safely map (not a literal block
 * scalar — `>` folding and quoted/plain scalars don't have per-line
 * indentation to strip in the first place) or has no recognized shebang.
 */
function buildScriptBlock(text: string, node: unknown, containerName: string | undefined): EmbeddedScriptBlock | undefined {
  if (!isScalar(node) || typeof node.value !== "string" || !node.range) return undefined;
  // BLOCK_LITERAL is `script: |`; anything else (BLOCK_FOLDED, PLAIN, QUOTE_*) either folds
  // newlines away or has no block indentation to strip, so the per-line dedent math below
  // doesn't apply — bail rather than guess.
  if (node.type !== Scalar.BLOCK_LITERAL) return undefined;

  const [nodeStart, nodeEnd] = node.range;
  const headerLineEnd = text.indexOf("\n", nodeStart);
  if (headerLineEnd === -1) return undefined;
  const contentStartOffset = headerLineEnd + 1;

  const rawLines = text.slice(contentStartOffset, nodeEnd).split("\n");
  const indent = rawLines.find((l) => l.trim().length > 0)?.match(/^[ \t]*/)?.[0].length ?? 0;

  const hostLineStarts: number[] = [];
  const dedentedLines: string[] = [];
  let cursor = contentStartOffset;
  for (const rawLine of rawLines) {
    hostLineStarts.push(cursor);
    dedentedLines.push(rawLine.length >= indent ? rawLine.slice(indent) : "");
    cursor += rawLine.length + 1;
  }

  const rawContent = dedentedLines.join("\n");
  const shebang = detectShebangLanguage(rawContent);
  if (!shebang) return undefined;

  const content = LANGUAGES_WHERE_TEKTON_REFS_NEED_MASKING.has(shebang.languageId) ? maskTektonRefs(rawContent) : rawContent;

  const virtualLineStarts: number[] = [];
  {
    let acc = 0;
    for (const l of dedentedLines) {
      virtualLineStarts.push(acc);
      acc += l.length + 1;
    }
  }

  return {
    ...shebang,
    containerName,
    content,
    rawContent,
    indent,
    hostRange: [contentStartOffset, nodeEnd],
    toHostOffset(virtualOffset: number): number {
      const line = lineIndexForOffset(virtualLineStarts, virtualOffset);
      const col = virtualOffset - virtualLineStarts[line];
      return hostLineStarts[line] + indent + col;
    },
    toVirtualOffset(hostOffset: number): number | undefined {
      if (hostOffset < contentStartOffset || hostOffset > nodeEnd) return undefined;
      const line = lineIndexForOffset(hostLineStarts, hostOffset);
      const col = hostOffset - hostLineStarts[line] - indent;
      if (col < 0) return undefined; // inside this line's leading indentation whitespace
      return virtualLineStarts[line] + Math.min(col, dedentedLines[line].length);
    },
  };
}

/** Every step/sidecar `script:` block in `parsed` with a recognized shebang, in document order. */
export function findEmbeddedScriptBlocks(parsed: ParsedTektonDoc): EmbeddedScriptBlock[] {
  const blocks: EmbeddedScriptBlock[] = [];
  for (const entry of stepAndSidecarEntryMaps(parsed)) {
    const scriptNode = entry.get("script", true);
    const nameNode = entry.get("name", true);
    // A standalone StepAction's one implicit "step" (its own spec) has no `name:` field of its
    // own to identify it by -- fall back to the resource's own metadata.name instead, so the
    // picker/writeback identification still has something meaningful to key off of.
    const containerName =
      (isScalar(nameNode) && typeof nameNode.value === "string" ? nameNode.value : undefined) ??
      (parsed.symbols.kind === "StepAction" ? parsed.symbols.metadataName : undefined);
    const block = buildScriptBlock(parsed.text, scriptNode, containerName);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** The embedded script block whose content range contains `offset`, if any. */
export function findEnclosingScriptBlock(parsed: ParsedTektonDoc, offset: number): EmbeddedScriptBlock | undefined {
  return findEmbeddedScriptBlocks(parsed).find(
    (b) => offset >= b.hostRange[0] && offset <= b.hostRange[1]
  );
}
