# Update 6 evidence: Q1 migration gate (commit 8959c3f)

Produced **locally**: Firebase Emulator (`demo-quality-dashboard`), synthetic data only. No Production access.

| File | What it is |
|---|---|
| `q1-gate-equivalence.test.js` | 17 scenarios: fresh synthetic legacy logs → plan → real `applyBaseline` → scenario change → OLD gate path vs NEW gate path on the same data; read counts on the gate step |
| `q1-gate-equivalence.json` | per scenario: old / new result, problems, extra checks, reads |
| `test-counts.txt` | unit 59/59, regression 15/15, rules 144/144, e2e + Q1 39/39 (one run, code = commit 8959c3f) |
| `e2e-results.txt` | e2e test lines (incl. ops-console "baseline: dry run, apply, gate → baselineComplete", rehearsal S7) |
| `test-run-summary.txt` | the run's own summary (generated docs rewritten by the tests were restored to HEAD) |

The equivalence test uses open rules on the local emulator because it checks gate logic, not rules; the rules
suites (144/144) and the e2e tests run with the project's rules files.
