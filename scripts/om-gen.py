#!/usr/bin/env python3
"""Generate the object-model data the language server checks paths and types against.

    scripts/om-gen.py --rrf <RepRapFirmware checkout> [--dsf <DuetSoftwareFramework checkout>] --out <file.json>

Paths and leaf types come from the firmware's own objectModelTable / objectModelArrayTable
definitions; fields that only exist with a single-board computer come from the
DuetSoftwareFramework object model (properties marked [SbcProperty(false)]). Use matching
releases of both (e.g. RepRapFirmware 3.6.4 and DuetSoftwareFramework v3.6.4).

The C++ is read as text, without a compiler. Every #if branch is taken. A type is written only
when the code proves it: a cast, the (value, decimals) float constructor, a literal, or a
declared member / return type; everything else is `unknown`, which the checker never reports.
Fields whose table entry has a condition (OBJECT_MODEL_FUNC_IF) may also be null.
"""
import argparse
import json
import os
import re
import subprocess
from collections import defaultdict

ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
ap.add_argument('--rrf', required=True, help='RepRapFirmware checkout (the directory holding src/)')
ap.add_argument('--dsf', help='DuetSoftwareFramework checkout, for the fields only an SBC provides')
ap.add_argument('--out', required=True, help='output JSON file')
ap.add_argument('--report', action='store_true', help='print coverage and the rows the walk never reached')
opts = ap.parse_args()

files = {}
for d, _, fs in os.walk(os.path.join(opts.rrf, 'src')):
    for f in fs:
        if f.endswith(('.cpp', '.h')):
            p = os.path.join(d, f)
            src = open(p, errors='replace').read()
            # eCv annotations and exception specs are noise for the type index
            src = re.sub(r'\b_ecv_\w+\b', '', src)
            src = re.sub(r'\*\s*null\b', '*', src)                 # `RotaryEncoder *null encoder;`
            src = re.sub(r'\bTHROWS\s*\([^)]*\)', '', src)
            # contract annotations: noexcept pre(index < Max) { … }
            src = re.sub(r'\b(?:pre|post)\s*\((?:[^()]|\([^()]*\))*\)', '', src)
            files[p] = src


def strip_comments(s):
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    return re.sub(r'//[^\n]*', '', s)


def balanced(s, i, open_='(', close=')'):
    """Index just past the bracket matching s[i] == open_."""
    depth = 0
    in_str = None
    j = i
    while j < len(s):
        c = s[j]
        if in_str:
            if c == '\\':
                j += 2
                continue
            if c == in_str:
                in_str = None
        elif c in '"\'':
            in_str = c
        elif c == open_:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return len(s)


def split_args(s):
    out, depth, cur, in_str = [], 0, '', None
    for c in s:
        if in_str:
            cur += c
            if c == in_str:
                in_str = None
            continue
        if c in '"\'':
            in_str = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        if c == ',' and depth == 0:
            out.append(cur.strip())
            cur = ''
        else:
            cur += c
    if cur.strip():
        out.append(cur.strip())
    return out


# ── Declarations: method return types and member types, by name ──────────────

TYPE = r'(?:const\s+)?(?:unsigned\s+|signed\s+)?[A-Za-z_][\w:]*(?:\s*<[^;(){}]*?>)?(?:\s+const)?\s*[\*&]?'
method_types = defaultdict(set)
member_types = defaultdict(set)
for p, s in files.items():
    t = strip_comments(s)
    for m in re.finditer(r'(?m)^[ \t]*(?:(?:static|virtual|inline|constexpr|explicit|friend)\s+)*(' + TYPE + r')\s*(?:\w+::)?(\w+)\s*\([^;{)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?[;{]', t):
        rt, name = m.group(1).strip(), m.group(2)
        if rt in ('return', 'else', 'new', 'delete', 'case', 'auto') or name in ('if', 'while', 'for', 'switch', 'return', 'sizeof'):
            continue
        method_types[name].add(rt)
    for m in re.finditer(r'(?m)^[ \t]*(?:(?:static|mutable|volatile|const)\s+)*(' + TYPE + r')\s*(\w+)\s*(?:\[[^\]]*\])?\s*(?:=[^;]*)?;', t):
        rt, name = m.group(1).strip(), m.group(2)
        if rt in ('return', 'goto', 'delete', 'using', 'typedef', 'break', 'continue', 'auto', 'const auto', 'auto&', 'auto *', 'auto*', 'auto &', 'const auto&', 'const auto &'):
            continue
        member_types[name].add(rt)

