# Weekly Plan V5 — Implementation (Development branch + Emulator only)

Approved design: [design.md](design.md) (commit `a32af2b`), with the approval decisions below.
Nothing was deployed, published, merged or written to Firebase Production. `QD_AUTH_MODE = "off"`,
`QD_CLOSE_REQUIRED_FROM = null` and `QD_OPS_WRITE_ENABLED = false` are unchanged.

## Approved decisions → what was built

| Decision | Implementation |
|---|---|
| Improve grouped by **defect only** | Top 5 defects, all lines together, one row per defect; Door A/B/C qty and the sub-causes (rootCause, with qty per line) inside the row; one link to Improvement — never repeated per line |
| Plan summary **public** | `scrapWeeklyPlans` holds numbers only (`ym, week, planOverride, historyRev, updatedAt`) and is publicly readable; who / reason → `history` (signed-in only); review notes → `scrapWeeklyReviews` (signed-in only); Admin edits with a required reason |
| Monthly budget = **Σ weekly plans** | no monthly override; weeks Mon–Sun clipped to the month, so a day is never counted in two months; 28/29/30/31-day months tested; an override may not exceed 50 × days of that week (page + calc), rules cap 0 … 350 |
| Keep **−50 % reduction goal** | separate section, basis shown (previous month total, Door A+B+C, Day + Night), data status shown; **CONFIRMED only when every previous-month day is final** through Shift Close, otherwise PROVISIONAL; read only when opened |

## Data flow

```
Dashboard (index.html) — render() already loads:
  scrapLogs  range query [From … To]                    ─┐
  scrapLogs  Attention look-back (one date only)         ├─► PlanCard (js/plan-card.js)
             window = min(To − 29, 1st of month) … To   ─┤      └─ WeeklyPlanCalc.buildMonth()
  scrapCloseSummary (close-required dates in range)     ─┘
  + scrapWeeklyPlans where ym == month (1 query, ≤ 6 docs)
  + only when the range starts after the 1st: scrapLogs [1st … From − 1] (1 query)
  + only close-required month dates not in the range: scrapCloseSummary (≤ 1 query)

weekly-plan.html — scrapLogs [1st … as of] (1 query) · scrapCloseSummary (≤ 1) · scrapWeeklyPlans (1)
  · signed in: scrapWeeklyReviews (1) · on demand: previous month scrapLogs + close summary
  · NO production documents (finality comes from Shift Close only)
```

- Scope = Target Evaluator scope: Door A/B/C × DAY/NIGHT (Door In Door and old shift codes are not counted).
- A day is **final** only through Shift Close: close-required date, 6/6 closed and WITHIN / OVER /
  NO PRODUCTION (TargetEvaluator, same summary). Otherwise LOGGED / PENDING / CONFLICT / READ ERROR,
  or NO DATA (no log: quantity unknown, **never 0**; a week without any log shows "No log").
  With `QD_CLOSE_REQUIRED_FROM = null` (today) no day is final: every figure is shown as "so far".
- Status: OVER (actual > plan to date — certain) · READ ERROR · ON TRACK (all elapsed days final) · NOT FINAL · NOT STARTED.
- The Attention Required recurring list still uses exactly the same 30 days (records are filtered back).

## Rules (candidate `emulator/firestore.rules`, bridge regenerated — NOT published)

| Path | Read | Write |
|---|---|---|
| `scrapWeeklyPlans/{ym}_{W#}` | public | Admin; fields exactly `ym, week, planOverride (null \| int 0…350), historyRev (= old + 1), updatedAt (= server time)`; id = `ym_week`; **history/{historyRev} must exist after the write**; delete: nobody |
| `scrapWeeklyPlans/{id}/history/{rev}` | signed-in QD users (Admin / Leader / Viewer) | Admin create only, in the same commit as the plan: `from` = old value, `to` = new value, reason 3–200, `by` = own e-mail, `at` = server time; update / delete: nobody |
| `scrapWeeklyReviews/{ym}_{W#}` | signed-in QD users | Admin; `ym, week, reviewNote (≤ 2000), updatedAt (server), updatedBy (own e-mail)` |

Production today denies `scrapWeeklyPlans`: until the candidate is published the page and card show the
default plan (50 × days) with a notice (tested under the production snapshot). No data to migrate.

## Files

New: `weekly-plan.html`, `js/weekly-plan-calc.js` (pure), `js/weekly-plan-data.js`, `js/weekly-plan-page.js`,
`js/plan-card.js`, `css/weekly-plan.css`, tests (unit / rules / e2e `weekly-plan*`).
Changed: `index.html` (card + scripts), `js/dashboard.js` (shared look-back, card call), `js/config.js`
(constants), `js/nav.js` + sidebars (Weekly Plan link), `emulator/firestore.rules` (+ bridge),
`plan-tracking.html` / `weekly-review.html` (retired → weekly-plan.html, files kept),
tests: rules.test, pv2-compat.test, page-inventory.test, rules-transition.e2e, regression oracle (read count).

## Results

See [results.md](results.md).
