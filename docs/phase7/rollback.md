# Rollback Verification (rehearsal stage R — all PASS)

| Rollback | How (production) | Rehearsal result |
|---|---|---|
| Candidate → **bridge** | re-publish `emulator/firestore.rules.bridge` | old tab saved again, new tab still saved; PV2 unaffected |
| → **production snapshot** (full undo of the rules) | re-publish `emulator/production.firestore.rules.snapshot` (hash-checked) | old tab saved; new site refused (exactly as before the rollout) |
| → **forward to candidate** again | re-publish candidate | new tab saved; **all scrap logs present** (count = before rollback + saves made meanwhile) |
| Clean-up after a rollback | `bridgeAudit` → `reconcileSlot` | the record the old tab saved during the rollback was found (1 slot) and reconciled → 0 problems |
| Production V2 during all publishes | — | 102 writes + 204 reads, **0 failures** |

Rules publishes in the rehearsal happened while pages were open (no reload): the new tab kept working across every change.

Notes:
- A site rollback to `QD_AUTH_MODE = "off"` must be paired with the bridge or the snapshot rules; under the candidate, "off" pages cannot save.
- Data created by the rollout (`scrapSlots`, events, `scrapCloseSummary`, `qdUsers`, `qdConfig`) needs no removal on rollback.
- After any rollback that let old pages save, run `bridgeAudit` + reconcile before moving forward again.
- Restoring from the export (R3) was not rehearsed (needs a real project); it is the last resort for data damage only.
