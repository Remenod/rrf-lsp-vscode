// parser/types.ts
// Derived from ExpressionParser.cpp, StringParser.cpp (RRF firmware)

export enum TokenType {
    // ── Literals ─────────────────────────────────────────────────────────────
    Integer,            // 42  0  -1
    HexInteger,         // 0xFF
    BinInteger,         // 0b1010
    Float,              // 3.14  1e-3
    StringLit,          // "hello"  (double-quote escape = "")
    CharLit,            // 'A'

    // ── Named constants (NamedEnum NamedConstant in ExpressionParser.cpp) ────
    True, False, Null, Pi, Iterations, Line, Result, Input,

    // ── G/M/T codes ──────────────────────────────────────────────────────────
    GCode,              // G28  M220  G29.1
    TCode,              // T0  T-1  T

    // ── Meta commands (StringParser.cpp, CheckIfMetaCommand) ─────────────────
    If, Elif, Else,
    While, Break, Continue,
    Abort,
    Var, Global, Set, Echo, Param, Skip,

    // ── Functions (NamedEnum Function in ExpressionParser.cpp) ───────────────
    FunctionName,       // abs acos asin atan atan2 ceil cos datetime degrees
    // drop exists exp fileexists fileread find floor isnan
    // log max min mod pow radians random round sin sqrt
    // square take tan vector

    // ── Operators (from ParseInternal operators string "?^&|!=<>+-*/") ───────
    Plus,               // +   (also unary)
    Minus,              // -   (also unary)
    Star,               // *
    Slash,              // /
    Caret,              // ^   string concat
    Eq,                 // =   (assignment context) or == (comparison)
    EqEq,               // ==
    NEq,                // !=
    Lt,                 // <
    Gt,                 // >
    LtEq,               // <=
    GtEq,               // >=
    And,                // &  or &&
    Or,                 // |  or ||
    Not,                // !
    Ternary,            // ?
    Colon,              // :
    Hash,               // #   length operator
    TripleGt,           // >>>
    DoubleGt,           // >>

    // ── Brackets ─────────────────────────────────────────────────────────────
    LParen,             // (
    RParen,             // )
    LBrace,             // {
    RBrace,             // }
    LBracket,           // [
    RBracket,           // ]

    // ── Structural ────────────────────────────────────────────────────────────
    Dot,                // .
    Comma,              // ,
    Semicolon,          // ; (also starts a comment)

    // ── Misc ──────────────────────────────────────────────────────────────────
    Identifier,         // var.x  global.y  param.z  or plain name
    Comment,            // ; rest of line
    EOF,
    Unknown,
}

export interface Token {
    type: TokenType;
    value: string;
    line: number;   // 0-based
    start: number;   // character offset from line start
    end: number;   // exclusive
}

// ── Known function names ──────────────────────────────────────────────────────
export const FUNCTION_NAMES = new Set([
    'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'datetime', 'degrees',
    'drop', 'exists', 'exp', 'fileexists', 'fileread', 'find', 'floor', 'isnan',
    'log', 'max', 'min', 'mod', 'pow', 'radians', 'random', 'round', 'sin', 'sqrt',
    'square', 'take', 'tan', 'vector',
]);

// ── Named constants ───────────────────────────────────────────────────────────
export const NAMED_CONSTANTS = new Set([
    'true', 'false', 'null', 'pi', 'iterations', 'line', 'result', 'input',
]);

// ── Meta command keyword → TokenType ─────────────────────────────────────────
export const META_KEYWORDS: Record<string, TokenType> = {
    if: TokenType.If,
    elif: TokenType.Elif,
    else: TokenType.Else,
    while: TokenType.While,
    break: TokenType.Break,
    continue: TokenType.Continue,
    abort: TokenType.Abort,
    var: TokenType.Var,
    global: TokenType.Global,
    set: TokenType.Set,
    echo: TokenType.Echo,
    param: TokenType.Param,
    skip: TokenType.Skip,
};

// ── Semantic token type names (for LSP legend) ────────────────────────────────
export const SEMANTIC_TOKEN_TYPES = [
    'keyword',      // 0  meta commands
    'function',     // 1  built-in functions
    'variable',     // 2  var. global. param.
    'number',       // 3  numeric literals
    'string',       // 4  string / char literals
    'operator',     // 5  operators
    'parameter',    // 6  named constants
    'macro',        // 7  G/M/T codes
    'comment',      // 8  ; comments
];

export const SEMANTIC_TOKEN_MODIFIERS: string[] = [];
