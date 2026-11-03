# Production Operations Tools — Admin page "Operations" tab

`js/ops-console.js` (UI) + `tools/ops/bridge-ops.js` + `tools/migration/ledger-baseline.js` (the same code the emulator tests run).

## Safety design

| Layer | Effect |
|---|---|
| Runs in the browser as the signed-in **Admin** | every read/write goes through the Firestore Rules; **no service-account key** |
| Tab visible only with sign-in enforced **and** role admin | nothing on today's site (sign-in off) |
| **Read-only by default** | audit, post-candidate audit, reconcile dry run, baseline dry run, JSON report — tested: zero documents changed |
| Write lock 1: `QD_OPS_WRITE_ENABLED = false` in `js/config.js` | Apply buttons answer "Writes are locked" (emulator test mode may unlock with `?qdOpsWrite=1`, nothing else can) |
| Write lock 2: type `<projectId>/(default)` exactly | wrong project or database text refused (tested with the production project id while connected to the demo project) |
| Write lock 3: approval reference + reason | required |
| Audit trail | every write step adds an immutable `qdOpsLog` record (action, project, database, approval reference, reason, summary, admin, server time); admin-read only, no update/delete (rules-tested) |

## Steps available

| Step | Kind | Notes |
|---|---|---|
| Bridge audit (date range) | read | slots whose stored logs disagree with ledger/close, import markers, slots without a ledger |
| Post-candidate audit ("logs created since") | read | logs created after the candidate publish that no ledger event accounts for — must be **0** |
| Reconcile dry run → Apply reconcile | read → write | ticked slots; clears a stale import marker first; audited `RECONCILE` event; closed shift → CHANGED |
| Baseline dry run → Apply baseline → Run gate | read → write → write | gate sets `baselineComplete` only when clean (`completeIfClean`) |

## Cost (reads)

- Audit over N days: scrap logs of the range + slots of the range (+ events of affected slots for the post-candidate check).
- Baseline dry run: **every scrap log and every slot** once (e.g. 10,000 logs ≈ 10,000 reads). Run once, at the planned step.

## Not done in Phase 8

Nothing was run against production. `QD_OPS_WRITE_ENABLED` stays `false`. Turning it on is part of the go-live change, for the duration of steps 6–8 only (runbook), then back to `false`.
