# Type checking

The language server reports expressions that RepRapFirmware rejects at run time because of the
types of their operands, and shows the inferred type of variables in hover. This file lists the
rules it follows. Each rule has an ID; the tests in this folder cite those IDs, and
`99-spec-coverage.test.ts` checks that every rule has a test.

The rules come from the RepRapFirmware source. Where the Duet3D documentation and the source
disagree, the source wins.

| What | Where |
|---|---|
| Expression semantics | `Duet3D/RepRapFirmware` tag `3.5.4`, `src/GCodes/GCodeBuffer/ExpressionParser.cpp` |
| Meta commands (`var`, `set`, `echo`, `abort`, conditions) | same tag, `src/GCodes/GCodeBuffer/StringParser.cpp` |
| Numeric literals | `RRFLibraries/src/General/NumericConverter.cpp` (`FitsInInt32`, `FitsInUint32`) |
| Date strings | `src/libc/strptime.cpp` (`SafeStrptime`) |
| Functions per line | `NamedEnum(Function, …)` in tags `3.5.4`, `3.6.3`, `3.7.0` |
| Object model | `@duet3d/objectmodel` |

## 1. Settings and diagnostics

- `TC-CFG-01` — `rrfgcode.typeCheck.enabled` (default `true`): `false` turns type checking off,
  so none of the diagnostics in `TC-DIAG-01` is produced.
- `TC-CFG-02` — `rrfgcode.rrfVersion` is the target firmware line: `3.5`, `3.6` or `3.7`, each
  meaning its latest release. Empty (the default) or any other value means no target (§10).

- `TC-DIAG-01` — every type diagnostic has `source: 'rrf-gcode'` and one of these codes:

  | code | meaning |
  |---|---|
  | `rrf-type-operand` | operator applied to operand types the firmware rejects (arithmetic, comparison, equality, unary `-` `+` `#`) |
  | `rrf-type-boolean` | non-Boolean where a Boolean is required: `if`/`elif`/`while`, `&&`, `\|\|`, `!`, `?:` condition |
  | `rrf-type-argument` | function argument of a type the function rejects |
  | `rrf-type-index` | subscript on a non-array, or a non-integer subscript |
  | `rrf-type-value` | a statically known value the firmware rejects (`random(0)`, `vector(-1, …)`, negative index, malformed date string, empty array for `max`/`min`) |
  | `rrf-version` | function, constant or feature not available on the target firmware |

- `TC-DIAG-02` — severity is Error, except the Warning of `TC-UN-06`.
- `TC-DIAG-03` — the message contains the firmware's run-time error text in double quotes
  (e.g. `"expected numeric operands"`) and names the offending operand type(s). When a union
  operand fails with different firmware texts, the message quotes one of them.
- `TC-DIAG-04` — ranges:
  * binary operator: the whole binary sub-expression, left operand start → right operand end;
  * unary operator: operator → end of operand;
  * `&&` / `||` / `?:` condition / `if` / `elif` / `while`: the offending operand or condition only;
  * function argument: that argument expression; index: the index expression, or the subscripted
    variable for "not an array";
  * `rrf-version`: the function name / constant token.
- `TC-DIAG-05` — one diagnostic per root cause. A sub-expression that has a type error has
  type `unknown` for its parents: `("a" + 1) * 2` yields exactly one diagnostic.
- `TC-DIAG-06` — a line that already has an Error from the syntax checks (lexer error, bracket,
  dangling operator, arity, `'#'` on a numeric literal, undefined variable, …) gets no type
  diagnostics.
- `TC-DIAG-07` — values the server cannot see are `unknown`: macro parameters, undefined
  variables, unknown object-model paths, unknown functions, variables only reachable under a dead
  `exists()` guard.
- `TC-DIAG-08` — only definite errors are reported: an expression is reported only when every
  combination of its operands' possible types fails in the firmware. An `unknown` operand, or
  any combination that succeeds, means no diagnostic.

## 2. Types

- `TC-TYPE-01` — the types are `int` (Int32), `uint` (Uint32), `float`, `bool`, `string`,
  `char`, `datetime`, `array<T>`, `object` (object-model object), `null`, `unknown`, and unions.
- `TC-TYPE-02` — `unknown` absorbs: any union containing `unknown` is `unknown`.
- `TC-TYPE-03` — hover on a variable shows ``Type: `…` ``: union members joined by ` | `,
  `int | uint | float` shown as `number`, an array whose elements are unknown shown as `array`.