class_members = defaultdict(lambda: defaultdict(set))   # class -> name -> member types
class_methods = defaultdict(lambda: defaultdict(set))   # class -> name -> return types
class_bases = defaultdict(list)
for p, s in files.items():
    if not p.endswith('.h'):
        continue
    t = strip_comments(s)
    for m in re.finditer(r'(?m)^[ \t]*(?:class|struct|namespace)\s+(\w+)\b([^;{()]*)\{', t):
        cls = m.group(1)
        heads = m.group(2)
        if 'INHERIT_OBJECT_MODEL' in heads:
            class_bases[cls].append('ObjectModel')
        if ':' in heads:
            class_bases[cls] += [b for b in re.findall(r'(?:public|protected|private)\s+(\w+)', heads)]
        end = balanced(t, m.end() - 1, '{', '}')
        body = t[m.end():end - 1]
        for d in re.finditer(r'(?m)^[ \t]*(?:(?:static|virtual|inline|constexpr|explicit|friend)\s+)*(' + TYPE + r')\s*(\w+)\s*\([^;{)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?[;{]', body):
            if d.group(1).strip() not in ('return', 'else', 'new', 'delete', 'case', 'auto'):
                class_methods[cls][d.group(2)].add(d.group(1).strip())
        for d in re.finditer(r'(?m)^[ \t]*(?:(?:static|mutable|volatile|const)\s+)*(' + TYPE + r')\s*(\w+)\s*((?:\[[^\]]*\])*)\s*(?:=[^;]*)?;', body):
            rt = d.group(1).strip()
            if rt not in ('return', 'goto', 'delete', 'using', 'typedef', 'break', 'continue', 'auto', 'friend'):
                class_members[cls][d.group(2)].add(rt + (' []' if d.group(3) else ''))
        # `float r25, beta, shC, seriesR;`
        for d in re.finditer(r'(?m)^[ \t]*(?:(?:static|mutable|volatile|const)\s+)*(' + TYPE + r')\s+(\w+(?:\s*\[[^\]]*\])?(?:\s*,\s*\w+(?:\s*\[[^\]]*\])?)+)\s*;', body):
            rt = d.group(1).strip()
            if rt in ('return', 'goto', 'delete', 'using', 'typedef', 'friend'):
                continue
            for nm in re.finditer(r'(\w+)\s*(\[[^\]]*\])?', d.group(2)):
                class_members[cls][nm.group(1)].add(rt + (' []' if nm.group(2) else ''))


def lineage(cls):
    out, todo = [], [cls]
    while todo:
        c = todo.pop(0)
        if c and c not in out:
            out.append(c)
            todo += class_bases.get(c, [])
    return out


def lookup(cls, name, call):
    table = class_methods if call else class_members
    for c in lineage(cls):
        if name in table.get(c, {}):
            return table[c][name]
    return set()


defines = {}
for p, s in files.items():
    for m in re.finditer(r'(?m)^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(.+?)[ \t]*(?://.*)?$', s):
        defines.setdefault(m.group(1), m.group(2).strip())


def define_kind(name, depth=0):
    v = defines.get(name)
    if v is None or depth > 5:
        return None
    if re.fullmatch(r'(?:"(?:[^"\\]|\\.)*"\s*|\w+\s*)+', v) and '"' in v:
        return 'string'
    if re.fullmatch(r'\w+', v):
        return define_kind(v, depth + 1)
    return None


# ── Object-model tables ───────────────────────────────────────────────────────

tables = {}      # class -> {section: [ (name, macro, args) ]}
arrays = {}      # class -> {index: [ [args of each ExpressionValue in the element lambda] ]}
parents = {}     # class -> parent class


def sections(body):
    """Yield (section, chunk) using the `// N.` comments; no comment means section 0."""
    marks = [(m.start(), int(m.group(1))) for m in re.finditer(r'(?m)^\s*//\s*(\d+)\.', body)]
    if not marks:
        yield 0, body
        return
    if marks[0][0] > 0:
        yield 0, body[:marks[0][0]]
    for k, (pos, n) in enumerate(marks):
        end = marks[k + 1][0] if k + 1 < len(marks) else len(body)
        yield n, body[pos:end]


