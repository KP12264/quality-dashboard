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

---

## Update 1, 2026-11-07: U1 real usage received

Received: `u1-reads.json`, Cloud Monitoring `firestore.googleapis.com/document/read_count`, project `daily-production-report-46b60`, daily sums, collected read-only by the owner. Stored unchanged as `evidence/u1-reads.json` (SHA-256 `5231d15a…cebbd9`; no token).

### Data check

| Check | Result |
|---|---|
| Series | 1 (`firestore_instance`, whole project / database; QD and PV2 together) |
| Points | **14**, each exactly 24 h, **UTC days** 2026-10-24 00:00Z … 2026-11-07 00:00Z |
| Gaps / overlaps / duplicates | **none** |
| Total / mean | 130,057 reads; 9,290 per day |

### Daily reads (UTC day = 07:00 → 07:00 Thailand time)

| UTC day | Reads | % of 50,000 |
|---|---|---|
| Sat 24 Oct | 323 | 0.6 % |
| Sun 25 Oct | 323 | 0.6 % |
| Mon 26 Oct | 5,088 | 10.2 % |
| **Tue 27 Oct** | **49,720** | **99.4 %** |
| Wed 28 Oct | 5,424 | 10.8 % |
| Thu 29 Oct | 21,375 | 42.8 % |
| Fri 30 Oct | 6,437 | 12.9 % |
| Sat 31 Oct | 335 | 0.7 % |
| Sun 1 Nov | 335 | 0.7 % |
| Mon 2 Nov | 7,509 | 15.0 % |
| Tue 3 Nov | 5,958 | 11.9 % |
| Wed 4 Nov | 12,595 | 25.2 % |
| Thu 5 Nov | 6,161 | 12.3 % |
| Fri 6 Nov | 8,474 | 16.9 % |

Pattern: weekends about 330 reads a day; ordinary weekdays 5,000–12,600 (10–25 %); two spikes, 27 Oct (99.4 %) and 29 Oct (42.8 %).

### Quota days (Pacific time) vs these UTC days

The quota resets at midnight Pacific time (to be confirmed on the pricing page):
- until 1 Nov (PDT): 07:00 UTC = 14:00 Thailand time;
- from 1 Nov (PST): 08:00 UTC = 15:00 Thailand time.

Each quota day therefore covers 17 h of one UTC day and 7 h of the next, and **daily buckets cannot be converted exactly**. Bounds:

| Quota day (PT) | Window (UTC) | Lower bound | Upper bound |
|---|---|---|---|
| 26 Oct | 26 Oct 07:00 → 27 Oct 07:00 | — | 5,088 + 49,720 = 54,808 |
| 27 Oct | 27 Oct 07:00 → 28 Oct 07:00 | — | 49,720 + 5,424 = 55,144 |

- The 49,720 reads of UTC 27 Oct fall into quota days 26 and 27 Oct, so at least one of them had **≥ 24,860** reads.
- Whether either **passed 50,000** cannot be decided from daily data.
- All other quota days stay **below 50,000** even at their upper bound. The highest is 21,375 + 6,437 = 27,812 for 29 Oct.

**Hourly data is needed** (read-only, see "Still needed" below).

### The 27 Oct spike: verifiable facts only (no cause assumed)

- The live Quality Dashboard (`main`) was deployed on 30 Oct 02:25–03:25 Thailand time (29 Oct 19:25–20:25 UTC; `git log origin/main`). That is **after** 27 Oct: no QD deploy happened that day.
- `main` has no listeners, no polling and no offline persistence (code check), so an idle open tab does not read.
- This development work never connected to Production (emulator only; no credentials).
- The metric counts the **whole project**: it cannot say whether the reads came from QD, PV2 or the legacy site.
- Possible sources, **each to be checked, none assumed**: heavy QD use (e.g. 31-day views and filter clicks, about 188 queries / 330 reads each), an Excel import or bulk work, PV2 use, a script or tool reading the database.

### A1 re-assessment (G2 **not** approved)

| Criterion (§9) | Value | Result |
|---|---|---|
| P = highest daily reads, last 14 days | **49,720** (UTC day; the quota day is unknown, up to 55,144) | **> 40,000** |
| Quota error in the last 14 days (U2) | not yet known; 27 Oct came within 0.6 % of the quota | **U2 needed** |
| Ordinary weekday | 5,000–12,600 (10–25 %) | low |

**A1 = HIGH risk, confirmed by real data.** The project **already** came within 0.6 % of the Spark quota on one day, without V5. On such a day a small extra load from any app, QD or PV2, could block **all** apps including PV2 until 14:00 / 15:00 Thailand time.

Per §9 (> 40,000): **Spark is not safe for PV2 as things are**. Before the bridge, either:
- **explain and prevent** the 27 Oct spike and keep usage below 40,000 a day; or
- move to **Blaze with a budget alert** [ACT, owner decision].

V5 itself makes the Dashboard cheaper per filter click. Its daily Δ still needs U3–U5.

### Still needed (read-only)

| # | Data | How |
|---|---|---|
| U1h | **Hourly** reads for 26 Oct 00:00Z – 29 Oct 00:00Z (and 29–30 Oct for the second spike) | same request as U1, with `aggregation.alignmentPeriod=3600s`, `interval.startTime=2026-10-26T00:00:00Z`, `interval.endTime=2026-10-31T00:00:00Z`; this gives exact quota-day totals and the hour of the spike |
| U2 | Quota errors | `firestore.googleapis.com/api/request_count` grouped by `metric.label.response_code` (and by `metric.label.method` for queries vs gets), same days: any `RESOURCE_EXHAUSTED`? |
| U2m | **Queries vs document reads** at the spike | `api/request_count` by `metric.label.method` (e.g. RunQuery, BatchGetDocuments) hourly over the same window: many requests with few documents each vs few requests with many documents |
| U3–U5 | scrap logs / day, number of improvements, users and views per day | as in §5 |
| — | What happened on 27 Oct (07:00 Thailand time 27 Oct → 07:00 28 Oct): imports, PV2 work, testing, a tool or script | Production manager / PV2 owner |

### Ways to reduce reads and protect PV2 (proposals; each is a separate decision)

