# Final UI Review & Release Readiness

Branch `claude/vigilant-pasteur-l91qt3`, Emulator `demo-quality-dashboard` only. Nothing was deployed, published or merged. Firestore Production and Production V2 were not touched.
The flags are unchanged: `QD_AUTH_MODE = "off"`, `QD_CLOSE_REQUIRED_FROM = null`, `QD_OPS_WRITE_ENABLED = false`.

**Final code: `2a031c0`.** **Overall: NO-GO for production.**

The code is ready and fully tested on the development branch, but every gate below that needs an owner decision is still open (⛔).
GO requires all ⛔ to be resolved and approved. NO-GO also applies if any suite fails or the re-copied production rules hash differs.

## 1. Dashboard V5 with the Scrap Budget card

Screenshots: `screens/dashboard-{1440,1024,820,390}.png` (full page) and `screens/dashboard-card-{1440,390}.png`.

The data is a realistic seeded month (`tests/support/release-seed.js`): 31 days, one over-50 day before Shift Close and one after, Shift Close from the 19th, and every close state.

| Check (tested in `tests/e2e/release-readiness.e2e.test.js` §1) | 1440 | 1024 | 820 | 390 |
|---|---|---|---|---|
| Order: KPI → Scrap Budget → Trend → Top 5 / Door Line → Attention → Pareto | ✅ | ✅ | ✅ | ✅ |
| No horizontal page scroll | ✅ | ✅ | ✅ | ✅ |
| Card height (limit: ≤ 260 px from 820 px up, ≤ 560 px on a phone) | ✅ | ✅ | ✅ | ✅ |
| Card share of the page height < 16 % | ✅ | ✅ | ✅ | ✅ |

The card is one compact row: this week next to this month on desktop and tablet, stacked on a phone. It sits between the KPI row and the trend chart, and all details stay on `weekly-plan.html`.

UI changes made in this review:
- The Actual, Remaining and Used figures are now a 3-column stat row, which keeps the card short on phones.
- The plan's source is shown next to it.
- Over budget reads "N over".

## 2. weekly-plan.html — states

| State | Screenshot | Asserted |
|---|---|---|
| Monthly summary (default budget, so far) | `weekly-plan-month-summary.png` | "Monthly budget · default", "2 of 5 weeks set by an Admin, 3 default (not set)" |
| Weekly table: **Over plan** (W2, Admin override), **Within plan** (W4, 7/7 final, Admin-confirmed default, 1 day >50), **Not final** | `weekly-plan-weeks-table.png` | status + plan source per row |
| Daily breakdown: Final, **Final · over 50**, Final · no production, Pending close, Conflict, **No data (not 0)** | `weekly-plan-days-W4-final-over50.png`, `weekly-plan-days-W5-states.png` | day state per date from the seed |
| Line × Shift (week + month to date) | included in both day screenshots | rows add up to the Door A+B+C total |
| Improve Top 5 (sub-causes open) | `weekly-plan-improve-top5.png` | one row per defect, ≤ 5 |
| Admin edit / override + history | `weekly-plan-admin-edit-dialog.png` | above 50/day refused, history (Thailand time) |
| Review note (Admin), Leader / Viewer read-only | `weekly-plan-review-note-admin.png` | no Edit button for Leader / Viewer |
| **So far** (current month) | `weekly-plan-current-month-so-far.png` | "so far" |
| **Provisional** reduction goal | `weekly-plan-goal-provisional.png` | status PROVISIONAL, never "Confirmed" |
| **No data** month | `weekly-plan-no-data-month.png` | "No log", never 0 |
| Future month (Not started) | `weekly-plan-future-not-started.png` | NOT_STARTED |
| Full page desktop / tablet / phone | `weekly-plan-full-1440.png`, `weekly-plan-full-1024.png`, `weekly-plan-full-820.png`, `weekly-plan-full-390.png` | no horizontal scroll |

A CONFIRMED goal (every previous-month day final) is covered by the unit tests. The seeded month is deliberately not fully closed.

## 3. Default plan is never shown as an approved plan

