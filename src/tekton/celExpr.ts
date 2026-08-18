/**
 * Structural (syntax-only) validation for CEL expressions (Tekton Triggers'
 * `cel` interceptor `filter`/`overlays[].expression` params). A real
 * recursive-descent parser against CEL's published grammar
 * (github.com/google/cel-spec/blob/master/doc/langdef.md#syntax), not a
 * pile of character-level heuristics — an earlier heuristic version (bracket
 * balance, string termination, then bolted-on "can't start/end on an
 * operator" checks) kept turning up new gaps one report at a time (e.g. two
 * adjacent identifiers with no operator between them was never caught,
 * since a generic adjacency check risks false positives against CEL's `in`
 * operator). A real parser either accepts or rejects, with no such gaps by
 * construction, and reports precise error positions as a side effect of
 * parsing rather than needing separate position-recovery logic.
 *
 * Still deliberately NOT semantic validation: param types aren't known
 * statically (Tekton doesn't type `body`/`header` beyond "some JSON"), so
 * this never rejects on type grounds — only on shapes no CEL program can
 * have regardless of types. Two grammar productions are intentionally
 * unsupported (message-literal construction `Msg{field: val}` after a
 * member, and macro-specific arg-count rules for `has`/`all`/`exists`/...)
 * since both are essentially unused in Tekton interceptor filters/overlays
 * (which only ever produce a bool or a string) — omitting them means a
 * very obscure expression could be wrongly accepted, never wrongly
 * rejected.
 *
 * No external dependency: the one CEL-aware npm package (`cel-js`) doesn't
 * expose token/error positions from its public API, which would leave
 * every diagnostic anchored at the whole expression regardless of the
 * ~160KB it would add to the bundle.
 *
 * Deliberately has no `vscode` dependency — see `model.ts`/`scriptEmbed.ts`
 * for the same convention.
 */

export interface CelIssue {
  /** offsets relative to the expression text passed to {@link checkCelExpression} */
  start: number;
  end: number;
  message: string;
}

type TokenType = "ident" | "number" | "string" | "punct" | "keyword";

interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const TWO_CHAR_PUNCT = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const ONE_CHAR_PUNCT = new Set("+-*/%!<>?:.,()[]{}".split(""));
const RELOPS = new Set(["<", "<=", ">", ">=", "==", "!="]);
/** `true`/`false`/`null` are their own literal tokens in CEL's grammar, not identifiers -- so `2.true` is rejected the same way `2.5` is (a member name must be a real IDENT), with no type-checking involved. */
const RESERVED_LITERALS = new Set(["true", "false", "null"]);

/** Lexes a single- or double-quoted string literal starting at `start` (the opening quote). */
function lexString(expr: string, start: number): { end: number; terminated: boolean } {
  const quote = expr[start];
  const n = expr.length;
  let i = start + 1;
  while (i < n) {
    if (expr[i] === "\\") {
      i += 2;
      continue;
    }
    if (expr[i] === quote) return { end: i + 1, terminated: true };
    i++;
  }
  return { end: n, terminated: false };
}

