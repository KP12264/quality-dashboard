# A1 decision report: Firestore reads (2026-11-12)

Based on the owner's Cloud Monitoring data for Pacific quota days 4–10 Nov 2026 ([summary](A1-baseline-summary-2026-11-04_10.md), [hourly CSV](baseline-2026-11-04_10-hourly.csv)) and earlier read-only evidence (A1/A2 Updates 1–13). No code, rules, job or data was changed.

**A1 = HIGH. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO.**

## 1. Summary

- Reads are low most of the time: median 6,660 per quota day; no reads are reported at night (no data points: not proven to be zero).
- **Short bursts drive the risk:**
  - one three-hour burst on Saturday 7 Nov (27,564 reads, 09:00–11:59 ICT) took one quota day to **67.9 %**;
  - earlier, W1 on 27 Oct read 22,636 in one hour.
- The data does **not** show who or what made the bursts.
- Monitoring reads are not yet checked against billed reads.

## 2. Spike: Saturday 7 Nov 2026, 09:00–11:59 ICT (= Fri 6 Nov 18:00–20:59 PST, quota day 6 Nov)

| Hour start (ICT) | Document reads | ListCollectionIds | ListDocuments | Reads per listing call |
|---|---|---|---|---|
| 08:00 | 756 | 0 | 0 | – |
| 09:00 | 2,931 | 6 | 4 | 293 |
| 10:00 | 3,655 | 5 | 3 | 457 |
| **11:00** | **20,978** | 2 | 1 | 6,993 |
| 12:00 | 431 | 0 | 0 | – |
| **09:00–11:59** | **27,564** | **13** | **8** | 1,313 |

For comparison:
- the daily 01:00 job: 2 ListDocuments → 341 reads (≈ 170 per call);
- 10 Nov 19:00 ICT: 2 ListCollectionIds + 1 ListDocuments → 143 reads.

### Facts

- ListCollectionIds appears **only** in this window (13) and at 10 Nov 19:00 ICT (2) in the whole week.
- ListDocuments appears outside the 01:00 job **only** in the same two windows.
- The reads **do not scale with the listing calls**: the 11:00 hour has the fewest calls (3) and the most reads (20,978).
- If each ListDocuments call read about as much as the 01:00 job's calls (≈ 170), the 8 calls would explain about 1,400 of 27,564 reads.
- The request metric records no SDK traffic (RunQuery / Listen) in this period, so the other reads have no request-level trace here.

### Not established

- That Firebase Console (Firestore → Data) caused the burst. It is one candidate, because it lists collections and documents.
- Other candidates:
  - a script or admin tool;
  - an export / backup / BigQuery-style tool;
  - app pages reading in parallel (Saturday morning: was there a shift?).

### Questions for the owner (7 Nov 09:00–12:00 ICT and 10 Nov 19:00 ICT)

1. Did anyone open **Firebase Console → Firestore → Data** (or Firestore in the Google Cloud console) at these times? Which collections?
2. Was any **script, Google Sheet / Apps Script, export, backup or reporting tool** run against Firestore at these times? By whom?
3. Was the **Quality Dashboard or Production V2** used at these times (Saturday morning shift? Dashboard with a long date range, Exec Trend 30, Assembly, Order Tracking)?
4. Was the **legacy app** (`…/daily-production-report/`) open at these times?
5. Did anything happen on Saturday 7 Nov that is not normal (catch-up data entry, an audit, a demo, an investigation)?

## 3. The 01:00 ICT job

| Quota day (PT) | Hour (ICT) | ListDocuments | Reads |
|---|---|---|---|
| 4 Nov | 5 Nov 01:00 | 2 | 341 |
| 5 Nov | 6 Nov 01:00 | 2 | 341 |
| 6 Nov | 7 Nov 01:00 | 2 | 341 |
| 7 Nov | 8 Nov 01:00 | 2 | 341 |
| 8 Nov | 9 Nov 01:00 | 2 | 341 |
| 9 Nov | 10 Nov 01:00 | 2 | 341 |
| 10 Nov | 11 Nov 01:00 | 2 | 343 |

**Facts.**
- Every day, in the same hour, the same 2 calls; 341–343 reads (0.7 % of the daily quota).
- The same pattern was seen in late October (A1 Part B).
- Neither the Quality Dashboard repository nor the Production V2 repository contains a scheduled job or a REST call (B6, Updates 10–11).
- The earlier owner check (S1) linked ListDocuments / ListCollectionIds requests to the web key "New Browser key" (`…J53c`), shared by QD, PV2 and the legacy app.

