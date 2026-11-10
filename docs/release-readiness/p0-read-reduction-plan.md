# P0 read-reduction plan: Q1 (migration gate), Q2a / Q2b (`improvements`)

> **Revision 4, 2026-11-10:** O1 readiness checklist after the emulator test (evidence `1cacb24`: 13 / 13 and pv2-compat 7 / 7) and the owner index check (no exemption). **O1 code change NOT APPROVED.** See "Revision 4" at the end.
>
> **Revision 3, 2026-11-10:** optimization plan O1–O10 for QD and PV2, ranked by read risk, from the static analysis in the A1/A2 report, Update 12. **Plan only: no code changed, no tests run.** See "Revision 3" at the end.
>
> **Revision 2, 2026-11-09:** Q1 (redesigned gate) is implemented and committed (`8959c3f`, branch only; old path kept as fallback; emulator gate reads 364 → 184). See the A1/A2 report, Update 6.
>
> **Revision 1, 2026-11-09:** Q2b is implemented and committed (`f6f83fd`, branch only; not merged or deployed). Q2a is **on hold for redesign**: the tried approach added reads. Q1 is **redesigned** without `count()` (the compat SDK 10.13.0 used by QD has no aggregate `count()`; checked in the bundle). See "Revision 1" at the end. The sections below are kept as written for the record.

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

### Proposed gate: count reconciliation, no timestamps, full re-read as fallback (SUPERSEDED by Revision 1: `count()` is not available in the compat SDK)

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

## Q2a. Dashboard improvement status counts (`js/dashboard.js:1292`) (ON HOLD, see Revision 1)

Facts: `getImprovements(db, { limit: 200 })` reads the **whole** collection (`improvement-adapter.js:74`), sorts by `createdAt` in the browser, keeps the newest 200 and counts their statuses.

Proposal: query `orderBy('createdAt', 'desc').limit(200)` on the server; same normalisation and counting.

| Topic | Assessment |
|---|---|
| Reads saved | I − 200 per Dashboard open, **only when I > 200**; 0 today if I ≤ 200 (growth protection) |
| Correctness risk | Firestore leaves documents **without** `createdAt` out of an `orderBy` on it. Today they are kept (treated as oldest). New records always get `createdAt` (`improvement-adapter.js:118`); older ones may not. **Precondition:** U3 shows 0 improvements without `createdAt`; otherwise keep today's code |
| Alternative (business decision) | `count()` per status: about 1 read per status per 1,000 documents, but the meaning changes from "newest 200" to "all" |
| Effect | read only; `improvements` is `allow read: if true` in Production and candidate rules; single-field index is automatic; no effect on PV2 |
| Tests | I = 0, 1, 200, 201, 500; equal `createdAt` values; a record without `createdAt` (must be detected by the precondition check, not silently dropped) |

## Q2b. Improvement edit page (`js/improvement-page.js:120`) (DONE in `f6f83fd`)

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

---

## Revision 1, 2026-11-09

### Q2b: done (commit `f6f83fd`, working branch only)

`ImprovementAdapter.getImprovementById` (`doc(id).get()`; an id containing "/" is answered "not found" without reading) used by `loadForEdit`. Emulator: edit page 2 LIST / 500 documents → 1 LIST + 1 GET / 251 (250 improvements; the list tab on the same page still reads the collection once). Same record and form values for existing, unknown and malformed ids. Tests: unit 59/59, regression 15/15, rules + privacy / ops-console e2e 156/156, Q2 equivalence + read signature 19/19. Evidence: [`evidence/r1-r2-q2-20261109/`](evidence/r1-r2-q2-20261109/README.md).

### Q2a: on hold, to be redesigned

The tried approach (server `orderBy('createdAt','desc').limit(201)`, full read as fallback) **was rejected**: whenever 200 or fewer records have `createdAt` (likely today) it read the collection **twice** (I = 200: 400 reads instead of 200); the regression test caught it (improvements read twice). It must not be reused. Constraints for a redesign:
- never more reads than today in any case;
- same records as the full read (the 13 equivalence cases in the evidence must stay identical);
- no `count()` in the compat SDK.
Candidate to evaluate after U3 (only worth it if I > 200): choose the path from the size seen by the previous full read in the same browser (a hint only; the correctness checks stay). Not started.

### Q1: redesigned without `count()` and without timestamps

