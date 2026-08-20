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
import { MaskedAction } from "./helmMask";

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

/** Prepends `indent` spaces to every non-empty line of `content`, without normalizing trailing newlines -- the shared building block behind both {@link reindentScriptContent} (the whole content) and {@link restoreTemplateGaps} (one segment at a time, between gaps). */
function reindentLines(content: string, indent: number): string {
  const pad = " ".repeat(indent);
  return content
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

/** Re-indents `content` (e.g. edited scratch-file text) by `indent` columns on every line, for writing back into a block scalar. Always ends with exactly one trailing newline. */
export function reindentScriptContent(content: string, indent: number): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return reindentLines(lines.join("\n"), indent) + "\n";
}

/**
 * A `{{ ... }}` Helm template action that landed inside this script block's
 * own content (see {@link EmbeddedScriptBlock.templateGaps}) -- shown as a
 * {@link templateGapMarkerLine} in `content`/`rawContent` rather than the
 * raw masked filler, and restored verbatim by {@link restoreTemplateGaps}
 * on write-back.
 */
export interface TemplateGap {
  /** 0-based position among this block's gaps, in document order -- embedded in its marker line so write-back can look it up directly by id rather than by *counting* markers, which breaks the moment an earlier one is deleted (every later marker would silently shift onto the wrong gap). */
  id: number;
  /** the action's original, unmasked text, verbatim (may span multiple lines) */
  original: string;
}

/** Single-line comment prefix per language, so a template gap's marker doesn't itself introduce a syntax error into the scratch file. */
const LINE_COMMENT_PREFIX: Record<string, string> = {
  shellscript: "#",
  python: "#",
  ruby: "#",
  perl: "#",
  php: "#",
  lua: "--",
  javascript: "//",
};

/**
 * A template gap's id, encoded as invisible characters rather than visible
 * text, so a marker line can show the *actual* original template as
 * readable context (what a plain "a Helm template was here" placeholder
 * can't) while staying robust to the user editing or reformatting around
 * it — recovery only needs this exact invisible span to survive, not the
 * visible text next to it. `GAP_ID_START`/`GAP_ID_END` (INVISIBLE
 * SEPARATOR / INVISIBLE PLUS) bound the span so it can be found reliably;
 * each bit of a fixed-width binary encoding of the id is one of two
 * zero-width characters (ZERO WIDTH SPACE / ZERO WIDTH NON-JOINER),
 * chosen because both survive ordinary text editing, clipboard
 * round-trips, and most formatters untouched -- unlike, say, a literal
 * NUL or other control character, which tools are far more likely to
 * strip or choke on. Built via `String.fromCharCode` rather than written
 * as literal characters in this file, deliberately -- an *actual*
 * invisible character sitting in the source would be unreviewable by eye
 * and at real risk of an editor/formatter silently normalizing or
 * stripping it on save.
 */
const GAP_ID_START = String.fromCharCode(0x2063); // INVISIBLE SEPARATOR
const GAP_ID_END = String.fromCharCode(0x2064); // INVISIBLE PLUS
const GAP_ID_BIT_ZERO = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
const GAP_ID_BIT_ONE = String.fromCharCode(0x200c); // ZERO WIDTH NON-JOINER
const GAP_ID_BITS = 16; // up to 65535 gaps per block -- far more than any real script will ever have

function encodeGapId(id: number): string {
  const bits = id.toString(2).padStart(GAP_ID_BITS, "0");
  return GAP_ID_START + [...bits].map((b) => (b === "1" ? GAP_ID_BIT_ONE : GAP_ID_BIT_ZERO)).join("") + GAP_ID_END;
}

const GAP_ID_RE = new RegExp(`${GAP_ID_START}([${GAP_ID_BIT_ZERO}${GAP_ID_BIT_ONE}]{${GAP_ID_BITS}})${GAP_ID_END}`);

/** Finds and decodes a gap id anywhere in `text`, or undefined if there isn't one (or it's been partially deleted). */
function decodeGapId(text: string): number | undefined {
  const m = GAP_ID_RE.exec(text);
  if (!m) return undefined;
  return parseInt(
    [...m[1]].map((c) => (c === GAP_ID_BIT_ONE ? "1" : "0")).join(""),
    2
  );
}

