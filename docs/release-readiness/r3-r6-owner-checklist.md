# R3 / R6 — Owner checklist for the Firestore read spikes (VIEW ONLY) — revision 2

Project `daily-production-report-46b60`, database `(default)`. Built from Updates 2–7 of the A1/A2 report.
**Approved so far: S1 only.** S2–S8 are listed for planning and need separate approval.
**Never:** change a setting, click Edit / Create / Enable / Disable / Delete, enable or open audit logs,
or open Firestore → Data. Status: **A1 = HIGH, G2 = NOT APPROVED.**

Changes in revision 2: G1 the 01:00 job with the R2 data; G2 the API metrics page (S1), whose content must
first be **checked**, not assumed; G3 where a scheduled job could live; G4 a careful read-risk note per page
(no page is promised to cost 0 reads); G5 the Pacific quota day per window; S4 no longer claims that the
Quotas page proves past usage; S8 paused; the 01:00 job is a separate track (Part B).

---

## 1. What is known (facts, from Updates 2–7)

| Fact | Source |
|---|---|
| Highest Pacific quota day 27,812 reads (55.6 %), PT 26 Oct; next 26,401 (52.8 %), PT 27 Oct; none above 50,000 by the metric | Update 2 |
| Highest hour 22,636 reads (27 Oct 11:00–12:00 Thailand) | Update 2 |
| All reads `type=QUERY`; `LOOKUP` 0; `read_ops_count` equals `read_count` in all 120 hours | Updates 3, 7 |
| No import-like hour (at most 130 updates, 0–68 creates in spike hours) | Update 3 |
| Snapshot listeners: 8 at once in W1, 29 in W4; QD (`main` and V5) has no `onSnapshot` | Update 3 |
| `api/request_count` and `query_stat` show only `ListDocuments` (daily 01:00 job); they do not capture the apps' traffic | Updates 2, 7 |
| `billable_read_units` / `billable_realtime_read_units`: no data | Update 4 |
| In the emulator, QD can produce both read patterns seen in production | Update 5 (R1) |
| Monitoring data for these days is kept until about **7 Dec 2026** | Monitoring retention |

## 2. Hypotheses (NOT verified)

- H1 The apps' (web SDK) traffic uses a channel that `request_count` / `query_stat` do not record.
- H2 W1 / W4 involve a listener-using client (PV2, a legacy page, or the Firebase console data viewer).
- H3 W5 is checking of the QD dashboard after the 30 Oct deploy.
- H4 The 01:00 job is a backup / export script.

## 3. Not yet known / not verifiable with the data in hand

- Which app, credential or person caused each spike.
- Which collections were read in each spike.
- Whether the free-tier quota was actually exceeded (Monitoring counts are not the quota ledger).
- Who owns the 01:00 `ListDocuments` job.
- Real collection sizes (U3, not approved).

---

## 4. Time windows (Thailand time = UTC+7)

| # | Thailand time | UTC | Pacific quota day | Facts |
|---|---|---|---|---|
| W1 | **Tue 27 Oct 2026, 11:00–12:00** | 27 Oct 04:00–05:00 | PT 26 Oct | 22,636 reads; rules LIST 856 / GET 592; 8 snapshot listeners; 130 updates |
| W2 | **Wed 28 Oct, 00:00–02:00** | 27 Oct 17:00–19:00 | PT 27 Oct | 9,316 + 13,701 reads; 68 creates, 1 delete; overlaps the 01:00 job |
| W3 | Thu 29 Oct, 09:00–10:00 | 29 Oct 02:00–03:00 | PT 28 Oct | 7,408 reads |
| W4 | Thu 29 Oct, 14:00–15:00 | 29 Oct 07:00–08:00 | PT 29 Oct | 29 snapshot listeners, 187 reads |
| W5 | **Fri 30 Oct, 03:00–07:00** | 29 Oct 20:00 – 30 Oct 00:00 | PT 29 Oct | 9,098 reads, mostly single-document reads; starts after the QD deploy (02:25–03:25) |
| W6 | Fri 30 Oct, 08:00–09:00 | 30 Oct 01:00–02:00 | PT 29 Oct | 4,169 reads |
| W7 | every day 01:00–02:00 | 18:00–19:00 the day before | – | 2 `ListDocuments`, about 166 documents each (≈ 333 reads) — see Part B |