Fact: `ShiftClose.loadSlot` = one slot `get` + one log query `date == / line == / shift ==`, then the pure `deriveStatus({ slot, logs })`. `ShiftClose.loadDay` already reads the logs once and filters in memory. So the gate can work from **one** read of each collection:

1. Read the whole `scrapLogs` once (N_L) and the whole `scrapSlots` once (S): the gate already reads both today.
2. Group logs in memory by the exact `date`, `line`, `shift` values (strict equality, same as the `==` query; values of another type do not match, as in Firestore).
3. For every planned slot: slot from step 1, logs from step 2, `deriveStatus` as today → the same problems `verifyApplied` reports today (missing slot, `liveLogCount` ≠ stored, plan quantity / count at `logVersion` 0, CONFLICT).
4. Plus, at no extra reads: for planned slots still at `logVersion` 0, the stored log ids and `fingerprint` must equal the plan (catches count-neutral edits that today's gate does not).
5. Unknown-slot check as today (`planBaseline(currentLogs, existing)` on the same data).

| Topic | Assessment (estimates) |
|---|---|
| Gate reads today | P (slot gets) + about N_L (per-slot log queries) + N_L (full logs) + S (full slots) |
| Gate reads after | N_L + S |
| Saved per gate | about N_L + P |
| Whole cycle (dry run + apply + gate) | about 3 N_L + 3 P + 2 S → about 2 N_L + 2 P + 2 S |
| Correctness | same checks on the same data, plus id / fingerprint checks; no timestamps, no counts; nothing can be missed that today's gate catches |
| Consistency | like today, the reads are not one snapshot; a write during the gate shows as a mismatch (same behaviour as today) |
| Effect | Admin tool only; not on `main`; no Rules change; no new index; PV2 unaffected |
| Tests (emulator) | `tests/rules/migration-gate.test.js`, e2e rehearsal S7 unchanged; new: same problems as the old gate on (a) log added around the ledger, (b) log in a new slot, (c) log without timestamps, (d) move between planned slots, (e) swap, (f) model / defect edit (newly caught), (g) excluded log edited into a slot, (h) write during the gate; read counts measured |

Alternatives considered and not recommended: Firestore REST `runAggregationQuery` from the browser with the user's ID token (works only if the browser call path is proven, e.g. CORS, and adds a second API surface); loading the modular SDK next to compat for `getCountFromServer` (two SDK copies, cross-bundle objects; fragile). Both need extra proof and save no more than the redesign above.

---

## Revision 3, 2026-11-10: optimization plan O1–O10 (QD and PV2)

**Status: PLAN ONLY.** No QD or PV2 code has been changed and no test has been run. Each item needs its own approval for:

1. a test branch with emulator tests;
2. a commit;
3. any change to the PV2 repository, which also needs that repository owner's approval.

Nothing here changes Production, Firebase Rules, API keys, Billing or any deploy. **A1 = HIGH. G2 = NOT APPROVED.**

**Sources and labels.** Code references and read counts come from the A1/A2 report, Update 12:

- [CODE] = seen in the code.
- [EMU] = local emulator measurement (R1).
- [EST] = estimate assuming 3 active lines (L = 3) and 2 shifts.

PV2 file paths refer to `KP12264/daily-production-report` `main` `431836a`. QD "live" = `origin/main` `b118f93`.

**Rules shared by every item:**

- **Test method.** Local Firestore emulator only, with synthetic data sized like the real system (3 lines × 2 shifts × 120 days, plus orders and master collections).
  - Reads are counted with a wrapper around the database (GET, LIST, billed = max(1, documents) per query), as in the Q1 test.
  - The same scenario runs on the old and the new code, and the data each page computes is compared, along with the rendered HTML where practical.
- **Pass criteria shared by every item:**
  - the displayed output is identical in every scenario;
  - reads fall to the target stated for the item;
  - the Load / Refresh button always reads fresh data;
  - no Rules change, no new index, no deploy needed;
  - the existing test suites pass.

### Ranking

| Rank | Item | Reads per action today | Expected after | Risk of wrong or stale output |
|---|---|---|---|---|
| 1 | O1 PV2 Assembly | all `prodV2_actualLogs` [CODE]; grows about 2L per day [EST] | that date's documents (≤ 2L) | low (no cache) |
| 2 | O2 QD Dashboard filters (live `main`) | 405–580 per click [EMU, page open] | 0 per filter click (V5 reuse) | medium (5-minute reuse) |
| 3 | O3 PV2 Dashboard Range / Other Lines / Trend | ≈ 279 per 31-day load [EST], up to 3 loads per range set-up | without duplicates and repeat loads | medium (cache) |
| 4 | O4 PV2 Exec | open ≈ 105, Trend 30 ≈ 360 [EST] | open −12; repeat views of the same days 0 | low–medium |
| 5 | O5 PV2 Order Tracking | all orders + every order day × 2 [CODE] | that line's orders; repeat Load only new days | medium |
| 6 | O6 QD Scrap Detail / Improvement / Executive | 250–382 per open [EMU] | minus mapping size from the second open | low |
| 7 | O7 PV2 Master Merge Preview | all actual + plan documents of a line [CODE] | that date's documents when a date is given | low |
| 8 | O8 PV2 Cabinet Coverage | 3 whole masters per date change [CODE] | masters once per page session | medium (intent is "live mapping") |
| 9 | O9 PV2 Plan / Loss | whole `prodV2_shiftMaster` (+ `prodV2_jigLayouts`) per change [CODE] | once per session + each Load | medium (Plan saves data) |
| 10 | O10 Legacy root `onSnapshot` | 1 + 1 per remote change [CODE] | no change proposed | — |

### O1. PV2 Assembly (`production-v2/js/assembly.js`)

1. **Code / collection.** `load()` `:95-110`, called on page open (`:165`), Date / Shift change (`:159`) and the Load button (`:156`). It reads `all("prodV2_actualLogs")` and then filters `x.date===date && (!shift || x.shift===shift)`. Collection: `prodV2_actualLogs`.
2. **Repeated reads.** Every document in the collection is read to use one date. Each Date / Shift change repeats the full read, and the cost grows every day.
3. **Fix.**
   - **Recommended:** `where("date","==",date)` (one equality filter, served by the automatic single-field index), with the shift filter and every other line of code kept as they are in the browser.
   - **Alternative:** add `where("shift","==",shift)` when a shift is chosen (two equality filters).
   - **Alternative:** 2L document gets by id. **Not** recommended: documents with non-standard ids would be missed.
4. **Risk of wrong or stale output.**
   - No cache, so nothing can go stale.
   - The client filter `===` and Firestore `==` are both type-strict, so the matched set should be identical.
   - Edge cases (date not a string, missing fields, unusual ids, `actualByCell` missing) are covered by the test plan.
5. **Before / After test.** Emulator, synthetic data; see the O1 test plan (prepared separately, not run).
6. **Pass criteria.**
   - totals and `matched.length` identical in 100 % of date × shift cases, edge cases included;
   - reads ≤ that date's documents + 1;
   - the rules snapshot (`emulator/production.firestore.rules.snapshot`) allows the query unchanged;
   - no new index;
   - no other PV2 file changed.

### O2. QD Dashboard filter re-read (live `main`)

1. **Code / collection.**
   - `origin/main` `js/dashboard.js:1207-1240`: Date, Line, Shift and Refresh call `render()`, which reads again (`:160-161`).
   - Collections: `prodV2_actualLogs`, `prodV2_dailyPlans`, `scrapLogs`, target and improvement collections.
2. **Repeated reads.** Line / Shift clicks re-read data already loaded.
3. **Fix.** Already on the V5 branch: 5-minute reuse (`js/dashboard.js:57-58, 163-166`). No new code is needed, but release depends on **G2 (not approved)**.
4. **Risk.** Data entered by others appears after a Date change, Refresh or 5 minutes.
5. **Test.** R1 harness on `main` and on V5: open → 5 filter clicks → Refresh → write data → Refresh.
6. **Pass criteria.** Filter clicks 0 reads; Refresh reads fresh; new data visible after Refresh; output identical.

### O3. PV2 Dashboard (`production-v2/js/dashboard.js`)

1. **Code / collection.**
   - `load()` `:722-775`, `trendCompare` `:780-815`, `otherLinesToday` `:817-846`, triggers `:852-866`.
   - Collections: `prodV2_dailyPlans`, `prodV2_actualLogs`, `prodV2_lossLogs`.
2. **Repeated reads.**
   - The current line is read twice: 2 per day, so 62 on a 31-day range.
   - A Line change re-reads every line in `otherLinesToday`.
   - `trendCompare` re-reads 7 days on every Day load.
   - Setting up a range (ViewMode → start → end) loads up to 3 times.
3. **Fix.**
   - (a) Pass the documents `load()` already holds into `otherLinesToday`.
   - (b) Add an in-memory page-session cache keyed by (date, line, shift), which Refresh and Date changes bypass.
   - (c) Debounce `load()` by about 300 ms.
4. **Risk.** Values can be stale until Refresh or a Date change. The debounce delays the first render by up to 300 ms.
5. **Test.** Day, Week, Range 31, Line change, Refresh, write data then Refresh, a fast Mode → start → end sequence. Compare `S.multiDay`, `S.plan` / `S.actual` and the Other Lines / Trend HTML.
6. **Pass criteria.**
   - output identical;
   - Range 31 ≤ 31 × 3 + 31 × (L − 1) × 2;
   - returning to a line already viewed adds no reads until Refresh;
   - a fast range set-up causes exactly 1 load.

### O4. PV2 Exec (`production-v2/js/exec.js`)

1. **Code / collection.** `fetchDay` / `fetchLoss` `:22-41`, `loadTrend` `:130-138`, `init` `:147-157`; same three collections.
2. **Repeated reads.** Today is read by `loadToday` and again by `loadTrend` (i = 0). Switching Trend 7 → 30 re-reads 7 days.
3. **Fix.** A per-date page-session cache in `fetchDay`. `loadTrend` reuses today. The Load button clears the cache.
4. **Risk.** Past days edited later stay stale until the Load button is pressed.
5. **Test.** Open → Trend 30 → Trend 7 → Trend 30 → Load. Compare chart `labels` / `ach` and the today cards.
6. **Pass criteria.** Identical values; open −12 reads; the second Trend 30 ≤ 23 × 12 reads; Load reads fresh.

### O5. PV2 Order Tracking (`production-v2/js/order.js:58-81`)

1. **Code / collection.** `prodV2_orders` (whole), plus `prodV2_actualLogs` documents for each order's dates.
2. **Repeated reads.** All orders, including finished ones, and all their days are re-read on every Load.
3. **Fix.**
   - (a) With a line filter, `where("lineId","==",lineFilter)` (equals today's client filter).
   - (b) A page-session cache of actual documents for past dates.
   - Hiding finished orders is **not** proposed, because it would change the display.
4. **Risk.** With (b), later edits to past actuals appear only after reopening the page.
5. **Test.** 20 synthetic orders (past, current, future, crossing month ends); compare `rows` for every line filter.
6. **Pass criteria.** Identical rows; filtered Load reads ≤ that line's orders; a repeat Load reads only today's documents.

### O6. QD Scrap Detail / Improvement / Executive Report

1. **Code / collection.**
   - `js/improvement-adapter.js:74` (whole `improvements`)
   - `js/scrap-model-mapping-adapter.js:32` (whole `scrapModelMappings`)
   - `js/scrap-adapter.js:108-110` (range query)
   - `js/target-evaluator.js:105`
2. **Repeated reads.** Whole collections on every open; the mapping collection rarely changes.
3. **Fix.**
   - A page-session cache for mappings.
   - `improvements` stays under Q2a (on hold, needs a new design).
   - Q2b is done (`f6f83fd`).
4. **Risk.** Mapping edits appear after reopening the page.
5. **Test.** R1 harness on the Scrap Detail, Executive and Improvement pages; compare the rendered DOM.
6. **Pass criteria.** DOM identical; second open in a session reads fewer by the mapping size; QD suite passes.

### O7. PV2 Master Merge Preview (`production-v2/js/master.js:900-930`)

1. **Code / collection.** QUERY `where('lineId','==',lineId)` on `prodV2_actualLogs` and `prodV2_dailyPlans`; the date is filtered in the browser.
2. **Repeated reads.** The whole history of the line is read even when a date is given.
3. **Fix.** When a date is given, add `where('date','==',date)`.
4. **Risk.** Low. The result is the same as the browser filter. Two equality filters may need the single-field index merge; verify this in the emulator and confirm read-only in Production that no single-field exemption exists for `date` / `lineId`.
5. **Test.** Compare `actualDocs` / `planDocs` with and without a date.
6. **Pass criteria.** Identical; with a date, reads ≤ that date's documents of the line.

### O8. PV2 Cabinet Coverage (`production-v2/js/cabinet-coverage.js:10-26`)

1. **Code / collection.** Whole `prodV2_doorMapping`, `prodV2_models`, `prodV2_jigLayouts` on every open and Date change.
2. **Repeated reads.** The masters are re-read on every Date change.
3. **Fix.** A page-session cache plus a Reload button, or a short time limit.
4. **Risk.** The code comment states the intent "live mapping, re-evaluated every time". **The owner must agree** to any cache.
5. **Test.** Open → 3 Date changes → edit mapping → Reload; compare the coverage result.
6. **Pass criteria.** Identical; a Date change reads only the plan document + 2L actual documents.

### O9. PV2 Plan / Loss (`production-v2/js/plan.js:269-277`, `production-v2/js/loss.js:149-151`)

1. **Code / collection.** Whole `prodV2_shiftMaster` (+ `prodV2_jigLayouts` in Plan) on every Date / Line / Shift change.
2. **Repeated reads.** The masters are re-read on every change.
3. **Fix.** A page-session cache; the Load button reads fresh; Plan reads the masters fresh again just before Save.
4. **Risk.** Plan **saves** data, so a stale shift master must never reach a saved document.
5. **Test.** Change Date / Line / Shift 5 times → edit shift master → Load → Save; compare `S.shift` and the saved document.
6. **Pass criteria.** Saved documents identical to today's code; masters read once per session plus each Load; Save always uses the latest master.

### O10. Legacy root `onSnapshot` (`index.html:760`)

No change proposed. First ask the owners whether the legacy root page is still deployed and used (R6 Q1 / Q5). It is a candidate source of the listeners seen in W1 / W4 [HYP].

### Order and gates (Revision 3)

1. O1, O3 and O4 (PV2, biggest effect, lowest risk) first, each as its own approved emulator test and, if it passes, a proposal to the PV2 owner.
2. O2 waits for G2.
3. Then O5, O6, and O7–O9.
4. Every PV2 change belongs to the PV2 repository and its owner; this repository only holds the plans and test evidence.

---

## Revision 4, 2026-11-10: O1 readiness checklist (PV2 Assembly)

Sources:

- emulator evidence [`evidence/o1-assembly-20261110/`](evidence/o1-assembly-20261110/README.md) (commit `1cacb24`);
- owner index check (owner-reported, A1/A2 report, Update 13).

**The O1 code change is NOT APPROVED.** Nothing here changes QD, PV2, rules, indexes, keys, Billing or any deploy. **A1 = HIGH. G2 = NOT APPROVED.**

| # | Requirement | Status | Basis |
|---|---|---|---|
| R1 | Reads before / after measured | **Done** | 745 → 1–14 per load; 270,435 → 2,202 over 363 cases (emulator, synthetic) |
| R2 | Totals and display identical in 100 % of cases | **Done** | 363 / 363 identical; matched set = independent expectation 363 / 363 |
| R3 | Date / Shift / Model filtering correct | **Done** | date × shift cases; 11 Model groups, 0 reads, same HTML |
| R4 | Malformed / missing data (E1–E19) | **Done** | same result in Before and After |
| R5 | No effect on other PV2 pages | **Done** | one line in one file; 34 PV2 file hashes unchanged; `assembly.js` loaded only by `assembly.html`; pv2-compat 7 / 7 |
| R6a | No rules change | **Done** | four rules files unchanged; query allowed (anonymous and signed in) |
| R6b | No new Production index | **Done (owner-reported)** | Automatic: Ascending / Descending / Arrays enabled; no exemptions (2026-11-10) |
| N1 | Approval of the O1 code change | **Open** | not approved |
| N2 | PV2 repository owner agreement; change made in the PV2 repository by its owner's process | **Open** | QD holds plans and evidence only |
| N3 | Cache-busting: bump `js/assembly.js?v=20260902-fix5` in `production-v2/assembly.html:22` | **Open** | HTML-only; not in the tested diff; without it browsers may keep the old file |
| N4 | Release / deploy path of PV2 and who performs it | **Open** | not known from this repository |
| N5 | Rollback | **Prepared (plan)** | revert line 100 and bump `?v=` again; no data or schema involved |
| N6 | Post-change check | **Open** | open Assembly for one date and shift; compare totals with the previous version, the same day, before any new entries; Monitoring `document/read_count` for the hour should fall by about all-documents − that date's documents per page load (attribution limited: the key is shared) |
| N7 | Browser SDK 9.23.0 | **Residual risk (low)** | tested with 10.13.0 in Node; `where ==` semantics are the same; check in N6 |

**Readiness:** technically ready for a decision on the O1 code change (R1–R6 met). Open items N1–N4 and N6 need decisions by the approvers and the PV2 owner. O1 reduces Assembly reads only; it does not resolve the cause of W1–W6 or the 01:00 job.
