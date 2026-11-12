# A1: real collection sizes and what they mean (2026-11-12)

**Status.** A1 = HIGH. Billed reads = UNVERIFIED. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO. **Root cause: NOT established.**

## 1. Real document counts (owner, production, count only)

The project owner ran two aggregate **count** queries (`runAggregationQuery` with `count`) in Google Cloud Shell:
- project `daily-production-report-46b60`, database `(default)`;
- no document content was read, nothing was written, there were no errors;
- the IAM permission check passed before the counts.

| Collection | Documents | readTime (UTC) | Thailand time |
|---|---|---|---|
| `prodV2_actualLogs` | **331** | 2026-11-12T11:50:22.754667Z | 12 Nov 18:50 |
| `scrapLogs` | **93** | 2026-11-12T11:50:39.314835Z | 12 Nov 18:50 |

**These are the sizes on 12 Nov, not on 7 Nov.**
- Documents may have been added (and possibly deleted) between 7 and 12 Nov.
- The size on 7 Nov is **unknown**. If only additions happened, it was **at most** 331 for `prodV2_actualLogs` and **at most** 93 for `scrapLogs`. Deletions are not excluded: Firebase Usage showed 1 delete in the week to 12 Nov, collection unknown.

## 2. Emulator seed vs production: documents read vs total reads

The emulator figures are estimates on synthetic data (see [Phase B report](A1-phaseB-emulator-reads.md)), not billed reads.

| | Emulator 30-day seed | Emulator 90-day seed | Production 12 Nov |
|---|---|---|---|
| `prodV2_actualLogs` documents in the collection | 252 | 540 | **331** |
| PV2 Assembly: documents returned per load | 252 | 540 | **331 (estimate)** |
| PV2 Assembly: other reads per load | 0 | 0 | 0 expected (code: no other read) |
| PV2 Assembly: estimated reads per load | 252 | 540 | **≈ 331 (not billed; UNVERIFIED)** |
| `scrapLogs` documents in the collection | 132 in the seeded month (QD seed) | — | **93 (whole collection)** |

**Note on the emulator seed.** In both runs the emulator's `prodV2_actualLogs` held the PV2 seed plus 72 documents written by the QD seed:
- 30-day run: 180 + 72 = 252;
- 90-day run: the 72 QD-seed ids fall inside the 90 days, so the total stayed 540.

Assembly returned exactly the collection size in both runs.

## 3. PV2 Assembly at 331 documents

### Verified (code at `431836a`, and emulator)

- `assembly.js` has **one** Firestore read: `load()` calls `all("prodV2_actualLogs")` = `collection("prodV2_actualLogs").get()` with **no filter**.
  - It then filters by date and shift **in the browser** (`logs.filter(x => x.date === date && …)`).
  - The other scripts on the page (`context-v2.js`, `nav.js`, `theme.js`, the Firebase layer) make no Firestore reads.
- `load()` runs on **page open, Load button, Date change and Shift change**.
- In the emulator, each of these four actions returned the whole collection:

  | Action | Documents returned |
  |---|---|
  | open | 252 |
  | date change | 252 |
  | shift change | 252 |
  | Load | 252 |

  Changing the model group re-renders without reading. There are no listeners and no timers.

### Estimate (not a billed figure)

- About **331 reads per Assembly load** at the 12 Nov size, or at most 331 on 7 Nov if only additions happened.
- Each extra tab, date change, shift change or Load press repeats it.
- The read grows with every new `actualLogs` document and never shrinks.

## 4. Scenario: how many Assembly loads would give 20,978 reads?

**This is an arithmetic scenario only. It is NOT a confirmed root cause.** It assumes every one of the 20,978 reads in the 11:00 ICT hour of 7 Nov came from Assembly, which is not established.

| Assumed collection size on 7 Nov | Loads for 20,978 reads | Per minute (one hour) | Largest 5-minute bucket (3,833 reads) |
|---|---|---|---|
| 331 (12 Nov size, upper bound) | **≈ 63.4 → at least 64 loads** | ≈ 1.1 | ≈ 11.6 loads in 5 minutes |
| 300 | ≈ 70 | ≈ 1.2 | ≈ 12.8 |
| 250 | ≈ 84 | ≈ 1.4 | ≈ 15.3 |

**Checks against Monitoring for 7 Nov.**
- **LIST evaluations.**
  - 64 or more Assembly loads would be 64 or more LIST evaluations, within the 731 LIST evaluations of that hour. So the arithmetic does not rule it out.
  - The other ≈ 667 LIST evaluations would then have returned almost no documents. That is possible: for example PV2 loss-log queries per day often return 0–1 documents, and the document-read metric counts returned documents. It is not shown.
