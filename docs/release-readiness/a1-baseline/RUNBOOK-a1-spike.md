# A1 spike detail: runbook for the project owner (Google Cloud Shell, read-only)

**Status.** A1 = HIGH. Billed reads = UNVERIFIED. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO.

**Purpose.** Get 5-minute Cloud Monitoring detail for the read burst on **Saturday 7 Nov 2026, 08:00–13:00 Thailand time (ICT)** (= 01:00–06:00 UTC). The script reports reads, rules evaluations, listeners, connections and request methods. Where available, it also reports requests by credential. It does **not** establish the cause of the burst.

## What `a1-spike.sh` does (v1.1)

- **Read-only API calls.**
  - Only HTTP GET to the Cloud Monitoring API v3: `metricDescriptors.get` and `timeSeries.list`.
  - No Firestore document is read.
  - Nothing is created or changed: no Firebase or Firestore setting, Rules, IAM, logging, alerting or gcloud configuration.
- **Request limit.** At most **30 HTTP requests** in total (curl does not retry on its own), and at most 5 pages per query.
- **Metrics checked before querying.** The descriptor of each metric is read first. A metric is reported as `MISSING` and not queried if:
  - its descriptor is missing; or
  - the descriptor does not list the resource type used.
- **Metrics queried:**

  | Name | Metric | Resource type | Aligner (300 s) |
  |---|---|---|---|
  | reads | `firestore.googleapis.com/document/read_count` | `firestore_instance` | SUM, by `type` |
  | rules | `firestore.googleapis.com/rules/evaluation_count` | `firestore.googleapis.com/Database` | SUM, by `request_method`, `result` |
  | listeners | `firestore.googleapis.com/network/snapshot_listeners` | `firestore.googleapis.com/Database` | MAX |
  | connections | `firestore.googleapis.com/network/active_connections` | `firestore.googleapis.com/Database` | MAX |
  | fsrequests | `firestore.googleapis.com/api/request_count` | `firestore.googleapis.com/Database` | SUM, by `api_method`, `response_code` |
  | byCredential (optional) | `serviceruntime.googleapis.com/api/request_count` | `consumed_api` (service Firestore) | SUM, by `credential_id`, `method`, `response_code` |

  If byCredential fails (for example 403), it is recorded as `UNAVAILABLE` and the script continues.
- **Missing data is not zero.**
  - `spike-5min.csv` has all 60 buckets.
  - A bucket without a data point is written as `NO_POINT`, never `0`.
  - `coverage.json` gives, per metric:
    - its state (`OK` / `MISSING` / `UNAVAILABLE`);
    - its series count;
    - buckets with and without a point.
- **Privacy and secrets.**
  - The access token comes from your own Cloud Shell login. It stays in memory, is passed to curl on stdin, and is never printed or written.
  - Error text is redacted (token, `ya29.` strings, e-mail addresses, home path).
  - `credential_id` is masked to its type plus the last 4 characters as soon as each page is saved.
    - It identifies a key, OAuth client or service account. It **does not identify a person**.
  - No home path, account or e-mail is written.
  - If a token-like string is found in the output, the script exits with code **9**. In that case, do not share the folder; report it.

## Steps

1. Open <https://console.cloud.google.com/> with the owner account and click **Activate Cloud Shell** (top right).
   - You need the permission `monitoring.timeSeries.list` (for example the role *Monitoring Viewer* or *Owner*).
   - The project id is fixed inside the script. Do not change any gcloud setting.
2. Download the script at the pinned commit (into a file; **do not** pipe it into bash), and check its hash. The commit hash and the expected SHA-256 are given in the owner instructions for this step.
3. Read the script once. Then run it:

   ```bash
   bash a1-spike.sh
   ```

   Expected end: `HTTP requests used: N (limit 30)`, exit code 0.
4. Pack the result and download it:
   - Pack: `cd ~ && tar czf a1-spike-result.tgz a1-spike-*/ && sha256sum a1-spike-result.tgz`.
   - In Cloud Shell, use ⋮ → **Download** → `a1-spike-result.tgz`.
   - Send the file **and** the printed SHA-256.

Do **not** run anything else. Do not open Firestore → Data: it reads documents.
