# A1 Update 2 evidence: Cloud Monitoring usage, 26 Oct – 1 Nov 2026 (UTC)

Read-only collection, run by the Firebase owner in Google Cloud Shell on 2026-11-09
with `a1-collect-v4.sh` (only HTTP GET calls to the Cloud Monitoring API v3).

| Item | SHA-256 |
|---|---|
| Original package `a1-usage-20261109T035208Z.tar.gz` (not stored here: it contains the account e-mail) | `540be6c0e9ee2db20f9b4621d76e4d2a0582a089434d0f45df3c110cead72fe8` |
| Collector `a1-collect-v4.sh` | `8f48bdca874868cfe6455e4b747ea63a7436a24f650d424c810b21cd0a049ab2` |
| `verify.py` (identical to the one embedded in v4) | `81ef37c92b62631acbfe1bb38404d4a5e717f0d8b28523f12a75f77dda4b53a6` |
| Original `collect-log.txt` (not stored) | `efa4d2624394677850bd98fbf0fcce9a30bbec300929f5db733f5f7d78a5e10f` |
| `collect-log.redacted.txt` (stored) | `004b03ddfcb1ece4aefe638f75dcc30195cfa464598cf25f4006ab83a1d87a00` |

- Every other file is **byte-identical** to the package; their hashes are in `MANIFEST.sha256`.
- `collect-log.redacted.txt` differs from the original in **two lines only**: line 2 (account e-mail → `[REDACTED-ACCOUNT]`) and line 126 (Cloud Shell home path → `/home/[REDACTED-USER]`).
- Secret scan before storing: no access token (`ya29.`), no `Bearer` value, no API key, private key, client secret, refresh token or password. The only matches are the pattern strings inside the collector script itself.
- Re-check: `sha256sum -c MANIFEST.sha256` (from this folder). Re-run verification on a copy: `python3 -I verify.py <copy-dir> 2026-10-26T00:00:00Z 2026-11-02T00:00:00Z` → exit 3, report identical to `verify-report.txt`.
