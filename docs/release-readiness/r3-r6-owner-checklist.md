# R3 / R6 — Owner checklist for the Firestore read spikes (VIEW ONLY)

Project `daily-production-report-46b60`, database `(default)`. Prepared from Updates 2–5 of the A1/A2 report.
**Do not change any setting, do not enable logs, do not open Audit Logs, do not browse documents.**

> ⚠ Browsing documents in the Firebase Console (Firestore → Data) **costs reads** and counts toward the
> same daily quota as PV2. Use only the Usage / Monitoring / Quotas pages listed below.

## The time windows to check

| # | Thailand time (ICT) | UTC | Pacific quota day | What the metrics show (facts) |
|---|---|---|---|---|
| W1 | **27 Oct 11:00–12:00** | 27 Oct 04:00–05:00 | PT 26 Oct | 22,636 reads (45 % of a day's quota in one hour); rules LIST 856 / GET 592; 8 snapshot listeners at the same time; 130 updates, 0 creates |
| W2 | **28 Oct 00:00–02:00** | 27 Oct 17:00–19:00 | PT 27 Oct | 9,316 + 13,701 reads; 49 + 19 creates; 1 delete; includes the daily 01:00 job |
| W3 | 29 Oct 09:00–10:00 | 29 Oct 02:00–03:00 | PT 28 Oct | 7,408 reads; 272 updates |
| W4 | 29 Oct 14:00–15:00 | 29 Oct 07:00–08:00 | PT 29 Oct | **29 snapshot listeners** at once, only 187 reads |
| W5 | **30 Oct 03:00–07:00** | 29 Oct 20:00 – 30 Oct 00:00 | PT 29 Oct | 9,098 reads, mostly single-document reads; starts right after the QD `main` deploy (30 Oct 02:25–03:25) |
| W6 | 30 Oct 08:00–09:00 | 30 Oct 01:00–02:00 | PT 29 Oct | 4,169 reads, mostly single-document reads |
| W7 | every day 01:00–02:00 | 18:00–19:00 the day before | – | exactly 2 `ListDocuments` requests + about 330 reads (= the whole weekend total) |

## R3 — what to look at in the Console (view only)

| # | Where | What to note for each window above | Why |
|---|---|---|---|
| C1 | Firebase Console → Firestore → **Usage** | daily and hourly reads / writes / deletes for 26–31 Oct; any "quota exceeded" notice | the billing-side view, to compare with the Monitoring numbers |
| C2 | Google Cloud Console → IAM & Admin → **Quotas** (filter: Firestore / free tier) | whether any Firestore quota shows as exceeded on 26–31 Oct | the only direct sign of a quota stop (`request_count` does not show the apps' errors) |
| C3 | Google Cloud Console → Firestore → **Key Visualizer** / **Query insights**, if the page exists for this database | which collection or key range was hot in W1, W2, W5 | identifies the collection, which no metric so far can |
| C4 | Firebase Console → Project settings → **Usage and billing** (Spark) | the daily usage figures for the same days | second billing-side view |
| C5 | Firebase Console → Authentication → **Users** (view only; personal data — note only counts and times, do not copy e-mails) | how many accounts signed in around W1 / W2 / W4 / W5 | who could have been using PV2 / QD at those hours |

For each page please send a screenshot or the numbers, with the time zone the page shows (many pages show the
browser's local time or Pacific time).

**Time-sensitive:** Cloud Monitoring keeps these numbers until about **7 Dec 2026**; Console pages may keep less.

## R6 — records to ask the system owners

| # | Question | Windows |
|---|---|---|
| Q1 | Was PV2 used heavily (data entry, reports, many open tabs) at these times? Which pages keep a live view (listeners)? | W1, W4 |
| Q2 | Was there night-shift entry, an import, a script or any bulk work around midnight? | W2 |
| Q3 | What runs every day at 01:00 Thailand time (2 `ListDocuments`)? A scheduled backup / export / script? Who owns it? | W7 |
| Q4 | After the QD deploy on 30 Oct (02:25–03:25), was the Dashboard opened repeatedly to check it (e.g. 31-day views, Refresh)? | W5, W6 |
| Q5 | Was the Firebase Console data viewer (Firestore → Data) open at any of these times? (it uses live listeners and costs reads) | W1, W2, W4 |
| Q6 | Any other tool, app or person with access to this Firebase project in these windows? | all |

## Not part of R3 / R6 (needs separate approval)

Audit logs (Admin Activity / Data Access), any setting change, U3 document counts, any Production query.