---

## Part A — Read spikes (W1–W6)

| Step | Page | Purpose | Status |
|---|---|---|---|
| **S1** | Google Cloud Console → APIs & Services → Cloud Firestore API → **Metrics** | First **check whether** the page can show method and credential at all; only then look at W1–W6 | **approved — guide in §6** |
| S4 | IAM & Admin → **Quotas** | Shows current limits and possibly recent usage. **It cannot be assumed to show past usage or a past quota stop for 26–31 Oct**; anything it shows is recorded as "as shown on the page", not as proof | not approved |
| S5 | Firebase Console → Firestore → **Usage** | Daily / hourly reads, writes, deletes; any quota notice; note the page's time zone | not approved |
| S7 | Google Cloud Console → Firestore → **Key Visualizer** (only if it exists for this database) | Hot key ranges / collections in W1, W2, W5 | not approved |
| S8 | Authentication → Users | **Paused**: an account count or "last sign-in" does not show activity in a spike window, and the page holds personal data | paused |
| R6 | Owners' records (questions Q1, Q2, Q4, Q5, Q6 in §8) | Who did what in W1–W6 | not approved |

## Part B — The daily 01:00 `ListDocuments` job (separate track)

Facts: 2 `ListDocuments` every day at 01:00–02:00 Thailand time (weekends included), about 166 documents each;
reported under `datastore_request` and `firestore.googleapis.com/Database`. It explains the ≈ 333 reads of that hour
and the 335 reads of a weekend day. **It does not explain W1–W6** (W2 overlaps it, but has about 23,000 reads).

| Step | Where | What to look for | Status |
|---|---|---|---|
| B1 | S1 page (same page as Part A) | If S1's check shows a method / credential breakdown: the credential behind `ListDocuments` at 01:00 | covered by the S1 approval only if the breakdown exists |
| B2 | APIs & Services → Credentials | Names / types of keys, OAuth clients, service accounts matching B1 (never key values) | not approved |
| B3 | IAM & Admin → Service Accounts | Names and any "last used" information | not approved |
| B4 | Firebase Console → Extensions | Installed extensions that could export / back up | not approved |
| B5 | Owners (R6 Q3) | Apps Script triggers, GitHub Actions (cron `0 18 * * *` UTC = 01:00 Thailand), a cron on a machine or server, backup tools | not approved |

---

## 5. Read risk per page (careful; nothing here is guaranteed)

| Page | Expected Firestore document reads | Basis / caution |
|---|---|---|
| APIs & Services metrics (S1), Credentials (B2), Service Accounts (B3), Quotas (S4) | **None expected** | These pages show service metrics or settings, not documents. **Not verified for this project**; if any page shows documents, stop and do not continue |
| Firestore → Usage (S5), Key Visualizer (S7) | **None expected** | They show usage statistics; **not verified**. Stop if documents appear |
| Extensions (B4) | **None expected**, but the page can change configuration | Look only; do not click Install / Reconfigure / Uninstall |
| **Firestore → Data** | **Reads every document shown, and keeps listening while open (more reads)** | **Never open.** It also creates the listener signature under investigation |
| Authentication → Users (S8) | Not Firestore reads, but personal data | Paused |

To check afterwards that a step really caused no reads, compare the Monitoring hour of the visit with the hours
around it (not approved yet; would be a separate read-only step).

---

## 6. S1 step-by-step guide (approved)

Goal: **first establish what the page can show.** Do not conclude anything from a chart before step 4.

