# A1 investigation report: Firestore reads (status 2026-11-12: WAITING FOR DATA)

**Status.**
- The baseline for 4–10 Nov 2026 has **not been collected yet**: this session has no Monitoring access (no gcloud credentials), by rule.
- The owner runs the read-only script (`RUNBOOK-cloud-shell.md`).
- Nothing in this report is concluded from static analysis alone.

**A1 = HIGH. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO.**

## 1. Method

| Item | Value |
|---|---|
| Script | `a1-baseline.sh` at commit `30fe62c` (SHA-256 `83655369942de1bbe8b8c93616ec5baf73e4a4c1c82cc7d91b3ae84e23a029d9`), v1 + hourly output + hour-completeness check, audited read-only: one HTTP GET endpoint (`timeSeries.list`), one gcloud command (`auth print-access-token`), output only under `~/a1-baseline-<time>/`; no POST / PUT / PATCH / DELETE, no Firebase command |
| Offline test | local mock only (no Google call; mock numbers are **not** used anywhere in this report): 4–10 Nov windows 08:00Z → 08:00Z (00:00 PST = 15:00 ICT), 168 hours, none missing or duplicated; DST days 1 Nov 2026 (25 h) and 14 Mar 2027 (23 h) correct; a missing hour is reported; no token written; manifest verifies |
| Period | quota days **4–10 Nov 2026 (Pacific, PST)** = 08:00 → 08:00 UTC = **15:00 → 15:00 ICT** |
| Time zones in the output | daily table: quota day (PT) + window in ICT; `hourly.csv`: hour end in UTC, hour start in PST and in ICT |
| Separate measures (never substituted) | **document reads** = `document/read_count`; **query requests** = `api/request_count` (RunQuery + RunAggregationQuery + ListDocuments); **billed reads** = Firebase Console Usage (by hand) |

## 2. Data collected so far (real, from earlier read-only collections; not the 4–10 Nov baseline)

| Source | Facts |
|---|---|
| A1 Update 1 (UTC days 24 Oct – 6 Nov) | mean 9,290 document reads / UTC day; weekends about 323–335 |
| A1 Update 2 (exact quota days, PT) | 26 Oct **27,812 (55.6 %)**, 27 Oct 26,401, 28 Oct 12,801, 29 Oct 15,240, 30 Oct 2,245, 31 Oct 335 |
| Spike windows (ICT) | W1 Tue 27 Oct 11–12: 22,636 reads in one hour · W2 28 Oct 00–02: 9,316 + 13,701 · W3 29 Oct 09–10: 7,408 · W5 30 Oct 03–07: 9,098 (after the QD deploy 02:25–03:25) · W6 30 Oct 08–09: 4,169 |
| Scheduled job | every day about 01:00 ICT: 2 × `ListDocuments` (about 333 reads) with the shared web key (owner unknown) |
| After 2026-11-07 00:00 UTC | **no data** |

## 3. Baseline 4–10 Nov (to be filled from `baseline.md` / `hourly.csv`)

| Quota day (PT) | Window (ICT) | Document reads | % of 50,000 | Highest hour (ICT) | Query requests | Billed reads (Console) |
|---|---|---|---|---|---|---|
| Wed 4 Nov | 4 Nov 15:00 → 5 Nov 15:00 | missing | – | – | missing | missing |
| Thu 5 Nov | 5 Nov 15:00 → 6 Nov 15:00 | missing | – | – | missing | missing |
| Fri 6 Nov | 6 Nov 15:00 → 7 Nov 15:00 | missing | – | – | missing | missing |
| Sat 7 Nov | 7 Nov 15:00 → 8 Nov 15:00 | missing | – | – | missing | missing |
| Sun 8 Nov | 8 Nov 15:00 → 9 Nov 15:00 | missing | – | – | missing | missing |
| Mon 9 Nov | 9 Nov 15:00 → 10 Nov 15:00 | missing | – | – | missing | missing |
| Tue 10 Nov | 10 Nov 15:00 → 11 Nov 15:00 | missing | – | – | missing | missing |

## 4. Analysis plan (applied once the data arrives)

