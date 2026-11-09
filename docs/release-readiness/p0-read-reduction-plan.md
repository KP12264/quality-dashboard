# P0 read-reduction plan: Q1 (migration gate), Q2a / Q2b (`improvements`)

**Status: PLAN ONLY. No code has been changed.** Each item needs its own approval before any code change, and none of it is a Production change. A1 = HIGH, G2 = NOT APPROVED.

Context: [A1/A2 report](a1-a2-firestore-quota.md), Updates 2-3. All read figures below are **estimates** from code reading. Production document counts are not known yet (U3); the U3 count script is prepared but **not run** (§4).

Symbols: N_L = all `scrapLogs`; P = slots planned by the baseline; K = slots that already had a ledger when the plan was made ("skipped"); S = all `scrapSlots`; E = logs the plan excluded (not Door A/B/C × DAY/NIGHT with a valid date); I = `improvements` documents.

---

## Q1. Bridge migration gate (`js/ops-console.js`, `tools/migration/ledger-baseline.js`)

### What the code does today (facts)

| Step | Reads (estimate) | Code |
|---|---|---|
| Baseline dry run | N_L + S (whole `scrapLogs` and `scrapSlots`) | `ops-console.js:75-76` |
| Apply | about 2 per planned slot (slot + day summary in a transaction) | `ledger-baseline.js applyBaseline` |
| Gate: `verifyApplied` | P slot reads + the logs of every planned slot (about N_L) | `ledger-baseline.js verifyApplied` → `ShiftClose.loadSlot` |
| Gate: "nothing saved around the ledger" | **N_L again** (whole `scrapLogs`) + **S** (whole `scrapSlots`) | `ops-console.js:116`, `completeIfClean` |

One cycle ≈ 3 N_L + 4 P + S, mostly inside one hour. This is the largest new V5 read event.

What the current gate actually detects:
- G1: every planned slot exists, `liveLogCount` = stored logs, and (still `logVersion` 0) quantity and count equal the plan; no CONFLICT.
- G2: any log whose slot has **no** ledger slot (re-plan of all current logs against all existing slots).
- It does **not** compare `fingerprint` / log ids, so an edit that keeps the count and quantity (e.g. model or defect changed) inside a planned slot is not detected today.

### Why a timestamp-based shortcut is not safe

The earlier idea (only re-read logs with `createdAt` / `updatedAt` after the dry run) is **rejected**:
- Logs written by old pages, scripts, the Firebase console or the Admin SDK may have no `createdAt` / `updatedAt` (U3 will count how many logs lack `createdAt`).
- An edit that changes a log's date / line / shift but not the number of documents is invisible to a count and, without `updatedAt`, to a timestamp query.
- `createdAt` is the client's clock (`Date.now()`), not the server's.

### Proposed gate: count reconciliation, no timestamps, full re-read as fallback

Every log is in exactly one of: a planned slot, a slot that has a ledger (skipped at plan time or created by the ledger since), the plan's excluded list, or **anywhere else** (the case the gate must catch). The gate counts the first three exactly; the fourth is whatever is left of the total.

1. **Planned slots:** `verifyApplied` as today (reads each planned slot and its logs), **plus** for slots still at `logVersion` 0: the stored log ids and `fingerprint` (id, date, line, shift, model, defect, quantity) must equal the plan. The logs are already loaded, so this adds no reads. It catches edits that keep the count (model / defect / quantity changes, swaps between planned slots).
2. **Ledger slots:** read `scrapSlots` (S reads; S ≪ N_L). For every slot not in the plan (skipped or created since): `count()` of its logs (`date`, `line`, `shift` equality, the query `ShiftClose` already uses) must equal its `liveLogCount` (1 read each while < 1,000 logs). Optional and recommended: for these slots also compare the fingerprint, reading only their logs (logs of the bridge days, small).
3. **Excluded logs:** `get()` each id in the plan's excluded list (E reads). Each must still exist and still be excluded; one that became a valid slot is reported.
4. **Total:** `count()` of the whole `scrapLogs` collection (about ⌈N_L / 1000⌉ reads) must equal (stored logs of planned slots) + (counts of ledger slots) + (excluded logs still present).
5. **Any mismatch in 1-4, or any error:** do not set `baselineComplete`. Run the **current full check** (N_L + S) and report its findings. The shortcut can therefore only make the gate stricter, never looser.

Why nothing can slip through: a log in an unknown slot (new log, moved log, or an excluded log edited into a new slot) is counted by step 4 but by none of steps 1-3, so the total is larger than the sum. A log moved out of a known slot lowers that slot's count below its `liveLogCount` (steps 1-2). An excluded log that is edited or deleted is caught by step 3. Two counts cannot cancel each other, because every known log is counted exactly once and each slot count is also checked against its own `liveLogCount`. Concurrent writes during the gate make the numbers disagree, which leads to the fallback (fail-safe).

