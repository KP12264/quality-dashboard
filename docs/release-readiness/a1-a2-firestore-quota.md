# A1 / A2 — Firestore Quota & Read Cost Assessment (READ-ONLY)

Date: 2026-11-07. Repository `8ab9310`; code `2a031c0`; rules unchanged since `770d500`.
Nothing was changed: no plan change, no code / rules change, no deploy, no publish, no merge, no Production read or write, Production V2 untouched.
**G2 is not approved by this report.**

**Why this matters.** Quality Dashboard (QD) and Production V2 (PV2) use the same Firebase project and the same `(default)` database (G1). The project is on **Spark** (`freeTier: true`). Firestore's free quota is per project, so QD reads and PV2 reads draw from **one shared daily allowance**.

## 1. Quota facts (from Google's documentation, via search; verify on the pricing page before deciding)

| Fact | Value |
|---|---|
| Free quota per day | **50,000 document reads**, 20,000 writes, 20,000 deletes, 1 GiB stored, 10 GiB outbound / month |
| Reset | daily at **midnight Pacific time** = **15:00 Thailand time** (14:00 while US daylight saving applies), i.e. during the Day shift |
| On Spark, when a quota is used up | requests fail with `RESOURCE_EXHAUSTED` **for every app in the project, PV2 included**, until the reset. Spark never bills |
| On Blaze | the same free quota applies first; usage beyond it is billed pay-as-you-go; nothing is blocked |
| Rules reads | reads needed to evaluate Security Rules are **billed**: each other document that `get()` / `exists()` / `getAfter()` reads, **once per document per request** |
| Free quota scope | only one database per project qualifies; here that is `(default)` |