1. Open Google Cloud Console and select the project **`daily-production-report-46b60`** (top bar). Check the project ID, not only the name.
2. Menu ☰ → **APIs & Services** → **Enabled APIs & services** → click **Cloud Firestore API**. If the API is not listed, stop and report that (do not enable anything).
3. Open the **Metrics** tab (the overview may show it directly). Look only; do not click Disable API, Manage, or any edit button.
4. **Capability check — record before anything else:**
   - 4a. Which charts exist (e.g. Traffic, Errors, Latency, by method)? List their titles.
   - 4b. Is there a filter or selector for **Methods**? For **Credentials**? Write "yes / no" for each, exactly as the page shows.
   - 4c. Which time ranges can be chosen? Can a **custom range** cover 26–31 Oct 2026? What time zone does the page say it uses?
   - If 4b is "no" for both: take the screenshot of step 5a only and stop. That is a valid result (it means S1 cannot answer the question).
5. Only if 4b shows a breakdown:
   - 5a. Set the range to **26 Oct 2026 00:00 – 31 Oct 2026 00:00** in the page's time zone (write it down).
   - 5b. Methods: note which methods appear and their totals; for the hours of W1, W2, W5 (convert from §4) note the leading methods.
   - 5c. Credentials: note which credentials appear around **01:00 Thailand time** (18:00 UTC) and around W1, W2, W5.
6. Close the page. Do not open other pages from it.

**Screenshots to take** (whole chart area, including the time range and time-zone label):
- S1-a: the Metrics page with the list of charts and the filter area (step 4).
- S1-b: the method filter / chart for 26–31 Oct (only if it exists).
- S1-c: the credential filter / chart for 26–31 Oct (only if it exists).
- S1-d: a zoom on 27 Oct 10:00–13:00 and 28 Oct 00:00–02:00 Thailand time, and on one night at 01:00 (only if the charts allow it).

