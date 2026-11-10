# O1 test plan: PV2 Assembly read reduction (emulator only; NOT RUN)

**Status: plan only.**
- No code changed in PV2 or QD; no test run.
- Running this plan needs a separate approval. Committing its harness or evidence needs another.
- Never connects to Production; never changes Firebase Rules, API keys, Billing; no deploy.
- **A1 = HIGH. G2 = NOT APPROVED.**

Reference: `p0-read-reduction-plan.md`, Revision 3, item O1; A1/A2 report, Update 12.

## 1. What is tested

PV2 `KP12264/daily-production-report` `main` `431836a`, file `production-v2/js/assembly.js` (loaded only by `production-v2/assembly.html:22`).

**Before** (`load()`, line 100–101, current code):

```js
const logs=await all("prodV2_actualLogs");
const matched=logs.filter(x=>x.date===date&&(!shift||x.shift===shift));
```

**After A, recommended.** Only line 100 changes:

```js
const logs=(await ProdV2DB.collection("prodV2_actualLogs").where("date","==",date).get()).docs.map(d=>({id:d.id,...d.data()}));
const matched=logs.filter(x=>x.date===date&&(!shift||x.shift===shift));   // unchanged
```

- One equality filter: served by the automatic single-field index; no composite index needed.
- The browser filter is kept unchanged, so the date and shift checks stay exactly as today.

**After B, optional, for comparison only.** Additionally `.where("shift","==",shift)` when a shift is chosen. Two equality filters are not recommended unless A fails.

The Before and After copies are kept **in the test workspace only**:
- copied read-only from `431836a`, with the SHA-256 of the original recorded;
- never pushed to the PV2 repository.

## 2. Environment

- Local Firestore emulator (`emulator/firebase.json`), project `demo-quality-dashboard`, `127.0.0.1:8080`. No network access to Google needed.
- Firebase compat SDK from `tests/node_modules` (`firebase-compat` 10.13.0). PV2 uses compat **9.23.0**; query semantics for `where ==` are the same.
  - **Limitation:** not the exact PV2 SDK version. This is recorded in the evidence.
- The harness runs the original `assembly.js` unchanged in a Node `vm` context, with:
  - a minimal fake `document` (elements `asmDate`, `asmShift`, `asmGroupFilter`, `asmLoadBtn`, `asmResults`, `asmStatus`, `asmMessage`);
  - `window.ProdV2DB` = a **read-counting wrapper** around the emulator database.
- Optional second layer: Playwright (preinstalled Chromium) with `assembly.html` served locally, if the SDK can be loaded locally without network. Otherwise skipped and recorded as not run.

**Read counter** (same method as the Q1 test):
- GET = 1 read.
- LIST = max(1, documents returned).
- `billed` = total.
- The number of `load()` calls is counted per trigger.

## 3. Synthetic data

Base set:
- Lines A, B, C × shifts DAY, NIGHT × 120 days (2026-07-01 … 2026-10-28) = **720** documents.
- Ids `actual_<date>_<line>_<shift>`, fields `date`, `lineId`, `shift`.
- `actualByCell` with keys `<block>|||<model>|||<door>` and integer values. The models and doors cover every pool in `BOM` / `POOLS` so every cabinet row renders.

Edge documents (each placed on the test dates `2026-10-05` and/or `2026-10-06`):

| # | Edge case | Expected (Before = After) |
|---|---|---|
| E1 | `date` as number `20261005` | excluded |
| E2 | `date` missing | excluded |
| E3 | `date` as Timestamp | excluded |
| E4 | `date` with a trailing space `"2026-10-05 "` | excluded |
| E5 | `date` in another format `"05/10/2026"` | excluded |
| E6 | `date` as array `["2026-10-05"]` | excluded |
| E7 | `shift` missing | counted only under "All Shifts" |
| E8 | `shift` lowercase `"day"` | counted only under "All Shifts" |
| E9 | `shift` unknown `"MORNING"` | counted only under "All Shifts" |
| E10 | `actualByCell` missing / `null` / a string / an array | document counted in `matched.length`, adds no totals |
| E11 | cell key with fewer than 3 parts (`"M-100"`, `"1|||M-100"`) | key skipped |
| E12 | values `"5"`, `"abc"`, `null`, `-3`, `2.5`, `0` | same `Number(v||0)` result in both (including `NaN`) |
| E13 | **non-standard document id** (random id, valid date / shift) | **counted in both** (this is why By-id gets are not used) |
| E14 | two documents for the same date / line / shift with different ids | both counted in both |
| E15 | a date with no documents (`2026-11-30`) | empty totals, `matched.length` 0 in both |
| E16 | one day with many models (200 cell keys) | identical totals |
| E17 | model / door names with spaces, Thai text, `&<>"'` | identical totals and escaped HTML |
| E18 | a subcollection under an actual document | not read in either |
| E19 | documents in other `prodV2_*` collections on the same date | not read in either |

## 4. Scenarios and checks

### S1. Read count before / after (requirement 1)

For each date and shift tested (S2), record `GET`, `LIST`, `billed` and the number of `load()` calls for Before and After.

