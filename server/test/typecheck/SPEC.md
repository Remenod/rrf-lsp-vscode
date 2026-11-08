# Type check — behaviour specification

This is the binding list of how the language server's type checker must behave.
Every rule has an ID; every ID has at least one test in `server/test/typecheck/*.test.ts`
(enforced by `99-spec-coverage.test.ts`). The tests are the executable form of this file.

Ground truth is the firmware source, not the Duet3D wiki:

| What | Where |
|---|---|
| Expression semantics (the fork the 22IDEX printers run) | `VisionMiner/duet/RepRapFirmware` tag `3.5.4-vm.1`, `src/GCodes/GCodeBuffer/ExpressionParser.cpp` |
| Meta commands (`var`, `set`, `echo`, `abort`, conditions) | same tag, `src/GCodes/GCodeBuffer/StringParser.cpp` |
| Numeric literals | `RRFLibraries/src/General/NumericConverter.cpp` (`FitsInInt32`, `FitsInUint32`) |
| Date strings | `src/libc/strptime.cpp` (`SafeStrptime`) |
| Per-version function / constant tables | upstream tags `3.3`, `3.4.0`, `3.5.0`, `3.6.0-beta.4`, `3.6.0-rc.2`, `3.6.0-rc.3`, `3.6.1` (`NamedEnum(Function, …)`) |

Tiers: **MUST** — required for the first release of the checker. **SHOULD** — precision or
hazard rules that may follow later. **PHASE 2** — needs data the server does not have yet.

## How the tests are gated

* `rule('TC-…', …)` tests are `todo` until their ID (or an `AREA-*` prefix) is listed in
  `implemented.ts`. Add IDs there as rules land; from then on they are hard failures.
* `guard('TC-…', …)` tests are always live. They assert things that are true today and must stay
  true: no false positives, no crashes, no changes to existing diagnostics.
* `RRF_TC_STRICT=1 npm test` runs every rule as a hard test — the red list is the work list.

## The interface the tests assume

* `DiagnosticsOptions` gains `typeCheck?: { enabled: boolean }` and `rrfVersion?: string`.
  An omitted `typeCheck` means enabled.
* VS Code settings `rrfgcode.typeCheck.enabled` (boolean, default `true`) and
  `rrfgcode.rrfVersion` (string, default `""`) feed those two options.
* Inferred types are observed through **hover** (`buildHover`): hovering a `var.`/`global.`/`param.`
  usage shows ``Type: `<type>` `` for that exact position (flow-sensitive). Expression types are
  observed by assigning the expression to a variable and hovering a later use. Hover takes no
  version: it types with the newest table.
* An expectation on a line that already has an error-severity diagnostic cannot be met
  (`TC-DIAG-06`); the harness fails such a test with `BLOCKED by an existing diagnostic: …`.
* Type diagnostics are identified as the diagnostics that appear with the checker on and do not
  appear with it off (multiset difference), so the tests never depend on unrelated diagnostics.

---

## 1. Contract

- `TC-CFG-01` **MUST** — `typeCheck.enabled = false` produces zero type diagnostics; omitting the
  option behaves as enabled.
- `TC-CFG-02` **MUST** — `rrfVersion` empty, malformed, or below `3.3` is *version-neutral*: no
  `rrf-version` diagnostics and no diagnostic whose outcome differs between firmware versions.