| # | Measure | Protects PV2 how | Type |
|---|---|---|---|
| P1 | Find the source of the 27 Oct spike (U1h, U2m, owners' records) and stop it from recurring | removes the known near-quota event | read-only analysis |
| P2 | Cloud Monitoring **alert** on `document/read_count` > 35,000 per day (notification only) | early warning before the cap | **[ACT]** monitoring config, owner decision |
| P3 | Blaze + budget alert | the cap no longer blocks PV2; cost risk instead | **[ACT]** billing, owner decision |
| P4 | QD read reductions R2 (lazy / re-used look-back), R1 (`improvements` server-side limit), R3 (re-use past production days) | lowers QD's share; filter re-use already done in V5 | code, later approved phase |
| P5 | Keep the QD cutover **off** heavy days; bridge starts on an ordinary weekday; watch hourly reads during the bridge | avoids stacking QD changes on a spike | operational |
| P6 | Long term: daily aggregate documents for production / scrap (one read instead of up to 186 per month view) | largest structural reduction | design change, involves PV2 data, separate phase |

**Status: A1 = HIGH (confirmed by U1). G2 = not approved.** Next: U1h, U2 / U2m and an explanation of 27 Oct.

---

## Update 2, 2026-11-09: hourly reads (U1h), requests (U2 / U2m) received

Collected read-only by the Firebase owner in Cloud Shell with `a1-collect.sh` v4 (only GET calls to the Cloud Monitoring API). Evidence, hashes and the redaction note: [`evidence/a1-usage-20261109/`](evidence/a1-usage-20261109/README.md). Package SHA-256 `540be6c0…72fe8` (matches the owner's Cloud Shell output).

### Data check

- Collector exit 3 = **INCOMPLETE**; failures: none; warnings: none. `verify.py` was re-run here on a copy of the data: identical report, byte for byte.
- Window: 2026-10-26T00:00Z → 2026-11-02T00:00Z, 168 hourly buckets, one query per (metric, resource type).
- `read_count` exists only on `firestore_instance` (resource label `project_id` only). `request_count` exists on **two** resource types: `datastore_request` and `firestore.googleapis.com/Database`. They are kept separate and never added.
- U1h = U1t in every hour; U2 and U2m = U2t in every hour, for both request types.
- **U1 reference: all 7 UTC days match exactly** (26 Oct 5,088 … 27 Oct 49,720 … 1 Nov 335).
- The 98 hours without a read point all lie inside matched days → consistent with zero reads.
- Why INCOMPLETE: 63 hours have reads but **no** request point in either request type (see "Requests" below).

### Hourly reads (UTC; Thailand = UTC+7; columns = hour ending 01…24 UTC; `.` = no point, consistent with 0)

All reads are `type=QUERY`; `type=LOOKUP` is 0 for the whole window; `module` / `version` are `__unknown__`.

```
26 Oct  .  496    .  489  1450  488  622   19  135  118  946    0 .  .  .  .  .  .  325   .    .    .    .    .
27 Oct  . 1308 1131  366 22636  715  113  109    6  127    6    6 125 .  .  .  .  9316 13701  0   55    .    .    .
28 Oct  2 1439  896  233   261  112    7  320 1091  319    .    8 339 0  . 62  .    .  335   .    .    .    .    .
29 Oct 34 1546 7408  990   118  107  124  187  199  124  128    7   . 120 .  .  .  329  497  359 2764 1878 3187 1269
30 Oct 23 4169    .    .     .    .    .    .    .    .  349    .   . 425 1136 . .  .  335   .    .    .    .    .
31 Oct  .    .    .    .     .    .    .    .    .    .    .    .   .  .  .  .  .  .  335   .    .    .    .    .
1 Nov   .    .    .    .     .    .    .    .    .    .    .    .   .  .  .  .  .  .  335   .    .    .    .    .
```

### Reads per Pacific quota day (exact; DST handled)

| PT quota day | UTC window | Reads | % of 50,000 | Data |
|---|---|---|---|---|
| 25 Oct | 07Z 25 → 07Z 26 | ≥ 3,545 | – | partial (window starts 00Z 26) |
| **26 Oct** | 07Z 26 → 07Z 27 | **27,812** | **55.6 %** | exact |
| **27 Oct** | 07Z 27 → 07Z 28 | **26,401** | **52.8 %** | exact |
| 28 Oct | 07Z 28 → 07Z 29 | 12,801 | 25.6 % | exact |
| 29 Oct | 07Z 29 → 07Z 30 | 15,240 | 30.5 % | exact |
| 30 Oct | 07Z 30 → 07Z 31 | 2,245 | 4.5 % | exact |
| 31 Oct | 07Z 31 → 07Z 1 Nov | 335 | 0.7 % | exact |
| 1 Nov | 07Z 1 → 08Z 2 Nov (25 h) | ≥ 335 | – | partial |

The 49,720 of Update 1 was a **UTC-day** total. It straddles the quota reset (14:00 Thailand time) and splits into 27,812 + 26,401. **No quota day passed 50,000 by this metric.** This is a metric value, not the Spark quota ledger.

### Hours with unusual reads

| UTC | Thailand | Reads | Facts |
|---|---|---|---|
| 27 Oct 04–05 | **27 Oct 11:00–12:00** | **22,636** | 45 % of the daily quota in one hour; QUERY; no request point |
| 27 Oct 17–18 | **28 Oct 00:00–01:00** | 9,316 | after midnight; no request point |
| 27 Oct 18–19 | **28 Oct 01:00–02:00** | 13,701 | same hour as the daily 2 × ListDocuments |
| 29 Oct 02–03 | 29 Oct 09:00–10:00 | 7,408 | |
| 29 Oct 20 – 30 Oct 00 | **30 Oct 03:00–07:00** | 9,098 (2,764 / 1,878 / 3,187 / 1,269) | four night hours in a row |
| 30 Oct 01–02 | 30 Oct 08:00–09:00 | 4,169 | |

Recurring: **every day at 01:00–02:00 Thailand time** there are exactly **2 ListDocuments** requests; on ordinary days that hour has 325–335 reads, which is the whole weekend total (335 per day).

### Requests (U2 by response code, U2m by method)

| Resource type | response_code | api_method | Total | Hours |
|---|---|---|---|---|
| `datastore_request` | OK 14 | ListDocuments 14 | 14 | 7 (01:00–02:00 Thailand, daily) |
| `firestore.googleapis.com/Database` | OK 14 | ListDocuments 14 | 14 | the same 7 hours, identical values |

Facts:
- The whole week has **14 requests** (all ListDocuments, all OK) against **88,714 reads**.
- **`api/request_count` does not reflect the applications' traffic.** The two resource types match in 7 of 7 hours: consistent with the same requests being reported twice.
- **No `RESOURCE_EXHAUSTED`** appears, but because the apps' traffic is not in this metric, this **does not show** that the apps never hit the quota.
- Consequence for §9: the first row ("any `RESOURCE_EXHAUSTED` in U2") **cannot be evaluated with `api/request_count`**. It needs another source: the Console Usage / Quotas pages, or the apps' own error reports.

Possible reasons why requests are missing (hypotheses, not verified):
1. The web SDK used by QD and PV2 sends queries over a streaming channel (Listen / WebChannel) that this metric does not count; only unary calls such as ListDocuments appear.
2. The metric covers only some API surfaces or clients.

### 27 Oct: facts and hypotheses

Facts:
- UTC 27 Oct = 49,720 reads, mostly in two blocks:
  - 22,636 reads at 11:00–12:00 Thailand on 27 Oct;
  - 23,017 reads at 00:00–02:00 Thailand on 28 Oct.
- All reads are QUERY. No request point exists for either block, apart from the 2 routine ListDocuments.
- The QD `main` deploy was 30 Oct 02:25–03:25 Thailand (Update 1), after 27 Oct. QD code has no listeners and no polling. This work never connected to Production.

Correlation only, cause not shown:
- The 30 Oct 03:00–07:00 reads (9,098) start right after the QD deploy window; post-deploy checking is possible.

Hypotheses (each to be checked; none assumed):
- 22,636 reads in one hour equal about 120 QD 31-day views (about 189 reads each), or one query or script reading a large collection.
- The midnight block suggests a script, a scheduled job, an import or night work rather than ordinary daytime use.
- The daily 01:00 ListDocuments looks like a scheduled job (e.g. a backup script); its owner is unknown.

### Limits on attributing reads to QD, PV2 or legacy

- `read_count` labels are `module`, `version` (both `__unknown__`) and `type`; the resource has only `project_id`. **No label identifies the app, user or collection.**
- `request_count` does not cover the apps' traffic, so the API method cannot separate them either.
- Attribution needs timing correlation plus records from the owners. GitHub Pages has no access log here, and Data Access audit logs are off (they are **not** to be turned on without a separate decision).

### A1 status after Update 2 (G2 **not** approved)

| Criterion (§9) | Value | Result |
|---|---|---|
| P = highest **quota-day** reads | **27,812** (55.6 %) | 25–40k band: Spark only with mitigation |
| Highest single hour | 22,636 (45 % of the quota) | a repeat inside a busy quota day could pass 50,000 |
| Quota errors | not measurable with `request_count` | open |
| Source of the spikes | unknown | open |

**A1 stays HIGH.** The measured peak is lower than Update 1 suggested (55.6 %, not 99.4 %). But the source of the spikes is unknown, a single hour reached 45 % of the quota, and there is no request-side evidence. Lowering A1 is a separate owner decision once the sources are known. **G2 remains NOT APPROVED.**

### Next (read-only; each step approved separately before it runs)

1. List the Firestore metrics that really exist (`metricDescriptors.list`, filter `starts_with("firestore.googleapis.com/")`).
2. Hourly reads vs writes vs deletes for 26–30 Oct; listener / connection and rules-evaluation metrics if they exist.
3. Read existing **Admin Activity** audit logs (always on; reading changes nothing) for import, export, index or database changes.
4. Owners: who or what runs at 01:00 Thailand daily, and what happened at the hours in the table above.

---

## Update 3, 2026-11-09: what the reads were (metric list, writes, deletes, listeners, connections, rules)

Collected read-only by the Firebase owner in Cloud Shell with `a1-investigate.sh` v1, steps 1-2 only (only GET calls to the Cloud Monitoring API; no audit logs). Evidence and hashes: [`evidence/a1-investigate-20261109/`](evidence/a1-investigate-20261109/README.md). Package SHA-256 `405b323f…0648` (matches the owner's value).

### Data check

- Collector exit 0 = **PASS**; warnings none; failures none. `verify.py` was re-run here on a copy of the data: identical report, byte for byte.
- Window 2026-10-26T00:00Z → 2026-10-31T00:00Z (120 hours), one query per (metric, resource type).
- `read_count` equals the Update 2 evidence in **all 120 hours**, and U1 on all 5 days.
- The API lists **31 Firestore metrics** (`metric-list.txt`). Collected: `document/read_count`, `write_count`, `delete_count`, `network/active_connections`, `network/snapshot_listeners`, `rules/evaluation_count`. `network/active_ignite_connections` exists but has no data in the window.
- Connections, listeners and rules evaluations are reported under both `firestore_instance` and `firestore.googleapis.com/Database` with **identical values in every hour**: one copy is used, nothing is added.

### Totals, 26-30 Oct (UTC)

| Metric | Total / max | Facts |
|---|---|---|
| Reads | 88,044 | all `type=QUERY`; `LOOKUP` = 0 |
| Writes | 3,370 | UPDATE 3,075 · CREATE 282 · UPDATE_NOOP 13; per day 770 / 911 / 864 / 692 / 133; highest hour 301 |
| Deletes | **1** | 28 Oct 01:00-02:00 Thailand |
| Active connections (gauge, max) | 5-9 per day | |
| Snapshot listeners (gauge, max) | 1 / **8** / 2 / **29** / 1 per day | |
| Rules evaluations | 26,617, all ALLOW, ruleset `STABLE` | GET 21,975 · LIST 4,270 · UPDATE 3,088 · CREATE 282 · DELETE 1 |

Every hour with reads also has rules evaluations.

### Two read patterns (reads ÷ rules GET+LIST evaluations)

**Pattern A: many documents per evaluation (about 9-23)**

| Thailand | Reads | Rules GET / LIST | Writes upd / create | Listeners max |
|---|---|---|---|---|
| **27 Oct 11-12** | **22,636** | 592 / 856 | 130 / 0 | **8** |
| 28 Oct 00-01 | 9,316 | 69 / 337 | 12 / 49 | 0 |
| 28 Oct 01-02 | 13,701 | 998 / 500 | 27 / 19 (+1 delete) | 1 |
| 29 Oct 09-10 | 7,408 | 139 / 286 | 272 / 7 | 0 |
| 26 Oct 11-12 | 1,450 | 23 / 71 | 4 / 0 | 0 |

**Pattern B: about 1 read per GET evaluation (0.7-1.2), i.e. many single-document reads**

| Thailand | Reads | Rules GET / LIST | Writes | Listeners max |
|---|---|---|---|---|
| 29 Oct 08-09 | 1,546 | 1,564 / 175 | 165 | 0 |
| **30 Oct 03-07** (4 h) | 9,098 | 10,198 / 357 | 0 | 0-7 |
| 30 Oct 08-09 | 4,169 | 3,956 / 191 | 82 | 1 |
| 30 Oct 21-22 | 1,136 | 1,476 / 31 | 0 | 0 |

### Facts

- **No unusual hour looks like an import:** at most 130 UPDATE and 0-49 CREATE in the spike hours.
- **Snapshot listeners are in use on this project:** 8 at the same time during the 22,636-read hour, 29 at 29 Oct 14:00-15:00 Thailand (only 187 reads that hour).
- **QD has no `onSnapshot`** in `main` or V5 (code search), so those listeners belong to another client.
- QD `main` reads PV2 production documents **one by one** with `doc(docId).get()` per date × line × shift (`js/data-adapter.js` lines 223, 244), which counts as GET.
- The QD `main` deploy was 30 Oct 02:25-03:25 Thailand. `js/verify-after-deploy.js` only checks file sizes in the browser; it does not read Firestore.
- In some Pattern B hours there are more GET evaluations than reads (e.g. 30 Oct 05-06: 4,550 vs 3,187). Not explained by this data.

### Hypotheses (each to be tested; none assumed)

1. Pattern B matches how QD reads production documents (a 31-day view is about 186 GETs). If 30 Oct 03:00-09:00 was QD, it would be about 70 such views (estimate), possibly post-deploy checking. PV2 may read documents the same way, so this is **not attributed**.
2. Pattern A is queries returning many documents. A listener-using client (PV2, legacy, or the Firebase console data viewer) was active during the 22,636-read hour; that does **not** prove it caused the reads.
3. The midnight activity (28 Oct 00:00-02:00) with a few creates could be night-shift entry, a script or console use.

### Risk of QD V5 to PV2 (shared quota)

- Daily use: V5 costs about the same as `main` to open (+1 read) and removes the filter re-reads (188 → 0), so the QD share should **fall**. Candidate rules add rule reads (A2: +1 per protected read, about +7 per save / close).
- **Largest new V5 read event:** the bridge tools in `js/ops-console.js` (one Baseline cycle reads about 2-3 × N_L + N_S + I, estimate, within one hour). N_L is not known yet (U3).
- **Main risk is cutover day:** migration plus post-deploy checking, stacking on an unexplained spike like 27 Oct. A1 stays **HIGH**.

### Next (each approved separately)

- Read-only: `api/billable_read_units` and `api/billable_realtime_read_units` by `api_method` / `service` (both confirmed to exist) to tell queries, batch gets and listeners apart.
- U3 document counts (method and cost to be proposed first; no Production query without approval).
- Code plan for P0: Q1 (bridge Gate reads) and Q2a/b (`improvements`); no code change without approval.

**Status: A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 4, 2026-11-09: billable read metrics have no data

Collected read-only by the Firebase owner in Cloud Shell with `a1-billable.sh` v1 (only GET calls to the Cloud Monitoring API). Evidence and hashes: [`evidence/a1-billable-20261109/`](evidence/a1-billable-20261109/README.md). Package SHA-256 `b16a0526ff7ecd4fa0f7c555997ce18ba2a9542c97cae691fa311d61c9f6caff`, **confirmed by the owner from Cloud Shell**.

### Result

- `api/billable_read_units` and `api/billable_realtime_read_units` are in the metric list (DELTA, INT64, labels `service`, `api_method`, resource `firestore.googleapis.com/Database`), but **returned no time series** for 26-30 Oct (HEADERS response `{"unit": "1"}`, no executionErrors, no unreachable).
- Over the same window `document/read_count` = **88,044** and equals the Update 2 evidence in all 120 hours. **No data is therefore not zero:** these two metrics do not record this database's reads in this window. Why (e.g. edition- or feature-specific metrics; the database is STANDARD edition) is a hypothesis, not checked.
- **`VERIFY STATUS: PASS` only means the data that exists is consistent** (read_count matches earlier evidence; no API errors). **It does not confirm or reject any hypothesis.** The `0?` cells for these metrics in the evidence report mean "no data", not zero. (Script weakness noted: a main metric without data should give INCOMPLETE; future scripts will do so.)

### Effect on the hypotheses (Updates 2-3)

| Hypothesis | Result |
|---|---|
| Web SDK reads go over a streaming channel (Listen) | not confirmed, not rejected (no data) |
| Pattern A = queries returning many documents | not confirmed, not rejected |
| Pattern B = many single-document reads | not confirmed, not rejected |
| A listener-using client caused the 27 Oct spike | not confirmed, not rejected |

Correction to Update 3: QD can produce **both** patterns. A 1-day Dashboard open runs a 31-day look-back range query (one LIST returning many documents, Pattern A-like); a 31-day view reads production documents one by one (Pattern B-like). Update 3 attributed nothing, so its conclusions stand; QD is not excluded as a contributor.

### Risk (unchanged)

Highest quota day 27,812 (55.6 %); highest hour 22,636 (45 %); sources not attributed; a quota error blocks PV2 too. QD V5 daily use should not add load beyond `main`; the main risk remains cutover day (migration gate Q1, post-deploy checking). **A1 = HIGH. G2 = NOT APPROVED.**

### Read-only options still open (each approved separately)

- R1: measure QD's own GET / LIST / reads signature per action in the **emulator** (no Production).
- R2: `document/read_ops_count` and `query_stat/per_query/*` (exist in the metric list; may also be empty; a metric without data will give INCOMPLETE).
- R3: owner views the Console (Usage; Key Visualizer / Query insights if this edition offers them) for 27 Oct 11:00-12:00 and 28 Oct 00:00-02:00 Thailand time; time-sensitive (retention).
- R4: read-only review of PV2 code for `onSnapshot` and query sizes (needs the PV2 owner's access).
- R5: existing Admin Activity audit logs (read only; contains personal data, so redaction).
- R6: owners' records for the hours above.
Monitoring data for this window is kept about 6 weeks (until about 7 Dec 2026).

---

## Update 5, 2026-11-09: R1 (QD read signature, emulator), R2 script, Q2a / Q2b

Evidence: [`evidence/r1-r2-q2-20261109/`](evidence/r1-r2-q2-20261109/README.md). All of it was produced **locally** in the Firebase Emulator (`demo-quality-dashboard`) with synthetic data; nothing touched Production.

### R1: QD read signature per action (emulator, synthetic data)

Synthetic data: about 4 scrap logs per day, 250 improvements. LIST = query `get()`, GET = document `get()`; reads = documents returned (at least 1 per query).

| Action | LIST | GET | Reads (est.) | GET / LIST | Reads / (GET + LIST) |
|---|---|---|---|---|---|
| Dashboard open (today) | 6 | 6 | 344 | 1.0 | 28.7 |
| Dashboard 1 day | 6 | 6 | 405 | 1.0 | 33.8 |
| Dashboard 31 days | 3 | 186 | 580 | 62 | 3.1 |
| Dashboard Refresh (31 days) | 4 | 186 | 582 | 46.5 | 3.1 |
| Dashboard filters Shift + Line | 0 | 0 | 0 | – | – |
| Weekly Plan, open month | 3 | 0 | 146 | 0 | 48.7 |
| Scrap Detail open / 31 days | 2 | 0 | 334 / 382 | 0 | 167 / 191 |
| Improvement list | 1 | 0 | 250 | 0 | 250 |
| Improvement edit page | 2 → **1** | 0 → **1** | 500 → **251** | – | – |
| Executive Report | 3 | 6 | 258 | 2.0 | 28.7 |

Comparison with Update 3 (consistency only):
- Pattern B hours (GET / LIST about 9-56) fall in the range of QD multi-day Dashboard views (31 days 62, Refresh 46.5, 7 days about 8). QD also reads production documents that do not exist (6 of 186 in the test), which could explain hours with more GET evaluations than reads (hypothesis).
- Pattern A (27 Oct 11:00-12:00 Thailand: GET / LIST 0.69, about 15.6 reads per evaluation) is consistent with a mix of 1-day Dashboard opens and Scrap Detail / Weekly Plan, but the number of opens implied by LIST (about 143) and by reads (about 57 at this data size) disagree; it depends on the real L and I (U3).
- The 8 snapshot listeners in that hour cannot be QD (no `onSnapshot` in QD).

**R1 does not identify the cause of the read spikes.** It shows that QD can produce both patterns, so QD is neither attributed nor excluded; a listener-using client other than QD was active in the 22,636-read hour.

### Q2b: done (commit `f6f83fd`, branch only; not merged or deployed)

Edit page: one document read instead of the whole collection (2 LIST / 500 → 1 LIST + 1 GET / 251 at 250 improvements). Same record and form values for existing, unknown and malformed ids; all other pages read and show the same as before. Tests: unit 59/59, regression 15/15, rules + privacy / ops-console e2e 156/156, Q2 equivalence + read signature 19/19. Cache busting `?v=20261109-q2b` on every page that loads the two files.

### Q2a: rejected approach, on hold

Server `orderBy('createdAt','desc').limit(201)` with a full-read fallback read the collection **twice** whenever 200 or fewer records have `createdAt` (I = 200: 400 reads); the regression test caught it. Removed before commit; not to be reused. Also found: the compat SDK 10.13.0 used by QD has **no aggregate `count()`**. Redesign constraints are in the [P0 plan](p0-read-reduction-plan.md), Revision 1.

### Q1: redesigned (plan only)

Without `count()` and timestamps: the gate reads `scrapLogs` and `scrapSlots` once, groups logs in memory exactly like the `==` queries, and runs the same checks (plus log-id / fingerprint checks). Estimated gate reads about N_L + P lower; details and tests in the [P0 plan](p0-read-reduction-plan.md), Revision 1. No code change yet.

### R2: `a1-querystat.sh` prepared, NOT run

SHA-256 `63b5afbef7b66ea85bc43bd5cef4929b390578681af7e73b6bf48adf5a1c812b`. GET only (Cloud Monitoring); collects `document/read_ops_count` (by type) and the `query_stat/per_query` distributions (queries per hour, mean results / scanned documents / index entries per query), with `read_count` checked against Update 2. **A target metric with no data, or missing from the list, gives INCOMPLETE**; the table shows "no data", never 0. Mock tests: 21 scenarios + token checks, all as expected.

Run procedure (for when it is approved):
1. Cloud Shell → ⋮ → Upload `a1-querystat.sh`.
2. `sha256sum ~/a1-querystat.sh; sed -n 2p ~/a1-querystat.sh; grep -c $'\r' ~/a1-querystat.sh; wc -l < ~/a1-querystat.sh` → the hash above, a line containing "R2", 0, 447. Anything else: do not run.
3. `bash ~/a1-querystat.sh; echo "exit=$?"`
4. `cloudshell download "$(ls -t ~/a1-querystat-*.tar.gz | head -1)"` and send the package and its `.sha256` value (exit 1: `collect-log.txt` only; exit 9: send nothing).

**Status: A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 6, 2026-11-09: Q1 migration gate implemented (code commit `8959c3f`)

Evidence: [`evidence/q1-gate-20261109/`](evidence/q1-gate-20261109/README.md). Firebase Emulator and synthetic data only; working branch only (not merged, not deployed, no migration run).

### What changed

- `tools/migration/ledger-baseline.js`: new pure `gateProblems(plan, logs, slotDocs)`. It reproduces `verifyApplied` and the "saved after the plan" check from **one** read of `scrapLogs` and **one** read of `scrapSlots` (logs matched to a slot like the `==` queries: string fields, strict equality). It adds, at no extra read, log-id and fingerprint checks for planned slots still at `logVersion` 0. `completeIfClean(..., currentLogs, currentSlots)` uses it; **without `currentSlots` the old path runs unchanged (fallback, still used by existing tests).**
- `js/ops-console.js`: the gate reads `scrapSlots` once and passes it in.
- `admin.html`: `?v=20261109-q1` for both files.
- No `count()` and no timestamps are used (the compat SDK has no aggregate `count()`; timestamps are not reliable for this check).

### Results (emulator, 123 synthetic logs, 60 planned slots)

| | Calls | Reads (est.) |
|---|---|---|
| Old gate | 60 GET + 62 LIST | 364 |
| New gate | 2 LIST | **184 (−49 %)** |

- **Problems identical to the old gate in all 17 scenarios** (same text, same order): clean; log added around the ledger; log in a new slot; logs without timestamps (planned and new slot); move between planned slots; quantity edit; delete; excluded log edited into a planned / new slot; slot document deleted; import marker (CONFLICT); ledger save after the baseline; field of another type; apply failed half-way.
- **Caught only by the new gate** (gate stays closed; stricter): two logs swapped between planned slots with the same quantity (log ids differ), and a model / defect edit with count and quantity unchanged (fingerprint differs).
- Tests (one run): unit **59/59**, regression **15/15**, rules **144/144**, e2e + Q1 equivalence **39/39** (incl. ops-console "baseline: dry run, apply, gate → baselineComplete" on the new path, and rehearsal S7 on the old path). Generated docs rewritten by the tests were restored.
- At Production size the saving is about N_L + P per gate run (all logs + planned slots); the real numbers need U3 (not approved).

### R3 / R6 checklist

Saved as [`r3-r6-owner-checklist.md`](r3-r6-owner-checklist.md): the 7 time windows (Thailand, UTC, Pacific quota day), the Console pages to **view only**, and the questions for the system owners. No personal data; no audit logs; no setting changes. Time-sensitive (Monitoring data until about 7 Dec 2026).

### Open (each needs approval)

R2 run by the owner (approved; result pending), U3 (not approved), Q2a redesign (on hold).

**Status: A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 7, 2026-11-10: R2 (read_ops_count + query_stat): INCOMPLETE

Collected read-only by the Firebase owner in Cloud Shell with `a1-querystat.sh` v1 (GET calls to Cloud Monitoring only). Package SHA-256 `3da2715b1683bbcae03d6c72808230f5c079455e6c2cf6451edfc3cb51a00b7c`, **confirmed by the owner from Cloud Shell**. Evidence: [`evidence/r2-querystat-20261109/`](evidence/r2-querystat-20261109/README.md). R2 was **not** run again; the re-verification below was done offline on copies of the package.

### Why the original run said FAIL

- The descriptor of `query_stat/per_query/scanned_index_entries_counts` declares the unit `"{index entry}"` (with a space). The API returned `unit: "{not_a_unit}"` even in the unaggregated HEADERS response, which has **one series of one metric**; the two other distribution metrics (`{result}`, `{document}`) returned their units normally. Why the API does this (e.g. the space) is a hypothesis.
- Verifier v1 failed on any `{not_a_unit}`. That rule was meant to catch mixed units, which cannot happen with one series of one metric. The data itself showed no fault.

### Verifier v2 (offline on the same data)

| | Verifier v1 (`6427aae8…0efa`) | Verifier v2 (`55c40d30…cca8`) |
|---|---|---|
| Status | FAIL (exit 2) | **INCOMPLETE (exit 3)** |
| `scanned_index_entries_counts` | FAIL: `{not_a_unit}` | **WARNING**: descriptor unit `{index entry}`, one series, **unit NOT verified**; its query counts equal `result_counts` in all 120 hours |
| query_stat coverage | not checked | **INCOMPLETE**: 15 of 16 flagged hours have reads but no query_stat point |

v2 never accepts `{not_a_unit}` as a unit: mixed units or a descriptor mismatch → FAIL; no descriptor unit, more than one series, or counts that disagree with `result_counts` → INCOMPLETE; one series of one metric with a descriptor unit → WARNING. Collector `a1-querystat.sh` v1.1 (`217ffb70…c228`) embeds v2; mock tests: 29 scenarios, all as expected (WARNING, INCOMPLETE, FAIL, STOP, token and argv checks). v1.1 has not been run against Google Cloud.

### What R2 shows (facts)

- `document/read_count` equals the Update 2 evidence in all 120 hours; `document/read_ops_count` equals `read_count` in all 120 hours (88,044, all `type=QUERY`; `LOOKUP` 0).
- `query_stat/per_query/*` recorded **only 10 queries in 5 days, all `ListDocuments`**, 2 per day at 01:00 Thailand time, about 166 documents each (2 × 166 ≈ the 333–335 reads of that hour). This is the daily job seen in Update 2; its owner is still unknown (R6 Q3).
- **15 of 16 flagged hours** (including 27 Oct 11:00–12:00 Thailand, 22,636 reads) have reads but **no query_stat point**.

### Limits of query_stat and conclusion

- Like `api/request_count` (Update 2), `query_stat` does **not** capture the applications' queries in this project; it only shows the `ListDocuments` calls. Why (e.g. the web SDK's streaming channel is not covered) is a hypothesis, not checked.
- **R2 = INCOMPLETE. R2 does not identify the cause of the read spikes**, and does not show whether they were large queries or many small ones. The open question stays open.

**Status: A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 8, 2026-11-10: R3 / S1 — Cloud Firestore API metrics (Google Cloud Console, view only)

Done by the owner in Google Cloud Console (APIs & Services → Cloud Firestore API → Metrics), project `daily-production-report-46b60`, following the [R3/R6 checklist](r3-r6-owner-checklist.md) §6. **Owner-reported results; no screenshots are stored in this repository.** Nothing was changed; no other step (S2–S8) was done.

### Facts (as reported from the page)

| Item | Result |
|---|---|
| Capability check (step 4) | The page **does** offer **Methods** and **Credentials** filters |
| Page time zone | UTC+7 |
| Range used | "30 days" (relative to the day of the check, 10 Nov 2026; it covers 26–31 Oct) |
| Credential `production-dashboard` | **no data** |
| Credential `New Browser key` | `GetOrListDocuments`: **60 requests**; `ListCollectionIds`: **2 requests** (over the 30 days) |
| Method `ListDocuments` (v1 and v1beta1) under `New Browser key` | **no data** |
| Conclusion of the check | the source of the read spikes and the owner of the 01:00 job **could not be identified** |

### Hypotheses (NOT verified)

- H5 The 60 `GetOrListDocuments` requests of `New Browser key` are the daily 01:00 job: 60 over 30 days equals the 2 per day seen in Updates 2 and 7, and a REST `GET` on a collection path is a list call that this page may report under `GetOrListDocuments` rather than `ListDocuments`. Not shown: the time of day of these 60 requests.
- H6 The apps' traffic (about 88,000 reads in 26–30 Oct) is not attributed to any credential this page lists (e.g. the web SDK's channel is reported differently or without a credential).
- H7 The 2 `ListCollectionIds` came from a tool that lists collections (e.g. a console or a script); source unknown.

### Unknowns

- Which app, credential or person caused W1–W6.
- Whether the 60 requests happen at 01:00 Thailand time, and who holds `New Browser key`.
- Whether the page counts the web SDK's streaming / channel traffic at all, and under which method or credential.
- Hourly values: the result above is a 30-day view; hours of W1–W6 were not isolated.

### Limits of the API metrics page (for this question)

- It counts **API requests**, not documents read; it cannot be compared one-to-one with `document/read_count`.
- Its method names (`GetOrListDocuments`) differ from the Firestore metrics' labels (`ListDocuments`), so "no `ListDocuments`" does not mean "no list calls".
- The credential filter shows only credentials the page can attribute; traffic without such a credential may not appear under any of them.
- The totals seen (62 requests in 30 days for one key, none for the other) are far below the read volumes of W1–W6, so **this view does not explain the spikes**.
- Owner-reported, without stored screenshots: the evidence level is lower than for Updates 2–7.

### Status

R3/S1 **does not identify** the cause of the read spikes or the owner of the 01:00 job. A possible lead for the 01:00 job (H5) needs a separate, approved check (e.g. the hourly view of `GetOrListDocuments` for `New Browser key` on one day, and who manages that key — steps B2/B3 of the checklist). **A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 9, 2026-11-10: S1 follow-up — hourly view of `New Browser key` (owner-reported)

Google Cloud Console → Cloud Firestore API → Metrics, done by the owner on 10 Nov 2026 (view only). The owner holds 2 screenshots; **they were not received in this session and are not stored here**, so the values below are as reported.

### Facts (as reported)

| Item | Value |
|---|---|
| Credential | `New Browser key` |
| Time range | 1 day (the day before the check, page time zone UTC+7) |
| Method | `google.firestore.v1.Firestore.GetOrListDocuments` |
| Requests | **2** |
| Errors | 0 % |
| Average latency | 0.104 s |
| Time on the chart | activity at about **01:00 UTC+7** |

### What this adds to H5 (H5: the 01:00 job is `New Browser key` calling `GetOrListDocuments`)

Consistent with H5, each point independent of the others:
- **count**: 2 requests in one day, as in the 60 requests / 30 days of Update 8 and the 2 per day of Updates 2 and 7;
- **time**: about 01:00 Thailand time, the hour of the daily job in Updates 2 and 7;
- **method family**: a get-or-list call, which fits a list of documents.

H5 is therefore **better supported** than in Update 8, but still **not proven**:
- The day seen is in November, not 26–30 Oct. That it is **the same job** as on 26–30 Oct is **not shown** (no per-day view of 26–30 Oct for this key yet).
- That `GetOrListDocuments` here is the `ListDocuments` of the Firestore metrics is an **inference** from naming, not shown on one page.
- The number of documents per request (about 166 in October) is not visible on this page.
- **Who holds or uses** `New Browser key` is unknown. A browser API key identifies a key, not a person or a program; a web app's key is public by design and may be used by any caller that has it.

### Not concluded

- **Not** concluded that this is the same job as 26–30 Oct.
- **Not** concluded that it relates to the read spikes. For scale only (fact): the job is 2 requests ≈ 333 reads a day, while W1 alone had 22,636 reads in one hour.

### Unknowns

Owner of the 01:00 job; whether `New Browser key` is the key in the QD / PV2 web configuration; the source of W1–W6.

**A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 10, 2026-11-10: B6 — read-only search of the QD repository

Searched (no code changed): the working branch `claude/vigilant-pasteur-l91qt3` at `c265e7d`, `origin/main` at `b118f93` (the live site), and the git history of all branches (files ever added). `tests/node_modules` excluded; `docs/` checked separately. The API key is shown only as its last 4 characters.

### Results (facts)

| # | Searched for | Result | File / line |
|---|---|---|---|
| 1 | Direct REST calls to Firestore (`firestore.googleapis.com`, `/v1/projects/`, `:listDocuments`, `documents/`) | **None in application code** on either branch. Matches only in tests, all against the **local emulator** (`127.0.0.1`, `/emulator/v1/…`, emulator `identitytoolkit`) | e.g. `tests/tools/seed-emulator.js:25`; account setup in `tests/e2e/*.test.js` |
| 2 | `GetOrListDocuments`, `ListDocuments`, `listCollectionIds`, `listCollections` | **None** on either branch | – |
| 2b | `fetch`, `XMLHttpRequest`, `axios`, `sendBeacon` in `js/` and `*.html` | **None** on either branch; QD reaches Firestore only through the Firebase SDK | – |
| 3 | Scheduled jobs: `.github/workflows`, cron, Apps Script (`.gs`), Cloud Functions, scheduler, crontab | **None** on either branch and **none ever added** in the git history | only `emulator/firebase.json` (emulator settings) |
| 4 | Time-of-day code (01:00, `getHours()==1`, `getUTCHours()==18`) and timers | **No time-of-day code.** Timers: 2 `setInterval`, working branch only, neither reads Firestore | `js/dashboard.js:1519` (stale-data hint every 30 s; code comment "no new fetch, no new adapter call"); `js/weekly-plan-page.js:431` (clock only, "no reads") |
| 5 | API keys | **One key** in the repository, the Firebase web configuration, same on both branches: `AIza…J53c`. Emulator mode uses `"demo-api-key"` | `js/config.js:26`; `js/firebase-init.js:48` |
| – | Scripts in `docs/` | The A1 evidence collectors call Cloud Monitoring only (GET), are run by hand in Cloud Shell, and contain no schedule | `docs/release-readiness/evidence/*/a1-*.sh` |

### What this means

- **No scheduled job and no direct Firestore REST call exist in the QD repository** (branch, `main`, history).
- **QD cannot be fully excluded.** The search covers code, not use: a browser with QD open at 01:00 would read through the Firebase SDK, and which API methods the SDK's traffic is reported under on the server side is not shown by this search. Whether `New Browser key` is the `…J53c` key is not known; a web key is public by design and can be used by any caller that has it.
- **The owner of the 01:00 job is still unknown.** PV2 and other repositories, Apps Script, Google Sheets, and cron or tools on any machine were not searched (outside this repository).
- **The cause of the read spikes (W1–W6) is still unknown.** B6 does not explain them.

### Hypotheses (NOT verified)

- Q-H1 The 01:00 job does not come from QD code (no code here makes a scheduled REST list call).
- Q-H2 `New Browser key` may or may not be the `…J53c` key (to be checked by its last 4 characters, step B2 / B2b).

### Next (each needs approval)

B2 / B2b (compare the last 4 characters of `New Browser key` with `…J53c`, view only); B6 for PV2 and other repositories by their owners; B5 owner questions; B1a / B1b (per-day view for 26–31 Oct).

**A1 = HIGH. G2 = NOT APPROVED.**

---

## Update 11, 2026-11-10: B2 / B2b (key identity) and B6 for the PV2 repository

### B2 / B2b (owner-confirmed, Google Cloud Console, view only)

`New Browser key` currently **ends in `J53c`**, the same last 4 characters as the QD Firebase web key (`js/config.js:26`). Only the last 4 characters were compared; the full key is not recorded anywhere in this repository.

### B6 for PV2 (read-only search)

Public repository `KP12264/daily-production-report`, cloned read-only (no code from it was run): `main` at `431836a` (2026-10-28 03:05 +0700), full history (287 commits). Keys shown only as their last 4 characters.

| # | Searched for | Result | File / line |
|---|---|---|---|
| 1 | Firebase web config / API key | **Same key `AIza…J53c`** as QD, in **two** places: PV2 and the legacy root app | `production-v2/js/firebase-v2.js:2`; `index.html:655` |
| 2 | Firestore access | **Firebase SDK only** (compat 9.23.0 in `production-v2/*.html`; compat 10.13.0 in the root `index.html`). **No** REST call, `fetch`, `XMLHttpRequest`, `listDocuments`, `listCollectionIds`, `GetOrList` | e.g. `production-v2/entry.html:8-10`, `index.html:10-11` |
| 3 | Scheduled jobs | **None**: no `.github/workflows`, cron, Apps Script, Cloud Functions, now or ever added in history. `01:00` appears only as shift time-block data | `production-v2/js/master.js:484-485` (data rows) |
| 3b | Timers | `setInterval(refreshCurrentBlock, 30000)`; lines 250–256 of that function contain no Firestore call. Other timers are save debounces (`setTimeout`) | `production-v2/js/entry.js:261`; `index.html:1014, 1020, 1179` |
| 4a | Snapshot listeners | **One `onSnapshot`**, in the legacy root app, on one document of `productionLogs` | `index.html:760` (collection `index.html:671`) |
| 4b | Whole-collection reads | `all(collection)` = `collection(n).get()` in 8 files, plus direct whole reads of master collections | `production-v2/js/{dashboard,entry,exec,loss,order,plan,assembly}.js` (`all` at line 6–13), `production-v2/dashboard.js:13`, `cabinet-coverage.js:17,25-26`, `master.js:1088,1273-1274,1327,1470` |
| 4c | Range reads | Dashboard week / custom range up to **31 days**: per day 2 document gets (`prodV2_dailyPlans`, `prodV2_actualLogs`) + 1 `prodV2_lossLogs` query; multi-line variants loop over lines × dates | `production-v2/js/dashboard.js:746-756, 788, 824-827` (copy in `production-v2/dashboard.js:693-695, 715-717`) |
| 4d | Line-wide scans | Model merge (admin): reads **all** `prodV2_actualLogs` and `prodV2_dailyPlans` of a line (every date) | `production-v2/js/master.js:908, 918` |
| 4e | Combination loops | Exec page: queries per line × shift combination | `production-v2/js/exec.js:24, 33-34` |
| – | Commits 26–31 Oct (+0700) | only `297f0e8` 28 Oct 03:04 and `431836a` 28 Oct 03:05, "Add files via upload" | git history |

### Facts

- **QD, PV2 and the legacy root app all use the same web key `…J53c`** (QD `js/config.js:26`; PV2 `production-v2/js/firebase-v2.js:2`; legacy `index.html:655`). A request made with `New Browser key` therefore **cannot be attributed to one app** by the key.
- Neither repository contains a scheduled job or a direct Firestore REST call.
- The only `onSnapshot` in either repository is in the legacy root app (`index.html:760`).
- PV2 has read patterns that can produce many reads: whole-collection reads, 31-day ranges with per-day document reads, line-wide scans.

### Hypotheses (NOT verified)

- P-H1 The snapshot listeners seen in W1 (8) and W4 (29) come from the legacy root app's `onSnapshot` (or the Firebase console data viewer).
- P-H2 PV2 range views (per-day gets of plans / actuals) can produce Pattern B (many single-document reads); PV2 whole-collection reads or line-wide scans can produce Pattern A (many documents per query).
- P-H3 The 01:00 job is outside all three apps' code (a script, sheet or tool using the public web key).

### Unknowns

- **The owner of the 01:00 job** (not in QD or PV2 code; the key is shared by all three apps).
- **The cause of the read spikes (W1–W6)**: QD, PV2 and the legacy app can each produce such reads; which one did is not shown.
- Which `dashboard.js` copy the live PV2 serves (`production-v2/dashboard.js` or `production-v2/js/dashboard.js`); collection sizes (U3, not approved).

**A1 = HIGH. G2 = NOT APPROVED.**
