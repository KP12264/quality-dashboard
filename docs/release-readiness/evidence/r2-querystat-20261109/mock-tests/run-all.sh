#!/bin/bash
# Runs every scenario; expected results are in results.txt.
D="$(cd "$(dirname "$0")" && pwd)"
for s in ok listpage notaunit notaunit_single notaunit_multi notaunit_nodescunit notaunit_sibling mixedunits coverage_gap qs_nodata ops_nodata all_nodata missing baddist readmismatch wrongrt execerr unreachable dup_conflict wrongkind noread listforeign listshape api403 html502 bad400 loop_token; do "$D/run-test.sh" "$s"; done
"$D/run-test.sh" ok_token_whitespace "ya""29.bad token" 2>/dev/null
"$D/run-test.sh" ok_argv_check "ya""29.FAKE-TEST-TOKEN_abc123" bin2
