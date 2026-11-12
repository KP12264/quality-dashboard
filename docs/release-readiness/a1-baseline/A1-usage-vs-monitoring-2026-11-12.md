# A1: Firebase Usage compared with Cloud Monitoring (2026-11-12)

**Status.** **Billed reads = UNVERIFIED. A1 = HIGH.** G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO.

**Source.**
- The project owner's view of Firebase Console → Firestore → Database `(default)` → **Usage**, read on 2026-11-12.
- Only the values shown are recorded here. The screenshot itself is not kept in the repository (owner's decision), and no account, browser or personal data is recorded.

## 1. Values shown by Firebase Usage

| Item | Value (as displayed, rounded by the Console) |
|---|---|
| Range | "Last 7 days", **Nov 5 – Nov 12, 2026** |
| Reads (7-day total) | **72K** |
| Writes (7-day total) | **3.1K** |
| Deletes (7-day total) | **1** |
| Tooltip "Nov 7 – Nov 8" | Reads **32K**, Writes **609**, Deletes **1** |

- The panel is headed **"Billable Metrics"**.
- The page states: *"Includes Firebase console usage. Does not include imports/exports and aggregation queries. May not match billing and quota usage."*
- The page does not show its time zone or the exact start and end of each bucket.

## 2. Monitoring windows (`document/read_count`, owner's run of `a1-baseline.sh`; [hourly CSV](baseline-2026-11-04_10-hourly.csv))

| Window | Thailand time (ICT) | Monitoring reads (sum of reported points) | Hours with no data point in the window |
|---|---|---|---|
| UTC day 7 Nov | 7 Nov 07:00 → 8 Nov 07:00 | **32,354** | 10 |
| Thai calendar day 7 Nov | 7 Nov 00:00 → 8 Nov 00:00 | **32,354** | 10 |
| Pacific quota day 6 Nov | 6 Nov 15:00 → 7 Nov 15:00 | 33,960 | 13 |
| Pacific day 7 Nov | 7 Nov 15:00 → 8 Nov 15:00 | 6,497 | 11 |
| Monitoring's whole range | 4 Nov 15:00 → 11 Nov 15:00 | 72,882 | 83 |

- The UTC day and the Thai day give the same sum because the hours of 7 Nov 00:00–06:59 ICT have **no data point**.
- Hours without a data point are **not counted as zero**: the sums cover reported points only.

## 3. Comparison

| Usage value | Closest Monitoring value | Comparable? |
|---|---|---|
| Tooltip "Nov 7 – Nov 8": 32K | 32,354 (UTC day / Thai day 7 Nov) | **Not confirmed**: the Usage bucket's time zone and boundaries are unknown, and 32K is rounded (it could stand for roughly 31,500–32,499 if rounded to the nearest thousand; the rounding rule is not stated) |
| Tooltip "Nov 7 – Nov 8": 32K | 33,960 (Pacific quota day 6 Nov) | **Not confirmed** either way: Usage and Monitoring are not proven to count the same reads |
| 7-day total 72K (Nov 5 – Nov 12) | 72,882 (4 Nov 15:00 → 11 Nov 15:00 ICT) | **No**: different ranges; Monitoring has no data after 11 Nov 15:00 ICT |

**The ±5 % criterion is NOT assessed:**
- the Usage figures are rounded;
- the Usage windows are not confirmed;
- Usage is a "billable metric" that the Console itself says may not match billing and quota usage.

## 4. Confirmed facts

1. Firebase Usage shows, for "Last 7 days, Nov 5 – Nov 12": Reads 72K, Writes 3.1K, Deletes 1. For the tooltip "Nov 7 – Nov 8": Reads 32K, Writes 609, Deletes 1.
2. The Usage panel is "Billable Metrics" and states that it includes Firebase console usage and may not match billing and quota usage.
3. Monitoring reported 32,354 reads for both the UTC day and the Thai day of 7 Nov, and 33,960 for the Pacific quota day 6 Nov.
4. Both sources show one day near 32–34K reads around 7 Nov, against much lower other days.

## 5. Hypotheses (not verified)

- **U1.** The Usage chart groups by UTC day or by the browser's (Thai) day. It would fit 32,354 ≈ 32K, but the Console does not state its time zone, and a close number does not prove it.
- **U2.** The Usage bucket is the Pacific quota day and Usage counts somewhat fewer reads than Monitoring (33,960 vs 32K). Not excluded.
- **U3.** Hours without a Monitoring data point had no reads. Not proven.

## 6. Unknowns

- The time zone and bucket boundaries of the Usage chart.
- Unrounded Usage values.
- Billed reads and quota usage per Pacific quota day (Cloud Billing / Quotas).
- Whether Usage and Monitoring count the same operations (e.g. empty or denied queries, Console reads).

## 7. Still needed from the owner (view only)

1. Usage with a custom range of one day (e.g. 7 Nov), or every tooltip label and value, and any unrounded figure (e.g. "View in Usage and Billing", or Firestore Usage in the Google Cloud console).
2. The time zone the Usage page uses (browser or UTC), if the page or account settings show it.
3. If available: Google Cloud console → Billing / Quotas, the daily Firestore read quota usage for 4–10 Nov.

Until these match on the same windows for at least 7 quota days, **billed reads stay UNVERIFIED**, and the A1 criterion "billed reads verified (±5 %)" stays **not met**.
