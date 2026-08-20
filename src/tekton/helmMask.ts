/**
 * Tekton pipelines are frequently authored as Helm chart templates. Raw
 * `{{ ... }}` / `{{- ... -}}` Go-template expressions are not valid YAML, so
 * parsing a chart's templates/*.yaml directly fails. Rather than requiring a
 * `helm template` render step (which needs values, dependencies, etc. and
 * loses the ability to map back to source positions 1:1), we mask each
 * template action in place with a same-length, YAML-safe placeholder. This
 * keeps every line/column stable so diagnostics and decorations still point
 * at the right place in the original file.
 */

const TEMPLATE_ACTION = /\{\{-?[\s\S]*?-?\}\}/g;

/** One masked `{{ ... }}` action, for callers that need to know where masking happened (e.g. `scriptEmbed.ts`, to recognize a masked line inside a script block and restore its original text on write-back). */
export interface MaskedAction {
  /** `[start, end)` in both the original and masked text -- masking never changes length, so these offsets are valid in either. */
  range: [number, number];
  /** the original, unmasked text. For a standalone action this includes its own line's original leading whitespace (e.g. `"{{- if .Values.foo }}"` at column 0 stays at column 0) -- a caller restoring it needs to put it back completely unchanged, not just re-attach the bare action to whatever indentation happens to surround it after an edit. */
  original: string;
  /** masked as a comment (alone on its own line(s)) rather than inline `x` filler -- see the doc comment on {@link maskHelmTemplates}. */
  standalone: boolean;
}

export interface MaskResult {
  text: string;
  masked: boolean;
  actions: MaskedAction[];
}

/** True when nothing but whitespace surrounds `source[start, end)` on its own line(s). */
function isAloneOnItsLines(source: string, start: number, end: number): boolean {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const before = source.slice(lineStart, start);
  const nextNewline = source.indexOf("\n", end);
  const after = source.slice(end, nextNewline === -1 ? source.length : nextNewline);
  return /^[ \t]*$/.test(before) && /^[ \t]*\r?$/.test(after);
}

/** Line-oriented view of `source`, for the neighbor-indentation lookup {@link maskHelmTemplates} needs -- built once per call rather than repeated `indexOf` scans. */
interface LineIndex {
  count: number;
  text(line: number): string;
  /** `[start, end)` of `line`'s own content, excluding its trailing newline */
  bounds(line: number): [number, number];
  /** greatest line index whose start offset is `<= offset` */
  lineAt(offset: number): number;
}

