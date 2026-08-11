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
 * Replaces each {{ ... }} action with a same-length run of `x` characters,
 * so the surrounding text still reads as a plain YAML scalar. Newlines
 * *within* an action are preserved as-is rather than flattened — Go
 * template actions are allowed to span multiple lines (e.g. a multi-line
 * pipeline argument list), and collapsing them would shift every line
 * number after the action, defeating the entire point of masking in place.
 */
export function maskHelmTemplates(source: string): MaskResult {
  let masked = false;
  const text = source.replace(TEMPLATE_ACTION, (match) => {
    masked = true;
    return match.replace(/[^\n\r]/g, "x");
  });
  return { text, masked };
}
