// SPEC.md <-> tests: every rule has a test, every test cites a rule, implemented.ts cites real rules.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SERVER_ROOT } from '../helpers/harness';
import { IMPLEMENTED } from './implemented';

const DIR = path.join(SERVER_ROOT, 'test', 'typecheck');
const spec = fs.readFileSync(path.join(DIR, 'SPEC.md'), 'utf8');

/** `- \`TC-AREA-NN\` **TIER** — …` */
const SPEC_RULES = new Map<string, string>();
for (const m of spec.matchAll(/^- `(TC-[A-Z]+-\d{2})` \*\*([A-Z0-9 ]+)\*\*/gm)) SPEC_RULES.set(m[1], m[2]);

const TESTED = new Map<string, number>();
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.test.ts'))) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  for (const m of text.matchAll(/\b(?:rule|guard)\(\s*'(TC-[A-Z]+-\d{2})'/g)) TESTED.set(m[1], (TESTED.get(m[1]) ?? 0) + 1);
  // Generated tests reference rule IDs through tables.
  for (const m of text.matchAll(/'(TC-[A-Z]+-\d{2})'/g)) if (!TESTED.has(m[1])) TESTED.set(m[1], 1);
}

describe('spec coverage', () => {
  it('SPEC.md defines rules', () => assert.ok(SPEC_RULES.size > 60, `${SPEC_RULES.size} rules`));

  it('every rule in SPEC.md has at least one test', () => {
    assert.deepEqual([...SPEC_RULES.keys()].filter(id => !TESTED.has(id)), []);
  });

  it('every rule cited by a test exists in SPEC.md', () => {
    assert.deepEqual([...TESTED.keys()].filter(id => !SPEC_RULES.has(id)), []);
  });

  it('implemented.ts only lists real rules or real area prefixes', () => {
    const bad = [...IMPLEMENTED].filter(p => p.endsWith('*')
      ? ![...SPEC_RULES.keys()].some(id => id.startsWith(p.slice(0, -1)))
      : !SPEC_RULES.has(p));
    assert.deepEqual(bad, []);
  });

  it('rule tiers are known', () => {
    const tiers = new Set(SPEC_RULES.values());
    for (const t of tiers) assert.ok(['MUST', 'SHOULD', 'PHASE 2'].includes(t), t);
  });

  it('summary', () => {
    const byTier: Record<string, number> = {};
    for (const t of SPEC_RULES.values()) byTier[t] = (byTier[t] ?? 0) + 1;
    const implemented = [...SPEC_RULES.keys()].filter(id => [...IMPLEMENTED].some(p => p === id || (p.endsWith('*') && id.startsWith(p.slice(0, -1)))));
    // Visible in the test output: how far the implementation has come.
    console.log(`type-check spec: ${SPEC_RULES.size} rules (${Object.entries(byTier).map(([k, v]) => `${v} ${k}`).join(', ')}), ${implemented.length} implemented`);
  });
});
