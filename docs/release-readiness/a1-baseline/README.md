# A1 read baseline per Firestore quota day (prepared 2026-11-11, NOT RUN)

**Status.**
- Prepared only; not run against Production.
- The owner runs [`a1-baseline.sh`](a1-baseline.sh) in Cloud Shell **after approval**.
- It is read-only: Cloud Monitoring `timeSeries.list` GET calls only.
- No document reads, no change, no Billing / alert / rules change.

**A1 = HIGH. G2 = NOT APPROVED. O1 = NOT APPROVED.**

## Quota day

- The Spark daily read quota (50,000) resets at **midnight Pacific time**.
- Quota day D = D 00:00 → D+1 00:00 America/Los_Angeles: **15:00 → 15:00 ICT** in winter (PST), 14:00 → 14:00 in summer (PDT).
- The script derives the windows with the time-zone database, so daylight-saving days have 23 or 25 hours.

## What is measured (kept separate, never added together)

| Column | Source | Note |
|---|---|---|
| **Document reads** | `firestore.googleapis.com/document/read_count` (`firestore_instance`), hourly sums; also split by label `type` | the anchor used in A1 Updates 1–2 |
| **Query requests** | `firestore.googleapis.com/api/request_count` by `api_method`: RunQuery + RunAggregationQuery + ListDocuments | a request count, **not** reads. A browser `Listen` stream (SDK) is counted per stream, not per query, so SDK queries can be under-counted here |
| Other requests | the same metric, all other methods (BatchGetDocuments, Commit, Listen, …) | — |
| **Billed reads** | **Firebase Console → Firestore → Usage**, typed in by hand | `billable_*` metrics had no data (A1 Update 4). An empty query is billed 1 read and has no document read; billed ≥ document reads is expected |

## Baseline table (to be filled; last 7 complete quota days before the deploy decision)

| Quota day (PT) | Window (ICT) | Document reads | % of 50,000 | Highest hour | Query requests | Billed reads (Console) | Status |
|---|---|---|---|---|---|---|---|
| D−7 … D−1 | 15:00 → 15:00 | — | — | — | — | — | **missing: script not run** |

Data in hand today (not the baseline):
- quota days PT 26–31 Oct (exact): 27,812 / 26,401 / 12,801 / 15,240 / 2,245 / 335;
- nothing after 2026-11-07 00:00 UTC.

## Thresholds after a deploy (from the monitoring plan)

- Warn at **≥ 35,000 (70 %)**.
- Act at **≥ 45,000 (90 %)**, or on any quota / resource-exhausted error in QD or Production V2.
- Hour spike: an hour > 2 × the same hour on baseline days, or > 10,000.

## Limits on attributing reads

- One project and one web key are shared by the Quality Dashboard, Production V2, the legacy root app, and any script using the key (the daily 01:00 job). The metrics **cannot tell which app read**.
- Hourly patterns, together with the owners' answers on who used which page (R6 questions), are the only way to narrow down the source.
- Per-page estimates come from the emulator (QD read-cost tables; PV2 static analysis, Update 12). They are not billed numbers.

## Run (owner, after approval)

```bash
bash a1-baseline.sh 7
```

Output: `~/a1-baseline-<time>/baseline.md`, `baseline.csv`, `raw/`, `MANIFEST.sha256`. There is no token in the files; the script stops with code 9 if one is ever found.
