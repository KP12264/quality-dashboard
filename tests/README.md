# Quality Dashboard tests

Nothing here touches the real Firebase project (`daily-production-report-46b60`).
Rules and browser tests run against the Firebase Emulator with the project
`demo-quality-dashboard`, which exists only inside the emulator. The regression test
uses an in-page mock of Firestore and opens the pages straight from disk.

```bash
cd tests
npm install            # firebase-tools, @firebase/rules-unit-testing, firebase (compat 10.13.0 for the browser), chart.js
npm run test:unit      # permission matrix (js/qd-auth.js)
npm run test:rules     # Firestore Security Rules + slot-ledger load/concurrency tests (starts the emulator)
npm run test:e2e       # pages in Chromium against the Auth + Firestore emulators (?qdEmulator=1)
npm run test:regression            # Dashboard V5 vs an independent oracle, sign-in off (≈10 min)
QD_REGRESSION_QUICK=1 npm run test:regression   # subset (≈2 min)
```

Needs Node 20+, Java 11+ (for the emulator) and Playwright's Chromium.

## Trying sign-in by hand

```bash
cd tests && npx firebase emulators:start --config ../emulator/firebase.json --project demo-quality-dashboard
node tools/seed-emulator.js                       # in a second terminal
cd .. && python3 -m http.server 5510 --bind 127.0.0.1
```

Open `http://127.0.0.1:5510/scrap-entry.html?qdEmulator=1` and sign in with `LEADA` / `demo1234`
(Leader, Door A Day + Night), `ADMIN1` (admin), `VIEW1` (viewer) or `PV2ONLY` (Production V2 only).
`?qdEmulator=1` works only on localhost and forces the demo project, so the page cannot reach real data.

## Slot ledger (Phase 2)

Every scrap write in sign-in mode goes through `js/scrap-ledger.js`: one transaction writes the
logs, raises `scrapSlots/{date}_{line}_{shift}.logVersion` by one and creates the audit event
`events/v{logVersion}`. `tests/rules/rules.test.js` proves that writes skipping or faking the
ledger are refused; `tests/rules/ledger-load.test.js` measures logs per transaction, runs
concurrent writers and an Excel-size import, and checks after each that the version, the events
and the stored logs agree. `tests/support/compat-shim.js` lets the real ledger module run on the
emulator's Firestore in Node.

## Shift Scrap Close (Phase 3)

`js/shift-close.js` derives the status of a Date + Line + Shift from the scrap logs actually
stored (PENDING / SUBMITTED / CONFIRMED_ZERO / NO_PRODUCTION / CHANGED / CONFLICT) and writes a
close or reconfirm as one transaction (close fields on the slot + audit event `events/c{revision}`).
`js/shift-close-ui.js` draws the panel on Scrap Entry and the matrix on `daily-confirmation.html`.
Both appear only in sign-in mode (`?qdEmulator=1` locally); with sign-in "off" they stay hidden.

- `tests/unit/shift-close.test.js` — status rules, fingerprint, shift end, Leader date window,
  config window == rules window, `QD_AUTH_MODE` still "off".
- `tests/rules/shift-close.test.js` — who may close, the 7-day window, CHANGED → reconfirm,
  duplicate and simultaneous closes, edits racing a close, partly failed imports (import marker),
  legacy logs and writes made around the ledger.
- `tests/e2e/shift-close.e2e.test.js` — the panel, confirm sheet, matrix, conflict, phone width,
  and the "off" mode staying hidden.

By hand: seed as above, then open `scrap-entry.html?qdEmulator=1&date=<yesterday>&line=A&shift=DAY`
or `daily-confirmation.html?qdEmulator=1`.

## Target + Shift Close (Phase 4)

From `QD_CLOSE_REQUIRED_FROM` (config, `null` = not in use) the daily ≤50 status is judged from
the 6 shift closes by `js/target-evaluator.js` (one evaluator for Dashboard, Executive Report
and CSV). Public pages read the e-mail-free mirror `scrapCloseSummary/{date}`, which the rules
keep equal to `scrapSlots` in every write. In local test mode `?qdCloseFrom=YYYY-MM-DD` sets the
date for that page only (emulator only).

- `tests/unit/target-close.test.js` — status of a day from the 6 closes, the priority when several
  statuses meet, before/after the close date, filters, Thailand time vs rules, public view fields.
- `tests/rules/close-summary.test.js` — the mirror cannot disagree with the slots or carry personal
  data, the public can read it but not the ledger, the import marker is audited (m{n}), and the
  rules enforce shift end and the Thailand-date Leader window.
- `tests/e2e/target-close.e2e.test.js` — Dashboard vs Executive Report vs CSV on the same days,
  filters, READ ERROR, read counts, phone width, and an Excel import with a real CSV file
  (success, partial failure → Conflict, blocked second import).

## Production readiness (Phase 5)

- `tests/rules/shift-time.test.js` — shift end at minute precision on SERVER time (the harness
  offsets only `qdBkkNow()`), NIGHT bound to its start date, Leader window by Thailand date.
- `tests/rules/pv2-compat.test.js` — the same 450 requests against the Production V2 rules alone
  and the combined draft; writes `docs/phase5/generated/rules-impact-matrix.md`.
- `tests/rules/migration.test.js` — ledger baseline dry run + apply on synthetic data; writes
  `docs/phase5/generated/migration-dry-run.md`.
- `tests/rules/budget.test.js` — heaviest valid write paths vs the rules limits (run after every
  rules change).
- `tests/unit/no-ledger-bypass.test.js` — no code path writes scrap logs around the ledger.
- Reports and runbook: `docs/phase5/`.
