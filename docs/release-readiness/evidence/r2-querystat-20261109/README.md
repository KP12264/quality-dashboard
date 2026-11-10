# Update 7 evidence: R2 (read_ops_count + query_stat), verifier v2

## 1. Original package (unchanged)

`package/` = every file of `a1-querystat-20261109T132452Z.tar.gz`, run by the Firebase owner in Google Cloud Shell
with `a1-querystat.sh` v1 (GET calls to Cloud Monitoring only). Package SHA-256
`3da2715b1683bbcae03d6c72808230f5c079455e6c2cf6451edfc3cb51a00b7c` (**confirmed by the owner from Cloud Shell**).
The archive itself is not stored; every file in it is, byte-identical (`MANIFEST.sha256`). Scan: no token, key,
e-mail address, home path or IP address. Original result: **VERIFY STATUS FAIL** (exit 2), one failure:
`scanned_index_entries_counts: API reported unit {not_a_unit}`.

## 2. Offline re-verification (no Google Cloud access; run on copies of `package/`)

| Verifier | SHA-256 | Result on the same data |
|---|---|---|
| v1 (`offline/verify-v1.py`, = `package/verify.py`) | `6427aae8b91c6b4a215b56d2c0350e3da867a6bf7a85a34f2fa695d741630efa` | FAIL (`offline/report-v1.txt`, identical to the package report) |
| **v2** (`offline/verify-v2.py`) | `55c40d308b28b6c0e33f1bda5e8308a9bcc2272dd151b5e7dc8633d79ce5cca8` | **INCOMPLETE** (`offline/report-v2.txt`, `offline/summary-v2.json`) |

v2 changes only the unit rule and adds a coverage check:
- `{not_a_unit}` is never accepted as a unit. Mixed units between pages, or a descriptor that disagrees with the data → FAIL.
  No descriptor / no descriptor unit, more than one series (HEADERS or FULL), or query counts that disagree with
  `result_counts` → INCOMPLETE. Exactly one series of one metric and one resource type with a descriptor unit →
  WARNING naming the descriptor unit and stating that the unit is NOT verified.
- query_stat coverage: flagged hours with reads but no query_stat point → INCOMPLETE (the question stays unanswered).

## 3. Collector v1.1 and mock tests

`collector/a1-querystat.sh` v1.1 = v1 + verifier v2 (SHA-256 `217ffb7039d8f6a9b32231266f353e27f820c2028d097f4a73be0567fa38c228`). **Not run against Google Cloud.**
`mock-tests/`: local HTTP mock of the Monitoring API, real curl, fake gcloud; `run-all.sh` runs 29 scenarios;
`results.txt` = the run (WARNING → PASS with warning, INCOMPLETE, FAIL, STOP, token / argv checks).
The fake test token is assembled at run time, so these files contain no token-like string.
