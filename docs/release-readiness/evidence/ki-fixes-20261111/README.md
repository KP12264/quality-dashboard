# Evidence: KI-1, KI-2 and test-date fixes (2026-11-11)

Local Firebase emulator only (project `demo-quality-dashboard`). No Production access, no rules published, no deploy. RC `357806d` is unchanged. **A1 = HIGH. G2 = NOT APPROVED. O1 = NOT APPROVED.**

## Confirmed root causes

| Issue | Root cause (facts) |
|---|---|
| KI-1 | Every ledger transaction reads and writes the one summary document `scrapCloseSummary/{date}`; the candidate rules require it in the same transaction. So writers on different slots of one date contend. When the SDK's own transaction retries ran out, the refused commit surfaced as **`failed-precondition`: "9 FAILED_PRECONDITION: the stored version (…) does not match the required base version (…)"** (`diag-before.json`, round 2: 5 / 6). `applyOps` retried only permission-denied, so the error reached the user |
| KI-2 | The rules allow only an Admin to confirm again a slot that is closed at its current version. The racing test always asked a Leader to reconfirm at the end, so it failed whenever the race ended SUBMITTED. `closeSlot` let a Leader attempt it and passed on a raw `permission-denied` |
| Test dates | `ledger-load.test.js` (`2026-11-03`) and `rules.test.js` (`2026-11-02`) wrote leader data on fixed dates that left the 7-day leader window. Further fixed dates in `ledger-load.test.js` (`2026-11-20/25/26`, `2026-12-0x`, `2026-11-1x`) and `e2e/auth.e2e.test.js` (`2026-11-02`) would expire or collide later |

## Fixes

| Area | Change |
|---|---|
| `js/scrap-ledger.js` | Retries **only** refused commits:<br>• `aborted`;<br>• `failed-precondition` whose message is the version mismatch.<br>Not retried: any other `failed-precondition`, `already-exists`, `unavailable`, `deadline-exceeded`.<br>Before each retry it re-reads the slots and the audit events since; if this write's record ids are already there, it does not write again.<br>Backoff with jitter, at most 8 conflict attempts, then `qd/busy` "Many saves for this date at the same moment — nothing was saved. Please try again."<br>Permission-denied keeps the existing path, plus the same already-committed check |
| `js/shift-close.js`, `js/shift-close-ui.js` | `qd/already-closed` "This shift is already confirmed at its current version. Only an Admin can confirm it again." **only** when the page states a Leader role and assigned slots, the slot is assigned, the date is clearly inside the leader window, and the slot just read is closed at its current version. In every other case the rules decide and their denial is passed on unchanged. Rights and rules unchanged |
| tests | `tests/support/dates.js` (Asia/Bangkok); relative dates in `ledger-load`, `rules`, `auth.e2e`; deliberate fixed dates annotated `fixed-date-ok`; guard test `tests/unit/test-dates-and-retry.test.js`; deterministic final step of the racing-closes test; new KI-1 (30 writers, real denial) and KI-2 tests |

## Results

| Check | Result |
|---|---|
| Diagnostic before / after (`diag-before.json` / `diag-after.json`, 8 rounds of 6 writers on 6 slots of one date + 15 writers on one slot) | before: 1 refusal (`failed-precondition`, version mismatch) · after: **0**, 6 / 6 and 15 / 15 in all rounds |
| "writers on different slots", 10 rounds | **10 / 10** (`loops-10-rounds.txt`) |
| Shift Close file, 10 rounds | **10 / 10** (24 / 24 each); the race ended SUBMITTED in rounds 4 and 9 (the case that failed before) |
| 30 writers, 5 per slot, 6 slots, one date | 30 saved once; each slot version 5, live 5, events v1..v5; summary entries exact (`full-rules.log`) |
| Real permission denial (Leader on another Line) | `permission-denied` at once (about 60 ms), no retry, nothing written |
| Dates with the clock +30 / +365 days | PASS (unit) |
| Unit | **64 / 64** |
| Regression | **15 / 15** |
| Rules (incl. PV2 compatibility, ledger-load, shift-close) | **150 / 150** |
| E2E (incl. "sign-in off (the live default)", "old site … under each rules version", "Shift Close stays hidden with sign-in off") | **111 / 111** |

Regenerated reports and screenshots from the runs were restored (not part of this change). Absolute local paths in the logs are shown as `<WORK>` / `<QD>`.