- **Expected Before:** 1 LIST, billed = all documents (720 + edge documents) per load.
- **Expected After A:** 1 LIST, billed = max(1, documents whose `date` == the selected date) per load (≤ 6 + that date's edge documents; 1 for E15).
- Triggers measured on both versions: page open (`init` → `load`), Date change, Shift change, Load button, Model filter change.
  - The Model filter change is expected to cost 0 reads (re-render only).
  - The number of `load()` calls per trigger must be the same for Before and After.

### S2. Totals identical in 100 % of cases (requirement 2)

Every date in the base range plus E15 × shift `""`, `DAY`, `NIGHT` (about 363 cases). Compare per case:

- `window.currentAsmTotals`: same keys, same values; numbers compared with `Object.is`, so `NaN` matches `NaN`;
- `matched.length`, read from the `asmMessage` text ("รวม N Actual Log");
- `asmResults.innerHTML` (byte-identical);
- `asmStatus` text and class.

### S3. Date and shift filtering (requirement 3)

For the test dates, compare the **set of matched document ids** (instrumented by wrapping `Array.prototype.filter` result in the harness, or by recomputing from the returned documents) against an independent expected list built from the seed:
- "All Shifts" includes E7–E9;
- DAY / NIGHT include only exact `"DAY"` / `"NIGHT"`;
- E1–E6 never match.

Also check: date change → shift change → date back gives the same results as a fresh load.

### S4. Malformed and missing data (requirement 4)

E1–E19 as in §3. Plus:
- an empty collection: totals empty, no error, status "Loaded";
- an empty date input: the early return "เลือกวันที่ก่อน" with **0 reads** in both versions;
- a query error (emulator stopped mid-test, or rules denying the read in a negative control): both versions show "Load failed" with the same message path.

### S5. No effect on other PV2 pages (requirement 5)

- **Diff check:**
  - After A differs from the original in **exactly one line of one file** (`production-v2/js/assembly.js:100`);
  - all other PV2 files are byte-identical (SHA-256 list of `production-v2/**` before and after);
  - `all()` stays in the file, so nothing else moves.
- **Scope check:** `assembly.js` is loaded only by `assembly.html:22`, and its functions are inside an IIFE. The only global it writes is `window.currentAsmTotals`, used only by `assembly.js:163` (verified by search at `431836a`).
- **Regression:** the QD rules suite `tests/rules/pv2-compat.test.js` runs unchanged against all rule variants and passes.

### S6. No Firebase Rules change and no new Production index (requirement 6)

- **Rules:** run the After A query against each rules file, unauthenticated and signed-in, with `assertSucceeds`:
  - `emulator/production.firestore.rules.snapshot` (owner-provided copy, sha256 `0967944b…2e2f`; `allow read: if collection.matches('prodV2_.*')`);
  - `emulator/production-v2.firestore.rules.snapshot`;
  - `emulator/firestore.rules`;
  - `emulator/firestore.rules.bridge`.

  A filtered list of the same collection needs no new permission. No rules file is edited.
- **Index:** the emulator does **not** enforce indexes, so the emulator cannot prove this. Evidence by design: one equality filter, no `orderBy`, no range, so it is served by the automatic single-field index, which exists unless an exemption was configured.
  - Optional owner check, read-only: Firebase Console → Firestore → Indexes → **Single field**, confirm there is no exemption for `prodV2_actualLogs.date`. Look only; do not open Firestore → Data.
  - After B (two equality filters) would rely on index merging, one more reason to prefer A.

## 5. Pass criteria (all must hold before any request to change PV2)

1. S2: identical `currentAsmTotals`, `matched.length`, `asmResults` HTML and status in **100 %** of cases (0 differences).
2. S3: matched id sets equal the independent expected sets for every tested date and shift.
3. S4: every edge case gives the same result in Before and After; no new error path; the empty-date case is 0 reads in both.
4. S1: After A billed ≤ (documents of that date) + 1 per load, and the number of `load()` calls per trigger is unchanged.
5. S5: exactly one changed line in one file; all other PV2 file hashes unchanged; `pv2-compat` tests pass.
6. S6: the query succeeds under all four rules files unchanged; no index file created or needed; the Production index check (if done) shows no exemption.
7. Evidence complete: results JSON, read-count table, file hashes, environment (SDK versions, emulator version), `MANIFEST.sha256`; secret scan clean.

**Stop conditions:** any difference in S2 or S3, any rules denial, or any need for an index → stop, record, and do not propose the change.

## 6. Evidence (if the run is approved)

`docs/release-readiness/evidence/o1-assembly-<date>/`, containing:
- `README.md` (method, limits, results);
- `o1-results.json`;
- `o1-reads.md`;
- `pv2-file-hashes.txt`;
- `MANIFEST.sha256`.

The Before and After copies of `assembly.js` are stored only as a diff (one line), not as a new PV2 version. Committing them needs separate approval.

## 7. Limits

- Synthetic data only; Production sizes are unknown (U3 not approved).
- SDK 10.13.0 compat in Node instead of 9.23.0 in the browser.
- The emulator does not enforce indexes.
- A fake DOM is not the full browser page (Playwright layer only if available offline).
- Equality-query semantics in the emulator are assumed to match Production.
