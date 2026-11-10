# Evidence: O1 PV2 Assembly read reduction, emulator Before/After (2026-11-10)

**What this is.** Test evidence only. It contains no change to QD or PV2 code, Firebase Rules, indexes, API keys, Billing or any deploy. The O1 change is **not** applied to PV2. **A1 = HIGH. G2 = NOT APPROVED.**

- Plan: [`o1-assembly-test-plan.md`](o1-assembly-test-plan.md).
- Context: [P0 plan, Revision 3, O1](../../p0-read-reduction-plan.md); [A1/A2 report, Update 12](../../a1-a2-firestore-quota.md).

## Set-up

| Item | Value |
|---|---|
| Firestore | local emulator only, `127.0.0.1:8080`, project `demo-quality-dashboard` (demo project: the emulator never contacts Google); started with `tests/node_modules/.bin/firebase emulators:exec --config emulator/firebase.json --only firestore` |
| Production access | **none** (no Production project id, no credentials; the harness refuses to start unless `FIRESTORE_EMULATOR_HOST` is `127.0.0.1:*`) |
| Code under test | PV2 `KP12264/daily-production-report` `431836a`, `production-v2/js/assembly.js` (sha256 `4483548586a2dbf0892bb5b2721f8f6305ab271206d2cef29254d0a52f644b4d`) |
| Before | that file, unchanged (local copy) |
| After | the same copy with **line 100 only** changed, see [`out/o1-after.diff`](out/o1-after.diff) (sha256 `b6f28397a7999eda3ed41147e481a6679e097a098dd8ac99095009c23d806c6b`) |
| SDK | Firebase compat 10.13.0 in Node 22.22.0 (PV2 uses compat 9.23.0 in the browser) |
| Page | the original file run in a Node `vm` with a minimal fake DOM; `ProdV2DB` = read counter over the emulator (GET = 1, LIST = max(1, documents)) |
| Data | synthetic: 3 lines × 2 shifts × 120 days (2026-07-01 … 2026-10-28) + 6 for today + edge documents E1–E19 = 745 `prodV2_actualLogs` documents |

The Before / After copies of PV2 code are **not** stored here. To reproduce:
1. copy `production-v2/js/assembly.js` from `431836a` to `src/before.js`;
2. apply `out/o1-after.diff` to get `src/after.js`;
3. set `O1_SRC` to that folder and run the harness under the emulator.

## Results

| Test | Pass | Fail | Log |
|---|---|---|---|
| `o1-assembly.test.js` (13 tests: one-line diff, page open, 363 date × shift cases, E1–E19, Model filter, empty date, read failure, 4 rules files) | **13** | **0** | [`out/run3.log`](out/run3.log) |
| QD `tests/rules/pv2-compat.test.js` (unchanged; PV2 rules compatibility across the 4 rules files) | **7** | **0** | [`out/pv2-compat.log`](out/pv2-compat.log) |

**Reads per action** (emulator, synthetic data; full data in [`out/o1-results.json`](out/o1-results.json)):

| Trigger | Before | After |
|---|---|---|
| Page open (today) | 745 | 6 |
| Date change (121 cases) | 745 each | 1–14 |
| Shift change (242 cases) | 745 each | 1–14 (all documents of the date; shift still filtered in the browser) |
| Load button (6 cases) | 745 | 11–14 |
| Date with no documents | 745 | 1 |
| Model filter (11 groups) | 0 | 0 |
| Empty date | 0 | 0 |
| **Sum over 363 cases** | **270,435** | **2,202 (−99.2 %)** |

`load()` ran once per trigger in both versions.

**Data comparison.**
- `currentAsmTotals`, `matched.length`, the result HTML and the status / message were identical in **363 / 363** cases (`caseDiffs: 0`, `keyOrderDiffs: 0`).
- The matched document set equalled an independent expectation from the seed in 363 / 363 cases.
- Edge cases behaved the same in Before and After:
  - E1–E6 (date as number / Timestamp / with a space / other format / array, or missing) never matched;
  - E7–E9 (shift missing / lower case / unknown) were counted only under "All Shifts";
  - E10 documents without usable cells were still counted;
  - E13 (non-standard id) and E14 (duplicate) were counted;
  - E18 (subcollection) and E19 (other collections) were never read.

**Rules.**
- With all four rules files unchanged (`production` snapshot, `repoPv2`, `candidate`, `bridge`), both the whole-collection read and the `where("date","==",…)` query were allowed for anonymous, signed-in listed and signed-in other users.
- The query returned exactly the documents the browser filter selects (12 / 12 checks).

**PV2 and QD unchanged.**
- [`out/pv2-hashes-before.txt`](out/pv2-hashes-before.txt) and [`out/pv2-hashes-after.txt`](out/pv2-hashes-after.txt) (34 files of `production-v2/`) are identical.
- The PV2 clone `git status` was clean at `431836a`; the QD working tree was clean after the runs.

## Limits

- The emulator does **not** enforce indexes. "No new index" rests on the query shape (one equality filter, no `orderBy`) plus the owner's view-only check in [`index-check-view-only.md`](index-check-view-only.md) (**not done yet**).
- SDK 10.13.0 in Node instead of 9.23.0 in the browser; a minimal fake DOM instead of the browser page (the Playwright layer was not run, because it needs the SDK from the network).
- Synthetic data only; Production sizes are unknown (U3 not approved).
- Models outside `POOLS` are not rendered by the page, so the escaping check for E17 shows equality only.

## Harness runs that are not results

[`out/run1.log`](out/run1.log) and [`out/run2.log`](out/run2.log) are **harness errors, fixed before `run3`**. In `run1` the Before / After comparison had already passed before each failing line.

- `run1` checked the wrong marker-key format: the page keys totals by parts 2–3.
- `run1` also assumed a NaN stays in the totals: `(x||0)` turns it back into 0.
- `run2` had a syntax error from a comment.

## Files and redaction

Absolute local paths were replaced by `<WORK>` (the test workspace), `<QD>` and `<PV2>`. No other content was changed.

- The published harness [`o1-assembly.test.js`](o1-assembly.test.js) differs from the run copy only in its path constants (`QD_ROOT`, `O1_SRC`, `O1_OUT`).
- [`out/MANIFEST.as-run.sha256`](out/MANIFEST.as-run.sha256) holds the hashes of the files as run, before redaction.
- `MANIFEST.sha256` holds the hashes of the published files.
- The e-mail addresses in the logs and harness (`*@prodv2.local`) are synthetic test identities.
