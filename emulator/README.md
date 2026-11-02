# Firebase Emulator — test only

**Do not publish or deploy anything from this folder.**

- `firestore.rules` is a *draft* that combines the Production V2 rules (copied
  verbatim from `KP12264/daily-production-report` @ `431836a`,
  `production-v2/firestore.rules`) with the new Quality Dashboard rules. The rules
  that are actually live on `daily-production-report-46b60` have not been
  verified (Phase 0, item G1), so this file must not replace them.
- `.firebaserc` points at `demo-quality-dashboard`. Projects named `demo-*` exist
  only inside the emulator; nothing here can read or write the real project.
- The tests in `../tests` start the emulator, seed demo users and data, and tear
  everything down. See `../tests/README.md`.
- Phase 3 adds to the draft: the Leader date window (`qdLeaderWindowDays()` = 7, same as
  `QD_LEADER_EDIT_WINDOW_DAYS` in `js/config.js`), the close / reconfirm path on `scrapSlots`
  with audit events `c{n}`, and the Excel import marker (`importPending`). Still draft, still
  emulator only.
- Phase 4 adds: `scrapCloseSummary/{date}` (public read, written only together with the slot it
  mirrors, no e-mails), audited import marker events `m{n}`, rules-side shift end
  (`qdShiftEndHours`, BLOCKED: times not confirmed) and Thailand time (`qdBkkNow`, UTC+7).
- Phase 5: confirmed shift ends at minute precision (`qdShiftEndMinutes`: DAY 19:50, NIGHT 08:00
  next day), ledger baseline (`b1` events, `qdConfig/ledger.baselineComplete`). See `docs/phase5/`.
