# Public Data Access Matrix (candidate rules)

Who can read what without signing in, and what personal data it carries. Permission rows are verified by `tests/rules/pv2-compat.test.js` (see `docs/phase6/generated/compatibility-matrix.md`); content checks by the rehearsal (S8).

| Collection | Public read | Signed-in read | Contains personal data? |
|---|---|---|---|
| `scrapLogs` | ✓ | ✓ | **No e-mail** (Phase 7 fix). Existing fields that may identify people: `recordedBy` (employee code from Excel), free-text `remark` → **G4 decision** |
| `scrapCloseSummary` | ✓ | ✓ | no (version, counts, close state, fingerprint, time) — test-enforced |
| `targetMaster` | ✓ | ✓ | no e-mail (fix) |
| `improvements` | ✓ | ✓ | no e-mail (fix); action `owner` is a typed name → **G4 decision** |
| `scrapModelMappings` | ✓ | ✓ | no e-mail (fix) |
| `scrapWeeklyPlans` | ✓ (new) | ✓ | no e-mail (fix) |
| `scrapSlots` + `events` (who closed, notes, reasons, audit) | ✗ | active QD users | yes — not public |
| `qdUsers` | ✗ | admin; own record | yes — not public |
| `qdConfig` | ✗ | QD users | no |
| `prodV2_*`, `productionLogs` | ✓ (PV2 rules, unchanged) | ✓ | `prodV2_authorizedUsers` lists employee codes (PV2's decision, L2) |

## Phase 7 finding and fix — e-mails on public documents

With sign-in enforced, the Phase 2 adapters stamped the signed-in **e-mail** (`createdBy` / `updatedBy`) onto `scrapLogs`, `improvements`, `targetMaster`, `scrapModelMappings` and `scrapWeeklyPlans` — all publicly readable, so anyone could list who saved what.

Fixed in the candidate:
- adapters no longer stamp e-mails on public documents;
- rules refuse any write that **adds** `createdBy` / `updatedBy` to these collections (values already on old documents are left unchanged);
- accountability is kept where it is not public: scrap → audit event `by` (every version); close/reconfirm → `closedBy` + event `c{n}`; markers/baseline/reconcile → events.
- Trade-off: changes to targets, improvements, mappings and weekly plans are no longer attributed to a person (no public place to store it). An admin-only audit collection can be added later if needed.

## Query / CSV checks (rehearsal S8, all PASS)

- Anonymous query of every public collection: no `@prodv2.local` anywhere; `scrapSlots`, events, `qdUsers`, `qdConfig` refused.
- Public Dashboard text: no e-mail, employee code or close reason.
- Executive Report CSV (incl. Shift Close columns): no e-mail, code or reason (per-slot detail = status only).
