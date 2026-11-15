// Tiny helpers for table-driven diagnostic tests.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { lint, msgs, errorsOf, has, LintOptions } from './harness';

export interface Case {
  /** Source text (may be multi-line). */
  src: string;
  /** Label override. */
  name?: string;
  opts?: LintOptions;
  /** Mark as a known gap: runs, reports, does not fail the suite. */
  todo?: string;
}

const label = (c: Case) => c.name ?? JSON.stringify(c.src);

/** Every case must produce no error-severity diagnostics. */
export function expectClean(cases: Array<string | Case>): void {
  for (const raw of cases) {
    const c: Case = typeof raw === 'string' ? { src: raw } : raw;
    it(`clean: ${label(c)}`, c.todo ? { todo: c.todo } : {}, () => {
      const ds = errorsOf(lint(c.src, c.opts));
      assert.deepEqual(msgs(ds), [], `unexpected errors for ${JSON.stringify(c.src)}`);
    });
  }
}

/** Every case must produce NO diagnostics at all (errors, warnings, info). */
export function expectSilent(cases: Array<string | Case>): void {
  for (const raw of cases) {
    const c: Case = typeof raw === 'string' ? { src: raw } : raw;
    it(`silent: ${label(c)}`, c.todo ? { todo: c.todo } : {}, () => {
      assert.deepEqual(msgs(lint(c.src, c.opts)), []);
    });
  }
}

/** Every [source, pattern] must produce a diagnostic whose message matches. */
export function expectDiag(cases: Array<[string, RegExp | string] | (Case & { match: RegExp | string })>): void {
  for (const raw of cases) {
    const c = Array.isArray(raw) ? { src: raw[0], match: raw[1] } as Case & { match: RegExp | string } : raw;
    it(`reports: ${label(c)}`, c.todo ? { todo: c.todo } : {}, () => {
      const ds = lint(c.src, c.opts);
      assert.ok(has(ds, c.match), `expected /${c.match}/ for ${JSON.stringify(c.src)}, got ${JSON.stringify(msgs(ds))}`);
    });
  }
}
