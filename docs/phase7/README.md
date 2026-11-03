# Phase 7 — Deployment Rehearsal & Final Safety Verification

Branch `claude/vigilant-pasteur-l91qt3` · baseline `0168534` · **Emulator only — nothing deployed, published or migrated.**
`QD_AUTH_MODE = "off"` · `QD_CLOSE_REQUIRED_FROM = null`.

| Deliverable | File |
|---|---|
| Final Deployment Sequence + GO / NO-GO | this page (§1, §2) |
| Final rehearsal — PASS/FAIL per scenario (generated) | [generated/rehearsal-report.md](generated/rehearsal-report.md) |
| Migration Gate Report | [migration-gate.md](migration-gate.md) · [generated/migration-gate.md](generated/migration-gate.md) |
| Bridge Risk Report | [bridge-risk.md](bridge-risk.md) |
| Legacy Page Inventory | [legacy-pages.md](legacy-pages.md) · [generated/legacy-page-inventory.md](generated/legacy-page-inventory.md) |
| Public Data Access Matrix | [public-data.md](public-data.md) |
| Rollback Verification | [rollback.md](rollback.md) |
| Test results / BLOCKED | §3, §4 |

## 1. Final Deployment Sequence (rehearsed end to end — 29/29 PASS)

The Phase 6 order was safe; the rehearsal added three required steps (marked ★).

| Step | Action | Saving possible for | Verified in rehearsal |
|---|---|---|---|
| 0 | Backup (`gcloud firestore export`) + re-copy the Console rules, hash must equal the snapshot | everyone | — (production action) |
| 1 | **Publish bridge rules** | old pages ✓ · PV2 ✓ | S1: old tab saved without reload; PV2 0 failures |
| 2 | Create first Admin + roles in `qdUsers` (Console) | unchanged | S2 |
| 3 | **Deploy site with `QD_AUTH_MODE = "enforce"`** (includes the ★ retired-page guard on the 3 old copies) | old ✓ (until reloaded) · new ✓ | S3: save, close, 10 concurrent saves, offline+retry, close-during-import, import partial failure |
| 4 | Ask everyone to reload; ★ **bridge audit** at least twice, one full production day apart | | S4: audit listed both problem slots |
| 5 | **Exit condition met** (see bridge-risk.md §4) → **publish candidate rules** | new ✓ · old ✗ with message | S5: open new tab kept saving without reload; old tab refused ("Save failed", entry kept) |
| 6 | ★ **Reconcile** every slot the audit lists + clear failed import markers (Admin); Leaders reconfirm CHANGED shifts | | S6: audit → 0 problems |
| 7 | **Baseline migration** → `completeIfClean` (gate) | everyone signed in (no write-blocked window) | S7: with a Leader saving concurrently; gate opened |
| 8 | (separate approval) set `QD_CLOSE_REQUIRED_FROM` | | S8: Dashboard status from closes; no personal data in pages or CSV |

**Never**: deploy the enforce site before the bridge/candidate rules (S0 proves the new site cannot save under production rules).

## 2. GO / NO-GO

GO only when every line is ✔. Any ✘ = NO-GO.

- [ ] G1: Console confirms database `(default)`, last-published time recorded, re-copied rules hash = `0967944b…2e2f`
- [ ] G2: PV2 + QD owners approved `emulator/firestore.rules` (candidate) and `emulator/firestore.rules.bridge`
- [ ] G4: public-read policy approved (public-data.md), incl. `recordedBy` / improvement `owner`
- [ ] All suites green on the exact commit to deploy (unit 42, rules 107, e2e 51, regression 15) and `node tools/rules/build-bridge.js --check`
- [ ] Backup export done; snapshot text ready to re-publish (R2)
- [ ] First Admin + role list ready
- [ ] Reload announcement sent; times of steps 1, 5 agreed (quiet period)
- [ ] Step 5 only after the exit condition (two clean audits ≥ 1 production day apart, the second after everyone reloaded)
- [ ] Step 7 only after step 6 audit = 0 problems
- **NO-GO / stop immediately** if: PV2 smoke fails after any publish (→ re-publish snapshot), any audit shows a problem that cannot be reconciled, `completeIfClean` returns problems (do not force `markComplete`).

## 3. Test results (Emulator)

| Suite | Result |
|---|---|
| Unit | 42/42 (adds page inventory, ledger-bypass) |
| Rules | 107/107 (adds migration-gate; candidate now refuses e-mails on public documents) |
| E2E | 51/51 (adds full rehearsal 29 scenarios, retired pages ×3) |
| Regression (repo) | 15/15 |
| Off-mode Dashboard matrix (107 scenarios) | identical to Phase 6 on the same day (diff 0) |
| ix (whole system incl. Executive Report) | 21/21 |
| Bridge-rules subset | 39/42 — the 3 differences are what the bridge cannot enforce (as production today) |

## 4. BLOCKED

| Code | Item | Needed |
|---|---|---|
| G1 | Database / publish time of the snapshot unconfirmed | Owner, in the Console |
| G2 | Approval of candidate + bridge; who publishes | PV2 + QD owners |
| G4 | Public read policy incl. remaining personal-ish fields (`recordedBy`, improvement `owner`, free-text remarks) | Management / IT |
| P7-1 | Retiring the 3 old copies (guard added, files kept) | Approve with the site deploy |
| P7-2 | `plan-tracking.html`, `weekly-review.html` are linked only from the retired `dashboard-classic.html` (unreachable from V5 navigation) | Decide: add to V5 navigation or retire |
| P7-3 | No production runner for bridge audit / reconcile / baseline (tools exist, emulator-tested) | Next phase: admin page or approved script |
| B1/B2, M1, C1/C2, L2 | As in Phase 6 | — |