for p, s in files.items():
    for m in re.finditer(r'DEFINE_GET_OBJECT_MODEL_TABLE_WITH_PARENT\(\s*(\w+)\s*,\s*(\w+)\s*\)', s):
        parents[m.group(1)] = m.group(2)
    for m in re.finditer(r'ObjectModelTableEntry\s+(\w+)::objectModelTable\[\]\s*=\s*\{', s):
        cls = m.group(1)
        close = re.compile(r'\n\};').search(s, m.end())
        body = s[m.end():close.start() if close else len(s)]
        secs = defaultdict(list)
        for n, chunk in sections(body):
            chunk = re.sub(r'(?m)^[ \t]*#.*$', '', chunk)          # every #if branch is kept
            starts = [r for r in re.finditer(r'\{\s*"(\w+)"\s*,', chunk)]
            for k, r in enumerate(starts):
                seg = chunk[r.end():starts[k + 1].start() if k + 1 < len(starts) else len(chunk)]
                for f in re.finditer(r'(OBJECT_MODEL_FUNC\w*)\s*\(', seg):
                    a = f.end() - 1
                    b = balanced(seg, a)
                    secs[n].append((r.group(1), f.group(1), split_args(strip_comments(seg[a + 1:b - 1]))))
        tables[cls] = secs
    for m in re.finditer(r'ObjectModelArrayTableEntry\s+(\w+)::objectModelArrayTable\[\]\s*=\s*\{', s):
        cls = m.group(1)
        close = re.compile(r'\n\};').search(s, m.end())
        body = s[m.end():close.start() if close else len(s)]
        entries = {}
        # Top-level groups, numbered by the last `// N.` comment before them.
        i, expect = 0, 0
        while True:
            j = body.find('{', i)
            if j < 0:
                break
            head = body[i:j]
            cm = re.findall(r'//\s*(\d+)\.', head)
            if cm:
                expect = int(cm[-1])
            k = balanced(body, j, '{', '}')
            grp = strip_comments(body[j:k])
            vals = []
            macro_vals = list(re.finditer(r'\bOBJECT_MODEL_ARRAY_VALUE\w*\s*\(', grp))     # 3.6 and later
            if macro_vals:
                for v in macro_vals:
                    a = v.end() - 1
                    inner = grp[a + 1:balanced(grp, a) - 1]
                    nested = list(re.finditer(r'\bExpressionValue\s*\(', inner))
                    if nested:
                        for w in nested:
                            b2 = w.end() - 1
                            vals.append(split_args(inner[b2 + 1:balanced(inner, b2) - 1]))
                    else:
                        vals.append(split_args(inner))
            else:
                # Every element lambda (#if/#else branches give several), not the count lambdas.
                pieces = grp.split('-> ExpressionValue')[1:] if '-> ExpressionValue' in grp else [grp]
                for elem in pieces:
                    elem = elem.split('-> size_t')[0]
                    local = {m2.group(2): m2.group(1) for m2 in re.finditer(r'((?:const\s+)?\w+\s*[&*])\s*(\w+)\s*=', elem)}
                    for v in re.finditer(r'\bExpressionValue\s*\(', elem):
                        a = v.end() - 1
                        args = split_args(elem[a + 1:balanced(elem, a) - 1])
                        if len(args) == 1 and re.fullmatch(r'&?\s*(\w+)', args[0]) and re.fullmatch(r'&?\s*(\w+)', args[0]).group(1) in local:
                            args = ['__type__:' + local[re.fullmatch(r'&?\s*(\w+)', args[0]).group(1)]]
                        vals.append(args)
            entries.setdefault(expect, []).extend(vals)
            expect += 1
            i = k
        arrays[cls] = entries

subclasses = defaultdict(set)
for c, par in parents.items():
    subclasses[par].add(c)
for c, bases in class_bases.items():
    for b in bases:
        if b != 'ObjectModel':
            subclasses[b].add(c)


def family(cls):
    """A class and every subclass with its own table (a base pointer may point to any of them)."""
    out, todo = [], [cls]
    while todo:
        c = todo.pop()
        if c in out:
            continue
        out.append(c)
        todo.extend(subclasses.get(c, ()))
    return out


def own_and_parents(cls):
    out = []
    while cls:
        out.append(cls)
        cls = parents.get(cls)
    return out


# ── Expression types ──────────────────────────────────────────────────────────

LEAF = {
    'int32_t': 'int', 'int': 'int', 'long': 'int',
    'uint32_t': 'uint', 'FilePosition': 'uint', 'unsigned': 'uint',
    'uint64_t': 'uint64',
    'float': 'float', 'double': 'float', 'bool': 'bool', 'char': 'char',
    'const char *': 'string', 'const char*': 'string', 'char *': 'string', 'const char': 'char', 'c_string': 'string',
    'DateTime': 'datetime', 'IPAddress': 'ip', 'MacAddress': 'mac', 'DriverId': 'driver',
}


def class_of(t):
    t = re.sub(r'\b(const|volatile)\b', '', t)
    t = t.replace('*', '').replace('&', '').strip()
    m = re.match(r'(?:\w+::)*ReadLockedPointer\s*<\s*(\w+)\s*>', t) or re.match(r'(?:\w+::)*(\w+)$', t)
    return m.group(1) if m else None