| Case | What the user sees | Screenshot |
|---|---|---|
| No plan document for a week | "Default · not set" (grey). The budget is labelled "Monthly budget · default", and the card says "N of M weeks have no plan set … not an approved plan" | `weekly-plan-weeks-table.png` |
| An Admin confirmed the default | "Default · confirmed" (green) | same |
| An Admin set a plan | "Set by Admin" (green), base shown | same |
| **Rules deny `scrapWeeklyPlans`** (production snapshot rules) | Every week and the budget show "Default · unconfirmed" (amber). Banner: "not readable here (access denied by the Firestore rules) … NOT a confirmed plan". The card shows the same | `state-plans-denied-production-rules.png`, `state-card-plans-denied.png` |
| **Read error** (not a permission problem) | "Default · unconfirmed". Banner: "could not be read (read error) … NOT a confirmed plan. Try Reload." | `state-plans-read-error.png` |
| Scrap read error | No figures at all (Read error); never 0 | `state-scrap-read-error.png` |

## 4. Firestore read cost

Full table: [generated/read-cost.md](generated/read-cost.md). Each cell is queries / documents, measured in the emulator.

- **Added by Weekly Plan V5 on the Dashboard:**
  - plans: 1 query (≤ 6 docs), once per month per page session;
  - missing days: 1 scrap query, only when the range starts after the 1st;
  - close summaries: only for close-required dates the range does not cover (0 while `QD_CLOSE_REQUIRED_FROM = null`).
  - A 1-day view needs no extra scrap query, because the existing look-back window now starts on the 1st (at most +1 day).
- **Filter changes, fixed in this review.** This was an existing behaviour: every Line / Shift click re-read the whole range — 189 queries / 330 docs for a 31-day month.
  - Now a click re-uses the loaded data when the reads would be identical (all daily-rule dates; the Line filter always), so it costs **0 / 0**. The numbers are identical to a fresh Refresh (tested).
  - Before the daily rule (per-shift target), a Shift change still reads, because the reads really differ.
  - "Last refreshed" keeps the time of the actual read. Refresh and date changes always read fresh.
- **Weekly Plan:**
  - open a month: 3 queries (scrap 1, plans 1, close summary ≤ 1); **no production documents**;
  - back to a month already seen: 0; Reload: reads again;
  - previous-month goal: +1 scrap query and 1 close summary, only when it is opened; opening it again: 0.
- **Reopening the Dashboard** reads again. The SDK has no offline cache enabled, so this is unchanged.
- **Before / after** (same data and clicks; `f6e2ba9` vs now): [generated/read-cost-before-after.md](generated/read-cost-before-after.md).
  - filter change on a 31-day range: 190 / 332 → **0 / 0**;
  - back to a month on Weekly Plan: 3 / 146 → **0 / 0**;
  - 7 / 30 / 31 days: −1 query (plans not re-read);
  - everything else is unchanged.

### Freshness (no stale data after a save or an import)

Re-used data is never older than `QD_VIEW_CACHE_MINUTES` = **5 minutes**.