/** Tokenizes `expr`, stopping at the first lexical error (unterminated string / unrecognized character). */
function lex(expr: string): { tokens: Token[]; error?: CelIssue } {
  const tokens: Token[] = [];
  const n = expr.length;
  let i = 0;

  while (i < n) {
    const c = expr[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // optional raw/bytes string prefix (r"...", b'...') -- lex prefix+string as one token
    const isStringPrefix = (c === "r" || c === "R" || c === "b" || c === "B") && (expr[i + 1] === '"' || expr[i + 1] === "'");
    if (c === '"' || c === "'" || isStringPrefix) {
      const start = i;
      const quoteAt = isStringPrefix ? i + 1 : i;
      const { end, terminated } = lexString(expr, quoteAt);
      if (!terminated) return { tokens, error: { start, end: n, message: "Unterminated string literal" } };
      tokens.push({ type: "string", text: expr.slice(start, end), start, end });
      i = end;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_]/.test(expr[i])) i++;
      const text = expr.slice(start, i);
      tokens.push({ type: RESERVED_LITERALS.has(text) ? "keyword" : "ident", text, start, end: i });
      continue;
    }

    if (/[0-9]/.test(c)) {
      const start = i;
      if (c === "0" && (expr[i + 1] === "x" || expr[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(expr[i])) i++;
      } else {
        i++;
        while (i < n && /[0-9]/.test(expr[i])) i++;
        if (expr[i] === "." && /[0-9]/.test(expr[i + 1] ?? "")) {
          i++;
          while (i < n && /[0-9]/.test(expr[i])) i++;
        }
        if (expr[i] === "e" || expr[i] === "E") {
          i++;
          if (expr[i] === "+" || expr[i] === "-") i++;
          while (i < n && /[0-9]/.test(expr[i])) i++;
        }
        if (expr[i] === "u" || expr[i] === "U") i++;
      }
      tokens.push({ type: "number", text: expr.slice(start, i), start, end: i });
      continue;
    }

    const two = expr.slice(i, i + 2);
    if (TWO_CHAR_PUNCT.has(two)) {
      tokens.push({ type: "punct", text: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ONE_CHAR_PUNCT.has(c)) {
      tokens.push({ type: "punct", text: c, start: i, end: i + 1 });
      i++;
      continue;
    }

    return { tokens, error: { start: i, end: i + 1, message: `Unexpected character "${c}"` } };
  }

  return { tokens };
}

class ParseError {
  constructor(public start: number, public end: number, public message: string) {}
}

type LiteralKind = "bool" | "number" | "string" | "null";

/** A subexpression that reduces to exactly one literal token, nothing else -- the only case the ternary check below can classify without any type inference. */
interface LiteralInfo {
  kind: LiteralKind;
  start: number;
  end: number;
}

/**
 * Recursive-descent parser over CEL's expression grammar (operator
 * precedence lowest to highest: ternary, ||, &&, relational, +/-, * / %,
 * unary, member/call/index, primary). Parses for validation only -- doesn't
 * build an AST, just consumes tokens or throws {@link ParseError} at the
 * first one that doesn't fit.
 *
 * Each level also returns a {@link LiteralInfo} when (and only when) the
 * subexpression it just parsed is *exactly* one literal token with nothing
 * else applied at or above that level (no operator, no call, no member
 * access) -- e.g. `5` is, `5 + 1` isn't, `body.count` isn't. This is enough
 * to catch a ternary whose branches are literally-typed and disagree
 * (`cond ? true : 234`) without attempting real type inference: the moment
 * either branch involves anything whose type isn't directly visible in the
 * text (a param, a member access, a call, a sub-expression), the check
 * backs off rather than guessing.
 */
class Parser {
  private pos = 0;

  constructor(private tokens: Token[], private exprLen: number) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isPunct(text: string): boolean {
    const t = this.peek();
    return !!t && t.type === "punct" && t.text === text;
  }

  private advance(): void {
    this.pos++;
  }

  private expectPunct(text: string): void {
    const t = this.peek();
    if (t && t.type === "punct" && t.text === text) {
      this.advance();
      return;
    }
    if (!t) throw new ParseError(this.exprLen, this.exprLen, `Expected "${text}" but the expression ended`);
    throw new ParseError(t.start, t.end, `Expected "${text}" but found "${t.text}"`);
  }

  private parseCallArgsIfPresent(): void {
    if (!this.isPunct("(")) return;
    this.advance();
    this.parseExprListUntil(")");
    this.expectPunct(")");
  }

  parseExpr(): LiteralInfo | undefined {
    const cond = this.parseConditionalOr();
    if (this.isPunct("?")) {
      this.advance();
      const thenInfo = this.parseConditionalOr();
      this.expectPunct(":");
      const elseInfo = this.parseExpr();
      if (thenInfo && elseInfo && thenInfo.kind !== elseInfo.kind) {
        throw new ParseError(
          thenInfo.start,
          elseInfo.end,
          `Ternary branches have different types ("${thenInfo.kind}" vs "${elseInfo.kind}")`
        );
      }
      return undefined;
    }
    return cond;
  }

  private parseConditionalOr(): LiteralInfo | undefined {
    const info = this.parseConditionalAnd();
    let touched = false;
    while (this.isPunct("||")) {
      this.advance();
      this.parseConditionalAnd();
      touched = true;
    }
    return touched ? undefined : info;
  }

  private parseConditionalAnd(): LiteralInfo | undefined {
    const info = this.parseRelation();
    let touched = false;
    while (this.isPunct("&&")) {
      this.advance();
      this.parseRelation();
      touched = true;
    }
    return touched ? undefined : info;
  }

  private parseRelation(): LiteralInfo | undefined {
    const info = this.parseAddition();
    let touched = false;
    while (true) {
      const t = this.peek();
      const isRelop = !!t && ((t.type === "punct" && RELOPS.has(t.text)) || (t.type === "ident" && t.text === "in"));
      if (!isRelop) break;
      this.advance();
      this.parseAddition();
      touched = true;
    }
    return touched ? undefined : info;
  }

  private parseAddition(): LiteralInfo | undefined {
    const info = this.parseMultiplication();
    let touched = false;
    while (this.isPunct("+") || this.isPunct("-")) {
      this.advance();
      this.parseMultiplication();
      touched = true;
    }
    return touched ? undefined : info;
  }

  private parseMultiplication(): LiteralInfo | undefined {
    const info = this.parseUnary();
    let touched = false;
    while (this.isPunct("*") || this.isPunct("/") || this.isPunct("%")) {
      this.advance();
      this.parseUnary();
      touched = true;
    }
    return touched ? undefined : info;
  }

  private parseUnary(): LiteralInfo | undefined {
    if (this.isPunct("!") || this.isPunct("-")) {
      this.advance();
      this.parseUnary();
      return undefined;
    }
    return this.parseMember();
  }

  private parseMember(): LiteralInfo | undefined {
    const info = this.parsePrimary();
    let touched = false;
    while (true) {
      if (this.isPunct(".")) {
        this.advance();
        const t = this.peek();
        if (!t || t.type !== "ident") {
          throw new ParseError(t ? t.start : this.exprLen, t ? t.end : this.exprLen, 'Expected a field/method name after "."');
        }
        this.advance();
        this.parseCallArgsIfPresent();
        touched = true;
        continue;
      }
      if (this.isPunct("[")) {
        this.advance();
        this.parseExpr();
        this.expectPunct("]");
        touched = true;
        continue;
      }
      break;
    }
    return touched ? undefined : info;
  }

  private parsePrimary(): LiteralInfo | undefined {
    const t = this.peek();
    if (!t) throw new ParseError(this.exprLen, this.exprLen, "Expected an expression but the expression ended");

    // leading-dot absolute name, e.g. `.google.rpc.Code`
    if (t.type === "punct" && t.text === ".") {
      this.advance();
      const id = this.peek();
      if (!id || id.type !== "ident") throw new ParseError(t.start, t.end, 'Expected an identifier after "."');
      this.advance();
      this.parseCallArgsIfPresent();
      return undefined;
    }

    if (t.type === "ident") {
      this.advance();
      this.parseCallArgsIfPresent();
      return undefined;
    }

    if (t.type === "keyword") {
      this.advance();
      return { kind: t.text === "null" ? "null" : "bool", start: t.start, end: t.end };
    }

    if (t.type === "number") {
      this.advance();
      return { kind: "number", start: t.start, end: t.end };
    }

    if (t.type === "string") {
      this.advance();
      return { kind: "string", start: t.start, end: t.end };
    }

    if (t.type === "punct" && t.text === "(") {
      this.advance();
      this.parseExpr();
      this.expectPunct(")");
      return undefined;
    }

    if (t.type === "punct" && t.text === "[") {
      this.advance();
      this.parseExprListUntil("]");
      this.expectPunct("]");
      return undefined;
    }

    if (t.type === "punct" && t.text === "{") {
      this.advance();
      this.parseMapEntriesUntil("}");
      this.expectPunct("}");
      return undefined;
    }

    throw new ParseError(t.start, t.end, `Unexpected token "${t.text}"`);
  }

  private parseExprListUntil(closer: string): void {
    if (this.isPunct(closer)) return;
    this.parseExpr();
    while (this.isPunct(",")) {
      this.advance();
      if (this.isPunct(closer)) return; // trailing comma
      this.parseExpr();
    }
  }

  /** `{key: value, ...}` -- covers both field-init (`{name: expr}`) and map-init (`{expr: expr}`) shapes, since an identifier is a valid expr too. */
  private parseMapEntriesUntil(closer: string): void {
    const entry = () => {
      this.parseExpr();
      this.expectPunct(":");
      this.parseExpr();
    };
    if (this.isPunct(closer)) return;
    entry();
    while (this.isPunct(",")) {
      this.advance();
      if (this.isPunct(closer)) return;
      entry();
    }
  }

  parseTop(): void {
    this.parseExpr();
    const t = this.peek();
    if (t) throw new ParseError(t.start, t.end, `Unexpected token "${t.text}"`);
  }
}

/** Validates `expr` as CEL syntax, returning at most one issue -- a parser reports the first thing that doesn't fit and stops, same as most language tooling. */
export function checkCelExpression(expr: string): CelIssue[] {
  if (expr.trim().length === 0) {
    return [{ start: 0, end: expr.length, message: "Empty CEL expression" }];
  }

  const { tokens, error } = lex(expr);
  if (error) return [error];

  try {
    new Parser(tokens, expr.length).parseTop();
    return [];
  } catch (e) {
    if (e instanceof ParseError) return [{ start: e.start, end: Math.max(e.end, e.start + 1), message: e.message }];
    throw e;
  }
}

/**
 * Maps {@link checkCelExpression}'s expression-relative issue offsets onto
 * `sourceText`, given the CEL expression's own scalar `nodeRange` (as
 * produced by the `yaml` package — spans the whole scalar, quotes
 * included) and its already-decoded `value`.
 *
 * For the common case (plain, single- or double-quoted scalar with no
 * escape sequences) the decoded value is a verbatim substring of the raw
 * text right after any opening quote, so we can map offsets 1:1 — verified
 * by re-slicing and comparing rather than assumed, so a scalar style this
 * doesn't handle (block literals, escaped quotes) safely falls back to
 * anchoring the whole scalar instead of ever reporting a wrong position.
 */
export function celIssuesInSource(
  sourceText: string,
  nodeRange: [number, number],
  value: string
): { range: [number, number]; message: string }[] {
  const issues = checkCelExpression(value);
  if (issues.length === 0) return [];

  const mapping = mapValueIntoSource(sourceText, nodeRange, value);

  return issues.map((issue) =>
    mapping.precise
      ? { range: [mapping.contentStart + issue.start, mapping.contentStart + issue.end] as [number, number], message: issue.message }
      : { range: nodeRange, message: issue.message }
  );
}

/** Shared by {@link celIssuesInSource} and {@link celHighlightTokensInSource} -- see the doc comment above for what "precise" means and why it's verified rather than assumed. */
function mapValueIntoSource(
  sourceText: string,
  nodeRange: [number, number],
  value: string
): { contentStart: number; precise: boolean } {
  const [nodeStart] = nodeRange;
  const quoted = sourceText[nodeStart] === '"' || sourceText[nodeStart] === "'";
  const contentStart = quoted ? nodeStart + 1 : nodeStart;
  return { contentStart, precise: sourceText.slice(contentStart, contentStart + value.length) === value };
}

export type CelHighlightTokenType = "string" | "number" | "keyword" | "operator" | "variable" | "function" | "property";

export interface CelHighlightToken {
  type: CelHighlightTokenType;
  start: number;
  end: number;
}

/** Punctuation tokens meaningful enough to highlight as operators; brackets/comma/dot are left alone, same as most language highlighters. */
const OPERATOR_PUNCT_TEXT = new Set(["+", "-", "*", "/", "%", "!", "<", ">", "<=", ">=", "==", "!=", "&&", "||", "?", ":"]);

/**
 * Classifies `expr`'s tokens for syntax highlighting -- reuses the same
 * lexer as {@link checkCelExpression}, since token *shape* (string, number,
 * keyword, punctuation) is unambiguous regardless of whether the overall
 * expression is syntactically valid; a lex error still highlights whatever
 * tokens were found before it (useful mid-edit, when the expression is
 * necessarily incomplete). An identifier is further classified from its
 * neighbors: right before a "(" it's a `function` (a free function call or
 * a method call, e.g. the `matches` in `body.matches(...)` -- checked
 * before the "after a dot" rule below, so a method call reads as a
 * function rather than a property), right after a "." (and not a call)
 * it's a `property`, otherwise a plain `variable` -- and `in` (CEL's
 * membership operator, lexically just an identifier) is treated as a
 * `keyword`.
 */
export function tokenizeCelForHighlighting(expr: string): CelHighlightToken[] {
  const { tokens } = lex(expr);
  const out: CelHighlightToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "string") {
      out.push({ type: "string", start: t.start, end: t.end });
    } else if (t.type === "number") {
      out.push({ type: "number", start: t.start, end: t.end });
    } else if (t.type === "keyword") {
      out.push({ type: "keyword", start: t.start, end: t.end });
    } else if (t.type === "punct") {
      if (OPERATOR_PUNCT_TEXT.has(t.text)) out.push({ type: "operator", start: t.start, end: t.end });
    } else {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (t.text === "in") {
        out.push({ type: "keyword", start: t.start, end: t.end });
      } else if (next && next.type === "punct" && next.text === "(") {
        out.push({ type: "function", start: t.start, end: t.end });
      } else if (prev && prev.type === "punct" && prev.text === ".") {
        out.push({ type: "property", start: t.start, end: t.end });
      } else {
        out.push({ type: "variable", start: t.start, end: t.end });
      }
    }
  }

  return out;
}

/**
 * Maps {@link tokenizeCelForHighlighting}'s expression-relative token
 * offsets onto `sourceText`, the same way {@link celIssuesInSource} does
 * for validation issues -- except here, when the mapping can't be verified
 * precise (an escaped quote, a block scalar), highlighting is skipped
 * entirely rather than falling back to the whole-scalar range: unlike a
 * single diagnostic, several overlapping "highlight the whole value"
 * tokens would just look broken.
 */
export function celHighlightTokensInSource(
  sourceText: string,
  nodeRange: [number, number],
  value: string
): { range: [number, number]; type: CelHighlightTokenType }[] {
  const tokens = tokenizeCelForHighlighting(value);
  if (tokens.length === 0) return [];

  const mapping = mapValueIntoSource(sourceText, nodeRange, value);
  if (!mapping.precise) return [];

  return tokens.map((t) => ({ range: [mapping.contentStart + t.start, mapping.contentStart + t.end] as [number, number], type: t.type }));
}
