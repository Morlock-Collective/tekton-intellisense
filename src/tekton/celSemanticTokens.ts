/**
 * Syntax highlighting for `cel` interceptor `filter`/`overlays[].expression`
 * strings, via a Semantic Tokens Provider rather than a TextMate grammar
 * injection (compare `syntaxes/tekton-refs.injection.json`'s approach for
 * `$(...)` refs). A grammar can't safely scope itself to just these
 * strings: the CEL expression sits under a bare `value:` key (`- name:
 * filter` / `value: "..."`), and `value:` is one of the most generic,
 * ubiquitous keys in Tekton YAML -- a regex grammar would end up
 * highlighting unrelated strings as CEL. This provider instead reuses the
 * exact structural knowledge already built for diagnostics
 * (`model.ts#findCelExpressions`, `celExpr.ts`'s real lexer) to hand VS
 * Code precise token ranges, so there's no scoping ambiguity at all.
 *
 * Every token type used here (string/number/keyword/operator/variable/
 * function/property) is one of VS Code's *standard* semantic token types,
 * so themes color them out of the box with no `semanticTokenScopes`
 * contribution needed in package.json.
 */
import * as vscode from "vscode";
import { parseTektonFile, findCelExpressions } from "./model";
import { celHighlightTokensInSource, CelHighlightTokenType } from "./celExpr";

const TOKEN_TYPES: CelHighlightTokenType[] = ["string", "number", "keyword", "operator", "variable", "function", "property"];

export const celSemanticTokensLegend = new vscode.SemanticTokensLegend(TOKEN_TYPES);

export class CelSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(celSemanticTokensLegend);

    const tokens: { range: [number, number]; type: CelHighlightTokenType }[] = [];
    for (const parsed of parseTektonFile(document.getText())) {
      for (const loc of findCelExpressions(parsed)) {
        tokens.push(...celHighlightTokensInSource(parsed.text, loc.range, loc.value, loc.style));
      }
    }
    // Ascending document-offset order == ascending position order, which SemanticTokensBuilder
    // requires its pushes to arrive in.
    tokens.sort((a, b) => a.range[0] - b.range[0]);

    for (const { range, type } of tokens) {
      const start = document.positionAt(range[0]);
      const end = document.positionAt(range[1]);
      // CEL expressions live in single-line quoted scalars in every case this extracts from;
      // a token can't legitimately span multiple lines, so this is just defense in depth.
      if (start.line !== end.line) continue;
      builder.push(new vscode.Range(start, end), type);
    }

    return builder.build();
  }
}