1. **Abnormal hours:** hours > 2 × the median of the same hour-of-week, or > 10,000; days ≥ 35,000 (70 %).
2. **Shape of each spike:**
   - reads by `type` (QUERY vs LOOKUP);
   - query requests vs other requests (BatchGetDocuments, Listen, ListDocuments);
   - many documents per query points to whole-collection reads;
   - many single gets points to per-day document loops.
3. **Compare with usage (R6 answers):** shift hours, who used which page, deploy times (QD Pages runs from the GitHub Actions history), the 01:00 job.
4. **Candidate sources, checked against the shape only** (static analysis gives expectations, not proof):

   | Candidate | Expected signature |
   |---|---|
   | PV2 Assembly (whole `prodV2_actualLogs` per load) | QUERY reads ≈ collection size per load, few requests |
   | PV2 Dashboard Range / Exec Trend | many single-document gets (LOOKUP), plus small queries |
   | QD live `main` filters | about 400–580 reads per click, mixed |
   | Legacy root app | listener (Listen) traffic, small |
   | 01:00 job | 2 ListDocuments |

5. Every finding is labelled **Confirmed** (seen in the metrics), **Hypothesis**, or **Unknown**.

## 5. Findings

| Type | Finding |
|---|---|
| Confirmed | (none yet for 4–10 Nov). Earlier: highest quota day 55.6 %; one-hour spikes up to 22,636; daily 01:00 job |
| Hypotheses | PV2 pages with whole-collection or per-day reads cause the large spikes (static analysis, Update 12); not proven |
| Unknowns | which app produced W1–W6; owner of the 01:00 job; billed vs document reads per day; 4–10 Nov levels |

## 6. Read-reduction proposals (order by impact and risk; to be confirmed or re-ordered by the data; none started)

| # | Proposal | Expected effect | Risk | Needs |
|---|---|---|---|---|
| 1 | **O1** PV2 Assembly reads one date (tested: emulator −99 %, browser 745 → 6) | large if Assembly is used | low (one line; tested) | PV2 owner + approval |
| 2 | QD V5 limited release (filters re-use loaded data: 0 reads per click) | removes repeat reads on the live QD Dashboard | medium (release) | deploy approval |
| 3 | O3 PV2 Dashboard Range / Other Lines cache | about 279 → about 93 reads per 31-day load (estimate) | medium (cache freshness) | PV2 owner + tests |
| 4 | O4 PV2 Exec Trend re-use | Trend 30 about 360 → less on repeat | low–medium | PV2 owner + tests |
| 5 | Identify the 01:00 job | small (about 333 / day) | none (question) | owner |
| 6 | O5–O9 (Order, Cabinet, Plan / Loss caches), QD Q2a | case by case | medium | after the data |

## 7. Owner actions

See `RUNBOOK-cloud-shell.md`:
1. Run the script.
2. Send the `.tgz` and its SHA-256.
3. Send a Console Usage screenshot of the billed reads.
4. Send the R6 answers.

## 8. Update 2026-11-12: real collection sizes (count only)

Owner's aggregate count queries in production (no document content read, nothing written). Details and evaluation: [`A1-collection-counts-2026-11-12.md`](A1-collection-counts-2026-11-12.md).

| Collection | Documents | readTime (UTC) |
|---|---|---|
| `prodV2_actualLogs` | 331 | 2026-11-12T11:50:22.754667Z |
| `scrapLogs` | 93 | 2026-11-12T11:50:39.314835Z |

- **Sizes on 12 Nov, not 7 Nov.** The 7 Nov sizes are unknown, at most these if only additions happened.
- **PV2 Assembly.** It reads the whole `prodV2_actualLogs` collection on every open, date change, shift change and Load. That is about 331 reads per load (an estimate, not billed).
- **Scenario only (not a root cause).** About 64 Assembly loads in one hour would give 20,978 reads.
- **QD.** QD queries `scrapLogs` by date range, so no query can exceed 93 documents today. QD risk: low to medium.
- **Status unchanged.** Billed reads remain UNVERIFIED, and O1 remains NOT APPROVED.
