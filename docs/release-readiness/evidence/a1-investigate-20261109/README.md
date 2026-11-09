# A1 Update 3 evidence: Firestore metric list + hourly reads / writes / deletes / listeners / connections / rules, 26-30 Oct 2026 (UTC)

Read-only collection, run by the Firebase owner in Google Cloud Shell on 2026-11-09
with `a1-investigate.sh` v1, steps 1-2 only (only HTTP GET calls to the Cloud Monitoring API v3:
`metricDescriptors.list`, `timeSeries.list`; no audit logs read).

| Item | SHA-256 |
|---|---|
| Original package `a1-investigate-20261109T060235Z.tar.gz` | `405b323fc8897d680e9e6a2c0b17432dba2e1f5162e403f707185b28535c0648` |
| Collector `a1-investigate.sh` v1 | `d453016e55b712a7cf3f6e12574a5a97c869361dbaa7b7ddaaa278cd02654a11` |
| `verify.py` (identical to the copy embedded in the collector) | `31c0508f88cbe129f5da9890f6b98cf5ed593d92f92d3c0515884450967f63cb` |

- All files from the package are stored **unchanged** (byte-identical; hashes in `MANIFEST.sha256`). No redaction was needed.
- Personal-data / secret scan before storing: no access token (`ya29.`), no `Bearer` value, no API key, private key, client secret, refresh token, password, e-mail address, home path or IP address.
- Re-check: `sha256sum -c MANIFEST.sha256`. Re-run on a copy: `python3 -I verify.py <copy-dir> 2026-10-26T00:00:00Z 2026-10-31T00:00:00Z` -> exit 0, report identical to `verify-report.txt`.