def unwrap_type(t, subscripted):
    t = norm_type(t)
    if subscripted and re.search(r'\[\]\s*$', t):
        t = re.sub(r'\s*\[\]\s*$', '', t)
    elif subscripted and t.endswith('*'):
        t = t[:-1].rstrip()                         # p[i] on a pointer: the pointed-to type
    m = re.match(r'^(?:const )?(?:\w+::)*ReadLockedPointer\s*<\s*(?:const )?(\w+)\s*>', t)
    return (m.group(1) + ' *') if m else t


table_file = {}
for p, s in files.items():
    for m in re.finditer(r'ObjectModelTableEntry\s+(\w+)::objectModelTable\[\]', s):
        table_file[m.group(1)] = p


def generic_om_return(name):
    """Class behind a function declared to return `ObjectModel *`, when its defining file has one table."""
    for p, s in files.items():
        if not p.endswith('.cpp'):
            continue
        if re.search(r'ObjectModel\s*\*\s*(?:\w+::)?' + re.escape(name) + r'\s*\([^;{)]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{', s):
            owners = [c for c, f in table_file.items() if f == p]
            return owners[0] if len(owners) == 1 else None
    return None


SEG = re.compile(r'\s*(->|\.)\s*(\w+)\s*')


def chain_type(expr, cls):
    """Type of `self->a->b(…).c[i]` style chains, resolving each step in its class."""
    e = expr.strip()
    while True:
        if e.startswith('(') and balanced(e, 0) == len(e):
            e = e[1:-1].strip()
        elif e.startswith('&'):
            e = e[1:].strip()
        else:
            break
    m = re.match(r'^\(\s*\(\s*const\s+(\w+)\s*\*\s*\)\s*self\s*\)', e) or re.match(r'^\(\s*const\s+(\w+)\s*\*\s*\)\s*self\b', e)
    if m:
        cur, rest = m.group(1), e[m.end():]
    elif re.match(r'^self\b', e):
        cur, rest = cls, e[4:]
    elif re.match(r'^reprap\b', e):
        cur, rest = 'RepRap', e[6:]
    else:
        m = re.match(r'^(\w+)::(\w+)', e)
        if not m:
            return None
        cur, rest = m.group(1), '.' + e[len(m.group(1)) + 2:]
    t = cur + ' *'
    pos = 0
    while pos < len(rest):
        m = SEG.match(rest, pos)
        if not m:
            return None
        name = m.group(2)
        pos = m.end()
        call = pos < len(rest) and rest[pos] == '('
        if call:
            pos = balanced(rest, pos)
        sub = False
        while pos < len(rest) and rest[pos] == '[':
            pos = balanced(rest, pos, '[', ']')
            sub = True
        if name == 'Ptr' and call:
            continue                                   # ReadLockedPointer<T>::Ptr() -> T*
        cands = lookup(cur, name, call)
        if len(cands) != 1:
            return None
        t = unwrap_type(next(iter(cands)), sub)
        if call and re.match(r'^(?:const )?ObjectModel \*$', t):
            g = generic_om_return(name)
            if g:
                t = g + ' *'
        nxt = class_of(t)
        cur = nxt if nxt else None
        if cur is None and pos < len(rest):
            return None
    return t


def type_of(expr, cls):
    """Static C++ type of an expression, from the declaration index (best effort)."""
    ct = chain_type(expr, cls)
    if ct:
        return ct
    e = expr.strip()
    while e.startswith('(') and balanced(e, 0) == len(e):
        e = e[1:-1].strip()
    e = re.sub(r'^&\s*', '', e)
    subscripted = False
    while e.endswith(']'):
        depth, j = 0, len(e) - 1
        while j >= 0:
            if e[j] == ']':
                depth += 1
            elif e[j] == '[':
                depth -= 1
                if depth == 0:
                    break
            j -= 1
        e = e[:j].rstrip()
        subscripted = True
    # Trailing .Ptr() of a locked pointer: the element class of the pointer.
    ptr = e.endswith('.Ptr()')
    if ptr:
        e = e[:-len('.Ptr()')]
    # Last member or call in a chain: a->b().c, f(g(h(x)))
    call = None
    if e.endswith(')'):
        depth, j = 0, len(e) - 1
        while j >= 0:
            if e[j] == ')':
                depth += 1
            elif e[j] == '(':
                depth -= 1
                if depth == 0:
                    break
            j -= 1
        call, e = e[j:], e[:j].rstrip()
    m = re.search(r'(\w+)\s*$', e)
    if not m:
        return None
    name = m.group(1)
    if name == 'self':
        return cls + ' *'
    cands = method_types.get(name, set()) if call else member_types.get(name, set())
    if not cands and call is None:
        cands = method_types.get(name, set())
    if len(cands) != 1:
        kinds = {leaf_of_ctype(c) if not isinstance(leaf_of_ctype(c), tuple) else ('object', class_of(c)) for c in cands}
        if len(kinds) == 1 and cands:
            return next(iter(cands))
        return None
    t = next(iter(cands))
    if subscripted:
        if re.search(r'\[[^\]]*\]\s*$', t):
            t = re.sub(r'\s*\[[^\]]*\]\s*$', '', t)  # element of an array member
        elif norm_type(t).endswith('*'):
            t = norm_type(t)[:-1].rstrip()            # p[i] on a pointer
    if ptr:
        inner = re.search(r'<\s*(\w+)\s*>', t)
        return (inner.group(1) + ' *') if inner else t
    return t