**Mask before sending:**
- any **API key value**, OAuth **client secret** or token (should never be visible; if it is, do not send that image);
- **personal e-mail addresses** (a person's account); a service-account address may be shown only as its name part, with the domain kept if you wish (e.g. `name@…iam.gserviceaccount.com`);
- your own account name / avatar in the top bar;
- project number and billing account ID (not needed).

**Keep visible:** project ID, chart titles, method names, credential **type** and the non-personal part of its name, time range, time zone, values.

Send the screenshots with: the page's time zone, the date range used, and "yes / no" from step 4b.

---

### S1 result (2026-11-10, owner-reported; see A1/A2 report Update 8)

- Facts: Methods and Credentials filters **exist**; time zone UTC+7; range 30 days. `production-dashboard`: no data.
  `New Browser key`: `GetOrListDocuments` 60 requests, `ListCollectionIds` 2 requests; `ListDocuments` (v1, v1beta1): no data.
- Hypothesis H5: the 60 requests (= 2 per day × 30 days) are the 01:00 job (Part B); time of day not yet shown.
- Not identified: the source of W1–W6; the owner of the 01:00 job.
- Limits: request counts, not document reads; method names differ from the Firestore metric labels; traffic without an
  attributable credential may not appear; no hourly view yet; no screenshots stored.
- Next (needs approval): hourly view of `GetOrListDocuments` for `New Browser key` on one day; B2 / B3 for that key.

### S1 follow-up (2026-11-10, owner-reported; see Update 9)

- Facts: `New Browser key`, 1 day, `google.firestore.v1.Firestore.GetOrListDocuments`: 2 requests, 0 % errors,
  average latency 0.104 s, activity at about 01:00 UTC+7. 2 screenshots kept by the owner (not stored here).
- H5 better supported (count, time, method family consistent) but not proven: same job as 26–30 Oct not shown;
  `GetOrListDocuments` = `ListDocuments` is an inference; holder of the key unknown. Not linked to W1–W6.

### Part B next steps (proposed, read-only, each needs approval)

| # | Step | What to record | Masking |
|---|---|---|---|
| B1a | S1 page, `New Browser key`, `GetOrListDocuments`, **custom range 26–31 Oct**, per day / hour | 2 requests per day at about 01:00 on each of those days, or not | none needed |
| B1b | S1 page, `New Browser key`, `ListCollectionIds` | date and time of the 2 requests | none needed |
| B2 | APIs & Services → Credentials → `New Browser key` (open, **do not edit**) | creation date; application restrictions (HTTP referrers / none) and API restrictions as shown; **last 4 characters** of the key only | never the full key |
| B2b | Compare those 4 characters with the web config of QD and PV2 (already in G1 evidence R3 / R4) | same key or not | 4 characters only |
| B6 | Read-only code search in the repositories the owners control for REST calls to `firestore.googleapis.com/v1/projects/daily-production-report-46b60` (QD repository: can be searched here on approval; PV2 and others: by their owners) | file and line, schedule if any | none |
| B5 | Owners (R6 Q3), with the clue: a REST list call with the browser key, twice a day at 01:00 Thailand time: Apps Script trigger, GitHub Actions cron `0 18 * * *` UTC, Google Sheets import, cron on a machine / server, backup or uptime tool | the tool and its owner | no personal data in notes |

**B6 result for the QD repository (2026-11-10, Update 10):** working branch `c265e7d`, `origin/main` `b118f93` and the
git history: **no scheduled job, no direct Firestore REST call, no `ListDocuments` / `GetOrListDocuments` /
`listCollectionIds`**, no `fetch` in application code; timers only `js/dashboard.js:1519` and
`js/weekly-plan-page.js:431` (no reads); one API key `AIza…J53c` (`js/config.js:26`). **QD is not fully excluded**
(a browser with QD open reads through the SDK); **owner of the 01:00 job unknown; cause of the spikes unknown.**
Still open: B6 for PV2 and other repositories (their owners), B2 / B2b (is `New Browser key` = `…J53c`?).

**B2 / B2b and B6 for PV2 (2026-11-10, Update 11):** `New Browser key` ends in `J53c`, the same key as QD
(`js/config.js:26`), PV2 (`production-v2/js/firebase-v2.js:2`) and the legacy root app (`index.html:655`), so the key
cannot attribute a request to one app. PV2 repository (`431836a`, full history): SDK only, no REST call, no scheduled
job; one `onSnapshot` in the legacy root app (`index.html:760`); whole-collection reads, 31-day range reads and
line-wide scans exist (see Update 11). **Owner of the 01:00 job and cause of the spikes still unknown.**
Remaining for Part B: B5 (owners: scripts, sheets, tools using the web key); B1a / B1b.

Not to do without a separate decision: editing, restricting, rotating or deleting the key (it may be used by the
web apps; changing it could break PV2), enabling audit logs.

## 7. Evidence to keep (all steps)

Screenshot file name with step and date, the page's time zone, the exact date range selected, and a note of anything
that was **not** available on the page. No copied secrets, no personal e-mail addresses.

## 8. Questions for the owners (R6; not approved yet)

| # | Question | Windows |
|---|---|---|
| Q1 | Was PV2 used heavily (data entry, reports, many open tabs) at these times? Which pages keep a live view (listeners)? | W1, W4 |
| Q2 | Was there night-shift entry, an import, a script or bulk work around midnight? | W2 |
| Q3 | What runs every day at 01:00 Thailand time (2 `ListDocuments`)? Who owns it? | W7 (Part B) |
| Q4 | After the QD deploy on 30 Oct (02:25–03:25), was the Dashboard opened repeatedly to check it? | W5, W6 |
| Q5 | Was the Firebase console data viewer (Firestore → Data) open at any of these times? | W1, W2, W4 |
| Q6 | Any other tool, app or person with access to this project in these windows? | all |

## Not part of R3 / R6

Audit logs (Admin Activity / Data Access), any setting change, U3 document counts, any Production query or write.
