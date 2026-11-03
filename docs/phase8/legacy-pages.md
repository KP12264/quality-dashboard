# plan-tracking.html and weekly-review.html (P7-2)

## Findings (tested in the emulator)

- Not linked from any V5 page; only from `dashboard-classic.html` (retired in Phase 7).
- Both pages open without errors, but **cannot read or save weekly plans under any rules**: commit `3c28849` (2026-10-16, "Add files via upload") removed `SCRAP_WEEKLY_PLAN_COLLECTION` and `MONTHLY_REDUCTION_GOAL` from `js/config.js`. The adapter's error is caught and shown as "Weekly plan overrides could not be read". Monthly totals from `scrapLogs` still display.
- Production rules also deny `scrapWeeklyPlans` (Phase 6), so the feature has not worked in production since the V5 redesign.

## Options

| Option | Effect | Risk |
|---|---|---|
| **1. Retire (recommended)** | add `js/retired-page.js` (→ `index.html`); then **remove the `scrapWeeklyPlans` rule from the candidate** (51 → 36 opened permissions; no new public read except the close summary) | none — feature already not working |
| 2. Restore | re-add the two constants, add both pages to the V5 sidebar, keep the candidate's `scrapWeeklyPlans` rule (public read, admin write) | must be re-tested and redesigned to V5; owners must confirm the business still uses monthly plans |

Nothing was changed: no file deleted, no menu changed, constants not restored. Decision needed (P7-2).