| Topic | Assessment |
|---|---|
| Reads saved per gate (estimate) | about N_L − (K + new ledger slots) − E − ⌈N_L/1000⌉ when the numbers agree; 0 when they do not (fallback = today's cost) |
| Cycle total (estimate) | from about 3 N_L + 4 P + S to about 2 N_L + 4 P + 2 S + K + E |
| Correctness | stricter than today (adds log-id / fingerprint checks); never accepts what today's gate would reject |
| Effect on other systems | Admin page only; not on `main`; PV2 does not use it. No Rules change: `scrapLogs` and `scrapSlots` are readable, and `count()` is a read. No new index: equality on `date`, `line`, `shift` is already used by `ShiftClose.loadSlot` |
| Must be verified first (emulator) | that `count()` is available in the Firestore **compat** SDK 10.13.0 used by QD (if not, a different call path is needed; that is a design decision, not assumed here) |

Tests required before any approval to merge (emulator only):
- existing: `tests/rules/migration-gate.test.js`, e2e rehearsal S7 must still pass unchanged;
- new: (a) a log added around the ledger into a planned slot; (b) a log added into a brand-new slot; (c) a log **without** `createdAt` / `updatedAt` added or edited; (d) a log moved between two planned slots with the total unchanged; (e) a swap of two logs between slots (counts unchanged); (f) a model / defect edit with count and quantity unchanged; (g) an excluded log edited into a valid slot; (h) an excluded log deleted while another log is added elsewhere (total unchanged); (i) a write during the gate (must fall back or fail, never pass); (j) the numbers agree: `baselineComplete` set and the full re-read **not** executed (read count measured).

Operational (no code): run the migration once, right after the quota reset (14:00 / 15:00 Thailand time), on a light day, and never repeat the dry run without need.

---

## Q2a. Dashboard improvement status counts (`js/dashboard.js:1292`)

Facts: `getImprovements(db, { limit: 200 })` reads the **whole** collection (`improvement-adapter.js:74`), sorts by `createdAt` in the browser, keeps the newest 200 and counts their statuses.

Proposal: query `orderBy('createdAt', 'desc').limit(200)` on the server; same normalisation and counting.

| Topic | Assessment |
|---|---|
| Reads saved | I − 200 per Dashboard open, **only when I > 200**; 0 today if I ≤ 200 (growth protection) |
| Correctness risk | Firestore leaves documents **without** `createdAt` out of an `orderBy` on it. Today they are kept (treated as oldest). New records always get `createdAt` (`improvement-adapter.js:118`); older ones may not. **Precondition:** U3 shows 0 improvements without `createdAt`; otherwise keep today's code |
| Alternative (business decision) | `count()` per status: about 1 read per status per 1,000 documents, but the meaning changes from "newest 200" to "all" |
| Effect | read only; `improvements` is `allow read: if true` in Production and candidate rules; single-field index is automatic; no effect on PV2 |
| Tests | I = 0, 1, 200, 201, 500; equal `createdAt` values; a record without `createdAt` (must be detected by the precondition check, not silently dropped) |

## Q2b. Improvement edit page (`js/improvement-page.js:120`)

Facts: opening `improvement.html?id=…` reads the whole collection to find one id.

Proposal: `doc(id).get()`, then the same `normalizeImprovement`; a missing id gives the same "not found" result as today.

| Topic | Assessment |
|---|---|
| Reads saved | I − 1 per edit-page open |
| Correctness | same record, same normalisation; tests: existing id, unknown id, malformed id, record with and without owners (owners stay in the separate `improvementOwners` read, unchanged) |
| Effect | `allow read` covers `get`; no effect on PV2 |

Not P0: the improvement list page (needs all records), Scrap Detail / Executive Report look-ups (per-group queries could cost more than one full read; decide after U3).

---

## 4. U3 document counts (prepared, NOT run)

Script `a1-u3-count.sh` v1 (SHA-256 `c6b5706ccf6bc969dc1562a83a109b0e8d50585f942194a1d5c3e2a59193a6c8`): Firestore v1 `runAggregationQuery` with `count()` only (an HTTP POST that returns numbers, never documents), fixed list of 11 queries on QD collections, `count.upTo` = 50,000 per query. Counts include "documents **with** `createdAt` / `updatedAt`" (an `orderBy` on the field), so the number **without** the field is total − with (needed by Q1 and Q2a). Personal-data and PV2 collections are not counted. The owner's OAuth token is not checked by Security Rules, hence the fixed list.

Estimated cost (documented rule: 1 read per up to 1,000 index entries, minimum 1 per query; to be checked on the pricing page): Σ ⌈n / 1000⌉ over the 11 queries. **Hard ceiling 550 reads** (11 × 50) because of `upTo`; for example, with 20,000 scrap logs and small other collections, about 70 reads (estimate). Run once, after the quota reset. Requires separate approval.

---

## Order and gates

1. U3 (approval) → confirms N_L, I and the `createdAt` coverage.
2. Emulator check of `count()` in the compat SDK.
3. Q2b, then Q2a (if the precondition holds), then Q1, each as its own approved code change with the tests above, on the V5 branch only.
4. Read budget tests (Q5) alongside.

Nothing here changes Production, Rules, Billing or PV2.