def norm_type(t):
    t = re.sub(r'\s*\*\s*', ' *', t)
    t = re.sub(r'\s*&\s*', ' &', t)
    return re.sub(r'\s+', ' ', t).strip()


def leaf_of_ctype(t):
    t0 = norm_type(t)
    if t0 in LEAF:
        return LEAF[t0]
    base = re.sub(r'\b(const|volatile)\b', '', t0).replace('&', '').strip()
    if base in LEAF:
        return LEAF[base]
    if re.search(r'Bitmap', base):
        return 'bitmap'
    if re.match(r'^(u?int(8|16)_t|size_t|unsigned int|uint8_t|uint16_t)$', base):
        return 'int?'      # would not compile without a cast; flag it
    if base.endswith('char *'):
        return 'string'
    c = class_of(t0)
    if c in tables or any(x in tables for x in family(c or '')):
        return ('object', c, 0)
    return None


def strip_parens(e):
    e = e.strip()
    while e.startswith('(') and balanced(e, 0) == len(e):
        e = e[1:-1].strip()
    return e


def top_level(e):
    """Yield (index, char) of characters outside brackets and string/char literals."""
    depth, q, i = 0, None, 0
    while i < len(e):
        c = e[i]
        if q:
            if c == '\\':
                i += 2
                continue
            if c == q:
                q = None
        elif c in '"\'':
            q = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif depth == 0:
            yield i, c
        i += 1


def split_ternary(e):
    pos = [i for i, c in top_level(e) if c in '?:']
    q = next((i for i in pos if e[i] == '?'), None)
    if q is None:
        return None
    depth = 0
    for i in pos:
        if i <= q:
            continue
        if e[i] == '?':
            depth += 1
        elif e[i] == ':' and not (i + 1 < len(e) and e[i + 1] == ':') and not (i > 0 and e[i - 1] == ':'):
            if depth == 0:
                return e[:q], e[q + 1:i], e[i + 1:]
            depth -= 1
    return None


COMPARE = re.compile(r'\|\||&&|==|!=|<=|>=')


def has_top_compare(e):
    """A comparison or logical operator outside brackets: the value is a bool."""
    idx = {i for i, _ in top_level(e)}
    flat = ''.join(e[i] if i in idx else ' ' for i in range(len(e)))
    flat = flat.replace('->', '  ').replace('<<', '  ').replace('>>', '  ')
    if COMPARE.search(flat):
        return True
    # lone < or > outside templates: require spaces around them
    return bool(re.search(r'\s[<>]\s', flat))


def split_arith(e):
    """Operands of top-level binary + - * / %, or None."""
    idx = [i for i, c in top_level(e) if c in '+-*/%']
    parts, last = [], 0
    for i in idx:
        prev = e[:i].rstrip()
        if not prev or prev[-1] in '(+-*/%,?:!=<>&|' or e[i:i + 2] in ('->', '--', '++') or (i > 0 and e[i - 1] == '-' and e[i] == '>'):
            continue                                       # unary sign, pointer arrow
        if e[i] == '-' and i + 1 < len(e) and e[i + 1] == '>':
            continue
        if e[i] == '*' and re.search(r'(const\s+\w+|\w+_t|char|float|int)\s*$', prev):
            continue                                       # a pointer type in a cast
        parts.append(e[last:i])
        last = i + 1
    if not parts:
        return None
    parts.append(e[last:])
    return [p for p in (x.strip() for x in parts) if p]


CASTS = {'int32_t': 'int', 'int': 'int', 'long': 'int', 'uint32_t': 'uint', 'FilePosition': 'uint',
         'unsigned': 'uint', 'float': 'float', 'bool': 'bool', 'char': 'char'}


