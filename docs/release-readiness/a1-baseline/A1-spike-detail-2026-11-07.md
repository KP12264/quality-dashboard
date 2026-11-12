# A1: 5-minute detail of the read burst on Saturday 7 Nov 2026, 08:00–13:00 ICT

**Status.** A1 = HIGH. Billed reads = UNVERIFIED. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO.
**Root cause: NOT established.**

## Source

- **Script.** The project owner ran [`a1-spike.sh`](a1-spike.sh) v1.1 in Google Cloud Shell on 2026-11-12.
  - Commit `20f7d14`; script SHA-256 `dcb143c579aeab9156789c7e308013ae9631db93276e7d8eca92c4d03243873d`.
  - HTTP GET to Cloud Monitoring only, 12 requests.
- **Result archive.** SHA-256 `e7e6f3ce62d24587cbe2a4b707cbc3956f57562349bb15823975327117d53adb`.
  - Every file matched `MANIFEST.sha256`.
  - No token, e-mail or home path was found in the files.
- **Not stored in the repository.** The archive, its raw JSON, the 5-minute CSV and all credential labels. The archive's tar metadata contains a user name.
- **Window.** 01:00–06:00 UTC = 08:00–13:00 ICT, 60 buckets of 5 minutes (bucket times below are bucket starts, ICT).
- **Missing data.** `NO_POINT` means Monitoring returned no data point for a bucket. It is **not** counted as zero, and sums cover reported points only.

## 1. Confirmed facts (read directly from the Monitoring data)

1. **The 5-minute sums equal the hourly baseline** ([summary](A1-baseline-summary-2026-11-04_10.md)):

   | Hour (ICT) | Document reads | ListCollectionIds | ListDocuments | Buckets with no reads point |
   |---|---|---|---|---|
   | 08:00 | 756 | 0 | 0 | 3 of 12 |
   | 09:00 | 2,931 | 6 | 4 | 1 of 12 |
   | 10:00 | 3,655 | 5 | 3 | 4 of 12 |
   | **11:00** | **20,978** | 2 | 1 | 0 of 12 |
   | 12:00 | 431 | 0 | 0 | 7 of 12 |
   | **Window** | **28,751** | 13 | 8 | 15 of 60 |

2. **Read type.** All reported document reads are of type `QUERY`. `LOOKUP` is 0 in every bucket that has a point.
3. **Timing of the burst.** It is a sustained period from **10:50 to 12:00 ICT**, not a single peak.
   - 10:50–11:55 ICT: 268–3,833 reads per 5 minutes.
   - Largest buckets:

     | Bucket (ICT) | 11:35 | 11:50 | 11:25 | 11:20 | 11:40 | 10:55 | 11:00 |
     |---|---|---|---|---|---|---|---|
     | Reads | 3,833 | 3,089 | 3,016 | 2,762 | 2,175 | 1,865 | 1,698 |

   - Reads fall to 3 at 12:05.
4. **High reads started at 10:50 ICT.** The bucket at 10:50 had 901 reads and the bucket at 10:55 had 1,865. This is **before** the owner's earlier evidence of QD / PV2 being opened at about **11:26–11:28 ICT**.
5. **Security Rules evaluations.**
   - Rules were evaluated throughout the window, as LIST, GET, CREATE and UPDATE, all with result ALLOW. No DENY series was returned.
   - Rules evaluations by hour:

     | Hour (ICT) | 08 | 09 | 10 | 11 | 12 |
     |---|---|---|---|---|---|
     | LIST evaluations | 99 | 182 | 155 | 731 | 23 |
     | Reads ÷ LIST evaluations | 7.6 | 16.1 | 23.6 | 28.7 | 18.7 |

