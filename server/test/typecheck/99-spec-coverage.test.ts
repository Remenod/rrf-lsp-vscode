// SPEC.md <-> tests: every rule has a test, and every rule a test cites exists.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SERVER_ROOT } from '../helpers/harness';

const DIR = path.join(SERVER_ROOT, 'test', 'typecheck');
const spec = fs.readFileSync(path.join(DIR, 'SPEC.md'), 'utf8');

/** `- \`TC-AREA-NN\` — …` */
const SPEC_RULES = new Set<string>();
for (const m of spec.matchAll(/^- `(TC-[A-Z]+-\d{2})` — /gm)) SPEC_RULES.add(m[1]);

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
    assert.deepEqual([...SPEC_RULES].filter(id => !TESTED.has(id)), []);
  });

  it('every rule cited by a test exists in SPEC.md', () => {
    assert.deepEqual([...TESTED.keys()].filter(id => !SPEC_RULES.has(id)), []);
  });

  it('rule IDs are unique', () => {
    const ids = [...spec.matchAll(/^- `(TC-[A-Z]+-\d{2})` — /gm)].map(m => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });
});
