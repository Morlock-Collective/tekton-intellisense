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

/**
 * Replaces each {{ ... }} action with a placeholder of identical length.
 * Actions that look like they open a YAML mapping/sequence value (i.e. the
 * whole scalar is just the action) are replaced with a quoted empty-ish
 * placeholder so the surrounding YAML stays parseable; actions embedded
 * inside larger scalars (e.g. `image: {{ .Values.repo }}:{{ .Values.tag }}`)
 * are replaced with a run of `x` characters so string concatenation still
 * looks like a plain scalar.
 */
export function maskHelmTemplates(source: string): MaskResult {
  let masked = false;
  const text = source.replace(TEMPLATE_ACTION, (match) => {
    masked = true;
    const len = match.length;
    if (len <= 2) {
      return "x".repeat(len);
    }
    return "x".repeat(len);
  });
  return { text, masked };
}

/** Heuristic: does this file look like it contains Go-template syntax at all? */
export function looksLikeHelmTemplate(source: string): boolean {
  return TEMPLATE_ACTION.test(source);
}
