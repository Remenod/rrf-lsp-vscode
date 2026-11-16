#!/usr/bin/env python3
"""Generate the G-code parameter types the language server checks `{…}` values against.

    scripts/gcode-params-gen.py --rrf <RepRapFirmware checkout> --canlib <CANlib checkout>
                                --dsf <DuetSoftwareFramework checkout> --out <file.json> [--report]

Starting from every `case N:` of the main `switch (code)` in GCodes::HandleGcode and
GCodes::HandleMcode, and from GCodes::HandleTcode, the generator follows every call that
passes the GCodeBuffer on and records how each parameter letter is read:

    gb.Seen('S') … gb.GetFValue()          S is a float
    gb.TryGetUIValue('P', …)               P is an unsigned integer
    gb.Seen('P') … gb.GetQuotedString(…)   P is a string

The C++ is read as text, without a compiler:
  - every #if branch is kept (unless a branch leaves a brace open, or it is #if 0), and a letter
    read in several ways gets every kind (the checker only reports a value that no kind accepts);
  - a call goes to the class of its receiver (reprap.GetFansManager().ConfigureFan, fan->Configure),
    that class's bases and its subclasses, which stand for the virtual overrides;
  - the command number is passed on to callees, and `if (mCode == 669)` branches that cannot
    run for it are dropped. This is the one step that narrows a kind, so after a regeneration
    compare with --no-prune and check every narrowed letter against the source;
  - letters chosen at run time come from the code that picks them ('I' + axis, "XYZUVW"[tower],
    a char parameter); the axis letters are recorded as `axes`;
  - commands sent to CAN expansion boards read the letters of a CANlib parameter table, each as
    CanMessageGenericConstructor::PopulateFromCommand reads its descriptor type.

A read whose letter cannot be told from the text is recorded under "?"; its kinds may be those of
any letter of the command. With a single-board computer, DuetSoftwareFramework reads some
commands itself (MCodes.Process); those are listed under "sbc".

A fractional command (M569.1) gets an entry of its own when the firmware tells that fraction
apart (gb.GetCommandFraction() == 1, `switch (gb.GetCommandFraction())`) and does not hand it to
a macro file; the fraction is followed into callees like the command number.
"""
import argparse
import json
import os
import re
import subprocess
from collections import defaultdict

ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
ap.add_argument('--rrf', required=True, help='RepRapFirmware checkout (the directory holding src/)')
ap.add_argument('--canlib', required=True,
                help='CANlib checkout of the same firmware line (src/CanMessageGenericTables.h)')
ap.add_argument('--dsf', required=True,
                help='DuetSoftwareFramework checkout of the same line (src/DuetControlServer/Codes/Handlers)')
ap.add_argument('--out', required=True, help='output JSON file')
ap.add_argument('--report', action='store_true', help='print coverage figures and what could not be resolved')
ap.add_argument('--no-prune', action='store_true',
                help='keep the branches that cannot run for a command; compare with the normal output to review '
                     'every letter whose kinds the pruning narrowed')
opts = ap.parse_args()

# ── Sources ───────────────────────────────────────────────────────────────────────


