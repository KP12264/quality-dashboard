# A1 Update 4 evidence: billable read metrics, 26-30 Oct 2026 (UTC)

Read-only collection, run by the Firebase owner in Google Cloud Shell on 2026-11-09
with `a1-billable.sh` v1 (only HTTP GET calls to the Cloud Monitoring API v3:
`metricDescriptors.list`, `timeSeries.list`).

| Item | SHA-256 |
|---|---|
| Original package `a1-billable-20261109T082517Z.tar.gz` (value confirmed by the owner from Cloud Shell) | `b16a0526ff7ecd4fa0f7c555997ce18ba2a9542c97cae691fa311d61c9f6caff` |
| Collector `a1-billable.sh` v1 | `d03f96b7a729dd38470101bd3ed6302a51d159df870484261fb28c381f04ab15` |
| `verify.py` (identical to the copy embedded in the collector) | `4f5b0b1869ce61dedb06238108199538b599a632946d780701920d8aac491f5d` |

- **Result:** `api/billable_read_units` and `api/billable_realtime_read_units` returned **no time series** in the window (HEADERS response `{"unit": "1"}`, no executionErrors, no unreachable). Over the same window `document/read_count` = 88,044. **No data is not zero.**
- **VERIFY STATUS PASS** here only means the data that exists is consistent (read_count equals the Update 2 evidence in all 120 hours, U1 on all 5 days; no API errors). It does **not** confirm or reject any hypothesis. The `0?` cells for the billable metrics in `verify-report.txt` mean "no data", not zero.
- All files from the package are stored **unchanged** (hashes in `MANIFEST.sha256`). Personal-data / secret scan before storing: no token, key, e-mail address, home path or IP address; no redaction needed.
- Re-check: `sha256sum -c MANIFEST.sha256`. Re-run on a copy: `python3 -I verify.py <copy-dir> 2026-10-26T00:00:00Z 2026-10-31T00:00:00Z` -> exit 0, report identical.