- **Refresh** (Dashboard) and **Reload** (Weekly Plan) always read fresh, card included.
- **Opening a page** always reads fresh. For example, coming back from Scrap Entry after a save, or after an Excel import.
- **A date change** reads fresh (the card's own plans / missing days follow the same 5-minute rule).
- **A filter click** shows the data loaded at the time in "Last refreshed", which it does not change. Up to 5 minutes it re-uses that data; after 5 minutes it reads again.
- Tested (release-readiness §5): a log written elsewhere stays out on filter clicks; Refresh shows it in the KPI and the card; after 5 minutes a filter click shows the next one; a reopened page shows both. Weekly Plan: Reload, and a month older than 5 minutes, show the new log.

| Path | Behaviour | Test |
|---|---|---|
| Filter change within 5 min | re-uses the loaded data; numbers identical to a fresh read; "Last refreshed" unchanged | §4, §5 |
| Data older than 5 min | the next filter click / month switch reads fresh; until then a hint says "older than 5 min — press Refresh / Reload" (clock only, no reads) | §5, §6 |
| Refresh / Reload | always reads fresh (card included) | §4, §5, §6 |
| Save / import **in the same tab** (Scrap Entry is another page) | coming back is a new page load, or a back/forward-cache restore, which now reloads: always fresh | §6 |
| Save **in another tab** | shown at once with Refresh / Reload, at the latest after 5 minutes on the next action; the stale hint tells the user | §5, §6 |
| Admin plan / review save on weekly-plan.html | the page re-reads the plans at once | weekly-plan e2e |

### Private data after sign-out or an account switch

When a signed-in user signs out, or another account takes over, the page reloads. "Another account" includes a sign-out or switch in another tab, because Firebase Auth shares the session between tabs.

- No private value stays on screen or in memory: Recorded By, improvement owners, plan history, review notes.
- The page only shows "Signing out…" until the reload.
- Pages restored from the back/forward cache reload too.
- The caches hold public data only: scrap, plans, close summary. Review notes and history are never cached.
- Tested:
  - Weekly Plan: history and review note are gone after sign-out; signing out in tab B clears tab A; Admin → Viewer shows Viewer rights only.
  - Scrap Detail: "Recorded By" is gone after sign-out.
  - Existing auth / shift-close tests that sign out and back in still pass.

### Measuring reads: queries vs documents

The counter wraps every Firestore `get()` in the browser and records three numbers per collection:
- queries;
- documents returned;
- an **estimate** of billed reads: each document returned, at least 1 per query, and 1 per document get even when the document does not exist.

**Limitation:** the emulator has no billing, so actual billed reads cannot be measured here; they show only in the Firebase Console (Usage) on the real project. The query count is never used as the read count.

### Weekly status when a day is over 50

Two separate checks:

- **The daily limit (≤ 50 pcs/day).** Any day over 50 is flagged:
  - on the day ("Final · over 50", or ">50" while not final);
  - in the weeks table ("N day >50");
  - on the card ("N days over 50");
  - on the Dashboard (Target Performance OVER TARGET for that day).
- **The weekly status** compares the week's scrap with its **budget**. It is OVER when the actual exceeds the plan to date.

Seeded examples:
- W4: 7/7 days final, one day at 55 pcs, 129 of 350 → **Within plan** + "1 day >50" (`weekly-plan-days-W4-final-over50.png`).
- W2: one day at 62 pcs, 148 of an Admin plan of 120 → **Over plan** + "1 day >50".

A day over 50 therefore never hides; it does not by itself turn a week that is within its budget into "Over plan". If the rule should be "any day over 50 ⇒ week Over", that is a one-line change. **Decision needed (D1).**

## 5. Issues found in this review

| # | Issue | Kind | Fix | Test |
|---|---|---|---|---|
| 1 | Plan column and budget did not say whether the plan was Admin-set or a default; a default could look approved | UI / logic | plan source per week (DEFAULT / ADMIN_DEFAULT / OVERRIDE / UNAVAILABLE), budget source, card tag + note | unit `plan source`, e2e §2–3 |
| 2 | Plans read failure did not distinguish "access denied" from "read error" | UI | separate banners and texts | e2e §3 |
| 3 | Line / Shift filter re-read the whole range (pre-existing) | cost | re-use the loaded data when the reads would be identical | e2e §4 (0 reads, same numbers as Refresh), regression |
| 4 | Card re-read plans on every filter change | cost | per-session cache (cleared by Refresh) | e2e §4 |
| 5 | Weekly Plan re-read a month when switching back | cost | per-month cache (Reload reads fresh) | e2e §4 |
| 6 | Override history time used the device clock (UTC on a server) | logic | shown in Asia/Bangkok with "(TH)" | e2e §2 |
| 7 | Final days did not say why they were final (over 50, no production) | UI | "Final · over 50", "Final · no production" | e2e §2 |
| 8 | A week could show "On track" without showing a day over 50 | UI | "N day >50" in the weeks table | e2e §2 |
| 9 | A negative remaining (−28) looked like a value | UI | "28 over" (red) | screenshots |
| 10 | A completed, fully final week said "On track" | UI | "Within plan" | e2e §2 |
| 11 | Mobile card was tall | UI | 3-column stat row | e2e §1 height |
| 12 | `target-close` read test counted before the card had finished loading (race) | test | waits until the page has settled | e2e |
| 13 | Re-used data had no age limit (a save / import elsewhere could stay hidden until Refresh) | logic | 5-minute cap (`QD_VIEW_CACHE_MINUTES`) | e2e §5 |
| 14 | `rules-transition` expected the old banner wording | test | expects the new "access denied … NOT a confirmed plan" | e2e |
| 15 | Changed JS / CSS kept old `?v=` cache keys | release | bumped (qd-auth.js on every page) | — |
| 16 | Private data stayed on screen after sign-out / an account switch (also from another tab) | privacy | page reloads when the signed-in user leaves | e2e §6, privacy e2e |
| 17 | A page restored from the back/forward cache could show data from before a save | logic | reload on restore | e2e §6 |
| 18 | No sign that the shown data was old (other tab saves) | UI | stale hint next to Refresh / "Loaded hh:mm (TH)" on Weekly Plan | e2e §6 |
| 19 | Read report showed only documents returned | report | + billed estimate and the limitation | read-cost.md |
| 20 | Pre-existing: a period with no data kept the previous range's trend legend ("Over target") | UI | legend and note cleared with the empty state | e2e §1b, off-mode matrix |

Open (not fixed; decisions):

| # | Item | Note |
|---|---|---|
| O1 | Dashboard reads production documents per date / line / shift (186 for 31 days) | existing design, unchanged; a monthly aggregate would need a Production V2 change (out of scope) |
| O2 | Attention Required reads the 30-day look-back on every 1-day view | existing; now shared with the card (no extra query) |

## 6. Release readiness

| Gate / area | Status | Evidence |
|---|---|---|
| **G1** snapshot = published rules of `(default)` | ⛔ owner confirmation needed (database / publish time) | `emulator/production.firestore.rules.snapshot` sha256 `0967944b…2e2f` (unchanged) |
| **G2** approve candidate + bridge rules | ⛔ not approved. The candidate now also contains the Weekly Plan rules: sha256 `6fa05b5a…5668`, bridge `d94383fa…98e1` | [generated/rules-diff.md](generated/rules-diff.md), rules suite |
| **G4** public data policy | ⛔ decision. Weekly Plan follows the approved split: plan numbers public; who / why / notes signed-in only | rules `weekly-plan.test.js`, compatibility matrix |
| Bridge rules | ✅ regenerated, `--check` passes; Production V2 and legacy paths identical in all four rule sets | `pv2-compat.test.js` |
| Weekly Plan **needs the candidate (or bridge) rules**: production rules deny `scrapWeeklyPlans` | ⚠ without them the page / card show "Default · unconfirmed" and editing is impossible (safe fallback, tested) | e2e §3 |
| **Privacy migration** (M-P1) | ⛔ not approved for production; tool ready (dry run, backup, resume, idempotent, verify, **Exception Report**) | `privacy-migration.test.js`, `docs/phase9/generated/privacy-migration-report.md` |
| M-P2 exceptions (code > 64 chars, > 20 actions) | ⛔ decision | Exception Report lists them; nothing skipped silently |
| **Baseline migration** (M1) | ⛔ not run on production; gate tested | `migration-gate.test.js`, `migration.test.js` |
| Admin / Leader / Viewer | ✅ tested in rules and the browser (Weekly Plan: Admin edits; Leader / Viewer read-only; public numbers only) | `rules.test.js`, `auth.e2e`, `weekly-plan.*`, `release-readiness.e2e` |
| Legacy redirects | ✅ 3 old copies + `plan-tracking.html` / `weekly-review.html` → `weekly-plan.html` (files kept, query + hash kept) | `page-inventory.test.js`, `rules-transition.e2e` |
| Rollback | ✅ rehearsed: bridge → production snapshot → forward, no data lost. Weekly Plan: remove the card section / scripts (the card is optional); old pages: remove one script tag | `rehearsal.e2e` (R), `docs/phase7/generated/rehearsal-report.md` |
| Production V2 compatibility | ✅ PV2 block identical to production in candidate and bridge; PV2 users get nothing in QD | `pv2-compat.test.js`, `docs/phase6/generated/compatibility-matrix.md` |
| B1 / B2 close date, first admin + roles | ⛔ decision | — |
| C1 / C2 cost acceptance | ⛔ decision (see §4) | `generated/read-cost.md`, `generated/read-cost-before-after.md` |
| D1 weekly status rule with a day over 50 | ✅ approved and implemented (`c4a165e`): Budget status · Daily compliance · Data completeness | unit + e2e §2b, §8 |

## 7. Test results

See [results.md](results.md).
