# Compatibility Matrix — Summary

Full table: [generated/compatibility-matrix.md](generated/compatibility-matrix.md) (6 identities × 16 paths × 5 operations × 4 rule sets).
Real pages: [generated/transition-flows.md](generated/transition-flows.md).

## A. Permission matrix (candidate vs production)

| Area | Production | Candidate | Bridge |
|---|---|---|---|
| Production V2 read/write (allowlisted writer) | ✓ | ✓ same | ✓ same |
| PV2 by QD roles / anonymous | read only | read only (same) | same |
| Legacy `productionLogs` | public r/w | same | same |
| QD public read (`scrapLogs`, `targetMaster`, `improvements`, `scrapModelMappings`) | ✓ | ✓ | ✓ |
| QD public **write** (same 4) | ✓ anyone | **✗ closed** | ✓ (kept for transition) |
| `qdUsers` | ✗ | admin; own record get | same as candidate |
| `scrapSlots` / events / `qdConfig` read | ✗ | active QD users only (not public) | same |
| `scrapCloseSummary` | ✗ | public read; write with slot | same |
| `scrapWeeklyPlans` | ✗ | public read; admin write | same |
| Cross-system write / privilege escalation | — | none (tested) | none |

## B. Real pages (Emulator, `tests/e2e/rules-transition.e2e.test.js`)

| Rules | Old site (sign-in off — live today) | New site (sign-in on, Leader) |
|---|---|---|
| Production | form ✓, Excel import ✓, mapping ✓, Dashboard ✓ | **✗** cannot read role, save ✗, close ✗ |
| Bridge | ✓ all | ✓ save, ✓ close |
| Candidate | **✗** form / import / mapping refused ("Save failed", nothing lost silently); Dashboard ✓ | ✓ save, ✓ close |

Bridge risk (tested): an old page saving after a shift was closed → that slot shows **CONFLICT** (`ledger-count-mismatch`, `changed-outside-ledger`) — detected, not silently counted.

## C. Feature tests against the candidate (all pass)

| Area | Suite |
|---|---|
| Leader / Admin / Viewer, unauthorized access | `rules/rules.test.js`, `rules/pv2-compat.test.js`, `e2e/auth.e2e.test.js` |
| Scrap ledger, concurrent writes (15 at once, edit vs close) | `rules/ledger-load.test.js`, `rules/shift-close.test.js` |
| Shift close / reconfirm, server-time shift end, 7-day window | `rules/shift-close.test.js`, `rules/shift-time.test.js` |
| Excel import (real CSV, partial failure, marker) | `e2e/target-close.e2e.test.js`, `rules/shift-close.test.js` |
| Public summary integrity, no personal data | `rules/close-summary.test.js`, `e2e/target-close.e2e.test.js` |
| Public Dashboard, Executive Report, CSV | `e2e/target-close.e2e.test.js`, regression |
| QD off-mode (old behaviour) | `e2e/rules-transition.e2e.test.js` (+ off-mode regression) |
| Rules limits | `rules/budget.test.js` |

## D. Same suites against the bridge (`QD_RULES_FILE=emulator/firestore.rules.bridge`)

ledger-load + shift-close + close-summary + budget: 39/42. The 3 expected failures are what the bridge cannot enforce while public write stays open (exactly as production today): the Leader 7-day window for **scrap writes**, and field validation of `scrapLogs` (a row with qty −1 is accepted). Shift close window, ledger, mirror and audit stay enforced.
