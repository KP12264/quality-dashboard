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
