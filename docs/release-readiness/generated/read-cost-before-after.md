# Firestore Reads — Before / After the Read Optimization (generated)

Same seeded month (2026-10, Shift Close from 2026-10-19) and the same clicks, measured in the Firebase Emulator.
**Before** = commit `f6e2ba9` (Weekly Plan V5, before the release review). **After** = this commit.
Cells: **queries / documents read** (Firestore bills one read per document returned, at least one per query).

| Screen | Action | Before | After | Change |
|---|---|---|---|---|
| Dashboard | open (today) | 12 / 136 | **12 / 136** | +0 / +0 |
| Dashboard | range 1 day | 12 / 155 | **12 / 155** | +0 / +0 |
| Dashboard | range 7 days | 48 / 188 | **47 / 186** | -1 / -2 |
| Dashboard | range 30 days | 185 / 326 | **184 / 324** | -1 / -2 |
| Dashboard | range 31 days | 190 / 332 | **189 / 330** | -1 / -2 |
| Dashboard | filter Shift = Day (31-day range) | 190 / 332 | **0 / 0** | -190 / -332 |
| Dashboard | filter Line = Door A (31-day range) | 190 / 332 | **0 / 0** | -190 / -332 |
| Dashboard | Refresh (31-day range) | 190 / 332 | **190 / 332** | +0 / +0 |
| Weekly Plan | open 2026-10 | 3 / 146 | **3 / 146** | +0 / +0 |
| Weekly Plan | next month | 3 / 23 | **3 / 23** | +0 / +0 |
| Weekly Plan | back to 2026-10 | 3 / 146 | **0 / 0** | -3 / -146 |
| Weekly Plan | open goal | 2 / 144 | **2 / 144** | +0 / +0 |
| Weekly Plan | open goal again | 0 / 0 | **0 / 0** | +0 / +0 |

## Per collection

| Action | Before | After |
|---|---|---|
| Dashboard · open (today) | prodV2_actualLogs 6/6, scrapLogs 2/130, scrapCloseSummary 2/0, improvements 1/0, scrapWeeklyPlans 1/0 | prodV2_actualLogs 6/6, scrapLogs 2/130, scrapCloseSummary 2/0, improvements 1/0, scrapWeeklyPlans 1/0 |
| Dashboard · range 1 day | prodV2_actualLogs 6/6, scrapLogs 2/135, scrapCloseSummary 2/12, improvements 1/0, scrapWeeklyPlans 1/2 | prodV2_actualLogs 6/6, scrapLogs 2/135, scrapCloseSummary 2/12, improvements 1/0, scrapWeeklyPlans 1/2 |
| Dashboard · range 7 days | prodV2_actualLogs 42/42, scrapLogs 2/132, scrapCloseSummary 2/12, improvements 1/0, scrapWeeklyPlans 1/2 | prodV2_actualLogs 42/42, scrapLogs 2/132, scrapCloseSummary 2/12, improvements 1/0 |
| Dashboard · range 30 days | prodV2_actualLogs 180/180, scrapLogs 2/132, scrapCloseSummary 1/12, improvements 1/0, scrapWeeklyPlans 1/2 | prodV2_actualLogs 180/180, scrapLogs 2/132, scrapCloseSummary 1/12, improvements 1/0 |
| Dashboard · range 31 days | prodV2_actualLogs 186/186, scrapLogs 1/132, scrapCloseSummary 1/12, improvements 1/0, scrapWeeklyPlans 1/2 | prodV2_actualLogs 186/186, scrapLogs 1/132, scrapCloseSummary 1/12, improvements 1/0 |
| Dashboard · filter Shift = Day (31-day range) | prodV2_actualLogs 186/186, scrapLogs 1/132, scrapCloseSummary 1/12, improvements 1/0, scrapWeeklyPlans 1/2 | nothing read |
| Dashboard · filter Line = Door A (31-day range) | prodV2_actualLogs 186/186, scrapLogs 1/132, scrapCloseSummary 1/12, improvements 1/0, scrapWeeklyPlans 1/2 | nothing read |
| Dashboard · Refresh (31-day range) | prodV2_actualLogs 186/186, scrapLogs 1/132, scrapCloseSummary 1/12, improvements 1/0, scrapWeeklyPlans 1/2 | prodV2_actualLogs 186/186, scrapLogs 1/132, scrapCloseSummary 1/12, improvements 1/0, scrapWeeklyPlans 1/2 |
| Weekly Plan · open 2026-10 | scrapLogs 1/132, scrapWeeklyPlans 1/2, scrapCloseSummary 1/12 | scrapLogs 1/132, scrapWeeklyPlans 1/2, scrapCloseSummary 1/12 |
| Weekly Plan · next month | scrapLogs 1/23, scrapWeeklyPlans 1/0, scrapCloseSummary 1/0 | scrapLogs 1/23, scrapWeeklyPlans 1/0, scrapCloseSummary 1/0 |
| Weekly Plan · back to 2026-10 | scrapLogs 1/132, scrapWeeklyPlans 1/2, scrapCloseSummary 1/12 | nothing read |
| Weekly Plan · open goal | scrapLogs 1/132, scrapCloseSummary 1/12 | scrapLogs 1/132, scrapCloseSummary 1/12 |
| Weekly Plan · open goal again | nothing read | nothing read |
