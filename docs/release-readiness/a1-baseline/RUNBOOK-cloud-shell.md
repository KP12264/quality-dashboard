# A1 baseline: runbook for the project owner (Google Cloud Shell, read-only)

**What it does.**
- Reads Cloud Monitoring metrics only (`timeSeries.list`, HTTP GET).
- **No Firestore document is read**, nothing is created or changed, and no Rules, Billing, alert or gcloud setting is touched.
- No secret is asked for or stored: the access token comes from your own Cloud Shell login and never leaves memory.

**Period.** Quota days **4–10 November 2026, Pacific time (PST)**. Each quota day runs 00:00 → 24:00 PST = **08:00 → 08:00 UTC = 15:00 → 15:00 Thailand time (ICT)**, e.g. quota day 4 Nov = 4 Nov 15:00 ICT → 5 Nov 15:00 ICT.

## Steps

1. Open <https://console.cloud.google.com/> with the owner account, select project **daily-production-report-46b60**, and click **Activate Cloud Shell** (top right).

2. Check the project and the permission. You need `monitoring.timeSeries.list`, e.g. role *Monitoring Viewer* or *Owner*:

   ```bash
   gcloud config set project daily-production-report-46b60
   ```

   ```bash
   gcloud config get-value project
   ```

3. Get the script at the pinned commit `30fe62c` and check its hash. Expected SHA-256: `83655369942de1bbe8b8c93616ec5baf73e4a4c1c82cc7d91b3ae84e23a029d9`.

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/KP12264/quality-dashboard/30fe62c6b867ab96d58a6363fae9e2b419b08030/docs/release-readiness/a1-baseline/a1-baseline.sh
   ```

   ```bash
   sha256sum a1-baseline.sh
   ```

   It must print `83655369942de1bbe8b8c93616ec5baf73e4a4c1c82cc7d91b3ae84e23a029d9  a1-baseline.sh`. **Stop** if the hash differs.

4. Read the script once (it is short; only GET calls). Then run it for the 7 quota days ending 10 Nov:

   ```bash
   bash a1-baseline.sh 7 2026-11-10
   ```

   Expected end: `Written: ~/a1-baseline-<time>/baseline.md, baseline.csv, hourly.csv …`. Exit code 9 means a token-like string was found in the output: **do not share** the folder, and report it.

5. Pack and download the result:

   ```bash
   cd ~ && tar czf a1-baseline-result.tgz a1-baseline-*/ && sha256sum a1-baseline-result.tgz
   ```

   In Cloud Shell: ⋮ → **Download** → `a1-baseline-result.tgz`. Send the file **and** the printed SHA-256.

6. **Billed reads (by hand; the metrics cannot give them).** Firebase Console → Firestore → **Usage** → Reads, last 7 days → screenshot (note the time zone the page shows). Optional: Google Cloud Console → Billing / Usage for the same days.

7. **Usage context (R6, short answers).** For 4–10 Nov, roughly when were these used?
   - Quality Dashboard (which pages);
   - Production V2 (Dashboard with Week / Range, Exec Trend 30, Assembly, Order Tracking, data entry);
   - the legacy root app (`kp12264.github.io/daily-production-report/`);
   - any script, sheet or tool reading Firestore (the daily 01:00 ICT job);
   - was Firestore → Data in the Firebase Console open?

Do **not** run anything else, and do not open Firestore → Data (it reads documents).