function buildLineIndex(source: string): LineIndex {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] - 1 : source.length));
  return {
    count: starts.length,
    text: (line) => source.slice(starts[line], ends[line]),
    bounds: (line) => [starts[line], ends[line]],
    lineAt: (offset) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

const LEADING_WS = /^[ \t]*/;

/**
 * Replaces each {{ ... }} action with a same-length run of `x` characters,
 * so the surrounding text still reads as a plain YAML scalar — unless the
 * action is alone on its own line(s) (nothing but whitespace before/after
 * it), the common shape for a standalone Helm control-flow directive
 * (`{{- if ... }}`, `{{- end }}`, `{{- else }}`, `{{- range ... }}`, ...).
 * Those get masked as a same-length YAML *comment* instead: an `x`-run
 * still leaves a bare plain-scalar line behind, and at the top of a
 * document (or anywhere YAML can't yet tell what kind of node is coming
 * next) that reads as an implicit multi-line map key once folded together
 * with whatever real content follows on the next line — which YAML
 * rejects outright, failing the whole parse. A comment line disappears
 * from the parser's perspective entirely, the same as Helm would strip it
 * at render time.
 *
 * A standalone action also gets *re-indented* to match its surroundings
 * when it has both a non-blank, non-template neighbor before and after it
 * — the common shape for a control-flow line embedded inside an indented
 * block (most importantly inside a `script: |` block scalar, but the same
 * reasoning applies to a list/map). Left at its own original column
 * (often 0, a common Helm authoring style), a comment *inside*
 * block-scalar content isn't actually a comment at all — every line
 * at-or-above the block's indentation is literal scalar text, comment
 * syntax included — so a less-indented line still ends the block exactly
 * as the original `{{ ... }}` line would have, corrupting everything after
 * it. The target is the *lesser* of the two neighbors' own indentation,
 * not a required exact match between them (e.g. a control line between a
 * nested `if`'s body and the block's own base level legitimately has two
 * differently-indented real neighbors) — since both are assumed to
 * already be part of the same enclosing block, each is already at or
 * beyond that block's true indentation, so the smaller of the two still
 * safely is too. Re-indenting only ever *redistributes* the same
 * characters already on that action's own line(s) (never adds or removes
 * any, which would shift every offset after it) — so it silently declines
 * whenever the target indentation wouldn't leave room for at least a `#`,
 * falling back to the original in-place masking for that action instead
 * of guessing. With no "after" neighbor at all (e.g. a trailing
 * `{{- end }}` closing a whole-document wrapper, nothing following it) it
 * likewise leaves the original column alone, same as before this existed.
 *
 * Newlines *within* an action are preserved as-is rather than flattened —
 * Go template actions are allowed to span multiple lines (e.g. a
 * multi-line pipeline argument list), and collapsing them would shift
 * every line number after the action, defeating the entire point of
 * masking in place. A standalone multi-line action gets a `#` at the start
 * of *every* line it spans, not just its first, so each of those lines is
 * individually a valid comment too.
 */
export function maskHelmTemplates(source: string): MaskResult {
  const matches = [...source.matchAll(TEMPLATE_ACTION)];
  if (matches.length === 0) return { text: source, masked: false, actions: [] };

  const lines = buildLineIndex(source);

  const spans = matches.map((m) => {
    const start = m.index!;
    const end = start + m[0].length;
    const standalone = isAloneOnItsLines(source, start, end);
    return { start, end, standalone, firstLine: lines.lineAt(start), lastLine: lines.lineAt(end - 1) };
  });

  const isStandaloneLine = (line: number): boolean => spans.some((s) => s.standalone && line >= s.firstLine && line <= s.lastLine);
  const isBlankLine = (line: number): boolean => lines.text(line).trim().length === 0;
  const indentOf = (line: number): number => LEADING_WS.exec(lines.text(line))![0].length;

  const neighborIndent = (line: number, dir: 1 | -1): number | undefined => {
    for (let i = line + dir; i >= 0 && i < lines.count; i += dir) {
      if (isBlankLine(i) || isStandaloneLine(i)) continue;
      return indentOf(i);
    }
    return undefined;
  };

  const actions: MaskedAction[] = [];
  let out = "";
  let cursor = 0;

  for (const span of spans) {
    const original = source.slice(span.start, span.end);

    if (!span.standalone) {
      out += source.slice(cursor, span.start);
      actions.push({ range: [span.start, span.end], original, standalone: false });
      out += original.replace(/[^\n\r]/g, "x");
      cursor = span.end;
    } else {
      // The masked replacement for a standalone action can cover its whole line(s) -- leading
      // whitespace included, when re-indenting -- not just the original {{ ... }} span, so the
      // splice bookkeeping needs to describe what actually lands in `text` here, not the
      // original match's own (possibly narrower) bounds.
      const lineStart = lines.bounds(span.firstLine)[0];
      const lineEnd = lines.bounds(span.lastLine)[1];
      // Includes the line's own original leading whitespace (unlike `original` above), since a
      // caller restoring this text (scriptEmbed.ts, on write-back) needs to put the action back
      // completely unchanged, indentation included, not just re-attach the bare `{{ ... }}`.
      const originalWithIndent = source.slice(lineStart, lineEnd);
      out += source.slice(cursor, lineStart);

      const before = neighborIndent(span.firstLine, -1);
      const after = neighborIndent(span.lastLine, 1);
      const targetIndent = before !== undefined && after !== undefined ? Math.min(before, after) : undefined;
      const { text: maskedLines, commentColumns } = maskStandaloneLines(lines, span.firstLine, span.lastLine, targetIndent);
      out += maskedLines;

      // `range` points at the masked *comment* itself (where the `#` lands), not the line's
      // leading whitespace before it -- a caller mapping this offset against `text` (e.g.
      // scriptEmbed.ts, once its own block-indent stripping is layered on top) needs the
      // position of real content, not indentation it would otherwise strip away first.
      actions.push({ range: [lineStart + commentColumns[0], lineEnd], original: originalWithIndent, standalone: true });
      cursor = lineEnd;
    }
  }
  out += source.slice(cursor);

  return { text: out, masked: true, actions };
}

/** A line's length for masking purposes, excluding a trailing `\r` (CRLF) -- that character is preserved as-is rather than turned into `x` filler, same as the original non-standalone masking's `/[^\n\r]/g` did. */
function bodyLength(line: string): number {
  return line.endsWith("\r") ? line.length - 1 : line.length;
}

/** `#` + `x` filler for `line`'s first `bodyLength(line)` characters, `indent` spaces of which lead instead of filler -- any trailing `\r` is carried over unchanged. */
function maskLine(line: string, indent: number): string {
  const cr = line.endsWith("\r") ? "\r" : "";
  return " ".repeat(indent) + "#" + "x".repeat(bodyLength(line) - indent - 1) + cr;
}

/**
 * Masks every line of a standalone action's own span as a `#`-led comment
 * of the exact same length. When `targetIndent` is given and every
 * affected line has room for it (`targetIndent` spaces + at least one `#`),
 * re-indents to that depth; otherwise falls back to preserving each line's
 * own original leading whitespace, same as before re-indenting existed.
 *
 * Also returns the column each line's own `#` actually landed at (or, for
 * a line too short to fit even the fallback comment, where it *would*
 * have) -- callers that need to point at the masked comment itself (not
 * its line's leading whitespace) need this, since which of the two
 * strategies applied isn't otherwise visible to them.
 */
function maskStandaloneLines(
  lines: LineIndex,
  firstLine: number,
  lastLine: number,
  targetIndent: number | undefined
): { text: string; commentColumns: number[] } {
  const texts: string[] = [];
  for (let line = firstLine; line <= lastLine; line++) texts.push(lines.text(line));

  if (targetIndent !== undefined && texts.every((t) => bodyLength(t) >= targetIndent + 1)) {
    return { text: texts.map((t) => maskLine(t, targetIndent)).join("\n"), commentColumns: texts.map(() => targetIndent) };
  }

  const commentColumns = texts.map((t) => LEADING_WS.exec(t)![0].length);
  const text = texts.map((t, i) => (bodyLength(t) > commentColumns[i] ? maskLine(t, commentColumns[i]) : t)).join("\n");
  return { text, commentColumns };
}
