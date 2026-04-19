// parser/expression.ts
// Validation-only recursive-descent parser mirroring ExpressionParser::ParseInternal().
// Does NOT evaluate — it walks the token stream and collects parse errors.

import { Token, TokenType, FUNCTION_NAMES, NAMED_CONSTANTS } from './types';

export interface ParseError {
  message: string;
  start: number;   // character offset in line
  end: number;
  line: number;
}

// ── Operator priorities (mirrors ExpressionParser.cpp operators string "?^&|!=<>+-*/") ──
const BINARY_OPS = new Map<TokenType, number>([
  [TokenType.Ternary, 1],      // ?
  [TokenType.Caret, 2],        // ^ (string concat)
  [TokenType.And, 3],          // & / &&
  [TokenType.Or, 3],           // | / ||
  [TokenType.Not, 4],          // ! (parsed as != here)
  [TokenType.NEq, 4],          // !=
  [TokenType.Eq, 4],           // =  / ==
  [TokenType.EqEq, 4],         // ==
  [TokenType.Lt, 4],           // <
  [TokenType.Gt, 4],           // >
  [TokenType.LtEq, 4],         // <=
  [TokenType.GtEq, 4],         // >=
  [TokenType.Plus, 5],         // +
  [TokenType.Minus, 5],        // -
  [TokenType.Star, 6],         // *
  [TokenType.Slash, 6],        // /
]);

// Max args for known functions (undefined = variadic/unknown)
const FUNC_ARG_RANGE: Record<string, [number, number]> = {
  abs: [1, 1],
  acos: [1, 1],
  asin: [1, 1],
  atan: [1, 1],
  atan2: [2, 2],
  ceil: [1, 1],
  cos: [1, 1],
  datetime: [1, 1],
  degrees: [1, 1],
  drop: [2, 2],
  exists: [1, 1],
  exp: [1, 1],
  fileexists: [1, 1],
  fileread: [4, 4],
  find: [2, 2],
  floor: [1, 1],
  isnan: [1, 1],
  log: [1, 1],
  max: [1, 99],
  min: [1, 99],
  mod: [2, 2],
  pow: [2, 2],
  radians: [1, 1],
  random: [1, 1],
  round: [1, 1],
  sin: [1, 1],
  sqrt: [1, 1],
  square: [1, 1],
  take: [2, 2],
  tan: [1, 1],
  vector: [2, 2],
};