/**
 * The marker line shown in place of an embedded Helm template action, in
 * whatever comment syntax `languageId` uses: an invisible id (see above)
 * immediately followed by the template's own text, visible, for context
 * -- multi-line originals get their newlines collapsed to spaces here
 * only for display; {@link restoreTemplateGaps} always restores the real,
 * unflattened `original` looked up by id, never this visible rendering.
 */
function templateGapMarkerLine(languageId: string, id: number, original: string): string {
  const visible = original.replace(/\s*\n\s*/g, " ");
  return `${LINE_COMMENT_PREFIX[languageId] ?? "#"} ${encodeGapId(id)}${visible}`;
}

/**
 * Splices `gaps`' original template text back in, one per invisible gap
 * id (see {@link templateGapMarkerLine}) found in `content`, on whichever
 * line it appears -- robust against the user editing the visible text
 * around a marker (adding notes, reformatting, even editing the shown
 * template text itself, none of which is what actually gets restored)
 * since only the invisible span itself has to survive intact. A gap's
 * `original` already carries its own original indentation (see
 * `helmMask.ts#MaskedAction`), so it's spliced back in completely
 * unchanged — restoring it is supposed to be a no-op on that text, not a
 * second edit of its own. Everything else (real script content) is
 * re-indented by `indent` columns exactly like
 * {@link reindentScriptContent}, which this replaces whenever a block has
 * any gaps at all.
 *
 * A marker the user deleted is simply not restored — removing the line
 * removes whatever it stood for, same as editing any other text. A
 * marker whose id doesn't match any current gap (the host document
 * changed between opening the scratch file and saving it) is left as a
 * harmless comment rather than guessed at.
 */
export function restoreTemplateGaps(content: string, indent: number, gaps: TemplateGap[]): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const segments: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const id = decodeGapId(line);
    const gap = id !== undefined ? gaps.find((g) => g.id === id) : undefined;
    if (gap) {
      segments.push(reindentLines(current.join("\n"), indent));
      segments.push(gap.original);
      current = [];
    } else {
      current.push(line);
    }
  }
  segments.push(reindentLines(current.join("\n"), indent));

  return segments.filter((s) => s.length > 0).join("\n") + "\n";
}

/**
 * Re-renders every marker line in `content` back to its true visible text
 * (found by the same invisible id {@link restoreTemplateGaps} uses; only
 * what's shown *alongside* it is refreshed here, never the id itself).
 * Meant to be applied to the scratch file right after a save: editing a
 * marker's visible text has zero effect on the host document -- only the
 * invisible id matters for that -- so left alone, a stale edit would just
 * sit there indefinitely looking like it did something. A line whose id
 * doesn't match any current gap is left untouched, same
 * graceful-degradation reasoning as {@link restoreTemplateGaps}.
 */
export function refreshTemplateGapMarkers(content: string, languageId: string, gaps: TemplateGap[]): string {
  return content
    .split("\n")
    .map((line) => {
      const id = decodeGapId(line);
      const gap = id !== undefined ? gaps.find((g) => g.id === id) : undefined;
      return gap ? templateGapMarkerLine(languageId, gap.id, gap.original) : line;
    })
    .join("\n");
}

export interface EmbeddedScriptBlock extends ShebangLanguage {
  /** the step/sidecar's own `name:` value, if present — used to re-identify this same block later (e.g. when writing edits back), since the document may have changed since this was first found */
  containerName: string | undefined;
  /** dedented script body, with `$(...)` refs masked out where the target language doesn't tolerate them natively (see LANGUAGES_WHERE_TEKTON_REFS_NEED_MASKING) -- and each embedded Helm template action (see `templateGaps`) shown as a same-language comment marker rather than the raw masked filler */
  content: string;
  /** dedented script body, unmasked — what should be written back if this block's content is replaced (after {@link restoreTemplateGaps} puts any `templateGaps` back) */
  rawContent: string;
  /** number of leading whitespace columns stripped from every content line; needed to re-indent edited content back into the block scalar */
  indent: number;
  /** host-document offset range of the block's content, i.e. excluding the `script: |` header line itself */
  hostRange: [number, number];
  /** every Helm template action masked inside this block's own content, in document order — see {@link TemplateGap} and {@link restoreTemplateGaps} */
  templateGaps: TemplateGap[];
  /** Maps an offset within `content`/`rawContent` to the corresponding offset in the host document's source text. Only exact for offsets before this block's first template gap (if any) — a gap marker's length has no reason to match the template text it stands for, so nothing after one can stay position-exact against the host. */
  toHostOffset(virtualOffset: number): number;
  /** Maps an offset in the host document's source text to the corresponding offset within `content`/`rawContent`, or undefined if it falls outside this block's content (e.g. in the header line, or in a line's indentation whitespace). Same before-the-first-gap caveat as {@link toHostOffset}. */
  toVirtualOffset(hostOffset: number): number | undefined;
}

