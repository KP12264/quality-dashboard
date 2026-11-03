# Bridge Risk Report

The bridge (`emulator/firestore.rules.bridge`) = candidate + production's public blocks for `scrapLogs`, `targetMaster`, `improvements`, `scrapModelMappings`. It exists only so that pages still in sign-in "off" keep saving while the new site rolls out.

## 1. What is open during the bridge (tested)

| Risk | Result | Same as production today? |
|---|---|---|
| Anonymous create / update / delete on the 4 QD collections | accepted | yes |
| Leader 7-day window and field validation on `scrapLogs` | not enforced | yes |
| Writes around the ledger by old pages | possible | yes (today everything is "around") |
| Shift close, ledger, audit, public summary, import marker | **still enforced** | n/a (new) |

## 2. Detection (tested)

| Old page does… | Effect |
|---|---|
| saves into a **closed** shift | shift becomes **CONFLICT** (`ledger-count-mismatch`, `changed-outside-ledger`) — never counted silently; Dashboard shows CONFLICT, not WITHIN |
| saves into an open shift that already has a ledger slot | **CONFLICT** (count mismatch) |
| saves into a shift with no slot yet | counted as an old log when the slot is first written / by the baseline |
| edits a record of an open shift | an ordinary unattributed edit; the Leader confirms the current data when closing |

## 3. Clean-up after the bridge — `tools/ops/bridge-ops.js`

- `bridgeAudit(db, { from, to })` (read-only): every slot whose stored logs disagree with the ledger or with its close, import markers, logs without a slot.
- `reconcileSlot(db, slotId, reason, opts)` (Admin, **candidate rules only**): re-counts the slot from the logs stored; audited as event `v{n}` type `RECONCILE` with the full id list, fingerprint, previous count, reason and admin. The version moves, so a closed shift becomes **CHANGED** and the Leader must reconfirm. Forged reconciles (count ≠ listed ids, no reason, Leader) are refused.
- Rehearsal S4–S6: audit listed 2 slots → reconciled → reconfirmed → audit 0 problems. Also after a rollback (R): 1 slot → reconciled.

## 4. Bridge exit condition (measurable)

Publish the candidate (step 5) only when **all** hold:

1. Reload announcement sent and at least one full production day (Day + Night) has passed on the bridge.
2. `bridgeAudit` run twice, ≥ 1 production day apart: the second run shows **no new problem slot** compared with the first (i.e. no old page saved in between).
3. No `scrapLogs` created in that interval on slots without the ledger *after* the new site went live (shown by the audit as `withoutLedger` growing).
4. Problems from before are listed for reconcile in step 6.

Keep the bridge as short as possible (target: one production day).