- **Usage rate.**
  - "Loads" include date and shift changes, so 64 loads need not be 64 page opens: for example, a few people stepping through dates and shifts in one or more tabs.
  - Whether anyone did this on 7 Nov is **not known**.
- **Other hours.** The same arithmetic gives about 9 loads for 09:00 (2,931) and about 11 for 10:00 (3,655), again upper-bound sizes and only if all reads were Assembly.
- **Conclusion: Assembly could produce the burst on its own at about one load per minute.** Whether it did is **not established**. Mixed sources (QD, other PV2 pages, Console, legacy app) remain possible.

## 5. QD risk with `scrapLogs` = 93 documents

- QD queries `scrapLogs` **by date range**, not the whole collection.
  - In the emulator, the documents per query followed the period: 16 to 135.
  - The exception is the admin Ops Console (`ops-console.js`), which reads the whole collection on its actions.
- With 93 documents in the whole collection, **no single QD query can return more than 93 documents** today.
  - Upper bound per Dashboard load: 2 queries × 93 + other reads. The other reads are about 8 at the default range and about 187 document gets at a full-month range, which are `prodV2_actualLogs` per day.
  - So the bound is about **190–380 reads per load**, and much less for short ranges.
- To reach 20,978 reads in one hour, QD alone would need **about 55 or more full-month Dashboard loads**, or **over 100 default-range loads**, in that hour. Not impossible, but less likely than Assembly at the same usage.
- **QD risk today: LOW to MEDIUM.**
  - It grows with the number of scrap entries per period and with full-month ranges.
  - The largest QD read in the test is the full-month range (GET fan-out to `prodV2_actualLogs`, 6 per day).
- **Limit.** The QD code tested is the development branch (V5). The deployed QD may differ in how filters re-use data (V5 is not deployed).

## 6. Priority of F1–F6 (Impact, Risk, Complexity)

| Priority | Fix | Impact | Risk of the change | Complexity | Track |
|---|---|---|---|---|---|
| **1** | **F1** Assembly reads only the selected date (and shift) | **High**: ≈ 331 → about the documents of one date per load; stops growing with history; the largest single read in either app | Low (one query change; date field used by all writers; tested in emulator −99 %, browser 745 → 6) | Low | **O1 — NOT APPROVED** |
| 2 | **F6** Operational guidance: avoid stepping Assembly through dates / shifts and multiple Assembly tabs; avoid the Console Data viewer during work | Medium, immediate | Very low (no code) | Low | Owner decision |
| 3 | **F3** Exec: re-use today's documents; keep per-day results for the session | Medium: Trend 30 = days × lines × shifts × 2 per click; 360 → 276 after Trend 7 in the emulator | Low | Medium | PV2 O-item (O4) — not approved |
| 4 | **F4** Order Tracking: keep loaded actuals for the session | Low–Medium: repeat clicks 120 → 12 in the emulator | Low | Low–Medium | PV2 O-item (O5–O9 group) — not approved |
| 5 | **F2** Dashboard: re-use the selected line's documents | Low: about 22 % of a 31-day load | Low | Medium (several functions) | PV2 O-item (O3) — not approved |
| 6 | **F5** Refresh re-use window | Low / uncertain | Medium (risk of showing old data during entry) | Medium | QD: separate approval; PV2 part: O-item — not approved |

- **Separation.**
  - F1–F4 and the PV2 part of F5 are **Production V2** changes. F1 **is O1**, which is **NOT APPROVED**.
  - F2–F4 belong to later O-items (O3, O4, O5–O9), also not approved.
  - No QD code change is proposed here; QD V5 needs its own release approval.
- **Nothing is implemented.** Each item needs separate approval and, for PV2, the PV2 owner.

## 7. Still not established

- The source of the 7 Nov burst. Assembly is a strong candidate by arithmetic and shape, not by evidence of use.
- The collection size on 7 Nov.
- Billed reads (UNVERIFIED).
- Who used which page between 10:50 and 12:00 ICT on 7 Nov.

**Next evidence that would confirm or exclude Assembly:**
1. Owner / users: was PV2 Assembly used on Saturday 7 Nov 10:50–12:00? How many tabs and devices? Did anyone step through dates or shifts?
2. Chrome history for `production-v2/assembly.html` in that window (times only).
