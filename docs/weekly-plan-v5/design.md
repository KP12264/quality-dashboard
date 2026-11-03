# Weekly Plan V5 — Design for Approval (no implementation yet)

Status: **design only**. No code, rules or data changed for Weekly Plan. Baseline `a8e4075`.
Scope agreed: daily target ≤ 50 pcs; weekly + monthly scrap budget; admin plan / override; Actual,
Remaining, Achievement and data-completeness; the Dashboard's own scrap data (no extra reads);
Shift Close status from the existing system; missing data ≠ 0; Door A+B+C total with Line and Shift
detail; recurring defects in "Improve" **not split by Line**.

---

## 1. Where it lives

| Place | What | Who |
|---|---|---|
| Dashboard V5 → new **Scrap Budget** card (below the KPI row) | this week + this month at a glance, link "Weekly Plan →" | everyone (public, like the Dashboard) |
| New V5 page **`weekly-plan.html`** (sidebar item "Weekly Plan", between Dashboard and Scrap Entry) | month view: weeks, days, Line × Shift detail, Improve, plan editing | everyone reads; Admin edits plans; signed-in users read review notes |
| `plan-tracking.html`, `weekly-review.html` | retired with the existing guard once this page ships (redirect → `weekly-plan.html`) | — |

## 2. Wireframes

### 2.1 Dashboard V5 — Scrap Budget card (desktop)

```
┌ Scrap Budget · Nov 2026 ─────────────────────────────────────── Weekly Plan → ┐
│ THIS WEEK  W1 (03–09 Nov)            │ THIS MONTH (as of 03 Nov)              │
│ Actual   38 pcs  of plan 350          │ Actual   96 pcs  of budget 1,500      │
│ Remaining 312 pcs · used 11%          │ Remaining 1,404 pcs · used 6%         │
│ ▕██░░░░░░░░░░░░░░░░▏                   │ ▕█░░░░░░░░░░░░░░░░░▏                    │
│ Daily target ≤50 · today 12 (so far)  │ Days over 50: 0 of 3                  │
│ ⚠ 1 day not fully confirmed (5/6)     │ ⚠ 2 of 3 days not final               │
└───────────────────────────────────────────────────────────────────────────────┘
```
- "used %" = Actual ÷ Plan. Colours: ≤ plan-to-date = green, above = red; **not final** = hatched/amber.
- Before Shift Close is required (`QD_CLOSE_REQUIRED_FROM`), the warning reads "x of y days have no scrap log yet (not counted as 0)".
- Mobile (≤ 640 px): the two halves stack; bars full width; link becomes a full-width button.

### 2.2 `weekly-plan.html` — month view (desktop)

```
Weekly Plan                                         [ ◀ Oct 2026 | Nov 2026 ▼ | Dec ▶ ]
Daily target ≤50 pcs/day · Door A+B+C · Day+Night combined

┌ Month ───────────────────────────────────────────────────────────────────────────┐
│ Budget 1,500 (= Σ weekly plans) │ Actual 96 │ Remaining 1,404 │ Used 6% │ Projection 960 │
│ Data: 1 of 3 days final · 2 not final (Pending 1, Changed 1) · 0 Conflict          │
└──────────────────────────────────────────────────────────────────────────────────┘
┌ Weeks ───────────────────────────────────────────────────────────────────────────┐
│ Week │ Days   │ Plan        │ Actual │ Remaining │ Used │ Status        │ Data     │
│ W1   │ 01–02  │ 100         │ 58     │ 42        │ 58%  │ ON TRACK      │ 2/2 final │
│ W2   │ 03–09  │ 350 (✎ 300) │ 38*    │ 262*      │ 13%  │ NOT FINAL     │ 0/1 final │
│ W3…  │        │ 350         │ —      │ —         │ —    │ NOT STARTED   │ —        │
│ *so far — includes days not confirmed                      [Admin: Edit plan ✎]  │
└──────────────────────────────────────────────────────────────────────────────────┘
┌ Days of W2 ──────────────────────────────────────────────────────────────────────┐
│ Date   │ Scrap │ ≤50 │ Status (Target Evaluator) │ Shifts confirmed │ A │ B │ C    │
│ 03 Nov │ 38    │ ✓   │ INCOMPLETE (Pending)       │ 5/6              │12 │20 │ 6    │
└──────────────────────────────────────────────────────────────────────────────────┘
┌ Line × Shift (selected week) ───────────┐  ┌ Improve — recurring defects (all lines) ┐
│        Day   Night   Total              │  │ Defect        Model   Days Qty Lines    │
│ Door A  8      4      12                │  │ Dent          M-100   4    22  A, C     │
│ Door B 12      8      20                │  │ Scratch       M-200   3    11  B        │
│ Door C  6      0       6                │  │ [Create improvement →]                  │
│ Total  26     12      38                │  └─────────────────────────────────────────┘
└─────────────────────────────────────────┘
┌ Review note (signed-in only) ─────────────────────────────────────────────────────┐
```
- Admin "Edit plan": per week, `Plan override (pcs)` + `Reason` (required) → saved with history.
- Mobile: month summary → weeks as cards (one per week) → tap a week for days / Line × Shift / Improve.