COMMENT_OR_LITERAL = re.compile(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', re.S)


def strip_comments(s):
    """s without // and /* */ comments (a "http://…" string is kept); newlines are kept."""
    return COMMENT_OR_LITERAL.sub(lambda m: m.group(0) if m.group(0)[0] in '"\'' else
                                  ' ' + '\n' * m.group(0).count('\n'), s)


def brace_delta(lines):
    depth = 0
    for line in lines:
        line = re.sub(r"'(?:\\.|[^'\\])'|\"(?:\\.|[^\"\\])*\"", '', line)
        depth += line.count('{') - line.count('}')
    return depth


def flatten_conditionals(s):
    """Source with the preprocessor lines removed. Every branch of an #if group is kept when
    each closes the braces it opens; when one does not (`#if X  if (c) {  #else  {  #endif`)
    only the first is, so blocks stay balanced. #if 0 branches are dropped. Line numbers are kept."""
    groups = [[[[]], None]]                 # stack of [branches, condition of the first branch]
    for line in s.split('\n'):
        d = re.match(r'\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)', line)
        if not d:
            groups[-1][0][-1].append(line)
            continue
        kind = d.group(1)
        if kind in ('if', 'ifdef', 'ifndef'):
            groups.append([[[]], d.group(2).strip() if kind == 'if' else None])
        elif kind in ('elif', 'else') and len(groups) > 1:
            groups[-1][0].append([])
        elif kind == 'endif' and len(groups) > 1:
            branches, cond = groups.pop()
            if cond == '0':
                branches = branches[1:] or [[]]
            elif cond == '1':
                branches = branches[:1]
            if any(brace_delta(b) for b in branches):
                branches = branches[:1]
            kept = [line for b in branches for line in b]
            groups[-1][0][-1].extend(kept)
        groups[-1][0][-1].append('')        # the directive line itself
    while len(groups) > 1:                  # an unterminated #if
        branches, _ = groups.pop()
        groups[-1][0][-1].extend(line for b in branches for line in b)
    return '\n'.join(groups[0][0][0])


files = {}
for d, _, fs in sorted(os.walk(os.path.join(opts.rrf, 'src'))):
    for f in sorted(fs):
        if f.endswith(('.cpp', '.h')):
            p = os.path.join(d, f)
            s = flatten_conditionals(strip_comments(open(p, errors='replace').read()))
            s = re.sub(r'\b_ecv_\w+\b', '', s)
            s = re.sub(r'\bTHROWS\s*\([^)]*\)', '', s)
            s = re.sub(r'\b(?:pre|post)\s*\((?:[^()]|\([^()]*\))*\)', '', s)
            s = re.sub(r'(?m)^[ \t]*#.*$', '', s)                  # #define, #include …
            s = s.replace('INHERIT_OBJECT_MODEL', ': public ObjectModel')
            files[p] = s


def skip_string(s, i):
    """Index just past the string or char literal starting at s[i]."""
    q, j = s[i], i + 1
    while j < len(s) and s[j] != q:
        j += 2 if s[j] == '\\' else 1
    return j + 1


def balanced(s, i, open_='(', close=')'):
    """Index just past the bracket matching s[i] == open_."""
    depth, j = 0, i
    while j < len(s):
        c = s[j]
        if c in '"\'':
            j = skip_string(s, j)
            continue
        if c == open_:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return len(s)


def split_args(s):
    out, depth, cur, i = [], 0, '', 0
    while i < len(s):
        c = s[i]
        if c in '"\'':
            j = skip_string(s, i)
            cur += s[i:j]
            i = j
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        if c == ',' and depth == 0:
            out.append(cur.strip())
            cur = ''
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


def blank(s):
    return re.sub(r'[^\n]', ' ', s)


# `const char feedrateLetter = 'F';` and `constexpr const char* ANCHOR_CHARS = "ABCDIJKLO";`
char_consts, string_consts = {}, {}
for s in files.values():
    for m in re.finditer(r"\b(?:constexpr|const)\s+char\s+(\w+)\s*=\s*'(.)'\s*;", s):
        char_consts.setdefault(m.group(1), m.group(2))
    for m in re.finditer(r'\b(?:constexpr|const)\s+(?:const\s+)?char\s*(?:\*\s*(?:const\s*)?)?(\w+)\s*(?:\[\s*\])?\s*=\s*"([^"]*)"\s*;', s):
        string_consts.setdefault(m.group(1), m.group(2))

# Integer constants: `constexpr int8_t kvSubCommand = 1;` and enum members, numbered or not.
# A name given two different values is left out.
int_consts = {}


def add_const(name, value):
    int_consts[name] = None if name in int_consts and int_consts[name] != value else value


def parse_int(t):
    t = t.strip().rstrip('uUlL')
    return int(t, 16) if re.fullmatch(r'0[xX][0-9a-fA-F]+', t) else int(t) if re.fullmatch(r'-?\d+', t) else None


for s in files.values():
    # `constexpr NetworkProtocol HttpProtocol = 0, FtpProtocol = 1, …;` declares several
    for m in re.finditer(r'\b(?:constexpr|const)\s+(?:\w+::)*\w+\s+(\w+\s*=\s*-?\w+\s*(?:,\s*\w+\s*=\s*-?\w+\s*)*);', s):
        for d in re.finditer(r'(\w+)\s*=\s*(-?\w+)', m.group(1)):
            if parse_int(d.group(2)) is not None:
                add_const(d.group(1), parse_int(d.group(2)))
    for m in re.finditer(r'\benum\b[^{;()]*\{([^{}]*)\}', s):
        v = -1
        for item in split_args(m.group(1)):
            e = re.fullmatch(r'(\w+)\s*(?:=\s*(.+))?', item.strip())
            if not e:
                continue
            v = parse_int(e.group(2)) if e.group(2) else (None if v is None else v + 1)
            if v is not None:
                add_const(e.group(1), v)


def int_value(t):
    """The number a literal or a named constant (Enum::name) stands for, or None."""
    n = parse_int(t)
    if n is not None:
        return n
    v = int_consts.get(t.strip().split('::')[-1].strip())
    return v if isinstance(v, int) else None

# ── Classes, members and return types ───────────────────────────────────────────────

KEYWORDS = {'return', 'delete', 'new', 'else', 'case', 'goto', 'throw', 'using', 'typedef', 'namespace',
            'if', 'while', 'for', 'switch', 'sizeof', 'do', 'break', 'continue', 'operator', 'public',
            'private', 'protected', 'default', 'static_assert', 'template', 'typename', 'friend'}
CLASS = re.compile(r'(?<!enum )\b(?:class|struct)\s+(\w+)\s*(?:final\s*)?(?::\s*([^{;()]*?))?\s*\{')
TYPE = r'((?:\w+::)*\w+(?:\s*<[^;{}()<>]*(?:<[^;{}()<>]*>)?[^;{}()<>]*>)?)'
DECL = re.compile(TYPE + r'(?:\s*(?:const\b)?\s*(?:[\*&]\s*)+(?:const\b)?\s*|\s+)(\w+)\s*(?:\[[^\]]*\]\s*)*(?=[;=,){]|\[)')
WRAPPERS = {'ReadLockedPointer', 'WriteLockedPointer', 'ReadWriteLockedPointer', 'unique_ptr', 'shared_ptr'}

classes = defaultdict(lambda: {'bases': set(), 'members': {}, 'methods': {}})
children = defaultdict(set)
class_ranges = defaultdict(list)       # file -> [(start, end, class)]
free_returns, globals_ = {}, {}

for p, s in files.items():
    for m in CLASS.finditer(s):
        name, start = m.group(1), m.end() - 1
        end = balanced(s, start, '{', '}')
        class_ranges[p].append((start, end, name))
        for base in split_args(m.group(2) or ''):
            b = re.match(r'(?:\w+::)*(\w+)', re.sub(r'\b(?:public|protected|private|virtual)\b', ' ', base).strip())
            if b:
                classes[name]['bases'].add(b.group(1))
                children[b.group(1)].add(name)
        body = s[start + 1:end - 1]
        for d in DECL.finditer(body):
            if d.group(1) not in KEYWORDS and d.group(2) not in KEYWORDS:
                classes[name]['members'].setdefault(d.group(2), d.group(1))
        for d in re.finditer(TYPE + r'\s*[\*&]*\s*(\w+)\s*\(', body):
            if d.group(1) not in KEYWORDS:
                classes[name]['methods'].setdefault(d.group(2), d.group(1))
    for m in re.finditer(r'(?m)^\s*extern\s+(\w+)\s+(\w+)\s*;', s):
        globals_.setdefault(m.group(2), m.group(1))
    for m in re.finditer(r'(?m)^[ \t]*' + TYPE + r'\s*[\*&]*\s*(\w+)::(\w+)\s*\(', s):
        if m.group(1) not in KEYWORDS:
            classes[m.group(2)]['methods'].setdefault(m.group(3), m.group(1))
    for m in re.finditer(r'(?m)^' + TYPE + r'\s*[\*&]*\s*(\w+)\s*\(', s):
        if m.group(1) not in KEYWORDS:
            free_returns.setdefault(m.group(2), m.group(1))


def type_name(t):
    """The class a declared type refers to: `const ReadLockedPointer<Fan>&` -> Fan."""
    t = re.sub(r'\b(?:const|volatile|static|inline|constexpr|virtual|explicit|mutable|struct|class)\b', ' ', t).strip()
    m = re.match(r'((?:\w+::)*)(\w+)\s*(?:<(.*)>)?', t)
    if not m:
        return None
    name, arg = m.group(2), m.group(3)
    if arg and (name in WRAPPERS or name not in classes):
        inner = re.match(r'\s*(?:const\s+)?(?:\w+::)*(\w+)', arg)
        return inner.group(1) if inner else None
    return name


def ancestors(c):
    seen, todo = set(), [c]
    while todo:
        k = todo.pop()
        for b in (classes[k]['bases'] if k in classes else ()):
            if b not in seen:
                seen.add(b)
                todo.append(b)
    return seen


def descendants(c):
    seen, todo = set(), [c]
    while todo:
        for d in children.get(todo.pop(), ()):
            if d not in seen:
                seen.add(d)
                todo.append(d)
    return seen


def family(c):
    return {c} | ancestors(c) | descendants(c)


def lookup(c, what, name):
    """The declared type of a member or method of class c or of one of its bases."""
    for k in [c] + sorted(ancestors(c)):
        t = classes[k][what].get(name) if k in classes else None
        if t:
            return t
    return None

# ── Functions that receive the GCodeBuffer ──────────────────────────────────────────


class Function:
    def __init__(self, qual, cls, gb, params, body):
        self.qual, self.cls, self.gb, self.params, self.body = qual, cls, gb, params, body


functions = defaultdict(list)     # bare name -> [Function]
DEF = re.compile(r'(?m)^[ \t]*(?:[\w:<>,\*&]+[ \t]+)+\**&?((?:\w+::)*)(~?\w+)\s*\(')
for p, s in files.items():
    for m in DEF.finditer(s):
        a = m.end() - 1
        b = balanced(s, a)
        params = s[a + 1:b - 1]
        g = re.search(r'GCodeBuffer\s*(?:&|\*)\s*(\w+)', params)
        if not g:
            continue
        rest = re.match(r'\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{', s[b:])
        if not rest:
            continue
        body_start = b + rest.end() - 1
        body = s[body_start + 1:balanced(s, body_start, '{', '}') - 1]
        if m.group(1):
            cls = m.group(1).rstrip(':').split('::')[-1]
        else:
            inside = [r for r in class_ranges[p] if r[0] < m.start() < r[1]]
            cls = min(inside, key=lambda r: r[1] - r[0])[2] if inside else None
        functions[m.group(2)].append(Function(m.group(1) + m.group(2), cls, g.group(1), params, body))

# ── Receivers ─────────────────────────────────────────────────────────────────────


def chain_before(s, i):
    """The postfix expression ending at s[:i] as segments ('id', x), ('call', f), ('index',),
    ('scope', X), left to right; None if it is not a plain chain."""
    segs, j = [], i
    while True:
        while j > 0 and s[j - 1].isspace():
            j -= 1
        if j > 0 and s[j - 1] == ']':
            depth = 0
            while j > 0:
                j -= 1
                depth += {']': 1, '[': -1}.get(s[j], 0)
                if depth == 0:
                    break
            segs.append(('index',))
            continue
        call = False
        if j > 0 and s[j - 1] == ')':
            depth, k = 0, j
            while k > 0:
                k -= 1
                depth += {')': 1, '(': -1}.get(s[k], 0)
                if depth == 0:
                    break
            j = k
            while j > 0 and s[j - 1].isspace():
                j -= 1
            call = True
        m = re.search(r'(\w+)$', s[:j])
        if not m:
            return None if call or not segs else list(reversed(segs))
        j = m.start()
        segs.append(('call' if call else 'id', m.group(1)))
        while j > 0 and s[j - 1].isspace():
            j -= 1
        if s[:j].endswith('->') or s[:j].endswith('.'):
            j -= 2 if s[:j].endswith('->') else 1
            continue
        if s[:j].endswith('::'):
            m = re.search(r'(\w+)$', s[:j - 2])
            if m:
                segs.append(('scope', m.group(1)))
        break
    return list(reversed(segs))


def var_type(fn, name, pos):
    """The class of a variable used at fn.body[pos]: a local, a parameter, a member or a global."""
    best = None
    for d in DECL.finditer(fn.body, 0, pos):
        if d.group(2) == name and d.group(1) not in KEYWORDS:
            best = d
    if best:
        if best.group(1) == 'auto':
            e = re.match(r'\s*=\s*([^;]*);', fn.body[best.end():])
            if not e:
                return None
            segs = chain_before(e.group(1).strip(), len(e.group(1).strip()))
            return eval_chain(fn, segs, best.end()) if segs else None
        return type_name(best.group(1))
    for d in DECL.finditer(fn.params + ','):
        if d.group(2) == name:
            return type_name(d.group(1))
    t = (lookup(fn.cls, 'members', name) if fn.cls else None) or globals_.get(name)
    return type_name(t) if t else None


def eval_chain(fn, segs, pos):
    """The class of a receiver chain such as reprap.GetFansManager() or fans[i]."""
    t = None
    for k, seg in enumerate(segs):
        if seg[0] == 'scope':
            t = seg[1]
        elif seg[0] == 'index':
            continue
        elif k == 0 or (k == 1 and segs[0][0] == 'scope'):
            if seg[0] == 'id':
                t = fn.cls if seg[1] == 'this' else var_type(fn, seg[1], pos)
                if t is None and seg[1] in classes:
                    t = seg[1]
            else:
                owner = t or fn.cls
                r = (lookup(owner, 'methods', seg[1]) if owner else None) or free_returns.get(seg[1])
                t = type_name(r) if r else None
        else:
            r = lookup(t, 'methods' if seg[0] == 'call' else 'members', seg[1])
            t = type_name(r) if r else None
        if t is None:
            return None
    return t


def callees(fn, name, start):
    """The definitions a call to `name` at fn.body[start] may reach."""
    cands = functions.get(name, ())
    if not cands:
        return ()
    before = fn.body[:start].rstrip()
    if before.endswith('::'):
        # Base::Method(): that class, or the base it inherits the method from.
        m = re.search(r'(\w+)\s*::$', before)
        fam = {m.group(1)} | ancestors(m.group(1)) if m else set()
    elif before.endswith('.') or before.endswith('->'):
        segs = chain_before(fn.body, len(before) - (2 if before.endswith('->') else 1))
        t = eval_chain(fn, segs, start) if segs else None
        fam = family(t) if t else set()
    else:
        fam = family(fn.cls) if fn.cls else set()
        hit = [c for c in cands if c.cls in fam] or [c for c in cands if c.cls is None]
        if hit:
            return hit
    hit = [c for c in cands if c.cls in fam]
    if hit:
        return hit
    if len({c.cls for c in cands}) > 1:
        stats['unresolved'][f'call {fn.qual} -> {name}'] += 1
    return cands

# ── Letters ───────────────────────────────────────────────────────────────────────


AXIS_SOURCES = re.compile(r'\b(?:axisLetters|GetAxisLetters|AllowedAxisLetters)\b')


def letters_of(arg, fn=None, pos=None, bindings=None, seen=None):
    """Letters a Seen()/MustSee()/tagged-getter argument may stand for: letters, 'axes' for the
    axis letters, or {'?'} when the text does not tell."""
    a = arg.strip()
    fixed = re.fullmatch(r'(?:\w+\s*\.\s*)?axisLetters\s*\[\s*([XYZ])_AXIS\s*\]', a)
    if fixed:                                                   # the first three axes are always X, Y, Z
        return {fixed.group(1)}
    out = set()
    if AXIS_SOURCES.search(a):
        out.add('axes')
        a = AXIS_SOURCES.sub(' ', a)
    m = re.search(r"'([A-Za-z])'\s*\+", a)                      # 'I' + axis: I, J, K
    if m:
        return out | {chr(ord(m.group(1).upper()) + k) for k in range(3)}
    out |= {c.upper() for c in re.findall(r"'([A-Za-z])'", a)}
    for lit in re.findall(r'"([A-Za-z]*)"\s*\[', a):
        out |= set(lit.upper())
    seen = set() if seen is None else seen
    for name in re.findall(r'\b([A-Za-z_]\w*)\b', re.sub(r"'(?:\\.|[^'])'|\"(?:\\.|[^\"])*\"", ' ', a)):
        if name in seen:
            continue
        seen.add(name)
        if name in char_consts:
            out.add(char_consts[name].upper())
        elif name in string_consts:
            out |= set(string_consts[name].upper())
        elif bindings and isinstance(bindings.get(name), frozenset):
            out |= bindings[name]
        elif fn is not None:
            for src in assignments(fn, name, pos):
                out |= letters_of(src, fn, pos, bindings, seen) - {'?'}
    return out or {'?'}


def assignments(fn, name, pos):
    """What a char or char-pointer variable is given before fn.body[pos]: its initialiser,
    later `name = …`, and the range of `for (char name : …)`."""
    body = fn.body[:pos] if pos is not None else fn.body
    out = []
    decl = re.compile(r'\bchar\s*(?:\*\s*)*(?:const\s*)?(?:\*\s*)*&?\s*' + re.escape(name) + r'\s*(=|:)\s*')
    for m in decl.finditer(body):
        if m.group(1) == '=':
            end = body.find(';', m.end())
        else:                                                   # up to the for's ')'
            depth, end = 1, m.end()
            while end < len(body) and depth:
                depth += {'(': 1, ')': -1}.get(body[end], 0)
                end += 1
            end -= 1
        out.append(body[m.end():end if end >= 0 else len(body)])
    if out or re.search(r'\bchar\b[^;()]*\b' + re.escape(name) + r'\b', body):
        for m in re.finditer(r'(?<![\w.>])' + re.escape(name) + r'\s*=(?!=)\s*', body):
            end = body.find(';', m.end())
            out.append(body[m.end():end if end >= 0 else len(body)])
    return out

# ── Branches that cannot run for the command number ─────────────────────────────────────


def cond_tokens(s):
    out, i, atom = [], 0, ''

    def flush():
        nonlocal atom
        if atom.strip():
            out.append(('atom', atom.strip()))
        atom = ''
    while i < len(s):
        c = s[i]
        if s.startswith('&&', i) or s.startswith('||', i):
            flush()
            out.append(s[i:i + 2])
            i += 2
        elif c == '!' and not s.startswith('!=', i) and not atom.strip():
            out.append('!')
            i += 1
        elif c == '(' and not atom.strip():
            out.append('(')
            i += 1
        elif c == '(':
            j = balanced(s, i)
            atom += s[i:j]
            i = j
        elif c == ')':
            flush()
            out.append(')')
            i += 1
        elif c in '"\'':
            j = skip_string(s, i)
            atom += s[i:j]
            i = j
        else:
            atom += c
            i += 1
    flush()
    return out


FRACTION = re.compile(r'\b\w+\s*(?:\.|->)\s*GetCommandFraction\s*\(\s*\)')


def eval_cond(s, ints):
    """True, False or None (cannot tell) for an if condition, knowing the bound numbers."""
    toks = cond_tokens(FRACTION.sub('__frac', s))
    pos = 0

    def atom(t):
        m = re.fullmatch(r'(\w+)\s*(==|!=|<=|>=|<|>)\s*(-?[\w:]+)', t)
        if m and isinstance(ints.get(m.group(1)), int):
            var, op, num = m.groups()
        else:
            m = re.fullmatch(r'(-?[\w:]+)\s*(==|!=)\s*(\w+)', t)
            if not m or not isinstance(ints.get(m.group(3)), int):
                return None
            num, op, var = m.groups()
        n = int_value(num)
        if n is None:
            return None
        v = ints[var]
        return {'==': v == n, '!=': v != n, '<=': v <= n, '>=': v >= n, '<': v < n, '>': v > n}[op]

    def unary():
        nonlocal pos
        if pos >= len(toks):
            raise ValueError
        t = toks[pos]
        pos += 1
        if t == '!':
            v = unary()
            return None if v is None else not v
        if t == '(':
            v = disj()
            if pos >= len(toks) or toks[pos] != ')':
                raise ValueError
            pos += 1
            return v
        if isinstance(t, tuple):
            return atom(t[1])
        raise ValueError

    def conj():
        nonlocal pos
        v = unary()
        while pos < len(toks) and toks[pos] == '&&':
            pos += 1
            w = unary()
            v = False if v is False or w is False else (True if v and w else None)
        return v

    def disj():
        nonlocal pos
        v = conj()
        while pos < len(toks) and toks[pos] == '||':
            pos += 1
            w = conj()
            v = True if v is True or w is True else (False if v is False and w is False else None)
        return v
    try:
        v = disj()
        return v if pos == len(toks) else None
    except ValueError:
        return None


def statement_end(s, i):
    """Index just past the statement starting at s[i] (a block, an if/else chain, a loop or `…;`)."""
    while i < len(s) and s[i].isspace():
        i += 1
    if i < len(s) and s[i] == '{':
        return balanced(s, i, '{', '}')
    m = re.match(r'(if|while|for|switch)\s*\(', s[i:i + 20])
    if m:
        j = statement_end(s, balanced(s, i + m.end() - 1))
        if m.group(1) == 'if':
            e = re.match(r'\s*else\b', s[j:j + 40])
            if e:
                j = statement_end(s, j + e.end())
        return j
    depth, j = 0, i
    while j < len(s):
        c = s[j]
        if c in '"\'':
            j = skip_string(s, j)
            continue
        depth += {'(': 1, ')': -1, '{': 1, '}': -1}.get(c, 0)
        if c == ';' and depth <= 0:
            return j + 1
        j += 1
    return j


def fraction_aliases(fn):
    """Locals that hold the command fraction: `const int8_t fraction = gb.GetCommandFraction();`."""
    return set(re.findall(r'\b(\w+)\s*=\s*' + FRACTION.pattern + r'\s*;', fn.body))


def fraction_literals(fn, start, end):
    """Fractions a part of fn tells apart: `GetCommandFraction() == 2`, `case 2:` of a switch on it."""
    text = fn.body[start:end]
    names = [FRACTION.pattern] + [r'\b' + re.escape(a) + r'\b' for a in fraction_aliases(fn)]
    out = set()
    for n in names:
        out |= {int_value(x) for x in re.findall('(?:' + n + r')\s*(?:==|!=)\s*(-?[\w:]+)', text)}
        for m in re.finditer(r'\bswitch\s*\(\s*(?:' + n + r')\s*\)\s*\{', text):
            body = text[m.end():balanced(text, m.end() - 1, '{', '}') - 1]
            out |= {l[2] for l in switch_labels(body) if isinstance(l[2], int)}
    return out - {None}


def switch_labels(body):
    """[(label start, label end, value)] for the top-level labels of a switch body; value is
    an int, 'default', or None for a label that is not a number."""
    labels, depth, i = [], 0, 0
    while i < len(body):
        c = body[i]
        if c in '"\'':
            i = skip_string(body, i)
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        elif depth == 0 and (i == 0 or not (body[i - 1].isalnum() or body[i - 1] == '_')):
            m = re.match(r"(?:case\s+((?:[^:;'\n]|::|'(?:\\.|[^'])')+?)|default)\s*:(?!:)", body[i:i + 120])
            if m:
                v = int_value(m.group(1)) if m.group(1) else 'default'
                labels.append((i, i + m.end(), v))
                i += m.end()
                continue
        i += 1
    return labels


def reached_ranges(body, labels, value):
    """The (start, end) ranges of a switch body run for `value`: its case, the cases it falls
    into, or else the default."""
    ranges = [(after, labels[k + 1][0] if k + 1 < len(labels) else len(body)) for k, (_, after, _) in enumerate(labels)]
    hit = [k for k, l in enumerate(labels) if l[2] == value] or [k for k, l in enumerate(labels) if l[2] == 'default']
    out = []
    for k in hit[:1]:
        out.append(ranges[k])
        while falls_through(body[ranges[k][0]:ranges[k][1]]) and k + 1 < len(labels):
            k += 1
            out.append(ranges[k])
    return out


def rest_of_block(s, i):
    """Where the code reachable after s[i] in the same block ends: the block's closing brace,
    or the next case label, which is entered from the switch."""
    depth, j = 0, i
    while j < len(s):
        c = s[j]
        if c in '"\'':
            j = skip_string(s, j)
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            if depth == 0:
                return j
            depth -= 1
        elif depth == 0 and re.match(r'(?:case\b[^:]*|default\s*):(?!:)', s[j:j + 80]) and not (s[j - 1].isalnum() or s[j - 1] == '_'):
            return j
        j += 1
    return j


pruned_cache = {}


def pruned(fn, ints):
    """fn.body with the if/else branches and switch cases that cannot run for the bound numbers
    blanked out."""
    if opts.no_prune:
        return fn.body
    key = (id(fn.body), frozenset(ints.items()))
    if key in pruned_cache:
        return pruned_cache[key]
    s = fn.body
    if '__frac' in ints:
        ints = dict(ints, **{a: ints['__frac'] for a in fraction_aliases(fn)})
    if ints:
        for m in list(re.finditer(r'\bswitch\s*\(', s)):
            if not s[m.start():m.end()].strip():
                continue
            a = m.end() - 1
            b = balanced(s, a)
            var = FRACTION.sub('__frac', s[a + 1:b - 1]).strip()
            brace = re.match(r'\s*\{', s[b:])
            if not isinstance(ints.get(var), int) or not brace:
                continue
            start = b + brace.end()
            end = balanced(s, start - 1, '{', '}') - 1
            body = s[start:end]
            labels = switch_labels(body)
            if not labels or any(l[2] is None for l in labels):
                continue
            keep = sorted(reached_ranges(body, labels, ints[var]) + [(la, lb) for la, lb, _ in labels])
            parts, at = [], 0
            for x, y in keep:
                if x > at:
                    parts.append(blank(body[at:x]))
                parts.append(body[max(x, at):y])
                at = max(at, y)
            parts.append(blank(body[at:]))
            s = s[:start] + ''.join(parts) + s[end:]
            stats['branches dropped'] += 1
        for m in list(re.finditer(r'\bif\s*\(', s)):
            if not s[m.start():m.end()].strip():                 # inside a branch already dropped
                continue
            a = m.end() - 1
            b = balanced(s, a)
            v = eval_cond(s[a + 1:b - 1], ints)
            if v is None:
                continue
            then_end = statement_end(s, b)
            e = re.match(r'\s*else\b', s[then_end:then_end + 40])
            if v:
                after = statement_end(s, then_end + e.end()) if e else then_end
                then = s[b:then_end].strip()
                if not falls_through(then[1:-1] if then.startswith('{') else then) and \
                        not re.search(r'\belse\s*$', s[:m.start()]):
                    after = rest_of_block(s, after)      # `if (mCode != 669) { return …; }`: the rest cannot run
                if after > then_end:
                    s = s[:then_end] + blank(s[then_end:after]) + s[after:]
                    stats['branches dropped'] += 1
            else:
                s = s[:a + 1] + blank(s[a + 1:then_end]) + s[then_end:]
                stats['branches dropped'] += 1
    pruned_cache[key] = s
    return s

# ── Commands forwarded to expansion boards ─────────────────────────────────────────


can_tables, macro_types = {}, {}
for d, _, fs in sorted(os.walk(os.path.join(opts.canlib, 'src'))):
    for f in sorted(fs):
        if f.endswith('.h'):
            t = strip_comments(open(os.path.join(d, f), errors='replace').read())
            for m in re.finditer(r'\bParamDescriptor\s+(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};', t, re.S):
                can_tables[m.group(1)] = re.findall(r"\b([A-Z0-9_]+)_PARAM\s*\(\s*'([A-Z])'", m.group(2))
            for m in re.finditer(r'#define\s+([A-Z0-9_]+)_PARAM\s*\([^)]*\)\s*\{\s*_c\s*,\s*ParamDescriptor::(\w+)', t):
                macro_types[m.group(1)] = m.group(2)
descriptor_kinds = None


def read_descriptor_kinds():
    """ParamDescriptor type -> kinds, from the switch in PopulateFromCommand."""
    out = {}
    for fn in functions.get('PopulateFromCommand', ()):
        sw = re.search(r'\bswitch\s*\(\s*d->type\s*\)\s*\{', fn.body)
        if not sw:
            continue
        body = fn.body[sw.end():balanced(fn.body, sw.end() - 1, '{', '}') - 1]
        parts = re.split(r'\bcase\s+ParamDescriptor::(\w+)\s*:', body)
        pending = []
        for k in range(1, len(parts), 2):
            pending.append(parts[k])
            kinds = {k for g in re.findall(r'\b' + fn.gb + r'\s*\.\s*(\w+)\s*\(', parts[k + 1]) if g in GETTERS
                     for k in GETTERS[g].split('|')}
            if kinds or re.search(r'\bbreak\s*;', parts[k + 1]):
                for t in pending:
                    out[t] = kinds
                pending = []
    return out


def can_table_reads(fn, pos):
    global descriptor_kinds
    if descriptor_kinds is None:
        descriptor_kinds = read_descriptor_kinds()
    out = defaultdict(set)
    tables = re.findall(r'\bCanMessageGenericConstructor\s+\w+\s*\(\s*(\w+)\s*\)', fn.body[:pos])
    if not tables or tables[-1] not in can_tables:
        stats['unresolved'][f'CAN table in {fn.qual}: {tables[-1] if tables else "?"}'] += 1
        return out
    stats['can tables'].add(tables[-1])
    for macro, letter in can_tables[tables[-1]]:
        kinds = descriptor_kinds.get(macro_types.get(macro, ''), set())
        if not kinds:
            stats['unresolved'][f'CAN descriptor {macro}_PARAM'] += 1
        out[letter] |= kinds
    return out

# ── Reads ─────────────────────────────────────────────────────────────────────────


GETTERS = {
    'GetFValue': 'float', 'GetPositiveFValue': 'float', 'GetNonNegativeFValue': 'float',
    'GetDistance': 'float', 'GetSpeed': 'float', 'GetSpeedFromMm': 'float', 'GetAcceleration': 'float',
    'GetLimitedFValue': 'float', 'GetPwmValue': 'float',
    'TryGetFValue': 'float', 'TryGetNonNegativeFValue': 'float', 'TryGetPositiveFValue': 'float',
    'TryGetLimitedFValue': 'float',
    'GetIValue': 'int', 'GetLimitedIValue': 'int', 'TryGetIValue': 'int', 'TryGetLimitedIValue': 'int',
    'GetUIValue': 'uint', 'GetLimitedUIValue': 'uint', 'TryGetUIValue': 'uint', 'TryGetLimitedUIValue': 'uint',
    'GetPwmFrequency': 'uint',
    'TryGetBValue': 'bool',
    'GetQuotedString': 'string', 'GetPossiblyQuotedString': 'string', 'GetReducedString': 'string',
    'TryGetQuotedString': 'string', 'TryGetPossiblyQuotedString': 'string',
    'GetStringOrUIValue': 'string|uint',
    'GetFloatArray': 'float[]', 'TryGetFloatArray': 'float[]',
    'GetIntArray': 'int[]',
    'GetUnsignedArray': 'uint[]', 'TryGetUIArray': 'uint[]',
    'GetDriverId': 'driver', 'GetDriverIdArray': 'driver[]',
    'GetIPAddress': 'ip', 'GetMacAddress': 'mac',
    'GetExpression': 'any',
}
TAGGED = {n for n in GETTERS if n.startswith('Try') or n.startswith('GetLimited')}   # letter is argument 0
# GCodeBuffer methods that do not read a parameter value. A Get…/TryGet… method in neither
# list stops the generator, so that a getter added by a new firmware is not silently missed.
NOT_VALUE_GETTERS = {
    'GetActiveQueueNumber', 'GetBlockIndent', 'GetBlockState', 'GetChannel', 'GetCommandedQueue',
    'GetCommandFraction', 'GetCommandLetter', 'GetCommandNumber', 'GetCompleteParameters',
    'GetDistanceUnits', 'GetExplicitLineNumber', 'GetFileInput', 'GetFileName', 'GetIdentity',
    'GetIndent', 'GetJobFilePosition', 'GetLastResult', 'GetLastStatusReportType', 'GetLineNumber',
    'GetM291Result', 'GetNativeResponseMessageType', 'GetNormalInput', 'GetOwnQueue',
    'GetOwnQueueNumber', 'GetPrintingFilePosition', 'GetQueueNumberToLock', 'GetRequestedMacroFile',
    'GetResponseMessageType', 'GetStackDepth', 'GetState', 'GetStateText', 'GetVariables',
    'GetUnprecedentedString',       # the rest of the line, not a lettered parameter
}
gcodebuffer = next((s[m.end():balanced(s, m.end() - 1, '{', '}')] for p, s in files.items()
                    if p.endswith(os.path.join('GCodeBuffer', 'GCodeBuffer.h'))
                    for m in [re.search(r'\bclass\s+GCodeBuffer\b[^;{]*\{', s)] if m), '')
unclassified = sorted({n for n in re.findall(r'\b((?:Try)?Get\w*)\s*\(', gcodebuffer)} - set(GETTERS) - NOT_VALUE_GETTERS)
if unclassified:
    raise SystemExit('GCodeBuffer methods to classify in GETTERS or NOT_VALUE_GETTERS: ' + ' '.join(unclassified))
INT_TYPE = re.compile(r'(?:const\s+)?(?:unsigned\s+int|unsigned|int|u?int(?:8|16|32|64)_t|size_t|long)\s+(\w+)(?:\s*=.*)?')

memo = {}
stats = {'calls followed': 0, 'branches dropped': 0, 'unresolved': defaultdict(int), 'can tables': set(),
         'other gb calls': defaultdict(int)}


def bind_params(c, args, caller, pos, bindings):
    """Bindings of a callee's char parameters to letters, and of its integer parameters to
    the command number or another constant its caller passes."""
    out = {'__frac': bindings['__frac']} if bindings and '__frac' in bindings else {}
    aliases = fraction_aliases(caller)
    for k, p in enumerate(split_args(c.params)):
        if k >= len(args):
            break
        m = re.fullmatch(r'(?:const\s+)?char\s+(\w+)(?:\s*=.*)?', p.strip())
        if m:
            ls = letters_of(args[k], caller, pos, bindings)
            if ls != {'?'}:
                out[m.group(1)] = frozenset(ls)
            continue
        m = INT_TYPE.fullmatch(p.strip())
        if m:
            a = args[k].strip()
            if re.fullmatch(r'\d+[uU]?', a):
                out[m.group(1)] = int(a.rstrip('uU'))
            elif bindings and isinstance(bindings.get(a), int):
                out[m.group(1)] = bindings[a]
            elif bindings and '__frac' in bindings and (FRACTION.fullmatch(a) or a in aliases):
                out[m.group(1)] = bindings['__frac']
    return out


def analyse(fn, start, end, current, depth, stack, bindings):
    """letter -> kinds read in fn.body[start:end], given the letters last selected by Seen()."""
    out = defaultdict(set)
    if depth > 12:
        return out
    gb = fn.gb
    text = pruned(fn, {k: v for k, v in bindings.items() if isinstance(v, int)})
    out['__fractions'] |= fraction_literals(fn, start, end)
    pat = re.compile(r'\b' + re.escape(gb) + r'\s*(?:\.|->)\s*(\w+)\s*\(|\b(\w+)\s*\(')
    cur = set(current)
    selected = False                                            # whether a Seen() here chose `cur`
    last_seen_end = -1
    pos = start
    while True:
        m = pat.search(text, pos, end)
        if not m:
            break
        a = m.end() - 1
        args = split_args(text[a + 1:balanced(text, a) - 1])
        pos = a + 1                                             # look inside the arguments too
        if m.group(1):
            name = m.group(1)
            if name in ('Seen', 'MustSee'):
                # `gb.Seen('Z') || gb.Seen('S')`: either letter may be the one read next
                between = text[last_seen_end:m.start()] if last_seen_end >= 0 else ';'
                either = '||' in between and not re.search(r'[;{}]', between)
                if not either:
                    cur = set()
                for x in args:
                    cur |= letters_of(x, fn, m.start(), bindings)
                selected = True
                last_seen_end = balanced(text, a)
            elif name in GETTERS:
                for letter in (letters_of(args[0], fn, m.start(), bindings) if name in TAGGED and args else cur):
                    out[letter] |= set(GETTERS[name].split('|'))
            else:
                stats['other gb calls'][name] += 1
            continue
        name = m.group(2)
        if name in KEYWORDS or not any(x.lstrip('&*') == gb for x in args):
            continue
        if name == 'PopulateFromCommand':
            for letter, ks in can_table_reads(fn, m.start()).items():
                out[letter] |= ks
            continue
        for c in callees(fn, name, m.start(2)):
            bind = bind_params(c, args, fn, m.start(), bindings)
            key = (c.qual, id(c.body), frozenset(cur), frozenset(bind.items()))
            if key in stack:
                continue
            if key not in memo:
                stats['calls followed'] += 1
                memo[key] = analyse(c, 0, len(c.body), cur, depth + 1, stack | {key}, bind)
            for letter, ks in memo[key].items():
                if letter != '__selected':
                    out[letter] |= ks
            if memo[key].get('__selected'):                     # FindAxisLetter(gb) leaves its letter selected
                cur = set(memo[key]['__selected'])
                selected = True
    if selected:
        out['__selected'] = set(cur)
    return out

# ── The command switches ──────────────────────────────────────────────────────────


def main_switch(body):
    """(start, end) of the body of the `switch (code)` with the most case labels."""
    best = None
    for m in re.finditer(r'\bswitch\s*\(\s*code\s*\)\s*\{', body):
        start = m.end() - 1
        end = balanced(body, start, '{', '}')
        n = len(re.findall(r'\bcase\s+\d+\s*:', body[start:end]))
        if best is None or n > best[2]:
            best = (start + 1, end - 1, n)
    return best


def top_level(body):
    """body with nested {…} blocks reduced to {} and strings emptied."""
    out, depth, i = [], 0, 0
    while i < len(body):
        c = body[i]
        if c in '"\'':
            j = skip_string(body, i)
            if depth == 0:
                out.append(c + c)
            i = j
            continue
        if c == '{':
            if depth == 0:
                out.append('{')
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                out.append('}')
        elif depth == 0:
            out.append(c)
        i += 1
    return ''.join(out)


def block_tail(seg):
    """The contents of the last top-level {…} block of seg."""
    end = seg.rstrip().rfind('}')
    depth, i = 0, end
    while i >= 0:
        depth += {'}': 1, '{': -1}.get(seg[i], 0)
        if depth == 0:
            return seg[i + 1:end]
        i -= 1
    return ''


def falls_through(seg):
    """True unless the last statement of a case leaves the switch. A trailing bare block is
    looked into; a trailing if/else or loop counts as falling through."""
    while True:
        t = top_level(seg).rstrip()
        if not t:
            return True
        if t.endswith('{}'):
            if re.split(r'[;}]', t[:-2])[-1].strip():
                return True
            seg = block_tail(seg)
            continue
        last = re.split(r'[;{}]', t.rstrip(';').rstrip())[-1].strip()
        return not re.match(r'(?:break|return|throw|continue|goto)\b', last)


def cases(body, base):
    """[(code, [(start, end), …])] for the case labels of a switch body that starts at
    fn.body[base]; a case that falls through gets the ranges of the cases it runs into."""
    labels = switch_labels(body)
    return [(l[2], [(base + a, base + b) for a, b in reached_ranges(body, labels, l[2])])
            for l in labels if isinstance(l[2], int)]


def fraction_codes(fn, sw_start):
    """The codes a handler lets keep a fraction: the `code != N` of its macro-file filter."""
    head = fn.body[:sw_start]
    out = set()
    for m in re.finditer(r'\bif\s*\(', head):
        a = m.end() - 1
        b = balanced(head, a)
        if FRACTION.search(head[a + 1:b - 1]) and 'TryMacroFile' in head[b:statement_end(head, b)]:
            out |= {int(x) for x in re.findall(r'\bcode\s*!=\s*(\d+)', head[a + 1:b - 1])}
    return out


def macro_fraction(fn, sw_start, code, fraction):
    """True when the handler gives this fractional command to a macro file before its switch."""
    head = fn.body[:sw_start]
    for m in re.finditer(r'\bif\s*\(', head):
        a = m.end() - 1
        b = balanced(head, a)
        cond = head[a + 1:b - 1]
        if FRACTION.search(cond) and 'TryMacroFile' in head[b:statement_end(head, b)]:
            if eval_cond(cond, {'code': code, '__frac': fraction}) is not False:
                return True
    return False


commands = {}


def record(cmd, reads):
    entry = commands.setdefault(cmd, defaultdict(set))
    for letter, ks in reads.items():
        if not letter.startswith('__'):
            entry[letter] |= ks


for handler, letter in (('HandleGcode', 'G'), ('HandleMcode', 'M')):
    for fn in functions.get(handler, ()):
        sw = main_switch(fn.body)
        if not sw:
            continue
        for code, chain in cases(fn.body[sw[0]:sw[1]], sw[0]):
            def run(fraction):
                """Reads for the command with that fraction (-1: none); None leaves it open."""
                bind = {'code': code} if fraction is None else {'code': code, '__frac': fraction}
                reads = defaultdict(set)
                for a, b in chain:
                    for k, v in analyse(fn, a, b, set(), 0, frozenset(), bind).items():
                        reads[k] |= v
                return reads
            record(f'{letter}{code}', run(-1))
            for fraction in sorted(run(None)['__fractions']):
                if fraction > 0 and not macro_fraction(fn, sw[0], code, fraction):
                    record(f'{letter}{code}.{fraction}', run(fraction))
        for code in sorted(fraction_codes(fn, sw[0])):
            if not any(c.startswith(f'{letter}{code}.') for c in commands) and commands.get(f'{letter}{code}'):
                # A command that reads no parameter (G59.1 selects a coordinate system) needs no entries.
                stats['unresolved'][f'{letter}{code} keeps fractions, but none is told apart'] += 1
for fn in functions.get('HandleTcode', ()):
    record('T', analyse(fn, 0, len(fn.body), set(), 0, frozenset(), {'__frac': -1}))

# ── Commands a single-board computer reads itself ───────────────────────────────────────


def sbc_commands():
    """The case labels of `switch (code.MajorNumber)` in DSF's code handlers (MCodes.Process,
    MCodeHandler.ProcessAsync since 3.7): commands
    DuetSoftwareFramework reads itself, with its own conversions, before (or instead of) the firmware."""
    out = []
    handlers = os.path.join(opts.dsf, 'src', 'DuetControlServer', 'Codes', 'Handlers')
    for letter in 'GMT':
        # MCodes.cs / Process before 3.7, MCodeHandler.cs / ProcessAsync since
        names = [f'{letter}Codes.cs', f'{letter}CodeHandler.cs']
        found = [os.path.join(handlers, n) for n in names if os.path.exists(os.path.join(handlers, n))]
        if not found:
            raise SystemExit(f'no {" or ".join(names)} in {handlers}')
        s = strip_comments(open(found[0], errors='replace').read())
        m = re.search(r'\b(?:Value)?Task<Message\?>\s+Process(?:Async)?\s*\([^)]*\)\s*\{', s)
        if not m:
            continue
        body = s[m.end() - 1:balanced(s, m.end() - 1, '{', '}')]
        sw = re.search(r'\bswitch\s*\(\s*code\.MajorNumber\s*\)\s*\{', body)
        if not sw:
            continue
        cases = body[sw.end():balanced(body, sw.end() - 1, '{', '}') - 1]
        out += [f'{letter}{n}' for n in sorted({int(x) for x in re.findall(r'\bcase\s+(\d+)\s*:', top_level(cases))})]
    return out

# ── Output ────────────────────────────────────────────────────────────────────────


def describe_checkout(path):
    """The tag of the checkout (a release tag before a pre-release one on the same commit)."""
    def git(*args):
        return subprocess.run(['git', '-C', path, *args], capture_output=True, text=True, check=True).stdout.split()
    try:
        tags = git('tag', '--points-at', 'HEAD')
        return min(tags, key=lambda t: ('-' in t, t)) if tags else git('describe', '--tags', '--always')[0]
    except (OSError, subprocess.CalledProcessError, IndexError):
        return os.path.basename(os.path.abspath(path))


def sort_key(cmd):
    m = re.match(r'([GMT])(\d*)(?:\.(\d+))?', cmd)
    return (m.group(1), int(m.group(2) or -1), int(m.group(3) or -1))


data = {
    '_meta': {
        'generator': 'scripts/gcode-params-gen.py',
        'firmware': 'RepRapFirmware ' + describe_checkout(opts.rrf),
        'canlib': 'CANlib ' + describe_checkout(opts.canlib),
        'sbc': 'DuetSoftwareFramework ' + describe_checkout(opts.dsf),
        'kinds': 'float, int, uint, bool, string, ip, mac, driver (n or board.n), any; [] is a colon-separated list; '
                 'the letter "axes" stands for every axis letter, "?" for any letter of the command',
    },
    'commands': {c: {l: '|'.join(sorted(ks)) for l, ks in sorted(commands[c].items())} for c in sorted(commands, key=sort_key)},
    'sbc': sbc_commands(),
}
with open(opts.out, 'w') as f:
    json.dump(data, f, indent=1)
    f.write('\n')

if opts.report:
    n_letters = sum(len(v) for v in data['commands'].values())
    empty = [c for c, v in data['commands'].items() if not v]
    print(f'commands {len(data["commands"])}, typed letters {n_letters}, calls followed {stats["calls followed"]}, '
          f'branches dropped {stats["branches dropped"]}, CAN tables {len(stats["can tables"])}')
    print(f'no parameter read ({len(empty)}):', ' '.join(empty))
    unknown = [f'{c} ({v["?"]})' for c, v in data['commands'].items() if '?' in v]
    print(f'reads of a letter that could not be told ({len(unknown)}):', ' '.join(unknown))
    print(f'read by DuetSoftwareFramework itself ({len(data["sbc"])}):', ' '.join(data['sbc']))
    print(f'unresolved ({sum(stats["unresolved"].values())}):')
    for k, n in sorted(stats['unresolved'].items()):
        print(f'  {k} ({n})')
    print('other GCodeBuffer calls:', ' '.join(f'{k}({n})' for k, n in sorted(stats['other gb calls'].items())))
