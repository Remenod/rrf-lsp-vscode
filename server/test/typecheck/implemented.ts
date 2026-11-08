// Rule IDs from SPEC.md that the implementation claims to satisfy. Their tests are hard failures;
// every other `rule(...)` test runs as `todo`. Entries may be exact IDs ('TC-ARITH-01') or area
// prefixes ending in '*' ('TC-ARITH-*'). Run `RRF_TC_STRICT=1 npm test` to see the full red list.

export const IMPLEMENTED: ReadonlySet<string> = new Set<string>([
  'TC-CFG-*', 'TC-DIAG-*', 'TC-TYPE-*', 'TC-LIT-*',
  'TC-ARITH-*', 'TC-CAT-*', 'TC-BOOL-*', 'TC-CMP-*', 'TC-EQ-*', 'TC-TERN-*', 'TC-PREC-*',
  'TC-UN-*',
  'TC-COND-*', 'TC-STMT-*', 'TC-GC-01', 'TC-GC-02',
  'TC-FN-*',
  'TC-ARR-*',
  'TC-FLOW-*', 'TC-SC-*',
  'TC-VER-*',
  'TC-GLB-*', 'TC-PRM-*', 'TC-OM-*',
  'TC-FP-*', 'TC-ROB-*',
]);