def expr_kinds(e, cls, depth=0):
    """Kinds of a C++ expression passed to ExpressionValue(): a set of leaf kinds, or an object tuple."""
    e = strip_parens(e)
    if depth > 8 or not e:
        return {'unknown'}
    if e.startswith('__type__:'):
        k = leaf_of_ctype(e[len('__type__:'):])
        return k if isinstance(k, tuple) else {k or 'unknown'}
    t3 = split_ternary(e)
    if t3:
        out = set()
        for branch in t3[1:]:
            k = expr_kinds(branch, cls, depth + 1)
            out |= k if isinstance(k, set) else {'object'}
        return out
    if has_top_compare(e) or re.match(r'^!(?!=)', e):
        return {'bool'}
    parts = split_arith(e)
    if parts and len(parts) > 1:
        ks = [expr_kinds(x, cls, depth + 1) for x in parts]
        flat = set().union(*[k if isinstance(k, set) else {'unknown'} for k in ks])
        if 'float' in flat:
            return {'float'}
        if flat <= {'int', 'uint', 'int?'}:
            return {'uint'} if 'uint' in flat else {'int'}
        return {'unknown'}
    m = re.match(r'^\(\s*(?:const\s+)?(\w+)\s*\)\s*(.+)$', e, re.S)
    if m and m.group(1) in CASTS:
        return {CASTS[m.group(1)]}
    if m and re.fullmatch(r'u?int\d+_t|size_t|double|uint64_t|int64_t', m.group(1)):
        k = leaf_of_ctype(m.group(1))
        return {k if isinstance(k, str) else 'unknown'}
    if re.fullmatch(r'-?\d+\.\d*(?:e[-+]?\d+)?f?|-?\d+f', e):
        return {'float'}
    if re.fullmatch(r'-?(?:0x[0-9a-fA-F]+|\d+)[uUlL]*', e):
        return {'int?'}
    if e in ('true', 'false'):
        return {'bool'}
    if e == 'nullptr':
        return {'null'}
    if e.startswith('"') or re.search(r'\.c_str\(\)$|\bToString\(\)$', e):
        return {'string'}
    if re.match(r'^DateTime\s*\(', e):
        return {'datetime'}
    if re.match(r'^(lrintf|lrint|lround|lroundf)\s*\(', e):
        return {'int'}
    if re.fullmatch(r'[A-Z][A-Z0-9_]+', e) and define_kind(e):
        return {define_kind(e)}
    h = re.match(r'^(\w+)\s*\((.*)\)$', e, re.S)
    if h and any('ExpressionValue' in t for t in method_types.get(h.group(1), ())):
        inner = split_args(h.group(2))
        k = classify(inner[:1], cls, 'ELEM') if inner else 'unknown'
        return (k if isinstance(k, tuple) else set(k.split('|')))
    w = re.match(r'^ExpressionValue\s*\((.*)\)$', e, re.S)
    if w:
        k = classify(split_args(w.group(1)), cls, 'ELEM')
        return k if isinstance(k, tuple) else set(k.split('|'))
    t = type_of(e, cls)
    if t:
        k = leaf_of_ctype(t)
        if isinstance(k, tuple):
            return k
        if k is not None:
            return {k}
    return {'unknown'}


def classify(args, cls, macro):
    """What ExpressionValue(args...) produces: 'kind|kind', ('object', class, section) or ('array', class, n)."""
    nullable = '_IF' in macro
    if 'ARRAY' in macro:
        n = int(args[-1]) if args and args[-1].isdigit() else None
        return ('array', cls, n, nullable)
    if nullable:
        args = args[1:]
    if not args:
        return 'unknown'
    k = classify_args(args, cls)
    if nullable:
        if isinstance(k, tuple):
            return k[:3] + (True,)
        return '|'.join(sorted(set(k.split('|')) | {'null'}))
    return k


def classify_args(args, cls):
    if len(args) == 3 and args[2] == 'true':
        oc = cls if re.match(r'^(self|arg|\(const \w+\s*\*\)\s*self)$', args[0]) else class_of(type_of(args[0], cls) or '')
        lead = re.match(r'\s*(\d+)', args[1])     # `20 | (index << 8)`: the low byte is the array number
        return ('array', oc, int(lead.group(1)), False) if lead else 'unknown'
    if len(args) == 2 and 'SpecialType' in args[0]:
        return 'special'
    if len(args) == 2 and re.fullmatch(r'\d+', args[1]):
        a0 = args[0]
        if re.fullmatch(r'self|\(\s*const\s+\w+\s*\*\s*\)\s*self|\(\(const \w+\s*\*\)self\)', a0):
            return ('object', cls, int(args[1]), False)
        t = type_of(a0, cls)
        k = leaf_of_ctype(t) if t else None
        if isinstance(k, tuple):
            return ('object', k[1], int(args[1]), False)
        # (pointer, table) is an object we cannot place; (value, decimals) converts the value to float.
        if strip_parens(a0).startswith('&') or (t and '*' in t):
            return 'unknown'
        if k in ('float', 'int', 'uint', 'bool', 'char', 'int?'):
            return 'float'
        ek = expr_kinds(a0, cls)
        if isinstance(ek, set) and ek and ek <= {'float', 'int', 'uint', 'int?'}:
            return 'float'
        return 'unknown'
    if len(args) != 1:
        return 'unknown'
    k = expr_kinds(args[0], cls)
    if isinstance(k, tuple):
        return k if len(k) == 4 else k + (False,)
    return '|'.join(sorted(k))


