# Weekly Plan V5 — Test Results (Emulator `demo-quality-dashboard` only)

Code commit `770d500` (+ `cea652d` regenerated reports). Nothing deployed, published or merged.

## Before implementation: full regression of `a32af2b` (baseline)

| Suite | Result |
|---|---|
| Unit | 42/42 |
| Rules | 131/131 |
| E2E | 65/65 |
| Regression (Dashboard V5 vs oracle, sign-in off) | 15/15 |
| Off-mode Dashboard matrix | 107 scenarios, 0 errors |

No regression was found, so nothing had to be fixed before the feature work.

## After implementation

| Suite | Result | New |
|---|---|---|
| Unit | **56/56** | +14 `weekly-plan.test.js` |
| Rules | **144/144** | +13 `weekly-plan.test.js`; `rules.test` (admin plan write now needs history), `pv2-compat` (+2 paths) |
| E2E | **74/74** | +9 `weekly-plan.e2e.test.js`; `rules-transition` now checks the old plan pages redirect |
| Regression (sign-in off) | **15/15** | oracle: +1 scrap query when a range starts after the 1st (the card's gap query) |
| ix (whole system incl. Executive Report) | **21/21** | — |
| Bridge rules `--check` | up to date | — |

### Dashboard regression (off-mode matrix, 97 data snapshots / 107 scenarios, vs baseline)

- KPI, target detail, Door Line, Top defects, Pareto, trend, legend, Attention Required, layout overflow: **identical**.
- Firestore reads: the **only** differences:
  - +1 `scrapWeeklyPlans` query per render (≤ 6 documents);
  - +1 `scrapLogs` query per render **only** when a range starts after the 1st of the To month (24 of 97 snapshots).
- One harness artefact: the tablet hover check moves the mouse to fixed screen coordinates. The new card pushes the trend chart below the 1180 px viewport, so the hover misses. With the chart scrolled into view, the tooltip works on desktop, tablet and mobile.

### PV2 compatibility (`tests/rules/pv2-compat.test.js`)

- Production V2 and legacy paths: identical in all four rule sets (production snapshot, candidate, bridge, repo PV2).
- Candidate vs production changes:
  - 63 closed (unchanged);
  - 61 opened (was 51): +6 history get/list for Admin / Leader / Viewer, +7 review notes, −3 because a plain Admin write to `scrapWeeklyPlans` without history is now refused.
  - All are in the reviewed list.

### Firestore reads (E2E counter, emulator; `gets` = queries, `docs` = documents)

| Screen | Reads |
|---|---|
| Dashboard, one day (month end) | scrapLogs 2 queries (range + existing look-back, **no extra**), scrapWeeklyPlans 1 (≤ 6 docs), scrapCloseSummary 2 (only missing dates), production 6 (unchanged) |
| Dashboard, range 15 → end | scrapLogs 2 (range + gap 1 … 14), scrapWeeklyPlans 1, scrapCloseSummary 1 |
| weekly-plan.html (public) | scrapLogs 1, scrapWeeklyPlans 1, scrapCloseSummary 1, **production 0**, reviews / history 0 |
| Reduction goal opened | + 1 scrapLogs query (previous month), only on demand |

With `QD_CLOSE_REQUIRED_FROM = null` (today), no close summary is read at all.

## Defects found and fixed during the work

- The week's day list overwrote the `days` count, so the weeks table showed "[object Object]". Fixed by renaming the list to `dayList`. Unit and E2E assertions added.
- A week with no scrap log on any elapsed day showed "Actual 0 so far". It now shows "No log" (no data ≠ 0). Assertions added.
- The close-required check missed the daily-rule start date (Sep 2026 and earlier). It is now the same rule as `TargetEvaluator.closeRequired`.

Screenshots (emulator):
- `tests/e2e/artifacts-weekly-plan-desktop.png`
- `tests/e2e/artifacts-dashboard-budget-card.png`
- `tests/e2e/artifacts-weekly-plan-mobile-page.png`
- `tests/e2e/artifacts-weekly-plan-mobile-card.png`
