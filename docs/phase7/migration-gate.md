# Migration Gate Report

Generated detail: [generated/migration-gate.md](generated/migration-gate.md) (`tests/rules/migration-gate.test.js`) and rehearsal S7.

## Is `baselineComplete` required before saving scrap? — **No (GO)**

- Before the baseline, a slot is created on its first ledger write and counts its old logs at that moment (tested: form save and Excel import before the baseline).
- The baseline only *adds* slots for old logs that have none yet; it skips any slot that exists (created by a Leader meanwhile).
- After `baselineComplete`, new slots must start at `legacyCount 0`, so no client can state an old-log count any more (tested: save and import after the baseline, into migrated and new slots).
- **There is no period in which saving is blocked.**

## Scenarios

| Scenario | Result |
|---|---|
| Save / Excel import before the baseline | PASS |
| Save / Excel import after the baseline | PASS |
| Migration while Leaders keep saving (incl. into a planned, not-yet-migrated slot) | PASS — re-run skips the slot the Leader created |
| Migration fails half-way (1 of 34 slots) | PASS — `completeIfClean` refuses; nothing marked complete |
| Migration re-run | PASS — idempotent (0 created) |
| Scrap totals before → after | PASS — exactly the old logs + the saves made meanwhile |
| Rehearsal S7 (after the bridge clean-up, concurrent save) | PASS |

## Fixes made in Phase 7

- `completeIfClean(db, plan, migrationId, opts, currentLogs)` — the gate. `baselineComplete` is set **only** when every planned slot exists and is consistent, and no log stored *now* lacks a slot. Otherwise it returns the problems and writes nothing.
- `verifyApplied` compared each slot with the planned quantity even after a Leader legitimately saved into it; it now does so only while the slot is untouched since the baseline (`logVersion 0`).

## Safe order

Baseline **after** the candidate is published (step 7): from then on nothing can write around the ledger, so the plan cannot go stale behind the gate's back. If the gate refuses: re-run `applyBaseline`, reconcile what the bridge audit lists, run the gate again. Never call `markComplete` directly.