- `TC-TYPE-04` — hover on `param.X` shows ``Type: `unknown` ``.

## 3. Literals and constants

- `TC-LIT-01` — numbers without `.` or exponent: `0..2147483647` → `int`,
  `2147483648..4294967295` → `uint`, larger → `float`; with `.` or exponent (`1.0`, `1e3`) →
  `float`. Hex `0x…` and binary `0b…` follow the same ranges.
- `TC-LIT-02` — `"…"` → `string`, `'c'` → `char`.
- `TC-LIT-03` — `true`/`false` → `bool`, `null` → `null`, `pi` → `float`,
  `iterations`/`line`/`result` → `int`, `input` → `unknown` (depends on the `M291` mode).
- `TC-LIT-04` — `{a}` is just `a` (not an array); `{a,}` is a one-element array;
  `{a, b, …}` is `array<T(a) | T(b) | …>`; nesting composes; `( … )` is transparent.

## 4. Operators (`ExpressionParser::ParseInternal`)

- `TC-ARITH-01` — `+ - *` (`BalanceNumericTypes`): `uint` operands first become `float`;
  then any `float` → `float` (the other operand must be numeric, else `"expected numeric operand"`);
  else both `int` → `int`; else `"expected numeric operands"`.
- `TC-ARITH-02` — `uint` arithmetic is `float`: `3000000000 + 1` is `float`.
- `TC-ARITH-03` — `/` converts both operands to `float` (`"expected numeric operand"`);
  the result is always `float`, so `10 / 2` is `float`.
- `TC-ARITH-04` — `datetime` on the left of `+`/`-`: `+ int|uint` → `datetime`,
  `- int|uint` → `datetime`, `- datetime` → `int`, anything else `"invalid operand types"`.
  `datetime` on the right of `+`, or in `*` `/`, is an ordinary non-numeric operand.
- `TC-ARITH-05` — `string + string` additionally suggests `^`.
- `TC-CAT-01` — `^` accepts every operand type and yields `string`; never reported.
- `TC-BOOL-01` — `&&`/`||` (`&`/`|`) need `bool` operands (`"expected Boolean operand"`);
  each non-Boolean operand gets its own diagnostic; the result is `bool`. No truthiness.
- `TC-BOOL-02` — `!` needs `bool`. `!` binds tighter than comparisons: `!1 == 2` is
  `(!1) == 2` and is reported on `!1`.
- `TC-CMP-01` — `< > <= >=` (`BalanceTypes`, step by step: `uint`→`float`; same type or
  both strings → as is; one `float` → convert the other (`"expected numeric operand"`); string vs
  `char`/`datetime` → string; else `"cannot convert operands to same type"`). The balanced type must
  be `int`, `float`, `datetime` or `bool`, else
  `"expected numeric or Boolean operands to comparison operator"`. Result `bool`.
- `TC-CMP-02` — comparisons chain left to right: `1 < 2 < 3` is `bool < int` → error.
- `TC-EQ-01` — `==`/`!=` with `null` on either side is always legal.
- `TC-EQ-02` — otherwise `BalanceTypes` as in `TC-CMP-01`, and the balanced type must be
  `int`, `float`, `datetime`, `bool` or `string`. `char == char` and `array == array` →
  `"unexpected operand type to equality operator"`; `"5" == 5` and `1 == true` →
  `"cannot convert operands to same type"`.
- `TC-EQ-03` — `object == object` → `"cannot compare objects"`; `object == int` →
  `"cannot convert operands to same type"`; `object == null` is legal.
- `TC-UN-01` — unary `-`: `int`, `float` only; `uint` is rejected
  (`"expected numeric value after '-'"`).
- `TC-UN-02` — unary `+`: `int`, `float`; `uint` → `int`; `datetime` → `int`; else
  `"expected numeric or enumeration value after '+'"`.
- `TC-UN-03` — `#`: `string` or any array (heap or object model) → `int`; else
  `"operand of # is not an array or string"`.
- `TC-UN-04` — `-2147483648` and `-3000000000` are errors: the literal is `uint` before
  the sign applies.
