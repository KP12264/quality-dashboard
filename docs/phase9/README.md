# Phase 9 — Final Security Hardening & Data Migration Preparation

Branch `claude/vigilant-pasteur-l91qt3` · baseline `c0b64b1` · Emulator only. Nothing published, deployed, merged or migrated.
`QD_AUTH_MODE = "off"` · `QD_CLOSE_REQUIRED_FROM = null` · `QD_OPS_WRITE_ENABLED = false`.

| Deliverable | File |
|---|---|
| Privacy Migration Report | §1 + [generated/privacy-migration-report.md](generated/privacy-migration-report.md) |
| Operations Security Matrix | §2 + [generated/ops-security-matrix.md](generated/ops-security-matrix.md) |
| Weekly Plan Integration Proposal | [weekly-plan-proposal.md](weekly-plan-proposal.md) |
| Rules Diff | [generated/rules-diff.md](generated/rules-diff.md) |
| Final GO / NO-GO | §5 |

## 1. Privacy migration (old data → private sidecars)

Tool: `tools/migration/privacy-migration.js`, run from Admin → Operations → "5. Privacy migration".
- **scan** (read only) finds every old public `recordedBy` and improvement owner, plus exceptions it will not touch (code > 64 characters, > 20 actions).
- **backup** (JSON download) is required before **apply** (the button refuses otherwise); it is also the undo data.
- **apply**: one transaction per document, moves the value into `scrapLogPrivate` / `improvementOwners` and removes it from the public document; skips anything already migrated or changed meanwhile → **idempotent and resumable** (stop at any point, run again).
- **verify**: re-scan = 0 personal fields left; every sidecar equals the backup.
- Rules: removing `recordedBy` from an old log is a dedicated path — admin only, only that field, only when the sidecar holds the same value **and** names an authorised PRIVACY_MIGRATION run. Scrap quantities, ledger counts and close fingerprints never include it (a closed shift stayed SUBMITTED).
- Tested on synthetic old data: interrupted run + resume, re-run = 0 changes, verify clean, 2 exceptions reported (decision needed: **M-P2** — truncate / delete / keep those values).

## 2. Operations security (hardened)

New in the rules: every reconcile, baseline (`b1`), `baselineComplete` and privacy strip must name a **qdOpsLog START record of the same admin, same action, created within 12 hours** (server time). The audit record is now a precondition enforced by Firestore, not a UI step; `QD_OPS_WRITE_ENABLED` only enables buttons.

Matrix (direct SDK, no UI) — see the generated file. Summary:
- anonymous / viewer / leader / PV2 writer: refused for every operation, including when they borrow an admin's run id;
- admin without a run, with another admin's run, with a run of another action, or with a run older than 12 h: refused;
- forged qdOpsLog (other name, client time, unknown action): refused; update/delete of any qdOpsLog record: refused for everyone; read: admins only;
- concurrent: two admins reconcile one slot → exactly one RECONCILE event; reconcile racing a Leader save → consistent after re-run; same baseline twice at once → each slot created once (fix: a run that loses the race now reports "skipped", not "failed").

Rules budget (worst cases) still within limits, incl. reconcile of a 452-log slot and a privacy strip. Extra cost per operation: +1 qdOpsLog write per run start/result, +1 document read in the rules per operation write.

## 3. Weekly plan

Proposal only — see weekly-plan-proposal.md. Key points: the plan is a cumulative budget on top of the ≤ 50/day target; it must use the same record scope (fix: it currently also counts non-DAY/NIGHT shift codes) and respect Shift Close (a week is final only when its days are confirmed). `scrapWeeklyPlans` numbers can stay public; review notes should move to a signed-in collection.

## 4. Legacy cleanup

The 3 old copies are retired (guard, files kept). Phase 9: deep links keep query **and** `#hash` (tested: `dashboard.html?date&line&shift#import` → Scrap Entry with the same date/line/shift). Navigation: no V5 page or `js/nav.js` links to any retired page; `plan-tracking.html` / `weekly-review.html` stay as they are until the Weekly Plan replacement (proposal step 4).

## 5. Final GO / NO-GO

| Gate | Status |
|---|---|
| G1 snapshot = published rules of `(default)` | ⛔ owner confirmation needed |
| G2 approve candidate (incl. Phase 9 rules) + bridge | ⛔ |
| G4 public data policy + privacy option B | ⛔ |
| M1 baseline on production data | ⛔ |
| M-P1 privacy migration of old production data | ⛔ (tool ready, tested) |
| M-P2 handling of the 2 exception kinds | ⛔ |
| P7-1 retire old copies | ⛔ (implemented, approve with deploy) |
| P7-2 / Weekly Plan proposal | ⛔ decision |
| B1 / B2 close date, first admin + roles | ⛔ |
| C1 / C2 cost acceptance | ⛔ |
| All suites green on the release commit | ✅ this commit |

**GO** only when every ⛔ is resolved. **NO-GO** if any suite fails, the re-copied rules hash differs, or a PV2 smoke fails after a publish (→ re-publish snapshot).

## 6. Test results (this commit, Emulator)

| Suite | Result |
|---|---|
| Unit | 42/42 |
| Rules | 131/131 (adds privacy-migration 6, ops-security 9; budget incl. Phase 9 paths; PV2 compatibility 4 rule sets) |
| E2E | 65/65 (adds privacy migration via Operations tab, deep-link test) |
| Regression (repo) | 15/15 |
| Off-mode Dashboard matrix (107) | identical to Phase 8 (diff 0) |
| ix (whole system incl. Executive Report) | 21/21 |
