# Production Rules — Analysis & Diff

Source: `emulator/production.firestore.rules.snapshot` (Console copy; database/publish time UNCONFIRMED).

## 1. Every match pattern

| # | Match | read | create / update / delete | Notes |
|---|---|---|---|---|
| 1 | `/productionLogs/{doc}` | anyone | **anyone** | Legacy system, intentionally open ("forever"). Not changed by the candidate. |
| 2 | `/prodV2_authorizedUsers/{email}` | anyone | nobody (Console only) | Public read exposes the employee-code list (PV2 decision; not changed). |
| 3 | `/{collection}/{doc}` | `prodV2_*` only | `prodV2_*` except the allowlist, signed in + email in `prodV2_authorizedUsers` | Matches only top-level docs: `prodV2_*/x/sub/y` is NOT matched (default deny) even though the comment says subcollections are covered. |
| 4 | `/scrapLogs/{doc}` | anyone | **anyone** | Quality Dashboard (sign-in off). |
| 5 | `/targetMaster/{doc}` | anyone | **anyone** | QD |
| 6 | `/improvements/{doc}` | anyone | **anyone** | QD |
| 7 | `/scrapModelMappings/{doc}` | anyone | **anyone** | QD |
| 8 | `/{document=**}` | nobody | nobody | default deny |

Collections the code uses but production does **not** allow: `scrapWeeklyPlans` (Plan Tracking / Weekly Review: plan overrides cannot be read or saved today — the page shows "Weekly plan overrides could not be read"), and the Shift Close collections `qdUsers`, `scrapSlots` (+ events), `scrapCloseSummary`, `qdConfig` (not in use yet).

## 2. Public-write exposure today (any visitor, no sign-in)

| Collection | Possible today | Impact |
|---|---|---|
| `scrapLogs` | add / change / delete any scrap record | Dashboard, Target, Executive Report figures can be altered or wiped |
| `targetMaster` | change targets (pre-Oct-2026 rule) | Target status of past dates can be changed |
| `improvements` | add / change / delete | |
| `scrapModelMappings` | change Excel → model mapping | Wrong models on future imports |
| `productionLogs` | (legacy, unchanged by design) | out of QD scope — PV2 owner's decision |

Confirmed in the emulator: `tests/rules/pv2-compat.test.js` → "production today: the four QD collections are writable by ANYONE".

## 3. Impact on Production V2

The PV2 + legacy part (lines 28–59) is **character-for-character identical** to `production-v2/firestore.rules @ 431836a` and to the PV2 block of the Phase 5 draft. The candidate keeps it unchanged (test-enforced), and the compatibility matrix shows identical behaviour for every PV2/legacy path, identity and operation in all four rule sets.

## 4. Diff: production snapshot → Phase 5 draft / candidate

| Area | Production | Candidate | Change |
|---|---|---|---|
| PV2 + legacy (lines 28–59) | — | identical | none |
| `scrapLogs` | public read/write | public read; write only through the ledger by signed-in QD admin/leader (own Line/Shift, 7-day window), validated | **public write closed** |
| `targetMaster`, `improvements`, `scrapModelMappings` | public read/write | public read; write QD admin only | **public write closed** |
| `scrapWeeklyPlans` | denied | public read; write QD admin | **opened** (needed by Plan Tracking / Weekly Review) — approve (G4) |
| `qdUsers` | denied | get: admin / own record; list + write: admin | opened (new) |
| `scrapSlots` + `events` | denied | read: active QD users; write: ledger / close / marker / baseline rules | opened (new, not public) |
| `scrapCloseSummary` | denied | public read; write only together with its slot | opened (new, no personal data) — approve (G4) |
| `qdConfig/ledger` | denied | read QD users; write admin | opened (new) |
| default deny | yes | yes | none |

Totals (generated matrix): 63 permissions closed (all = public/non-role writes to the 4 QD collections), 51 opened (all on the 5 new/QD collections above), 0 changes on PV2/legacy. Phase 5 draft vs candidate: only the header comment changed — the Phase 5 PV2 block was already identical to production.

Note: the snapshot's own Phase-5-era comment ("PIN/employee-login for this app is a planned later phase") confirms the QD public-write block is temporary by design.