**How to identify the owner (read-only; do not stop or change the job):**
1. Ask the people with access (R6 Q3): an Apps Script trigger, a Google Sheet add-on, a cron job on a PC / server, a backup or uptime tool, a GitHub Action in another repository.
2. Google Cloud console → APIs & Services → Credentials / Metrics: requests by credential at about 01:00 ICT (view only, as in S1).
3. Apps Script: <https://script.google.com/> → My Triggers, for each account that has access to the project.
4. Any other GitHub repositories of the owners: search for `firestore.googleapis.com` or the project id (read-only; on approval).

**Impact.** Small (≈ 341 reads per day). It is not the cause of the bursts, but it is unexplained access with the shared web key. It stays unknown until identified.

## 4. Monitoring reads compared with Firebase Usage / billed reads (UNVERIFIED)

| Quota day (PT) | Monitoring document reads (quota day = 15:00 → 15:00 ICT) | Firebase Console Usage reads (time zone as shown) | Difference | Status |
|---|---|---|---|---|
| 4 Nov | 4,311 | — | — | **UNVERIFIED** |
| 5 Nov | 6,660 | — | — | **UNVERIFIED** |
| 6 Nov | 33,960 | — | — | **UNVERIFIED** |
| 7 Nov | 6,497 | — | — | **UNVERIFIED** |
| 8 Nov | 7,741 | — | — | **UNVERIFIED** |
| 9 Nov | 9,366 | — | — | **UNVERIFIED** |
| 10 Nov | 4,347 | — | — | **UNVERIFIED** |

**Why they can differ.**
- An empty query and a refused (rules) query are billed one read and may not appear as document reads.
- Listener resumes after more than 30 minutes offline are billed again.
- The Console chart may use a different day boundary or time zone (note which one it shows).
- Monitoring data is sampled and can arrive late.
- Usage can be rounded.

**Rule.** If the Console daily totals are within about ±5 % of Monitoring on all 7 days, Monitoring is accepted as the working measure. Otherwise A1 analysis uses the Console figures.

## 5. Decisions

### Proven

1. The highest quota day in the latest week reached 67.9 %, driven by one three-hour burst; the rest of the week was 8–19 %.
2. Reported reads fall only in 07:00–20:59 ICT, plus a fixed daily job at 01:00 ICT (≈ 341 reads). Hours without a data point are not counted as zero.
3. The burst windows are the only ones with ListCollectionIds / extra ListDocuments activity.
4. No QD deploy in the period.

### Not proven

- The source of the bursts (7 Nov, and the earlier 27 Oct).
- The owner of the 01:00 job.
- The split of day-time reads between QD, PV2 and the legacy app.
- Billed reads.

### Needed from the owner

1. Firebase Console → Firestore → Usage: reads per day 4–10 Nov (screenshot showing dates and time zone).
2. Answers to the questions in §2 (7 Nov 09:00–12:00 and 10 Nov 19:00 ICT).
3. The owner of the 01:00 job (§3).
4. Usage times of QD / PV2 / legacy pages for the other notable hours: 5 Nov 16:00, 6 Nov 19:00, 9 Nov 09:00, 10 Nov 13:00 ICT.

### Fix QD, PV2, or nothing yet?

- **No code change yet.**
  - The largest risk in the data is a burst whose source is unknown and which carries listing calls that the QD and PV2 app code never makes (no ListCollectionIds in either repository, B6).
  - Changing app code now would not address it.
- **Non-code steps that are safe now** (owner's decision):
  - ask everyone not to browse Firestore → Data during working hours unless needed;
  - identify the 01:00 job;
  - keep daily monitoring.
- **After the owner's answers:**

  | If the source is … | Then |
  |---|---|
  | the Console or a tool | operational fix (who may browse, when), no code change |
  | PV2 pages | O1 (Assembly, tested, −99 % in the emulator) and then O3 / O4, each with PV2 owner approval |
  | QD pages | the V5 limited release (filter re-use) and Q2a, after its own approval |

### Criteria before lowering A1 from HIGH to MEDIUM (all must hold)

1. Billed reads verified against Monitoring for at least 7 quota days (§4).
2. The source of the large bursts identified (7 Nov, and the 27 Oct W1 if possible) and either removed or shown to be a controlled, rare activity.
3. The 01:00 job identified (owner known, purpose known).
4. **14 consecutive quota days** below 50 % (25,000), with no hour above 10,000, measured with the same script.
5. Daily monitoring in place with the agreed thresholds (Warn ≥ 35,000, Act ≥ 45,000).

Lowering A1 further (LOW) would additionally need any planned release (QD V5, O1) measured not to raise reads, or a plan / capacity change decided by the owner (not in scope).
