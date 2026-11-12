# A1 baseline summary: Firestore reads, Pacific quota days 4–10 Nov 2026

**Source.**
- Cloud Monitoring, collected by the project owner in Cloud Shell on 2026-11-12 with `a1-baseline.sh` at commit `30fe62c` (read-only).
- Result archive sha256 `229a43f3d8ec69ca5777746dce4fdd0ad95f5ab9a8108d4c67783785a18affe6`; all 11 files passed the archive manifest.
- Account names, paths and tokens are not reproduced here.

**Status.** A1 = HIGH. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO.

> **Monitoring reads are not billed reads.** All numbers below are `firestore.googleapis.com/document/read_count` (document reads reported by Cloud Monitoring). Billed reads (Firebase Console → Usage) have **not** been provided yet: status **UNVERIFIED** (see `A1-decision-report.md`, §4).

## Time

- Pacific quota day D = D 00:00 → D+1 00:00 America/Los_Angeles (PST in this period) = **08:00 → 08:00 UTC = 15:00 → 15:00 Thailand time (ICT)**.
- Example: quota day 6 Nov = 6 Nov 15:00 ICT → 7 Nov 15:00 ICT.
- Window: 2026-11-04 08:00Z → 2026-11-11 08:00Z (168 hours, no DST change inside).

## Daily (document reads)

| Quota day (PT) | Window (ICT) | Document reads | % of 50,000 | Highest hour (start, ICT) |
|---|---|---|---|---|
| Wed 4 Nov | 4 Nov 15:00 → 5 Nov 15:00 | 4,311 | 8.6 % | 5 Nov 11:00 · 1,159 |
| Thu 5 Nov | 5 Nov 15:00 → 6 Nov 15:00 | 6,660 | 13.3 % | 5 Nov 16:00 · 2,598 |
| **Fri 6 Nov** | **6 Nov 15:00 → 7 Nov 15:00** | **33,960** | **67.9 %** | **Sat 7 Nov 11:00 · 20,978** |
| Sat 7 Nov | 7 Nov 15:00 → 8 Nov 15:00 | 6,497 | 13.0 % | 7 Nov 15:00 · 1,642 |
| Sun 8 Nov | 8 Nov 15:00 → 9 Nov 15:00 | 7,741 | 15.5 % | 9 Nov 09:00 · 4,102 |
| Mon 9 Nov | 9 Nov 15:00 → 10 Nov 15:00 | 9,366 | 18.7 % | 10 Nov 13:00 · 5,171 |
| Tue 10 Nov | 10 Nov 15:00 → 11 Nov 15:00 | 4,347 | 8.7 % | 11 Nov 10:00 · 1,290 |
| **Total** | | **72,882** (mean 10,412 · median 6,660) | | |

## Hourly (document reads by Thailand hour of the hour start)

Columns run from 15 (15:00) to 14 (14:00 of the next calendar day), i.e. one quota day per row. `·` = no data point for that hour; `0` = a point with value 0. The full 168-hour list in UTC, PST and ICT is in [`baseline-2026-11-04_10-hourly.csv`](baseline-2026-11-04_10-hourly.csv).

| Quota day (PT) | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 | 14 | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-04 | 105 | 121 | 107 | 238 | 398 | 0 | · | · | · | · | 341 | · | · | · | · | · | · | 997 | 116 | 0 | 1,159 | · | 729 | 0 | 4,311 |
| 2026-11-05 | 7 | 2,598 | · | 107 | 107 | · | · | · | · | · | 341 | · | · | · | · | · | 2 | 0 | · | 865 | 217 | 1,454 | 27 | 935 | 6,660 |
| 2026-11-06 | 20 | · | · | · | 4,613 | 0 | · | · | · | · | 341 | · | · | · | · | · | · | 756 | 2,931 | 3,655 | 20,978 | 431 | 109 | 126 | 33,960 |
| 2026-11-07 | 1,642 | 0 | 121 | 171 | 1,093 | 0 | · | · | · | · | 341 | · | · | · | · | · | · | 448 | 877 | 1,010 | 46 | 363 | · | 385 | 6,497 |
| 2026-11-08 | 107 | 1,235 | · | 118 | 7 | · | · | · | · | · | 341 | · | · | · | · | · | · | 1,093 | 4,102 | 598 | 7 | · | 115 | 18 | 7,741 |
| 2026-11-09 | 114 | 828 | 0 | 249 | 0 | 238 | · | · | · | · | 341 | · | · | · | · | · | · | 116 | 989 | 1,105 | 7 | 73 | 5,171 | 135 | 9,366 |
| 2026-11-10 | 397 | 276 | 180 | 509 | 143 | 0 | · | · | · | · | 343 | · | · | · | · | · | · | 12 | 478 | 1,290 | 719 | · | · | · | 4,347 |

## Separate measures

| Measure | Source | 4–10 Nov |
|---|---|---|
| Document reads | `document/read_count` | 72,882; all labelled `type = QUERY`, `LOOKUP` = 0 |
| Query / list requests | `api/request_count` by method | only `ListDocuments` (22) and `ListCollectionIds` (15) appear; no RunQuery / BatchGet / Listen is recorded in this metric for the period |
| Billed reads | Firebase Console → Usage | **not provided: UNVERIFIED** |

## Confirmed facts

1. Highest quota day: **6 Nov, 33,960 (67.9 %)**, above the earlier highest 27,812 (55.6 %, PT 26 Oct) and just under the 70 % warning level.
2. **Sat 7 Nov 09:00–11:59 ICT: 27,564 reads** (2,931 + 3,655 + 20,978). The hour 11:00–11:59 alone is 42 % of a day's quota. These three hours are also the only ones with many `ListCollectionIds` / `ListDocuments` calls (13 + 8).
3. **Daily at 01:00–01:59 ICT: 2 `ListDocuments` and 341 reads** (343 on 11 Nov), on 7 / 7 days; 2,389 reads in the week (3.3 %).
4. Apart from that job, every **reported** read is between **07:00 and 20:59 ICT**. For 21:00–06:59 ICT the metric has **no data points**; this is not evidence of zero reads (see H4).
5. 83 of 168 hours have no data point (almost all at night). They are shown as `·`, never as 0.
6. No Quality Dashboard deploy in the period (last GitHub Pages run: `b118f93`, 29 Oct).

## Hypotheses (not verified)

- **H1.** The 7 Nov burst is linked to a tool that lists collections and documents. It could be Firebase Console → Firestore → Data or a script / admin tool; **not established**. The listing calls alone do not account for the volume (see the decision report, §2).
- **H2.** The 01:00 job is an external scheduled script or tool.
- **H3.** The day-time reads are normal Quality Dashboard / Production V2 page use during shifts.
- **H4.** Hours without a data point had no reads (DELTA metric). To be checked against Console Usage totals.

## Unknowns

- Billed reads per day.
- Who or what made the 7 Nov burst and the small 10 Nov 19:00 ICT cluster.
- The owner of the 01:00 job.
- How day-time reads split between QD, PV2 and the legacy app (one project, one shared web key).
- What `type = QUERY` covers for SDK document reads.