/**
 * Builds an {@link EmbeddedScriptBlock} for a `script:` scalar node, or
 * undefined if it's not a form this can safely map (not a literal block
 * scalar — `>` folding and quoted/plain scalars don't have per-line
 * indentation to strip in the first place) or has no recognized shebang.
 */
function buildScriptBlock(
  text: string,
  node: unknown,
  containerName: string | undefined,
  maskedActions: MaskedAction[]
): EmbeddedScriptBlock | undefined {
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

  const virtualLineStarts: number[] = [];
  {
    let acc = 0;
    for (const l of dedentedLines) {
      virtualLineStarts.push(acc);
      acc += l.length + 1;
    }
  }

  const toHostOffset = (virtualOffset: number): number => {
    const line = lineIndexForOffset(virtualLineStarts, virtualOffset);
    const col = virtualOffset - virtualLineStarts[line];
    return hostLineStarts[line] + indent + col;
  };
  const toVirtualOffset = (hostOffset: number): number | undefined => {
    if (hostOffset < contentStartOffset || hostOffset > nodeEnd) return undefined;
    const line = lineIndexForOffset(hostLineStarts, hostOffset);
    const col = hostOffset - hostLineStarts[line] - indent;
    if (col < 0) return undefined; // inside this line's leading indentation whitespace
    return virtualLineStarts[line] + Math.min(col, dedentedLines[line].length);
  };

  const rawContentBeforeGaps = dedentedLines.join("\n");
  const shebang = detectShebangLanguage(rawContentBeforeGaps);
  if (!shebang) return undefined;

  // Only a *standalone* action (masked as its own comment line, per helmMask.ts) can appear here
  // at all -- an inline substitution mid-line (`echo {{ .Values.x }}`) stays embedded as `x`
  // filler, same as everywhere else; there's no separate "line" to mark or restore for those.
  const gapSpans = maskedActions
    .filter((a) => a.standalone && a.range[0] >= contentStartOffset && a.range[1] <= nodeEnd)
    .map((a) => ({ virtualRange: [toVirtualOffset(a.range[0]), toVirtualOffset(a.range[1])] as [number | undefined, number | undefined], original: a.original }))
    .filter((g): g is { virtualRange: [number, number]; original: string } => g.virtualRange[0] !== undefined && g.virtualRange[1] !== undefined);

  const templateGaps: TemplateGap[] = gapSpans.map((g, id) => ({ id, original: g.original }));

  const spliceGaps = (source: string): string => {
    if (gapSpans.length === 0) return source;
    let out = "";
    let pos = 0;
    gapSpans.forEach((gap, id) => {
      out += source.slice(pos, gap.virtualRange[0]) + templateGapMarkerLine(shebang.languageId, id, gap.original);
      pos = gap.virtualRange[1];
    });
    return out + source.slice(pos);
  };

  const rawContent = spliceGaps(rawContentBeforeGaps);
  const content = spliceGaps(
    LANGUAGES_WHERE_TEKTON_REFS_NEED_MASKING.has(shebang.languageId) ? maskTektonRefs(rawContentBeforeGaps) : rawContentBeforeGaps
  );

  return {
    ...shebang,
    containerName,
    content,
    rawContent,
    indent,
    hostRange: [contentStartOffset, nodeEnd],
    templateGaps,
    toHostOffset,
    toVirtualOffset,
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
    const block = buildScriptBlock(parsed.text, scriptNode, containerName, parsed.maskedActions);
    if (block) blocks.push(block);
  }
  return blocks;
}
