# Update 5 evidence: R1 (QD read signature, emulator), R2 script, Q2a / Q2b

Everything here was produced **locally**: Firebase Emulator, project `demo-quality-dashboard`, synthetic data
(`tests/support/release-seed.js` + 250 synthetic improvements, 5 without `createdAt`). No Production data,
no Production connection (the harness answers every non-local request itself and fails on any request to a
real Firestore / Auth host; none happened).

| File | What it is |
|---|---|
| `read-signature.e2e.test.js` | R1 harness: counts LIST (query get) / GET (document get) / documents per action in the browser |
| `r1-signature-before.json` | R1 at commit `272a0ba` (code before Q2b) |
| `r1-signature-after-q2b.json` | same actions with Q2b (commit `f6f83fd`) |
| `q2-equivalence.e2e.test.js` | Q2a / Q2b equivalence test (real compat SDK in a browser, emulator) against the old algorithm |
| `q2-equivalence-q2a-draft.json` | results with the **rejected** Q2a draft (shows the extra reads, e.g. I = 200: 400 reads) |
| `regression-q2a-draft-excerpt.txt` | regression failure caused by the Q2a draft (improvements read twice) |
| `q2a-q2b-draft.patch` | the rejected draft (kept for the record; not to be reused as is) |
| `q2-equivalence-q2b.json` | results with Q2b only (no Q2a): every case identical to the old behaviour |
| `test-summary-q2b.txt` | Q2b test run: unit 59/59, regression 15/15, rules + privacy/ops e2e 156/156, Q2 + signature 19/19 |
| `a1-querystat.sh` | R2 collector, **not run** (SHA-256 `63b5afbef7b66ea85bc43bd5cef4929b390578681af7e73b6bf48adf5a1c812b`) |
| `r2-mock-tests.txt` | R2 mock tests: 21 scenarios + token/argv checks |

Scan before storing: no token, key, e-mail address or personal data (only the container path `/home/user`).
Hashes: `MANIFEST.sha256`.