export class ExpressionValidator {
  private pos = 0;
  private tokens: Token[];
  readonly errors: ParseError[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ── Entry: validate the whole expression ──────────────────────────────────
  validate(): ParseError[] {
    this.parseInternal(0);
    // Expect EOF after expression (for expression-only contexts)
    return this.errors;
  }

  // ── ParseInternal: mirrors ExpressionParser::ParseInternal ────────────────
  private parseInternal(priority: number): void {
    this.parseUnaryOrPrimary();
    this.parseBinaryTail(priority);
  }

  // ── Unary prefix + primary ────────────────────────────────────────────────
  private parseUnaryOrPrimary(): void {
    const t = this.current();

    switch (t.type) {
      // Unary operators: -  +  !  #
      case TokenType.Minus:
      case TokenType.Plus:
      case TokenType.Not:
        this.advance();
        this.parseInternal(10); // unary priority = 10 (highest)
        return;

      case TokenType.Hash:
        this.advance();
        if (this.isAlpha(this.current())) {
          this.parseIdentifierExpression();
        } else {
          this.parseInternal(10);
        }
        return;

      // Bracket expressions
      case TokenType.LParen:
        this.advance();
        this.parseInternal(0);
        this.expect(TokenType.RParen, "expected ')'");
        return;

      case TokenType.LBrace:
        this.advance();
        this.parseInternal(0);
        // may be array {a, b, c}
        while (this.current().type === TokenType.Comma) {
          this.advance();
          if (this.current().type === TokenType.RBrace) break;
          this.parseInternal(0);
        }
        this.expect(TokenType.RBrace, "expected '}'");
        return;

      case TokenType.LBracket:
        this.advance();
        if (this.current().type !== TokenType.RBracket) {
          this.parseInternal(0);
          while (this.current().type === TokenType.Comma) {
            this.advance();
            if (this.current().type === TokenType.RBracket) break;
            this.parseInternal(0);
          }
        }
        this.expect(TokenType.RBracket, "expected ']'");
        return;

      // Literals
      case TokenType.Integer:
      case TokenType.HexInteger:
      case TokenType.BinInteger:
      case TokenType.Float:
      case TokenType.StringLit:
      case TokenType.CharLit:
      case TokenType.True:
      case TokenType.False:
      case TokenType.Null:
      case TokenType.Pi:
      case TokenType.Iterations:
      case TokenType.Line:
      case TokenType.Result:
      case TokenType.Input:
        this.advance();
        // Trailing index  expr[N]
        this.parseTrailingIndexes();
        return;

      // Function call or identifier
      case TokenType.FunctionName:
        this.parseFunctionCall(t);
        return;

      case TokenType.Identifier:
        this.parseIdentifierExpression();
        return;

      // EOF / unexpected
      case TokenType.EOF:
        return;

      default:
        if (t.type !== TokenType.Comment) {
          this.addError(`unexpected token '${t.value}'`, t);
        }
        this.advance();
        return;
    }
  }

  // ── Function call ──────────────────────────────────────────────────────────
  private parseFunctionCall(nameTok: Token): void {
    this.advance(); // consume function name
    const funcName = nameTok.value.toLowerCase();

    // Special: exists(expr) — takes an identifier, not a normal expression
    if (funcName === 'exists') {
      this.expect(TokenType.LParen, "expected '(' after 'exists'");
      // optional # prefix
      if (this.current().type === TokenType.Hash) this.advance();
      this.parseIdentifierExpression();
      this.expect(TokenType.RParen, "expected ')' after exists argument");
      return;
    }

    this.expect(TokenType.LParen, `expected '(' after '${nameTok.value}'`);

    const argRange = FUNC_ARG_RANGE[funcName];
    let argCount = 0;

    if (this.current().type !== TokenType.RParen) {
      this.parseInternal(0);
      argCount = 1;

      while (this.current().type === TokenType.Comma) {
        this.advance();
        this.parseInternal(0);
        argCount++;
      }
    }

    if (argRange) {
      const [minA, maxA] = argRange;
      if (argCount < minA) {
        this.addError(`'${funcName}' requires at least ${minA} argument(s), got ${argCount}`, nameTok);
      } else if (argCount > maxA) {
        this.addError(`'${funcName}' takes at most ${maxA} argument(s), got ${argCount}`, nameTok);
      }
    }

    this.expect(TokenType.RParen, `expected ')' after arguments to '${funcName}'`);
    this.parseTrailingIndexes();
  }

  // ── Identifier expression: var.x  global.y  param.z  obj.model.path ───────
  private parseIdentifierExpression(): void {
    const t = this.current();
    if (t.type === TokenType.Identifier) {
      this.advance();
    } else if (this.isKnownWordToken(t)) {
      this.advance();
    }
    this.parseTrailingIndexes();
  }

  // ── Trailing [ ] index operators ──────────────────────────────────────────
  private parseTrailingIndexes(): void {
    while (this.current().type === TokenType.LBracket) {
      this.advance();
      this.parseInternal(0);
      this.expect(TokenType.RBracket, "expected ']'");
    }
  }

  // ── Binary operator tail ───────────────────────────────────────────────────
  private parseBinaryTail(priority: number): void {
    for (; ;) {
      const t = this.current();
      const prio = BINARY_OPS.get(t.type);
      if (prio === undefined || prio <= priority) return;

      this.advance();

      // Ternary: expr ? expr : expr
      if (t.type === TokenType.Ternary) {
        this.parseInternal(prio);
        this.expect(TokenType.Colon, "expected ':' in ternary expression");
        this.parseInternal(prio - 1);
        return;
      }

      this.parseInternal(prio);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private current(): Token { return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 }; }
  private advance(): Token { return this.tokens[this.pos++] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 }; }

  private expect(type: TokenType, msg: string): boolean {
    const t = this.current();
    if (t.type === type) { this.advance(); return true; }
    if (t.type !== TokenType.EOF) {
      this.addError(msg, t);
    }
    return false;
  }

  private addError(message: string, tok: Token): void {
    this.errors.push({ message, start: tok.start, end: tok.end, line: tok.line });
  }

  private isAlpha(t: Token): boolean {
    return t.type === TokenType.Identifier || t.type === TokenType.FunctionName ||
      (t.type >= TokenType.True && t.type <= TokenType.Input);
  }

  private isKnownWordToken(t: Token): boolean {
    // Tokens that are valid expression starts even though they have specific types
    return t.type >= TokenType.True && t.type <= TokenType.Input;
  }
}

// ── Validate a full line (meta command + optional expression) ─────────────────
export interface LineValidationResult {
  errors: ParseError[];
  exprStart?: number;   // column where the expression starts (for hover etc.)
}

export function validateLine(tokens: Token[], lineText: string): ParseError[] {
  const errors: ParseError[] = [];
  if (!tokens.length) return errors;

  const first = tokens[0];

  // Meta commands that take an expression
  const expressionMeta = new Set([
    TokenType.If, TokenType.Elif, TokenType.While,
    TokenType.Set, TokenType.Echo, TokenType.Var, TokenType.Global,
  ]);

  // Check bracket balance over the whole line
  checkBracketBalance(tokens, errors);

  if (expressionMeta.has(first.type)) {
    // Skip to expression part (after the keyword and optional variable name for var/global/set)
    let exprStart = 1;
    if (first.type === TokenType.Var || first.type === TokenType.Global) {
      // var <name> = <expr>   or   global <name> = <expr>
      if (tokens[1]?.type === TokenType.Identifier) exprStart = 2;
      if (tokens[exprStart]?.type === TokenType.Eq) exprStart++;
    } else if (first.type === TokenType.Set) {
      // set <name> = <expr>
      if (tokens[1]?.type === TokenType.Identifier) exprStart = 2;
      if (tokens[exprStart]?.type === TokenType.Eq) exprStart++;
    }
    const exprTokens = tokens.slice(exprStart);
    if (exprTokens.length > 0 && exprTokens[0].type !== TokenType.EOF) {
      const v = new ExpressionValidator(exprTokens);
      errors.push(...v.validate());
    }
  }

  return errors;
}

// ── Bracket balance checker ───────────────────────────────────────────────────
function checkBracketBalance(tokens: Token[], errors: ParseError[]): void {
  const stack: Token[] = [];
  const PAIRS: Partial<Record<TokenType, TokenType>> = {
    [TokenType.LParen]: TokenType.RParen,
    [TokenType.LBrace]: TokenType.RBrace,
    [TokenType.LBracket]: TokenType.RBracket,
  };
  const CLOSERS = new Set([TokenType.RParen, TokenType.RBrace, TokenType.RBracket]);
  const OPENER_FOR: Partial<Record<TokenType, string>> = {
    [TokenType.RParen]: '(',
    [TokenType.RBrace]: '{',
    [TokenType.RBracket]: '[',
  };

  for (const t of tokens) {
    if (t.type === TokenType.EOF || t.type === TokenType.Comment) break;
    if (PAIRS[t.type] !== undefined) {
      stack.push(t);
    } else if (CLOSERS.has(t.type)) {
      if (stack.length === 0) {
        errors.push({ message: `unexpected '${t.value}'`, start: t.start, end: t.end, line: t.line });
      } else {
        const open = stack[stack.length - 1];
        if (PAIRS[open.type] !== t.type) {
          errors.push({
            message: `mismatched bracket: expected '${tokenChar(PAIRS[open.type]!)}' but got '${t.value}'`,
            start: t.start, end: t.end, line: t.line,
          });
          stack.pop();
        } else {
          stack.pop();
        }
      }
    }
  }

  for (const unclosed of stack) {
    errors.push({
      message: `unclosed '${unclosed.value}'`,
      start: unclosed.start, end: unclosed.end, line: unclosed.line,
    });
  }
}

function tokenChar(tt: TokenType): string {
  switch (tt) {
    case TokenType.RParen: return ')';
    case TokenType.RBrace: return '}';
    case TokenType.RBracket: return ']';
    default: return '?';
  }
}