- `TC-UN-05` — `#` written directly before a function call or a named constant is
  ignored by the firmware (`ParseIdentifierExpression` never applies the length to those paths):
  `#vector(3, 0)` is the array itself, `#abs(-5)` is `5`, `#true` is `true`. The type is the
  operand's own type.
- `TC-UN-06` — a Warning `rrf-type-operand` on that `#` ("has no effect — write
  `#(vector(3, 0))`"); none for `#(…)`, `#"…"`, `#{…}`, `#var.x`, `#<object-model path>`.
- `TC-TERN-01` — the `?:` condition must be `bool` (`"expected Boolean operand"`).
- `TC-TERN-02` — the result is the union of both branches; a literal `true`/`false`
  condition yields only the taken branch's type. `?:` is right-associative.
- `TC-PREC-01` — priorities `?`(1) `^`(2) `& |`(3) `= != < > <= >=`(4) `+ -`(5)
  `* /`(6) unary(10); the reported sub-expression follows them (`"a" ^ 1 + 2` is legal,
  `"a" + 1 ^ "b"` is reported on `"a" + 1`).

## 5. Conditions and statements

- `TC-COND-01` — `if`, `elif`, `while` conditions must be `bool`
  (`StringParser::EvaluateCondition` → `ParseBoolean`); range = the whole condition.
- `TC-COND-02` — a braced condition `if {expr}` is checked the same way.
- `TC-COND-03` — blocks under a literal `false` condition are checked like any other
  block.
- `TC-STMT-01` — `echo` items and `echo >{expr}` file names accept every type.
- `TC-STMT-02` — `var`, `global` and `set` right-hand sides accept every type; a `set`
  that changes a variable's type is never reported.
- `TC-STMT-03` — a type error inside an `abort` message is an Error like any other. The
  firmware still aborts, but shows
  `invalid expression after 'abort': <error text>` instead of the message
  (`StringParser::ProcessAbortCommand`), and the diagnostic message says so.

## 6. Functions (`ParseIdentifierExpression`)

Which functions exist on which version is in §10.

- `TC-FN-01` — argument types (all others are errors with the quoted firmware text):

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

- `TC-FN-02` — results: `abs` keeps `int`/`float`; `floor ceil` → `int`; `isnan` → `bool`;
  trig, `exp log sqrt degrees radians atan2` → `float`; `mod` and multi-argument `max`/`min` →
  balanced numeric; single-argument `max`/`min` → the element type; `random` → `int`;
  `datetime` → `datetime`; `fileexists exists` → `bool`; `fileread` → `array<unknown>`;
  `vector(n, v)` → `array<T(v)>`.
- `TC-FN-03` — `abs` of a `uint` is an error (`abs(3000000000)`).
- `TC-FN-04` — single-argument `max`/`min` of a non-array (`max(5)`, `max("abc")`) is an
  error; of a statically empty array (`max(vector(0, 1))`) → `rrf-type-value`
  `"array has no elements"`.
- `TC-FN-05` — single-argument `max`/`min` of an object-model array (`max(move.axes)`,
  `max(tools[0].offsets)`) is an error: the firmware accepts only heap arrays.
- `TC-FN-06` — `vector`: size `uint`/`float`/non-number → `rrf-type-argument`; negative
  literal size → `rrf-type-value`; `vector(10 / 2, 0)` is an error (`/` yields `float`).
- `TC-FN-07` — `random`: literal `0` or negative → `rrf-type-value`; `float` →
  `rrf-type-argument`.
- `TC-FN-08` — `datetime`: a string literal that does not match the lenient
  `SafeStrptime` shape → `rrf-type-value` `"string is not a valid date and time"`. Each field is
  `StrToI32` (`NumericConverter`: blanks, optional sign, digits) and the separators must match
  exactly: `/^N-N-NTN:N:N/` with `N = [ \t]*[+-]?\d+`, trailing text allowed. Valid:
  `"2024-01-01T00:00:00"`, `"2024-1-1T1:2:3"`, `"2024-01-01T00:00:00Z"`, `"2024- 1-01T 1:02:03"`.
- `TC-FN-09` — `fileread`: delimiter must be a `char` literal (`','`, not `","`); negative
  literal offset/count → `rrf-type-value`.
- `TC-FN-10` — `pow(int, int)` → `int` unless the exponent is a negative literal (→
  `float`); any `float`/`uint` operand → `float`.
- `TC-FN-11` — one diagnostic per bad argument, ranged on that argument; a call with a bad
  argument has type `unknown`.
- `TC-FN-12` — where available (§10): `square` → `float`, `round` → `int` (numeric
  argument); `take`/`drop(array|string, int ≥ 0)` keep the first operand's kind;
  `find(string, char|string)` → `int` (arrays rejected: `"first operand of function is not a string"`).

## 7. Arrays and indexing

- `TC-ARR-01` — element types: literals `{…}`, `vector(n, v)`, nested arrays;
  `fileread` elements are `unknown`.
- `TC-ARR-02` — an index on a variable/object-model path must be `int`
  (`"expected integer expression"`): `uint`, `float` (including any `/` result), `string`, `bool`
  are errors.
- `TC-ARR-03` — indexing a variable that holds a non-array →
  `"Cannot index into variable or parameter '<name>' of non-array type"`, ranged on the variable.
  Strings are not indexable through variables on any version.
- `TC-ARR-04` — a literal negative index (`var.a[-1]`) → `rrf-type-value`
  `"Index out of range"`.
- `TC-ARR-05` — a literal index ≥ a statically known length (literal or
  `vector(<literal>, …)`) → `rrf-type-value` `"Index out of range"`.
- `TC-ARR-06` — `set var.a[i] = v`: `var.a` must hold an array (`"Expected an array
  expression"`, ranged on `var.a`); `i` must be a non-negative `int` (`"expected non-negative integer"`).
- `TC-ARR-07` — a bracketed expression may be indexed (`{1,2}[0]`, `(var.a)[0]`); the
  index must be a non-negative `int`; a non-array base → `"left operand of [ ] is not an array"`.
- `TC-ARR-08` — nested indexing follows element types; indexing past the nesting depth is
  an error.
- `TC-ARR-09` — object-model arrays: index must be `int`; an element with object-model
  fields is `object`; an element without known fields is `unknown`.

## 8. Variables: flow typing

- `TC-FLOW-01` — `var x = e` gives `x` the type of `e`.
- `TC-FLOW-02` — after `set var.x = e` the type is `T(e)` until the next assignment.
- `TC-FLOW-03` — after `if`/`elif`/`else`, the type is the union of each branch's end
  type, plus the type before the `if` when there is no `else`. Conditions are not constant-folded
  for flow.
- `TC-FLOW-04` — `while`: the type at the loop head is the fixed-point union of the entry
  type and every path back (end of body, `continue`); after the loop it is the head type plus every
  `break` path.
- `TC-FLOW-05` — `abort` and `M99` end a path; its types do not flow on.
- `TC-FLOW-06` — a use inside a nested block sees assignments made earlier in that block.
- `TC-FLOW-07` — same-named variables in sibling blocks are independent.
- `TC-FLOW-08` — `set var.a[i] = e` widens the element type; `var.a` stays an array.
- `TC-FLOW-09` — null narrowing: inside `if X != null` / `elif X != null`, in the right
  operand of `X != null && …`, and in the true branch of `X != null ? … : …`, `null` is removed from
  the type of `X` (a variable or global); `== null` narrows the other way. If narrowing leaves no
  type at all (the branch cannot run), `X` is `unknown` inside that branch, so uses of `X` there are
  not reported. Other code in the branch is still checked.

## 9. Evaluation and short-circuit

The firmware parses the skipped operand of `&&`, `||` and `?:` with `evaluate = false`. In that
mode most type errors are suppressed, but some checks run unconditionally.

- `TC-SC-01` — when the deciding operand is a literal (`false && …`, `true || …`,
  `true ? x : …`, `false ? … : y`), evaluation-dependent errors in the skipped operand are not
  reported. Errors the firmware raises unconditionally are still reported: unary `-`/`+` on a
  literal of the wrong type, `random` of a bad literal, `datetime` of a bad literal or type,
  single-argument `max`/`min` of a non-array literal.
- `TC-SC-02` — when the deciding operand is not a literal, both operands are checked
  normally (each one runs on some path).

## 10. Firmware versions

- `TC-VER-01` — `drop`, `find`, `round`, `square` and `take` need 3.6; on 3.5 each is an Error
  `rrf-version` on the function name, quoting `"unknown function"` and naming 3.6. 3.6 and 3.7
  have the same functions and constants. The result of an unavailable function is `unknown`.
- `TC-VER-02` — indexing a bracketed string (`("abc")[0]`) is an error on 3.5 and a `char` on 3.6
  and 3.7.
- `TC-VER-03` — with no target, every function the server knows is accepted and typed by the
  newest table, and outcomes that differ between lines are not reported.

## 11. Globals, parameters, object model

- `TC-GLB-01` — `global.X` has the union of the types of every `global X = e` and
  `set global.X = e` in all indexed files (flow-insensitive, order-independent). Assignments that
  read globals are resolved as a least fixed point: `global a = 170` plus
  `set global.a = global.a + 1` is `int`, not `unknown`.
- `TC-GLB-02` — persistence writes count as assignments: an `echo >`/`>>` whose expression
  is `"set global.X = " ^ E` contributes `T(E)` (a `string` `E` contributes `unknown`, because it
  is written unquoted); `"set global.X = <literal>"` contributes the literal's type. Any other
  `echo` redirect whose text contains `global.X =` makes `X` `unknown`. Writes with a computed
  global name (`"set global." ^ …`) are ignored (see `TC-GLB-04` for globals that only such a
  write gives a value). A write whose value is the global
  itself (`"set global.X = "^{global.X}`, the backup idiom) contributes nothing — it is a fixed
  point, not a reason to widen to `unknown`.
  The recognised shapes:
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
- `TC-GLB-03` — `unknown` when undeclared in every indexed file, or when any assignment
  has an `unknown` type (e.g. from `param.`, `input`, an element of a `fileread` array). A
  `fileread(…)` result itself is `array<unknown>`, not `unknown`.
- `TC-GLB-04` — a global whose every visible value is `null` is `unknown`. "Visible values"
  are every declaration, every `set` and every recognised persistence write (`TC-GLB-02`). A
  global that is always `null` would be pointless, so its real value is written where the checker
  cannot see it: an `echo` that builds the global's name at run time, or a file edited by hand.
  Typing it as `null` would report `null * 2` where the value is in fact a number. A global with
  any non-`null` visible value
  keeps its union (`global g = null` plus `set global.g = 5` is `null | int`). Local variables are
  not affected: `var x = null` is `null`.
- `TC-PRM-01` — `param.X` is always `unknown`; `exists(param.X)` is `bool`.
- `TC-OM-01` — object-model leaves typed from `@duet3d/objectmodel`: `boolean` → `bool`,
  `string` → `string`, `number` → `number` (`int | uint | float`), class instance → `object`,
  collection → `array`; leaves whose default is `null` (no type information) → `unknown`.
  Fields named like functions (`.min`, `.max`) are fields, not calls.
- `TC-OM-02` — paths not in the model (`state.noSuchField`) are `unknown`.
- `TC-OM-03` — `object` in arithmetic is an error; see `TC-EQ-03` for comparison.
- `TC-OM-04` — `#` on an object-model array is `int`.
- `TC-OM-05` — `#` written directly before an object-model path never fails
  (`ObjectModel::GetObjectValue` with `WantArrayLength`): arrays, strings and bitmaps give `int`,
  every other leaf is returned unchanged (`#move.axes[0].homed` is a `bool`). `#(path)` with
  parentheses goes through `ApplyLengthOperator` and follows `TC-UN-03`.

## 12. G-code command lines

- `TC-GC-01` — expressions inside `{ … }` on G/M/T lines are type-checked internally.
- `TC-GC-02` — parameter values are not checked against the parameter's type. String-valued
  parameters accept every type (`StringParser::GetQuotedString` uses `AppendAsString`), so
  `M98 P{1}` and `M291 P{3.5}` are legal.

## Not checked

- Parameter values of G/M/T commands against the parameter's type: `G1 X{"10"}` is not reported.
- Integer versus float in the object model: `@duet3d/objectmodel` types every number as
  `number`, so object-model numbers are `int | uint | float`, and fields whose default is `null`
  (`move.axes[].machinePosition`) have no type at all and are `unknown`.

## Related syntax rules

The syntax checks accept `{1,2}[0]`, `(x)[0]` and `#abs(-5)`, as the firmware does, and reject
`abs(1)[0]` / `fileread(…)[0]`: the firmware cannot index a function result (`echo`/`if` fail with
`expected ','`, and `var`/`set` silently drop the index and store the whole value).
