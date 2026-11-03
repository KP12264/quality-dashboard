# Weekly Plan Integration — Proposal (no structural change made)

## 1. What exists today

| Item | State |
|---|---|
| `js/scrap-plan-calc.js` (pure) | Monthly target = `DAILY_TARGET_PCS × days in month`; weeks Mon–Sun clipped to the month; weekly plan = `50 × days in week` unless overridden; status per week ON_TARGET / OVER from **cumulative actual vs plan**; previous-month comparison with `MONTHLY_REDUCTION_GOAL`. |
| `scrapWeeklyPlans/{ym}_{W#}` | `{ ym, week, planOverride, reviewNote, updatedAt }` — written by admins only (candidate rules) |
| `plan-tracking.html`, `weekly-review.html` | not in V5 navigation; **broken since `3c28849`** (config constants removed); production rules deny the collection |

## 2. Relationship with the daily target (≤ 50 pcs/day)

| | Daily target (Target Evaluator) | Weekly / monthly plan |
|---|---|---|
| Unit | one production day, Door A+B+C, Day+Night | a week / the month, cumulative |
| Limit | ≤ 50 per day | 50 × days (or override) |
| Shift Close | from `QD_CLOSE_REQUIRED_FROM`: a day is final only with 6/6 shifts confirmed (INCOMPLETE / CONFLICT / READ ERROR otherwise) | not aware of closes today |
| Records counted | lines A/B/C **and** shifts DAY/NIGHT | lines A/B/C, **any shift code** (old "เช้า"/"ดึก" records would count) — mismatch to fix |
| A day over 50 | OVER for that day | can still be "on plan" if other days were low |

So the weekly plan is a *budget* view on top of the daily target, not a replacement. Both must read the same records with the same scope.

## 3. Proposed design (V5)

**UI** — a "Plan" card on the Dashboard V5 + a V5 page `weekly-plan.html` (sidebar item "Weekly Plan"); the old pages stay retired-ready (P7-2 → retire after this ships).

```
Dashboard V5
┌ KPI row … ┐  ┌ Plan this month ───────────────────────────────┐
              │ Nov 2026  MTD 412 / plan 450 pcs  ● on plan       │
              │ W1 ▇▇▇▇ 88/100  W2 ▇▇▇▇▇▇ 160/150 ▲  W3 …          │
              │ 2 days not confirmed yet (Shift Close) → details  │
              └───────────────────────────────────────────────────┘
weekly-plan.html (V5 layout): month picker · weeks table (plan, override, actual,
gap, status, days confirmed n/d) · admin: edit override · review note (signed-in)
```

**Data flow**
1. Reuse the Dashboard's single `scrapLogs` range query for the month (no second read of scrap logs).
2. Scope = exactly the Target Evaluator scope (A/B/C × DAY/NIGHT) — fix the shift-code mismatch in `scrap-plan-calc.js`.
3. Plan numbers from `scrapWeeklyPlans` (≤ 6 docs/month).
4. From `QD_CLOSE_REQUIRED_FROM`: a week is **final** only when all its days are confirmed (reuse `scrapCloseSummary`, already loaded for the Dashboard); otherwise show "not final" — never treat a missing close as 0.
5. Restore the two config constants under new names in `js/config.js` (with tests), not the old pages.

## 4. Does `scrapWeeklyPlans` need public read?

| Field | Personal? | Needed by the public Dashboard? | Proposal |
|---|---|---|---|
| `planOverride`, `ym`, `week` | no | yes (the Plan card is public like the rest of the Dashboard) | keep **public read** |
| `reviewNote` (free text) | can contain names | no | move to `scrapWeeklyReviews/{ym}_{W#}` — **signed-in read**, admin write |
| `updatedBy` | — | — | already never written (Phase 7) |

If the Plan card should be sign-in only, `scrapWeeklyPlans` can become signed-in read instead (G4 decision).

## 5. Effort / order (after approval)

1. config constants + scope fix + unit tests (small)
2. Plan card on Dashboard V5 (medium) — off-mode Dashboard regression must stay unchanged except the new card
3. `weekly-plan.html` V5 page + admin override + private review notes (medium)
4. retire `plan-tracking.html` / `weekly-review.html` with the guard (small)