- `TC-CFG-03` **MUST** — accepted version syntax: `X.Y`, `X.Y.Z`, `X.Y.Z-alpha.N`, `-beta.N`,
  `-rc.N`. `X.Y` means `X.Y.0`. Pre-releases order `alpha < beta < rc < release`. Any other suffix
  (the fork's `3.5.4-vm.1`) is ignored, i.e. means the release itself.
- `TC-CFG-04` **MUST** — the checker only adds diagnostics. Every non-type diagnostic is identical
  with the checker on and off.

- `TC-DIAG-01` **MUST** — every type diagnostic has `source: 'rrf-gcode'` and one of these codes:

  | code | meaning |
  |---|---|
  | `rrf-type-operand` | operator applied to operand types the firmware rejects (arithmetic, comparison, equality, unary `-` `+` `#`) |
  | `rrf-type-boolean` | non-Boolean where a Boolean is required: `if`/`elif`/`while`, `&&`, `\|\|`, `!`, `?:` condition |
  | `rrf-type-argument` | function argument of a type the function rejects |
  | `rrf-type-index` | subscript on a non-array, or a non-integer subscript |
  | `rrf-type-value` | a statically known value the firmware rejects (`random(0)`, `vector(-1, …)`, negative index, malformed date string, empty array for `max`/`min`) |
  | `rrf-version` | function, constant or feature not available on the target firmware |
  | `rrf-skipped-operand` | an operand that fails exactly when the firmware skips it (§9) |

- `TC-DIAG-02` **MUST** — severity is Error, except where a rule says Warning (`TC-UN-06`, §9).
- `TC-DIAG-03` **MUST** — the message contains the firmware's runtime error text in double quotes
  (e.g. `"expected numeric operands"`) and names the offending operand type(s). When a union
  operand fails with different firmware texts, any one of them is acceptable.
- `TC-DIAG-04` **MUST** — ranges:
  * binary operator: the whole binary sub-expression, left operand start → right operand end;
  * unary operator: operator → end of operand;
  * `&&` / `||` / `?:` condition / `if` / `elif` / `while`: the offending operand or condition only;
  * function argument: that argument expression; index: the index expression, or the subscripted
    variable for "not an array";
  * `rrf-version`: the function name / constant token.
- `TC-DIAG-05` **MUST** — one diagnostic per root cause. A sub-expression that has a type error has
  type `unknown` for its parents: `("a" + 1) * 2` yields exactly one diagnostic.
- `TC-DIAG-06` **MUST** — a line that already has an error-severity non-type diagnostic (lexer
  error, bracket, dangling operator, arity, `'#'` on a numeric literal, undefined variable, …) gets
  no type diagnostics.
- `TC-DIAG-07` **MUST** — values the server cannot see are `unknown` and never reported:
  undefined variables, unknown object-model paths, unknown functions, variables only reachable
  under a dead `exists()` guard.
- `TC-DIAG-08` **MUST** — *definite errors only*. A diagnostic is produced only when every
  combination of the operands' possible types fails in the firmware. Any `unknown` operand, or any
  combination that succeeds, means no diagnostic.

## 2. Types

- `TC-TYPE-01` **MUST** — the types are `int` (Int32), `uint` (Uint32), `float`, `bool`, `string`,
  `char`, `datetime`, `array<T>`, `object` (object-model object), `null`, `unknown`, and unions.
- `TC-TYPE-02` **MUST** — `unknown` absorbs: any union containing `unknown` is `unknown`.
- `TC-TYPE-03` **MUST** — hover shows ``Type: `…` `` with union members joined by ` | `;
  `int | uint | float` may be written `number`; an array with unknown elements may be written
  `array`. Order is not significant.
- `TC-TYPE-04` **MUST** — hover on `param.X` shows ``Type: `unknown` ``.

## 3. Literals and constants

- `TC-LIT-01` **MUST** — numbers without `.` or exponent: `0..2147483647` → `int`,
  `2147483648..4294967295` → `uint`, larger → `float`; with `.` or exponent (`1.0`, `1e3`) →
  `float`. Hex `0x…` and binary `0b…` follow the same ranges.
- `TC-LIT-02` **MUST** — `"…"` → `string`, `'c'` → `char`.
- `TC-LIT-03` **MUST** — `true`/`false` → `bool`, `null` → `null`, `pi` → `float`,
  `iterations`/`line`/`result` → `int`, `input` → `unknown` (depends on the `M291` mode).
- `TC-LIT-04` **MUST** — `{a}` is just `a` (not an array); `{a,}` is a one-element array;
  `{a, b, …}` is `array<T(a) | T(b) | …>`; nesting composes; `( … )` is transparent.

## 4. Operators (`ExpressionParser::ParseInternal`)

- `TC-ARITH-01` **MUST** — `+ - *` (`BalanceNumericTypes`): `uint` operands first become `float`;
  then any `float` → `float` (the other operand must be numeric, else `"expected numeric operand"`);
  else both `int` → `int`; else `"expected numeric operands"`.
- `TC-ARITH-02` **MUST** — `uint` arithmetic is `float`: `3000000000 + 1` is `float`.
- `TC-ARITH-03` **MUST** — `/` converts both operands to `float` (`"expected numeric operand"`);
  the result is always `float`, so `10 / 2` is `float`.
- `TC-ARITH-04` **MUST** — `datetime` on the left of `+`/`-`: `+ int|uint` → `datetime`,
  `- int|uint` → `datetime`, `- datetime` → `int`, anything else `"invalid operand types"`.
  `datetime` on the right of `+`, or in `*` `/`, is an ordinary non-numeric operand.
- `TC-ARITH-05` **SHOULD** — `string + string` additionally suggests `^`.
- `TC-CAT-01` **MUST** — `^` accepts every operand type and yields `string`; never reported.
- `TC-BOOL-01` **MUST** — `&&`/`||` (`&`/`|`) need `bool` operands (`"expected Boolean operand"`);
  each non-Boolean operand gets its own diagnostic; the result is `bool`. No truthiness.
- `TC-BOOL-02` **MUST** — `!` needs `bool`. `!` binds tighter than comparisons: `!1 == 2` is
  `(!1) == 2` and is reported on `!1`.
- `TC-CMP-01` **MUST** — `< > <= >=` (`BalanceTypes`, step by step: `uint`→`float`; same type or
  both strings → as is; one `float` → convert the other (`"expected numeric operand"`); string vs
  `char`/`datetime` → string; else `"cannot convert operands to same type"`). The balanced type must
  be `int`, `float`, `datetime` or `bool`, else
  `"expected numeric or Boolean operands to comparison operator"`. Result `bool`.
- `TC-CMP-02` **MUST** — comparisons chain left to right: `1 < 2 < 3` is `bool < int` → error.
- `TC-EQ-01` **MUST** — `==`/`!=` with `null` on either side is always legal.
- `TC-EQ-02` **MUST** — otherwise `BalanceTypes` as in `TC-CMP-01`, and the balanced type must be
  `int`, `float`, `datetime`, `bool` or `string`. `char == char` and `array == array` →
  `"unexpected operand type to equality operator"`; `"5" == 5` and `1 == true` →
  `"cannot convert operands to same type"`.
- `TC-EQ-03` **MUST** — `object == object` → `"cannot compare objects"`; `object == int` →
  `"cannot convert operands to same type"`; `object == null` is legal.
- `TC-UN-01` **MUST** — unary `-`: `int`, `float` only; `uint` is rejected
  (`"expected numeric value after '-'"`).
- `TC-UN-02` **MUST** — unary `+`: `int`, `float`; `uint` → `int`; `datetime` → `int`; else
  `"expected numeric or enumeration value after '+'"`.
- `TC-UN-03` **MUST** — `#`: `string` or any array (heap or object model) → `int`; else
  `"operand of # is not an array or string"`.
- `TC-UN-04` **MUST** — `-2147483648` and `-3000000000` are errors: the literal is `uint` before
  the sign applies.
- `TC-UN-05` **MUST** — `#` written directly before a function call or a named constant is
  ignored by the firmware (`ParseIdentifierExpression` never applies the length to those paths):
  `#vector(3, 0)` is the array itself, `#abs(-5)` is `5`, `#true` is `true`. The type is the
  operand's own type.
- `TC-UN-06` **SHOULD** — Warning `rrf-type-operand` on that `#` ("has no effect — write
  `#(vector(3, 0))`"); none for `#(…)`, `#"…"`, `#{…}`, `#var.x`, `#<object-model path>`.
- `TC-TERN-01` **MUST** — the `?:` condition must be `bool` (`"expected Boolean operand"`).
- `TC-TERN-02` **MUST** — the result is the union of both branches; a literal `true`/`false`
  condition yields only the taken branch's type. `?:` is right-associative.
- `TC-PREC-01` **MUST** — priorities `?`(1) `^`(2) `& |`(3) `= != < > <= >=`(4) `+ -`(5)
  `* /`(6) unary(10); the reported sub-expression follows them (`"a" ^ 1 + 2` is legal,
  `"a" + 1 ^ "b"` is reported on `"a" + 1`).

## 5. Conditions and statements

- `TC-COND-01` **MUST** — `if`, `elif`, `while` conditions must be `bool`
  (`StringParser::EvaluateCondition` → `ParseBoolean`); range = the whole condition.
- `TC-COND-02` **MUST** — a braced condition `if {expr}` is checked the same way.
- `TC-COND-03` **MUST** — blocks under a literal `false` condition are checked like any other
  block (decision D-4).
- `TC-STMT-01` **MUST** — `echo` items and `echo >{expr}` file names accept every type.
- `TC-STMT-02` **MUST** — `var`, `global` and `set` right-hand sides accept every type; a `set`
  that changes a variable's type is never reported.
- `TC-STMT-03` **MUST** — a type error inside an `abort` message is an **Error** like any other
  (decision D-7). The firmware still aborts, but shows
  `invalid expression after 'abort': <error text>` instead of the message
  (`StringParser::ProcessAbortCommand`), and the diagnostic message says so.

## 6. Functions (3.5.4 table, `ParseIdentifierExpression`)

- `TC-FN-01` **MUST** — argument types (all others are errors with the quoted firmware text):

  | function | accepted arguments | firmware text on error |
  |---|---|---|
  | `abs` | `int`, `float` (not `uint`) | `expected numeric operand` |
  | `acos asin atan cos sin tan exp log sqrt degrees radians floor ceil isnan` | `int`, `uint`, `float` | `expected numeric operand` |
  | `atan2(y, x)` | both `int`/`uint`/`float` | `expected numeric operand` |
  | `mod pow` | both numeric, balanced as `TC-ARITH-01` | `expected numeric operand(s)` |
  | `max min` (2+ args) | all numeric | `expected numeric operand(s)` |
  | `max min` (1 arg) | a heap array (literal, `vector`, `fileread`, array variable) | `operand is not an array` |
  | `random` | positive `int`, or `uint` | `expected positive integer` |
  | `datetime` | `int`, `uint`, `datetime`, `string` | `can't convert value to DateTime` |
  | `fileexists` | anything | — |
  | `fileread(path, offset, count, delim)` | `string`, `int ≥ 0`, `int ≥ 0`, `char` | `expected string operand` / `expected non-negative integer` / `expected character operand` |
  | `vector(n, value)` | `int ≥ 0`, anything | `expected non-negative integer` |
  | `exists(path)` | an identifier path (syntax layer) | — |

- `TC-FN-02` **MUST** — results: `abs` keeps `int`/`float`; `floor ceil` → `int`; `isnan` → `bool`;
  trig, `exp log sqrt degrees radians atan2` → `float`; `mod` and multi-argument `max`/`min` →
  balanced numeric; single-argument `max`/`min` → the element type; `random` → `int`;
  `datetime` → `datetime`; `fileexists exists` → `bool`; `fileread` → `array<unknown>`;
  `vector(n, v)` → `array<T(v)>`.
- `TC-FN-03` **MUST** — `abs` of a `uint` is an error (`abs(3000000000)`).
- `TC-FN-04` **MUST** — single-argument `max`/`min` of a non-array (`max(5)`, `max("abc")`) is an
  error; of a statically empty array (`max(vector(0, 1))`) → `rrf-type-value`
  `"array has no elements"`.
- `TC-FN-05` **SHOULD** — single-argument `max`/`min` of an object-model array (`max(move.axes)`,
  `max(tools[0].offsets)`) is an error: the firmware accepts only heap arrays.
- `TC-FN-06` **MUST** — `vector`: size `uint`/`float`/non-number → `rrf-type-argument`; negative
  literal size → `rrf-type-value`; `vector(10 / 2, 0)` is an error (`/` yields `float`).
- `TC-FN-07` **MUST** — `random`: literal `0` or negative → `rrf-type-value`; `float` →
  `rrf-type-argument`.
- `TC-FN-08` **MUST** — `datetime`: a string literal that does not match the lenient
  `SafeStrptime` shape → `rrf-type-value` `"string is not a valid date and time"`. Each field is
  `StrToI32` (`NumericConverter`: blanks, optional sign, digits) and the separators must match
  exactly: `/^N-N-NTN:N:N/` with `N = [ \t]*[+-]?\d+`, trailing text allowed. Valid:
  `"2024-01-01T00:00:00"`, `"2024-1-1T1:2:3"`, `"2024-01-01T00:00:00Z"`, `"2024- 1-01T 1:02:03"`.
- `TC-FN-09` **MUST** — `fileread`: delimiter must be a `char` literal (`','`, not `","`); negative
  literal offset/count → `rrf-type-value`.
- `TC-FN-10` **MUST** — `pow(int, int)` → `int` unless the exponent is a negative literal (→
  `float`); any `float`/`uint` operand → `float`.
- `TC-FN-11` **MUST** — one diagnostic per bad argument, ranged on that argument; a call with a bad
  argument has type `unknown`.
- `TC-FN-12` **MUST** — where available (§10): `square` → `float`, `round` → `int` (numeric
  argument); `take`/`drop(array|string, int ≥ 0)` keep the first operand's kind;
  `find(string, char|string)` → `int` (arrays rejected: `"first operand of function is not a string"`).

## 7. Arrays and indexing

- `TC-ARR-01` **MUST** — element types: literals `{…}`, `vector(n, v)`, nested arrays;
  `fileread` elements are `unknown`.
- `TC-ARR-02` **MUST** — an index on a variable/object-model path must be `int`
  (`"expected integer expression"`): `uint`, `float` (including any `/` result), `string`, `bool`
  are errors.
- `TC-ARR-03` **MUST** — indexing a variable that holds a non-array →
  `"Cannot index into variable or parameter '<name>' of non-array type"`, ranged on the variable.
  Strings are not indexable through variables on any version.
- `TC-ARR-04` **MUST** — a literal negative index (`var.a[-1]`) → `rrf-type-value`
  `"Index out of range"`.
- `TC-ARR-05` **SHOULD** — a literal index ≥ a statically known length (literal or
  `vector(<literal>, …)`) → `rrf-type-value` `"Index out of range"`.
- `TC-ARR-06` **MUST** — `set var.a[i] = v`: `var.a` must hold an array (`"Expected an array
  expression"`, ranged on `var.a`); `i` must be a non-negative `int` (`"expected non-negative integer"`).
- `TC-ARR-07` **MUST** — a bracketed expression may be indexed (`{1,2}[0]`, `(var.a)[0]`); the
  index must be a non-negative `int`; a non-array base → `"left operand of [ ] is not an array"`.
  *Blocked*: the syntax layer currently reports `unexpected '['` on these valid forms.
- `TC-ARR-08` **MUST** — nested indexing follows element types; indexing past the nesting depth is
  an error.
- `TC-ARR-09` **MUST** — object-model arrays: index must be `int`; an element with object-model
  fields is `object`; an element without known fields is `unknown`.

## 8. Variables: flow typing

- `TC-FLOW-01` **MUST** — `var x = e` gives `x` the type of `e`.
- `TC-FLOW-02` **MUST** — after `set var.x = e` the type is `T(e)` until the next assignment.
- `TC-FLOW-03` **MUST** — after `if`/`elif`/`else`, the type is the union of each branch's end
  type, plus the type before the `if` when there is no `else`. Conditions are not constant-folded
  for flow.
- `TC-FLOW-04` **MUST** — `while`: the type at the loop head is the fixed-point union of the entry
  type and every path back (end of body, `continue`); after the loop it is the head type plus every
  `break` path.
- `TC-FLOW-05` **SHOULD** — `abort` and `M99` end a path; its types do not flow on.
- `TC-FLOW-06` **MUST** — a use inside a nested block sees assignments made earlier in that block.
- `TC-FLOW-07` **MUST** — same-named variables in sibling blocks are independent.
- `TC-FLOW-08` **MUST** — `set var.a[i] = e` widens the element type; `var.a` stays an array.
- `TC-FLOW-09` **MUST** — null narrowing: inside `if X != null` / `elif X != null`, in the right
  operand of `X != null && …`, and in the true branch of `X != null ? … : …`, `null` is removed from
  the type of `X` (a variable or global); `== null` narrows the other way. If narrowing leaves no
  type at all (the branch cannot run), `X` is `unknown` inside that branch, so uses of `X` there are
  not reported. Other code in the branch is still checked (D-4).

## 9. Evaluation and short-circuit

The firmware parses the skipped operand of `&&`, `||` and `?:` with `evaluate = false`. In that
mode most type errors are suppressed, **but** every variable, parameter and object-model value
reads as `null`, and some checks run unconditionally.

- `TC-SC-01` **MUST** — when the deciding operand is a literal (`false && …`, `true || …`,
  `true ? x : …`, `false ? … : y`), evaluation-dependent errors in the skipped operand are not
  reported. Errors the firmware raises unconditionally are still reported: unary `-`/`+` on a
  literal of the wrong type, `random` of a bad literal, `datetime` of a bad literal or type,
  single-argument `max`/`min` of a non-array literal.
- `TC-SC-02` **MUST** — when the deciding operand is not a literal, both operands are checked
  normally (each one runs on some path).
- `TC-SC-03` **SHOULD** — Warning `rrf-skipped-operand` in an operand that may be skipped (right
  of `&&`/`||`, either branch of `?:`) for constructs that throw on `null`: unary `-` or `+` applied
  to an identifier, a parenthesised identifier or `#identifier`; `random(<identifier>)`;
  `datetime(<identifier>)`; single-argument `max`/`min(<identifier>)`. The message quotes the
  firmware text and suggests a safe form (`0 - var.x`, `var.x * -1`). When the deciding operand is
  a literal that always skips, the same construct is a definite Error. *Derived from source,
  not yet reproduced on a printer.*
- `TC-SC-04` **SHOULD** — Warning `rrf-skipped-operand` for `fileread(…)` in an operand that may be
  skipped: `ReadArrayFromFile` runs without an `evaluate` guard, so the file is opened even when
  the operand is skipped (a missing file throws; an identifier path is `null`).
- `TC-SC-05` **MUST** — no `rrf-skipped-operand` for safe forms: `0 - var.x`, `var.x * -1`,
  `abs(var.x)`, multi-argument `max`, literal arguments, left operands, statement level, and code
  inside `if` blocks (skipped blocks are never parsed).

## 10. Firmware versions

- `TC-VER-01` **MUST** — function availability (from the tags):

  | added in | functions |
  |---|---|
  | 3.3 | `abs acos asin atan atan2 cos degrees exists floor isnan max min mod radians random sin sqrt tan` |
  | 3.4.0 | `datetime` |
  | 3.5.0 | `ceil exp fileexists fileread log pow vector` |
  | 3.6.0-beta.4 | `drop find take` |
  | 3.6.0-rc.2 | `square` |
  | 3.6.0-rc.3 | `round` |

  An unavailable function → Error `rrf-version` on the name; the message quotes
  `"unknown function"` and says in which version it was added.
- `TC-VER-02` **MUST** — the constant `input` needs 3.5.0.
- `TC-VER-03` **MUST** — indexing a bracketed string (`("abc")[0]`) is an error before
  3.6.0-beta.4 and a `char` from then on. *Blocked by the same syntax bug as `TC-ARR-07`.*
- `TC-VER-04` **MUST** — with no version, every function the server knows is accepted and typed by
  the newest table, and version-dependent outcomes are not reported.
- `TC-VER-05` **MUST** — a version newer than the newest known table (e.g. `3.7`) uses the newest
  table.
- `TC-VER-06` **MUST** — `rrf-version` diagnostics follow `TC-DIAG-01..04`.

## 11. Globals, parameters, object model

- `TC-GLB-01` **MUST** — `global.X` has the union of the types of every `global X = e` and
  `set global.X = e` in all indexed files (flow-insensitive, order-independent). Assignments that
  read globals are resolved as a least fixed point: `global a = 170` plus
  `set global.a = global.a + 1` (the probe-angle macros) is `int`, not `unknown`.
- `TC-GLB-02` **MUST** — persistence writes count as assignments: an `echo >`/`>>` whose expression
  is `"set global.X = " ^ E` contributes `T(E)` (a `string` `E` contributes `unknown`, because it
  is written unquoted); `"set global.X = <literal>"` contributes the literal's type. Any other
  `echo` redirect whose text contains `global.X =` makes `X` `unknown`. Writes with a computed
  global name (`"set global." ^ …`) are ignored (decision D-5; see `TC-GLB-04` for the globals
  that only such a write gives a value). A write whose value is the global
  itself (`"set global.X = "^{global.X}`, the backup idiom) contributes nothing — it is a fixed
  point, not a reason to widen to `unknown`.
  Every shape below occurs in the corpus:
  * the prefix may start with blanks (`"  set global.X = " ^ E`);
  * a literal write is a number, `true`, `false`, `null` or a doubled-quote string
    (`"set global.X = ""manual"""` → `string`); anything else after `=` inside the string
    (`" set global.X = var.n"`, generated code) is an "other" write;
  * a `;` ends the value: inside a literal write (`"set global.X = 0 ; disabled"` → `int`), or as a
    following string piece that starts with optional blanks and `;`, together with every piece
    after it (`"set global.X = " ^ E ^ "; every " ^ E ^ " layers"` → `T(E)`;
    `"set global.X = "^{global.X}^" ; note"` is still the backup idiom);
  * the quoted wrapper `"set global.X = """ ^ E ^ """"` writes a string and contributes `string`;
  * any other piece after the value (`"set global.X = " ^ var.a ^ "," ^ var.b`) makes it an
    "other" write.
- `TC-GLB-03` **MUST** — `unknown` when undeclared in every indexed file, or when any assignment
  has an `unknown` type (e.g. from `param.`, `input`, an element of a `fileread` array). A
  `fileread(…)` result itself is `array<unknown>`, not `unknown`.
- `TC-GLB-04` **MUST** — a global whose every visible value is `null` is `unknown` (decision D-5).
  "Visible values" are every declaration, every `set` and every recognised persistence write
  (`TC-GLB-02`). Nobody keeps a global that is always `null`, so its real value is written
  somewhere the checker cannot see: an `echo` with a computed name, or a file edited by hand.
  Treating it as `null` would report `null * 2` on a configured printer where the value is a
  number. In the corpus this covers exactly `tool0RetractDistance`, `tool1RetractDistance`,
  `tool0ExtrudeDistance` and `tool1ExtrudeDistance`, which get a number only from the
  computed-name `echo` in `Tool Change Retraction`. A global with any non-`null` visible value
  keeps its union (`global g = null` plus `set global.g = 5` is `null | int`). Local variables are
  not affected: `var x = null` is `null`.
- `TC-PRM-01` **MUST** — `param.X` is always `unknown`; `exists(param.X)` is `bool`.
- `TC-OM-01` **MUST** — object-model leaves typed from `@duet3d/objectmodel`: `boolean` → `bool`,
  `string` → `string`, `number` → `number` (`int | uint | float`), class instance → `object`,
  collection → `array`; leaves whose default is `null` (no type information) → `unknown`.
  Fields named like functions (`.min`, `.max`) are fields, not calls.
- `TC-OM-02` **MUST** — paths not in the model (fork-only fields such as `state.vmFeatureLevel`)
  are `unknown`.
- `TC-OM-03` **MUST** — `object` in arithmetic is an error; see `TC-EQ-03` for comparison.
- `TC-OM-04` **MUST** — `#` on an object-model array is `int`.
- `TC-OM-05` **MUST** — `#` written directly before an object-model path never fails
  (`ObjectModel::GetObjectValue` with `WantArrayLength`): arrays, strings and bitmaps give `int`,
  every other leaf is returned unchanged (`#move.axes[0].homed` is a `bool`). `#(path)` with
  parentheses goes through `ApplyLengthOperator` and follows `TC-UN-03`.

## 12. G-code command lines

- `TC-GC-01` **MUST** — expressions inside `{ … }` on G/M/T lines are type-checked internally.
- `TC-GC-02` **MUST** — parameter values are not checked against the parameter's type in this
  phase. String-valued parameters accept every type (`StringParser::GetQuotedString` uses
  `AppendAsString`), so `M98 P{1}` and `M291 P{3.5}` are legal.
- `TC-GC-03` **PHASE 2** — numeric and integer parameters (`GetFValue` / `GetIValue` /
  `GetUIValue`) need a per-command parameter-type table; until it exists nothing is reported.

## 13. Guarantees

- `TC-FP-01` **MUST** — the Vision Miner 4.2.0 corpus produces zero type diagnostics, with
  `rrfVersion` unset and with `3.5.4`.
- `TC-FP-02` **MUST** — the idiom list in `90-guarantees.test.ts` produces zero type diagnostics.
- `TC-ROB-01` **MUST** — never throws, for any input (fuzzed lines, truncated files).
- `TC-ROB-02` **MUST** — the corpus lints in under 3× the time it takes without the checker.
- `TC-ROB-03` **MUST** — deterministic, and independent of the order files are indexed in.
- `TC-ROB-04` **MUST** — 200-deep parentheses and 100-branch ternary chains do not overflow.

---

## Decisions

The maintainer settled these on 2026-11-08 (D-3 and D-6 are internal choices). Each is encoded in
tests; reversing one changes the listed tests.

| ID | Decision | Rejected | Tests |
|---|---|---|---|
| D-1 | Definite errors only (`TC-DIAG-08`). Confirmed for now; may be revisited | Also warn when *some* union member fails | every `guard(…)` that asserts silence for a union operand |
| D-2 | Checker on by default, `rrfVersion` unset by default | Off by default / default 3.5.4 | `TC-CFG-01`, `TC-VER-04` |
| D-3 | *Internal.* Types observed via hover; `number` alias allowed | A dedicated inference API | `typeAt` in `contract.ts` only |
| D-4 | Literal-`false` blocks are checked, as every existing diagnostic already is | Treat them as dead code | `TC-COND-03` |
| D-5 | Recognised persistence writes are typed; computed-name writes are ignored; a global whose only visible values are `null` is `unknown` (`TC-GLB-04`) | Keep such a global `null` (false errors on unguarded reads of the four retraction distances); any write mentioning a global makes it `unknown` (26 of the corpus's 40 globals lose all checks) | `TC-GLB-02`, `TC-GLB-04` |
| D-6 | *Internal.* One diagnostic per non-Boolean operand of `&&`/`\|\|` | One per expression | `TC-BOOL-01` matrix |
| D-7 | Type errors in `abort` messages are Errors | Warnings | `TC-STMT-03` |
| D-8 | Skipped-operand hazards are Warnings (an Error when the skip is certain), SHOULD tier | Always Errors / not reported | `TC-SC-03`, `TC-SC-04` |
| D-9 | Parameter value types are phase 2 | Phase 1 with a hand-built table | `TC-GC-02`, `TC-GC-03` |
| D-10 | Object-model numbers are `int \| uint \| float`; `null`-default leaves are `unknown` | Treat numbers as `float` (false errors on `tools[state.currentTool]`) | `TC-OM-01` and every OM guard |

Corpus facts behind D-5: 74 `echo` writes build the global name at run time. 73 are in
`Upgrade to 4.1.0`: they copy a pre-4.1.0 setting into its new file or write the same default
that `sys/globals.g` declares, so ignoring them does not change any global's type in practice.
The 74th is in `Tool Change Retraction` and is the only place the four retraction/extrusion
distances get a number.

Possible follow-ups after phase 1 (not decided):

* D-9: a parameter-type table (integer / float / string per command letter). A candidate source
  is the firmware's `GetIValue` / `GetFValue` / `GetQuotedString` calls.
* D-10: an integer/float table for object-model fields, generated from the firmware's
  object-model tables. The library types every number as `number` and gives no type at all to
  145 fields whose default is `null` (for example `move.axes[].machinePosition`).
* D-8: confirm `TC-SC-03` on a printer (`var x = 5` / `if false && -var.x < 0` / `echo "survived"`
  should stop with `expected numeric operand`); drop the rule if `survived` is printed.

## Known blockers in other layers

* The syntax layer reports `unexpected '['` on `{1,2}[0]` and `(x)[0]`, which the firmware accepts.
  `TC-ARR-07` and `TC-VER-03` cannot pass until that is fixed (`TC-DIAG-06` suppresses the line).
* The syntax layer reports `unexpected 'abs'` on `#abs(-5)` / `#vector(3, 0)`, which the firmware
  accepts (the `#` is ignored). The function-call half of `TC-UN-05`/`TC-UN-06` is blocked by it.
* The syntax layer accepts `abs(1)[0]` and `fileread(…)[0]`. The firmware cannot index a function
  result: `echo`/`if` fail with `expected ','` / extra characters, and `var`/`set` **silently drop
  the index** and store the whole array.
* The object-model index is built from `@duet3d/objectmodel` 3.6.x, not 3.5.4. Tests use paths
  that exist in both (`move.axes[0]`, `state.status`, `heat.heaters[0].current`).

## Suggested implementation order

1. `TYPE`, `LIT`, `DIAG`, `CFG` — the lattice, hover display, the diagnostic plumbing.
2. `ARITH`, `CAT`, `BOOL`, `CMP`, `EQ`, `UN`, `TERN`, `PREC` — the matrices.
3. `COND`, `STMT`, `GC-01/02`.
4. `FN`, then `ARR`.
5. `FLOW`, then `GLB`, `PRM`, `OM`.
6. `VER`, then `SC`.