6. **Admin / console-type API calls.** These came in three short clusters:

   | Cluster (ICT) | First | Then (within about 10 minutes) |
   |---|---|---|
   | ≈ 09:00 | `Locations.ListLocations`, `FirestoreAdmin.ListDatabases` | `ListCollectionIds` and `GetOrListDocuments` |
   | ≈ 10:50–10:55 | the same, plus `FirestoreAdmin.GetDatabase` | the same |
   | ≈ 11:25 | `Locations.ListLocations`, `FirestoreAdmin.ListDatabases` | the same |

   - At most 4 `ListCollectionIds` and 3 `GetOrListDocuments` calls per 5 minutes.
   - The masked credential labels cannot be matched to any specific key and identify no person.
7. **Client SDK methods.** Neither `firestore/api/request_count` nor `serviceruntime/api/request_count` returned any `RunQuery`, `Listen`, `BatchGetDocuments` or `Commit` series in the window, although CREATE / UPDATE rules evaluations show that client writes took place.
8. **Listeners and connections.**
   - At most **3** snapshot listeners and **5** active connections in any bucket.
   - Both metrics have no point in 20 of 60 buckets.
9. **Gap.** No metric returned a point for 09:55–10:10 ICT.

## 2. Correlations (measured, but they do not show cause)

- **C1. Reads vs rules LIST evaluations.**
  - Over the 45 buckets with both values, reads correlate with rules `LIST/ALLOW` evaluations: **Pearson r = 0.91**.
  - Reads vs `GET/ALLOW`: r = 0.08.
  - **r = 0.91 does NOT confirm that client queries are the root cause.**
    - It is a correlation over one window, from one metric family.
    - Rules evaluations count requests, not documents, and cannot attribute reads to an app, a page or a person.
    - Reads that bypass Security Rules (Console, admin tools) leave no trace in this metric and could run at the same time.
    - A common cause (for example several people working at once) would give the same pattern.
- **C2. Console-type activity and the burst start.** The second admin-call cluster (≈ 10:50–10:55) falls at the start of the high-read period. This is co-occurrence in time only. The listing calls are few, and the reads they cause cannot be measured with these metrics.
- **C3. Reads per LIST evaluation rose** from 7.6 (08:00) to 28.7 (11:00). This could mean larger query results per request, but it is a ratio of two counts, not a measured query size.

## 3. Hypotheses (not verified)

- **H1. Rules-evaluated client queries made most of the 11:00-hour reads.** The client would be QD, PV2 or the legacy app, through the web SDK.
  - Supported by C1, and by the fact that Console / admin reads bypass rules.
  - Not shown: which app, page or query.
- **H2. The Firebase Console was opened about three times** (≈ 09:00, ≈ 10:50, ≈ 11:25 ICT).
  - Supported by fact 6 and by the owner's screenshot of the Data viewer at 09:07.
  - Its share of the 28,751 reads is unknown.
- **H3. Queries in the 11:00 hour returned more documents per request** (wider date ranges, larger collections, or listener re-reads). Supported only by C3.
- **H4. App sessions were active before 11:26.** Fact 4 shows high reads from 10:50, before the QD / PV2 opening evidence at 11:26–11:28.
  - Either other sessions (other people, other devices, already-open tabs, the legacy app) were active, or the reported times are approximate.

## 4. Unknowns

- The root cause of the burst.
- Which app, page, device or person made the rules-evaluated queries.
- The number of reads made by the Console, including any real-time Data viewer.
- What happened in buckets with `NO_POINT`, including 09:55–10:10 ICT.
- Why the request metrics show no client SDK methods.
- Billed reads for this period.

## 5. Next evidence

1. **Chrome history** for 7 Nov 08:00–13:00 ICT on the browsers that may have been used.
   - Search: `console.firebase.google.com`, `kp12264.github.io`, the QD and PV2 addresses.
   - Record times and paths only.
2. **Who used which app between 10:50 and 12:00 ICT** on Saturday 7 Nov: pages, date ranges, number of tabs and devices.
3. **Emulator measurement** of reads per page and per action for QD and PV2. Compare it with the shape above: QUERY only, about 29 reads per LIST evaluation in the 11:00 hour.