# ── Walk from the root ────────────────────────────────────────────────────────

paths = {}     # path -> set of kinds
unresolved = []


reached = set()     # (class, section, name) rows the walk visited


def emit(path, kind):
    ks = paths.setdefault(path, set())
    if isinstance(kind, str):
        ks.update(kind.split('|'))
    else:
        ks.add(kind[0])
        if len(kind) > 3 and kind[3]:
            ks.add('null')


def has_table(c):
    return any(x in tables for x in family(c or ''))


def walk_object(cls, sec, prefix, depth, seen):
    if depth > 12:
        return
    for c in (family(cls) if sec == 0 else [cls]):
        for owner in own_and_parents(c):
            s = sec if owner == c else 0
            for name, macro, args in tables.get(owner, {}).get(s, []):
                reached.add((owner, s, name))
                k = classify(args, owner, macro)
                path = prefix + name
                if isinstance(k, tuple) and k[0] == 'object':
                    emit(path, k)
                    key = (k[1], k[2], path)
                    if has_table(k[1]) and key not in seen:
                        walk_object(k[1], k[2], path + '.', depth + 1, seen | {key})
                    elif not has_table(k[1]):
                        unresolved.append((path, owner, args))
                elif isinstance(k, tuple) and k[0] == 'array':
                    emit(path, k)
                    walk_array(k[1], k[2], path, depth + 1, seen)
                else:
                    emit(path, k)
            if s != 0:
                break


def walk_array(cls, n, path, depth, seen):
    # Array numbers continue across the class hierarchy: look in the class, then its parents.
    elems, owner = None, cls
    for c in own_and_parents(cls):
        if n in arrays.get(c, {}):
            elems, owner = arrays[c][n], c
            break
    cls = owner
    if not elems:
        emit(path + '[]', 'unknown')
        unresolved.append((path + '[]', cls, ['array', n]))
        return
    for args in elems:
        k = classify(args, cls, 'ELEM')
        if isinstance(k, tuple) and k[0] == 'object':
            emit(path + '[]', k)
            if has_table(k[1]):
                walk_object(k[1], k[2], path + '[].', depth + 1, seen)
            else:
                unresolved.append((path + '[]', cls, args))
        elif isinstance(k, tuple) and k[0] == 'array':
            emit(path + '[]', k)
            walk_array(k[1], k[2], path + '[]', depth + 1, seen)
        else:
            emit(path + '[]', k)


def camel(name):
    """System.Text.Json camelCase: lower the leading capitals (SBC -> sbc, IPAddress -> ipAddress)."""
    i = 0
    while i < len(name) and name[i].isupper():
        i += 1
    if i == 0:
        return name
    if i == len(name) or i == 1:
        return name[:i].lower() + name[i:]
    return name[:i - 1].lower() + name[i - 1:]


dsf_classes = {}      # name -> list of (prop, cs type, sbc_only)
dsf_enums = set()


def read_dsf(root):
    """Classes of the DSF object model: their JSON property names, C# types and SBC-only marks."""
    for d, _, fs in os.walk(root):
        for f in fs:
            if not f.endswith('.cs'):
                continue
            s = open(os.path.join(d, f), encoding='utf-8-sig', errors='replace').read()
            s = re.sub(r'(?m)^\s*///.*$', '', s)
            for m in re.finditer(r'\benum\s+(\w+)', s):
                dsf_enums.add(m.group(1))
            for m in re.finditer(r'\b(?:partial\s+)?class\s+(\w+)', s):
                cls = m.group(1)
                start = s.find('{', m.end())
                depth, i = 0, start
                while i < len(s):
                    if s[i] == '{':
                        depth += 1
                    elif s[i] == '}':
                        depth -= 1
                        if depth == 0:
                            break
                    i += 1
                body = s[start + 1:i]
                props = dsf_classes.setdefault(cls, [])
                for p in re.finditer(r'((?:\[[^\]]*\]\s*)*)public\s+(?!static|const|override|event)([\w<>\[\]?,\. ]+?)\s+(\w+)\s*(?:\{|=>)', body):
                    attrs, cs, name = p.group(1), p.group(2).strip(), p.group(3)
                    if name in ('get', 'set') or cs in ('class', 'void') or 'JsonIgnore' in attrs:
                        continue
                    jn = re.search(r'JsonPropertyName\("([^"]+)"\)', attrs)
                    props.append((jn.group(1) if jn else camel(name), cs, 'SbcProperty(false)' in attrs))


