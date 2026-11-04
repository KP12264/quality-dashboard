# Firestore Reads — Before / After the Read Optimization (generated)

Same seeded month (2026-10, Shift Close from 2026-10-19) and the same clicks, measured in the Firebase Emulator on 2026-11-04.
**Before** = commit `f6e2ba9` (Weekly Plan V5, before the release review). **After** = commit `1363aae` (final code).

Three separate numbers, never mixed:
- **Queries** = Firestore `get()` calls (a document get counts as one).
- **Docs** = documents returned to the browser (counted in the page on every get).
- **Est. reads** = an *estimate* of billed reads: each document returned, at least 1 per query (an empty query still costs 1), and 1 per document get (also when it does not exist).

> **Limitation:** the Firebase Emulator has no billing. *Est. reads* is calculated from the counts above and is **not** the billed number from Firebase. Actual billed reads are visible only in the Firebase Console (Usage) of the real project, which was not accessed.

| Screen | Action | Before: queries / docs / est. reads | After: queries / docs / est. reads | Change (queries / est. reads) |
|---|---|---|---|---|
| Dashboard | open (today) | 12 / 136 / 141 | **12 / 136 / 141** | +0 / +0 |
| Dashboard | range 1 day | 12 / 155 / 156 | **12 / 155 / 156** | +0 / +0 |
| Dashboard | range 7 days | 48 / 188 / 189 | **47 / 186 / 187** | -1 / -2 |
| Dashboard | range 30 days | 185 / 326 / 327 | **184 / 324 / 325** | -1 / -2 |
| Dashboard | range 31 days | 190 / 332 / 333 | **189 / 330 / 331** | -1 / -2 |
| Dashboard | filter Shift = Day (31-day range) | 190 / 332 / 333 | **0 / 0 / 0** | -190 / -333 |
| Dashboard | filter Line = Door A (31-day range) | 190 / 332 / 333 | **0 / 0 / 0** | -190 / -333 |
| Dashboard | Refresh (31-day range) | 190 / 332 / 333 | **190 / 332 / 333** | +0 / +0 |
| Weekly Plan | open 2026-10 | 3 / 146 / 146 | **3 / 146 / 146** | +0 / +0 |
| Weekly Plan | next month | 3 / 23 / 25 | **3 / 23 / 25** | +0 / +0 |
| Weekly Plan | back to 2026-10 | 3 / 146 / 146 | **0 / 0 / 0** | -3 / -146 |
| Weekly Plan | open goal | 2 / 144 / 144 | **2 / 144 / 144** | +0 / +0 |
| Weekly Plan | open goal again | 0 / 0 / 0 | **0 / 0 / 0** | +0 / +0 |

## Per collection (queries / docs / est. reads)

| Action | Before | After |
|---|---|---|
| Dashboard · open (today) | prodV2_actualLogs 6/6/6, scrapLogs 2/130/131, scrapCloseSummary 2/0/2, improvements 1/0/1, scrapWeeklyPlans 1/0/1 | prodV2_actualLogs 6/6/6, scrapLogs 2/130/131, scrapCloseSummary 2/0/2, improvements 1/0/1, scrapWeeklyPlans 1/0/1 |
| Dashboard · range 1 day | prodV2_actualLogs 6/6/6, scrapLogs 2/135/135, scrapCloseSummary 2/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | prodV2_actualLogs 6/6/6, scrapLogs 2/135/135, scrapCloseSummary 2/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 |
| Dashboard · range 7 days | prodV2_actualLogs 42/42/42, scrapLogs 2/132/132, scrapCloseSummary 2/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | prodV2_actualLogs 42/42/42, scrapLogs 2/132/132, scrapCloseSummary 2/12/12, improvements 1/0/1 |
| Dashboard · range 30 days | prodV2_actualLogs 180/180/180, scrapLogs 2/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | prodV2_actualLogs 180/180/180, scrapLogs 2/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1 |
| Dashboard · range 31 days | prodV2_actualLogs 186/186/186, scrapLogs 1/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | prodV2_actualLogs 186/186/186, scrapLogs 1/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1 |
| Dashboard · filter Shift = Day (31-day range) | prodV2_actualLogs 186/186/186, scrapLogs 1/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | nothing read |
| Dashboard · filter Line = Door A (31-day range) | prodV2_actualLogs 186/186/186, scrapLogs 1/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | nothing read |
| Dashboard · Refresh (31-day range) | prodV2_actualLogs 186/186/186, scrapLogs 1/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 | prodV2_actualLogs 186/186/186, scrapLogs 1/132/132, scrapCloseSummary 1/12/12, improvements 1/0/1, scrapWeeklyPlans 1/2/2 |
| Weekly Plan · open 2026-10 | scrapLogs 1/132/132, scrapWeeklyPlans 1/2/2, scrapCloseSummary 1/12/12 | scrapLogs 1/132/132, scrapWeeklyPlans 1/2/2, scrapCloseSummary 1/12/12 |
| Weekly Plan · next month | scrapLogs 1/23/23, scrapWeeklyPlans 1/0/1, scrapCloseSummary 1/0/1 | scrapLogs 1/23/23, scrapWeeklyPlans 1/0/1, scrapCloseSummary 1/0/1 |
| Weekly Plan · back to 2026-10 | scrapLogs 1/132/132, scrapWeeklyPlans 1/2/2, scrapCloseSummary 1/12/12 | nothing read |
| Weekly Plan · open goal | scrapLogs 1/132/132, scrapCloseSummary 1/12/12 | scrapLogs 1/132/132, scrapCloseSummary 1/12/12 |
| Weekly Plan · open goal again | nothing read | nothing read |
