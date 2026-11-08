// Rule IDs from SPEC.md that the implementation claims to satisfy. Their tests are hard failures;
// every other `rule(...)` test runs as `todo`. Entries may be exact IDs ('TC-ARITH-01') or area
// prefixes ending in '*' ('TC-ARITH-*'). Run `RRF_TC_STRICT=1 npm test` to see the full red list.

export const IMPLEMENTED: ReadonlySet<string> = new Set<string>([
  // e.g. 'TC-TYPE-*', 'TC-LIT-01',
]);