INT = {'int', 'long', 'uint', 'ulong', 'short', 'ushort', 'byte', 'sbyte'}
FLOAT = {'float', 'double', 'decimal'}
COLL = re.compile(r'^(?:\w+\.)*(?:ObservableCollection|StaticModelCollection|ModelCollection|List|IList|MessageCollection|ModelGrowingCollection|ObservableSet)<(.+)>$')

dsf_paths = {}


def cs_kind(cs):
    cs = cs.strip()
    nullable = cs.endswith('?')
    base = cs.rstrip('?').strip()
    if base in INT:
        return 'int', nullable
    if base in FLOAT:
        return 'float', nullable
    if base == 'bool':
        return 'bool', nullable
    if base in ('string', 'char'):
        return 'string', nullable
    if base in ('DateTime', 'DateTimeOffset', 'TimeSpan'):
        return 'datetime', nullable
    if base in dsf_enums:
        return 'enum', nullable
    if base.endswith('[]') or COLL.match(base):
        return 'array', nullable
    if base in dsf_classes:
        return 'object', nullable
    return 'other:' + base, nullable


def dsf_walk(cls, prefix, sbc, depth):
    if depth > 10:
        return
    for name, cs, own_sbc in dsf_classes.get(cls, []):
        path = prefix + name
        k, nullable = cs_kind(cs)
        flag = sbc or own_sbc
        dsf_paths[path] = {'t': k + ('|null' if nullable else ''), 'cs': cs, 'sbc': flag}
        base = cs.rstrip('?').strip()
        if k == 'object':
            dsf_walk(base, path + '.', flag, depth + 1)
        elif k == 'array':
            m = COLL.match(base)
            elem = (m.group(1) if m else base[:-2]).rstrip('?').strip()
            ek, en = cs_kind(elem)
            dsf_paths[path + '[]'] = {'t': ek + ('|null' if en or elem != (m.group(1) if m else base[:-2]).strip() else ''), 'cs': elem, 'sbc': flag}
            if ek == 'object':
                dsf_walk(elem, path + '[].', flag, depth + 1)


walk_object('RepRap', 0, '', 0, frozenset())

# ── Output ──────────────────────────────────────────────────────────────────────

# Kinds the checker understands; anything else (uint64, IP and MAC addresses, driver IDs, ports,
# special values) is `unknown`.
KNOWN = {'int', 'uint', 'float', 'bool', 'string', 'char', 'datetime', 'object', 'array', 'bitmap', 'null'}


def norm(kinds):
    ks = {k if k in KNOWN else 'unknown' for k in kinds}
    if 'unknown' in ks:
        return 'unknown' + ('|null' if 'null' in ks else '')
    return '|'.join(sorted(ks))


def describe_checkout(path):
    try:
        out = subprocess.run(['git', '-C', path, 'describe', '--tags', '--always'], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return os.path.basename(os.path.abspath(path))


data = {
    '_meta': {
        'generator': 'scripts/om-gen.py',
        'firmware': 'RepRapFirmware ' + describe_checkout(opts.rrf),
    },
    'paths': {p: norm(k) for p, k in sorted(paths.items())},
}

if opts.dsf:
    DSF_ROOT = os.path.join(opts.dsf, 'src', 'DuetAPI', 'ObjectModel')
    read_dsf(DSF_ROOT)
    dsf_walk('ObjectModel', '', False, 0)
    CS = {'int': 'int', 'float': 'float', 'bool': 'bool', 'string': 'string', 'enum': 'string', 'array': 'array', 'object': 'object'}
    sbc = {}
    for p, v in sorted(dsf_paths.items()):
        if not v['sbc'] or p in data['paths']:
            continue
        ks = v['t'].split('|')
        sbc[p] = norm({CS.get(k, 'unknown') if k != 'null' else 'null' for k in ks})
    data['_meta']['sbc'] = 'DuetSoftwareFramework ' + describe_checkout(opts.dsf)
    data['sbc'] = sbc

with open(opts.out, 'w') as f:
    json.dump(data, f, indent=1, sort_keys=False)
    f.write('\n')

if opts.report:
    allrows = {(c, sec, r[0]) for c, secs in tables.items() for sec, rows in secs.items() for r in rows}
    missed = sorted(allrows - reached)
    print(f'tables {len(tables)}, rows {len(allrows)}, not reached {len(missed)}, paths {len(paths)}, '
          f'objects without a table {len(unresolved)}, sbc {len(data.get("sbc", {}))}')
    for m in missed:
        print('  not reached:', m)