## 3. Calculations (one module, pure, unit-tested: extend `js/scrap-plan-calc.js`)

| Value | Definition |
|---|---|
| Scope | **exactly the Target Evaluator scope**: lines A/B/C **and** shifts DAY/NIGHT (today's plan code also counts other shift codes — fixed) |
| Daily target | `DAILY_TARGET_PCS` (50), per production day, Door A+B+C, Day+Night |
| Week | Mon–Sun clipped to the month (unchanged) |
| Base weekly plan | 50 × days in the week |
| Weekly plan | Admin override if set, else base |
| Monthly budget | Σ weekly plans (so overrides flow into the month); shown with "base 50 × days" for reference |
| Actual | Σ scrap of the days elapsed (as-of = today or the month end) |
| Remaining | Plan − Actual (may be negative = over) |
| Used / Achievement | Actual ÷ Plan (%); **Plan-to-date** = Plan × elapsed days ÷ days |
| Week status | NOT STARTED · ON TRACK (Actual ≤ plan-to-date) · OVER (Actual > plan-to-date) · **NOT FINAL** (any elapsed day not final and Actual ≤ plan-to-date) · READ ERROR |
| Day final? | from the **same `TargetEvaluator.evaluate` units the Dashboard uses**: final = WITHIN, OVER, NO PRODUCTION (and, before `QD_CLOSE_REQUIRED_FROM`, a day with production and scrap logs); not final = INCOMPLETE, CONFLICT, NO DATA, READ ERROR |
| Missing data | a day with no scrap log is **unknown**, never 0: Actual is shown as "so far" (`*`), the week cannot be ON TRACK-final, Remaining is labelled "at most" |
| OVER is certain | if Actual of final + reliable days already > plan, the week is OVER even with days not final (same principle as the daily OVER) |
| Line × Shift detail | Σ per line/shift from the same records; totals row = Door A+B+C |
| Improve (recurring) | group by **model + defect, across all lines** (line is NOT part of the key); show distinct days, qty, and the lines involved as info; threshold = `RECURRING_THRESHOLD_DISTINCT_DATES` (new function; the existing per-line one used by Scrap Detail / Executive Report stays unchanged) |

## 4. Data model

| Collection | Fields | Read | Write | Notes |
|---|---|---|---|---|
| `scrapWeeklyPlans/{ym}_{W#}` (existing name) | `ym`, `week`, `planOverride` (int ≥ 0 or null), `updatedAt` | public | Admin, with a history entry in the same commit | numbers only; **`reviewNote` removed** from this public doc |
| `scrapWeeklyPlans/{id}/history/{n}` (new) | `from`, `to`, `reason` (3–200), `at`, `by` | signed-in QD users | Admin, create only | audit of every override change; not public (has e-mail + free text) |
| `scrapWeeklyReviews/{ym}_{W#}` (new) | `reviewNote` (≤ 2000), `updatedAt` | signed-in QD users | Admin | free text kept off public documents (G4 policy B) |
| config (`js/config.js`) | `QD_WEEKLY_PLAN_COLLECTION`, `QD_WEEKLY_REVIEW_COLLECTION`, `QD_MONTHLY_REDUCTION_GOAL` | — | — | restores what `3c28849` removed, under new names, unit-tested |

Production today denies `scrapWeeklyPlans` entirely, so no old documents need migrating.

## 5. Rules impact (candidate; not published)

```
match /scrapWeeklyPlans/{id} {
  allow read: if true;                                   // numbers only (decision G4)
  allow write: if qdAdmin() && qdNoNewPersonal()
    && request.resource.data.keys().hasOnly(['ym','week','planOverride','updatedAt','historyRev'])
    && (request.resource.data.planOverride == null
        || (request.resource.data.planOverride is int && request.resource.data.planOverride >= 0
            && request.resource.data.planOverride <= 100000))
    && request.resource.data.historyRev == resource.data.get('historyRev', 0) + 1
    && existsAfter(/databases/$(database)/documents/scrapWeeklyPlans/$(id)/history/$(string(request.resource.data.historyRev)));
  match /history/{n} {
    allow read: if qdActive();
    allow create: if qdAdmin() && request.resource.data.by == qdEmail() && request.resource.data.at == request.time
      && request.resource.data.reason is string && request.resource.data.reason.size() >= 3;
    allow update, delete: if false;
  }
}
match /scrapWeeklyReviews/{id} {
  allow read: if qdActive();
  allow write: if qdAdmin() && request.resource.data.keys().hasOnly(['reviewNote','updatedAt'])
    && request.resource.data.reviewNote is string && request.resource.data.reviewNote.size() <= 2000;
}
```
Changes vs the current candidate: `scrapWeeklyPlans` gets field validation + mandatory history (today: any admin write); review notes move to a non-public collection. Opened permissions: +2 paths for signed-in reads (history, reviews). If G4 decides plan numbers are not public, change `allow read` to `qdActive()` (the public Dashboard card would then hide for visitors). Budget impact: one `existsAfter` per plan write — negligible.

## 6. Read-cost impact (Firestore document reads)

| Screen | Today | With Weekly Plan V5 | How it is kept low |
|---|---|---|---|
| Dashboard, single day (default) | main range query (1 day) + 30-day lookback query (Attention) + production 6 + summary ≤ 1 | **same queries**; the lookback window becomes `min(date − 29, month start) … date` (≤ 31 days → at most **+1 day** of scrap logs); + **≤ 6** plan docs; + **≤ 31** close-summary docs only after `QD_CLOSE_REQUIRED_FROM` | the card is computed from the lookback records already loaded (no new scrap query) |
| Dashboard, range | range query + production + summary | range query **start moved to the month start** when the range starts later in the month (extra = scrap logs of those days); + ≤ 6 plan docs | still one scrap query |
| `weekly-plan.html` | (broken today) | 1 scrap query for the month + production 6 × days (≈ 180, same as a 30-day Dashboard) + ≤ 31 summary + ≤ 6 plans (+ ≤ 6 reviews signed-in) | previous-month comparison loaded only when the user opens it (otherwise a second month of logs) |
| Admin plan save | — | 1 plan write + 1 history write (+ 1 read) | — |

No `onSnapshot` / timers. The card does not read production for the whole month: its completeness uses closes (after go-live) or "days with scrap logs" (before), so it never claims a day is fine without evidence.

## 7. Test plan (for implementation)

| Level | Tests |
|---|---|
| Unit (pure calc) | weeks clipping (month starting Sunday / 28–31 days); base plan, override, monthly = Σ weeks; Actual / Remaining / Used / plan-to-date; scope = A/B/C × DAY/NIGHT only (old Thai shift codes excluded); missing day ≠ 0 ("so far", NOT FINAL); OVER certain with non-final days; day final mapping from TargetEvaluator statuses incl. before/after `QD_CLOSE_REQUIRED_FROM`; Line × Shift sums = total; recurring grouped by model + defect across lines (same defect on A and C = one row with lines "A, C"); config constants present |
| Rules (emulator) | plan write: Admin + history required, Leader/Viewer/anonymous refused, invalid override refused, no e-mail field; history immutable, not public; reviews signed-in read only, Admin write; public can read plan numbers; budget test still green |
| E2E (emulator) | Dashboard card numbers = page numbers = calc; **read count**: Dashboard default load adds ≤ 1 day of scrap logs + ≤ 6 plan docs, no extra scrap query; card hidden/locked states; weekly page month switch; Admin edit with reason → history; Leader cannot edit; signed-in sees review note, public does not; Shift Close states shown (Pending / Changed / Conflict / No production); mobile 390 px no horizontal scroll; old pages redirect to `weekly-plan.html` |
| Regression | off-mode Dashboard matrix: **expected diff only in the new card** (new baseline after approval); Executive Report unchanged (ix); PV2 compatibility unchanged |

## 8. Implementation steps (after approval)

1. Config constants + calc module (scope fix, statuses, recurring-by-model+defect) + unit tests
2. Rules for plans/history/reviews + rules tests (emulator only)
3. `weekly-plan.html` (V5) + admin edit + review notes + E2E
4. Dashboard Scrap Budget card (reusing loaded data) + read-count E2E + regression baseline update
5. Retire `plan-tracking.html` / `weekly-review.html` → `weekly-plan.html`

## 9. Questions for approval

1. Recurring key in "Improve": **model + defect** (proposed) or **defect only**?
2. Should plan numbers be public (Dashboard card for visitors) or signed-in only?
3. Monthly budget = Σ weekly plans (proposed) — or a separate monthly override?
4. Keep the previous-month reduction goal (`MONTHLY_REDUCTION_GOAL`, 50 %) on the page?
