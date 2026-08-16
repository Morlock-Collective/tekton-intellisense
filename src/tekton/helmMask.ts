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

export interface MaskResult {
  text: string;
  masked: boolean;
}

/** True when nothing but whitespace surrounds `source[start, end)` on its own line(s). */
function isAloneOnItsLines(source: string, start: number, end: number): boolean {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const before = source.slice(lineStart, start);
  const nextNewline = source.indexOf("\n", end);
  const after = source.slice(end, nextNewline === -1 ? source.length : nextNewline);
  return /^[ \t]*$/.test(before) && /^[ \t]*\r?$/.test(after);
}

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
 * Newlines *within* an action are preserved as-is rather than flattened —
 * Go template actions are allowed to span multiple lines (e.g. a
 * multi-line pipeline argument list), and collapsing them would shift
 * every line number after the action, defeating the entire point of
 * masking in place. A standalone multi-line action gets a `#` at the start
 * of *every* line it spans, not just its first, so each of those lines is
 * individually a valid comment too.
 */
export function maskHelmTemplates(source: string): MaskResult {
  let masked = false;
  const text = source.replace(TEMPLATE_ACTION, (match, offset: number) => {
    masked = true;
    if (!isAloneOnItsLines(source, offset, offset + match.length)) {
      return match.replace(/[^\n\r]/g, "x");
    }
    return match
      .split(/(\n)/)
      .map((segment) =>
        segment === "\n" || segment.length === 0 ? segment : "#" + segment.slice(1).replace(/[^\n\r]/g, "x")
      )
      .join("");
  });
  return { text, masked };
}
