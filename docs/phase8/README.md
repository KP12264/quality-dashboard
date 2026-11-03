# Phase 8 — Production Launch Preparation (NO DEPLOY)

Branch `claude/vigilant-pasteur-l91qt3` · baseline `ee979cd`. Emulator only. `QD_AUTH_MODE = "off"`, `QD_CLOSE_REQUIRED_FROM = null`, `QD_OPS_WRITE_ENABLED = false`.

| Topic | File |
|---|---|
| Public data privacy (policy B, pending G4) | [privacy.md](privacy.md) |
| Production operations tools (Admin → Operations) | [operations.md](operations.md) |
| Cutover safety, post-candidate audit, notifications, recovery | [cutover.md](cutover.md) |
| plan-tracking / weekly-review (P7-2) | [legacy-pages.md](legacy-pages.md) |
| Production runbook (backup, smoke, monitoring, rollback) | [runbook.md](runbook.md) |

## Approvals needed before GO

| Code | Decision | Evidence available | Owner |
|---|---|---|---|
| G1 | Snapshot = published rules of `(default)`; publish time | hash-checked snapshot; **production confirmation missing** | Firebase owner |
| G2 | Approve candidate + bridge rules; who publishes | compatibility matrix, rehearsal (PV2 0 failures) | PV2 + QD owners |
| G4 | Public read policy + privacy option B | privacy.md, tests | Management / IT |
| P7-1 | Retire the 3 old copies | Phase 7 tests | QD owner |
| P7-2 | Retire or restore plan-tracking / weekly-review | legacy-pages.md (feature broken since `3c28849`) | QD owner |
| B1 | Date for `QD_CLOSE_REQUIRED_FROM` (not retroactive) | Phase 4/7 tests | Release owner |
| B2 | First Admin + role list | — | QD owner |
| M1 | Run baseline on production data (step 7) | dry-run tool, gate | Release owner |
| M-P1 | (optional) remove old public `recordedBy` / owners | privacy.md §4 | G4 owner |
| C1/C2 | Cost acceptance (see below) | measured reads | Firebase owner |

## Tested (emulator) vs not yet evidenced in production

| Tested in the emulator ✔ | No production evidence yet ✘ |
|---|---|
| PV2 behaviour identical under candidate/bridge (480 checks × 4 rule sets); PV2 continuous R/W through every publish | that the snapshot is what is published (G1) |
| Full rollout rehearsal 29/29, rollback/forward, data intact | Rules publish propagation time on the real project |
| Privacy B, ops tools, post-candidate audit, cutover message | GitHub Pages cache behaviour for this site |
| Rules limits (450 logs/tx, 4 slots/tx, expression budget) | real latency / contention on the factory network |
| Migration gate on synthetic data | migration on real data volume (M1) |
| Read counts per page (Dashboard 9 days: +6 summary reads) | billing of reads inside rules (`get`/`getAfter`) — C1; region price — C2 |

## Cost limits to accept (C1/C2)

- Per scrap save: 4 writes + ~3 reads; whether document reads made inside the rules are billed is NOT VERIFIED.
- Dashboard / Executive Report: + ≤ 1 read per close-required day in range.
- Daily Confirmation: 6 slot reads + 1 log query per load.
- Baseline dry run / apply: every scrap log once + ~3 writes per slot (one-time).

## Results (this phase)

| Suite | Result |
|---|---|
| Unit | 42/42 |
| Rules (emulator) | 115/115 (adds privacy 8) |
| E2E | 63/63 (adds privacy 5, operations 5, plan pages 2; rehearsal 29 scenarios) |
| Regression (repo) | 15/15 |
| Off-mode Dashboard matrix (107 scenarios) | identical to Phase 7 (diff 0) |
| ix (whole system incl. Executive Report) | 21/21 |
| PV2 compatibility (4 rule sets) | identical on every PV2/legacy path (part of the rules suite) |