Sources:
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Understand Cloud Firestore billing](https://firebase.google.com/docs/firestore/pricing)
- [Quotas and limits](https://docs.cloud.google.com/firestore/quotas)
- [Error codes (RESOURCE_EXHAUSTED)](https://docs.cloud.google.com/firestore/docs/understand-error-codes)

The official pages could not be opened from this session (blocked network hosts): the values come from search results and must be confirmed on the pages above. Prices per 100,000 operations for `asia-southeast1` were **not** retrieved; read them from the pricing page for the Blaze comparison.

## 2. How QD V5 reads (code review)

| Check | Finding |
|---|---|
| Real-time listeners (`onSnapshot`) | **none** in any page |
| Polling | **none**; the two `setInterval`s (Dashboard stale hint, Weekly Plan "Loaded hh:mm") only read the clock |
| Offline persistence | not enabled (no `enablePersistence`); every page load reads from the server |
| Re-reads | filter change: 0 reads within 5 min (re-use); Refresh / date change / page open: read again; the Weekly Plan re-uses a month for 5 min |
| Whole-collection reads | `improvements` is read **in full** by Dashboard, Scrap Detail and Executive Report: `limit` is applied after download, so cost grows with the number of improvements. `scrapModelMappings` is read in full by Scrap Entry |
| Biggest readers (unchanged design) | production documents: one per date × line × shift (**186 for a 31-day range**); the Attention look-back on a 1-day view (scrap logs of up to 31 days) |

### Measured reads per action (emulator, same seeded data; queries / est. reads)

V5 final code, from `generated/read-cost.md` and `generated/read-cost-before-after.md`:

| Action | Queries | Est. reads |
|---|---|---|
| Dashboard open, 1 day | 12 | 141–156 |
| Dashboard 7 days | 47 | 187 |
| Dashboard 30 days | 184 | 325 |
| Dashboard 31 days | 189 | 331 |
| Dashboard filter change (≤ 5 min) | **0** | **0** |
| Dashboard Refresh, 31 days | 190 | 333 |
| Weekly Plan, open a month | 3 | 146 |
| Weekly Plan, back to a month (≤ 5 min) | 0 | 0 |
| Weekly Plan, previous-month goal | 2 | 144 |
| Daily Confirmation (signed in) | 3 | 8 (1 + 1 + 6) |
| Scrap Entry close panel (signed in) | 4 | 4 + that slot's logs |

Est. reads = documents returned, at least 1 per query. These counts are **not** billed numbers.

### V5 compared with the Dashboard live today (`main`)

Measured offline: mock Firestore, no network; `get()` calls per action.

| Action | Live today (`main`) | V5 | Difference |
|---|---|---|---|
| Open / 1 day | 9 | 10 | +1 (weekly plans, ≤ 6 docs) |
| 7 days | 44 | 46 | +2 (plans + the card's missing days) |
| 30 days | 184 | 185 | +1 |
| 31 days | 188 | 189 | +1 |
| Filter Shift / Line (31 days) | **188 each** | **0** | **−188 each** |

V5 hardly changes the cost of opening the Dashboard and removes the largest repeated cost (filter clicks). The real daily effect depends on how often users click filters today. That figure is **not available**.

### Read cost as a formula (inputs from Production, see §5)

L = scrap logs per day (average) · I = number of `improvements` documents · D = days in the selected range.

| Action | Est. reads |
|---|---|
| Dashboard open, 1 day | 6 production docs + L × 31 (look-back) + L + I + ≤ 6 plans + ≤ 2 auth |
| Dashboard, D days | 6 × D production docs + L × D + I + ≤ 6 + missing days of the month |
| Weekly Plan, a month | L × days elapsed + ≤ 6 + close summaries (0 now; ≤ 31 after B1) |
| Executive Report, monthly | 180 production docs + L × 30 + I |
| Scrap Detail, 30 days | L × 30 + I |

## 3. A2: reads made by the rules (candidate)

| Request | Documents read by the rules (billed, once each) | Extra |
|---|---|---|
| Public read (`read: if true`): `scrapLogs`, `prodV2_*`, `productionLogs`, `targetMaster`, `improvements`, `scrapModelMappings`, `scrapCloseSummary`, `scrapWeeklyPlans` | none | **0** |
| Signed-in read of a protected collection (`qdActive()`): `scrapSlots`, `qdConfig`, plan history, review notes, `scrapLogPrivate`, `improvementOwners` | `qdUsers/{me}` | **+1 per request** |
| Reading the own role (`qdUsers/{me}`) at sign-in | `qdUsers/{me}` | +1 |
| A scrap save / edit / delete through the ledger (one transaction) | `qdUsers/{me}`, `scrapSlots/{slot}`, its event, `scrapCloseSummary/{date}`, `qdConfig/ledger` | about **+5** (rules limit: 20 per transaction), plus the transaction's own reads of the slot and summary (+2) |
| A shift close / reconfirm | about the same set | about **+5** |
| Operations (reconcile, baseline, privacy strip) | adds `qdOpsLog/{run}` | about +6 per document written |
| Today (production rules) / during the bridge for the public collections | none | 0 |

The emulator does not bill, so these numbers come from reading the rules, not from a measurement. Effect:
- **Reading dashboards adds no rule reads** (public collections).
- Rule reads come with signed-in work: about +7 per save or close, +1 per protected read.
- 1,000 saves or closes a day would add about **7,000 reads**.
- Measure the real effect in Console → Usage during the bridge and after the candidate.

## 4. QD vs PV2 (separation)

- Firestore usage (Console → Usage; Cloud Monitoring `document/read_count`) is reported **per project / database, not per app**. QD and PV2 cannot be read apart there.
- Today's total already contains today's live QD, PV2 and the legacy site. **V5 changes only QD's share**: about +1 query per load, −188 per filter click, plus rule reads for signed-in work after the candidate.
- PV2's share can be estimated as `total − QD estimate` (formula in §2 with real L, I and the number of views). It cannot be measured directly without changing code, which is out of scope here.

## 5. Real usage: **not available in this session**

This session has no access to the Firebase / Google Cloud console (G1). **No usage figure is assumed.** The Firebase owner provides, read-only:

| # | Data | Where (read-only) |
|---|---|---|
| U1 | Document **reads per day, last 14 days** (incl. the peak day), plus writes and deletes | Firebase Console → Firestore → **Usage** tab (choose the last 14 days), or Google Cloud Console → Monitoring → Metrics explorer → `firestore.googleapis.com/document/read_count`, sum per day. A screenshot or a CSV export, uploaded as a file |
| U2 | Any quota errors (`RESOURCE_EXHAUSTED`) in those 14 days | Usage tab (a hit limit shows there), or Cloud Logging filter `"RESOURCE_EXHAUSTED"` |
| U3 | L: average scrap logs per day | Console → Firestore → `scrapLogs` → Query builder with a date filter (last 30 days), count only. A count query costs about 1 read per 1,000 entries |
| U4 | I: number of `improvements` documents | Console → Firestore → `improvements` (count) |
| U5 | Expected usage: number of people / screens opening the Dashboard, Weekly Plan, Executive Report per day; saves / closes per day | owner's estimate (Production manager) |
| U6 | Prices per 100,000 reads / writes for `asia-southeast1`, Standard edition | the Firestore pricing page |

## 6. Ways to reduce reads (proposals only; each is a code change for a later approved phase)

| # | Proposal | Saves (est.) | Keeps data correct? |
|---|---|---|---|
| R1 | Read `improvements` with a server-side `limit` / order (or a count) instead of the whole collection | I − 200 per load once I > 200; protects growth | yes (only the newest / counts are shown) |
| R2 | Load the Attention look-back **when the section is on screen**, or re-use it for 5 min like the card | up to L × 31 per 1-day open | yes (same data, read later or re-used) |
| R3 | Re-use **past days'** production documents for 5 min across Refresh / date changes | up to 186 per repeated monthly view | yes within the 5-min rule; Refresh would need to force fresh |
| R4 | Keep 1 day as the default range; avoid auto-opening 31-day views | — (already so) | yes |
| R5 | No real-time listeners, no polling (keep as now) | — | yes |
| R6 | Offline persistence | does not reduce server `get()` calls; **not recommended** for this purpose | — |

Priority if A1 shows tight headroom: R2, then R1, then R3.

## 7. Spark vs Blaze

| | Spark (now) | Blaze |
|---|---|---|
| Cost | free | free quota first, then pay-as-you-go (prices: pricing page, U6) |
| When daily reads pass 50,000 | **all apps blocked until 15:00 Thailand time, PV2 included** | nothing blocked; billed |
| Cost control | automatic (hard stop) | budgets and alerts **notify but do not stop** spending unless automated |
| Other | — | needs a billing account; enables paid features (e.g. backups / PITR, check availability) |
| Main risk | an outage of PV2 caused by QD usage (or by anything else) | unexpected cost if usage spikes or is abused (public read rules) |
| Change type | — | **[ACT]** billing change: owner decision, outside this review |

## 8. Bridge duration vs the audit condition

- The exit condition (`bridge-risk.md` §4) needs **two bridge audits at least one full production day (Day + Night) apart**, with no new problem slot.
- So the bridge lasts **at least** the time from the first audit to the second: ≥ 1 production day. It cannot be "≤ 1 production day".
- **Corrected target:** minimum 1 full production day between the audits; **target 1–2 days**; extend only while audits still show new problem slots.
- During that window today's public write access stays open (G2 A3).
- Reads during the bridge are the same as today, plus Weekly Plan / close summary reads by users of the new site.
- The quota day resets at 15:00 Thailand time, so watch Usage across two quota days.

The wording in `g2-rules-review.md` (A3) is corrected accordingly.

## 9. Decision criteria (verifiable)

Let **P** = the highest daily reads in the last 14 days (U1). Let **Δ** = the V5 change, estimated with §2–3 from U3–U5: the per-load deltas, minus the saved filter re-reads, plus rule reads (+7 per save or close, +1 per protected read).

| Result | Decision (owner) |
|---|---|
| Any `RESOURCE_EXHAUSTED` in the last 14 days (U2) | **Do not cut over on Spark.** Reduce usage first (§6), or move to Blaze with a budget alert [ACT], before the bridge |
| P + Δ ≤ **25,000** (≤ 50 % of the quota) | Spark acceptable. Daily Usage check for 2 weeks (C2); stop / roll back if a day passes 40,000 |
| 25,000 < P + Δ ≤ **40,000** (50–80 %) | Spark only with R2 (+ R1) implemented and tested first, and a daily check. Prepare Blaze as the fallback |
| P + Δ > **40,000** (> 80 %) | Blaze with a budget alert before the bridge [ACT], or reduce usage first; Spark is not safe for PV2 |

During the bridge and the first 2 weeks:
- check Usage every day;
- a day above 40,000 reads triggers the owner's decision: R-bridge / R1 rollback, Blaze, or usage limits;
- any quota error stops the cutover.

## 10. Summary

| Item | Status |
|---|---|
| QD V5 read pattern (no listeners, no polling, filter re-use) | **PASS** |
| V5 vs live Dashboard: about +1 query per load, −188 per filter click | **PASS** (measured offline) |
| A2 rule reads quantified (0 for public reads; about +7 per save / close; +1 per protected read) | **PASS** (from the rules; to be confirmed in Usage) |
| A1 headroom on the shared Spark quota | **PENDING DATA**: U1–U6 from the Firebase owner |
| Plan choice (Spark / Blaze) | **PENDING APPROVAL** (cost owner + PV2 owner) using §9 |
| G2 | **not approved**; A1 decision first |
