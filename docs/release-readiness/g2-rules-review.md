# G2 — Security Rules Readiness Review (READ-ONLY)

Date: 2026-11-07 · repository `729784f` (code `2a031c0`; rules unchanged since `770d500`).
Nothing was changed: no rules published or edited, no deploy, no merge, no Production read or write, Production V2 untouched.
**G1 = PASS does not approve the cutover. This review approves nothing either: G2 still needs the owners' decisions below.**

Legend: **PASS** verified · **BLOCKED** a problem that must be fixed first · **PENDING APPROVAL** needs an owner decision.

## 0. Rule sets reviewed

| Rule set | File | SHA-256 | Lines | Role |
|---|---|---|---|---|
| Production (published) | `emulator/production.firestore.rules.snapshot` | `0967944b…2e2f` | 85 | today; **= published rules** (G1, byte-identical) |
| Bridge | `emulator/firestore.rules.bridge` | `d94383fa…98e1` | 672 | transition: candidate + today's public QD blocks |
| Candidate | `emulator/firestore.rules` | `6fa05b5a…5668` | 649 | final target |

`node tools/rules/build-bridge.js --check`: **up to date** (the bridge is exactly the candidate plus production's public QD blocks).

Evidence used:
- Rules suite **144/144** on `2a031c0`; rules unchanged since.
- `pv2-compat.test.js` 4/4, which writes `docs/phase6/generated/compatibility-matrix.md`: 18 paths × 6 identities × 5 operations = 540 checks.
- Dedicated suites: `rules`, `privacy`, `privacy-migration`, `ops-security`, `shift-close`, `close-summary`, `weekly-plan`, `migration-gate`, `budget`.
- E2E: rehearsal with rollback (29 steps), auth, privacy, weekly-plan, release-readiness.

## 1. Read / write per collection (P = production · B = bridge · C = candidate)

| Collection | Public (not signed in) | QD Viewer | QD Leader | QD Admin | PV2 writer (no QD role) | Change P→C |
|---|---|---|---|---|---|---|
| `productionLogs` (legacy) | P/B/C: read + write | same | same | same | same | **none** |
| `prodV2_authorizedUsers` | P/B/C: read; write nobody | same | same | same | same | **none** |
| `prodV2_*` (e.g. `actualLogs`, `dailyPlans`) | P/B/C: read only | read only | read only | read only | read + write | **none** |
| `prodV2_*/…/subcollection` | P/B/C: denied | denied | denied | denied | denied | none |
| `scrapLogs` | P/B: read + **write** · C: read | C: read | C: own slot, via ledger, 7-day window | C: any slot, via ledger | C: read | write closed to the ledger path |
| `targetMaster` | P/B: read + write · C: read | C: read | C: read | read + write | C: read | write → Admin |
| `improvements` | P/B: read + write · C: read | C: read | C: read | read + write (no owner names) | C: read | write → Admin |
| `scrapModelMappings` | P/B: read + write · C: read | C: read | C: read | read + write | C: read | write → Admin |
| `scrapCloseSummary` | P: denied · B/C: read (no e-mail) | read | read; written only with the slot | same | read | **opened** read |
| `scrapWeeklyPlans` | P: denied · B/C: read (numbers) | read | read | read; write with history | read | **opened** read |
| `scrapWeeklyPlans/*/history` | denied | read | read | read; create only | denied | opened to signed-in |
| `scrapWeeklyReviews` | denied | read | read | read + write + delete | denied | opened to signed-in |
| `scrapSlots` (+ `events`) | denied | read | read; write via ledger / close on own slot | read; write via ledger / close / ops | denied | opened to signed-in |
| `qdConfig` | denied | read | read | write only via an audited gate run | denied | opened to signed-in |
| `qdUsers` | denied | own document only (get) | own document only | read + write all | denied | opened (Admin; own doc) |
| `scrapLogPrivate` | denied | **read** | read; write with own log | read + write | denied | new, signed-in only |
| `improvementOwners` | denied | **read** | read | read + write | denied | new, signed-in only |
| `qdOpsLog` | denied | denied | denied | read + create; never update / delete | denied | new, Admin only |
| anything else | denied | denied | denied | denied | denied | none |

Totals (matrix): **63 permissions closed, 61 opened** of 540. Every change is in the reviewed list (`pv2-compat` test 3).

## 2. Findings

### PASS

| # | Check | Evidence |
|---|---|---|
| P1 | **Production V2 unchanged in bridge and candidate**: `productionLogs`, `prodV2_authorizedUsers`, `prodV2_*` (incl. subcollections) give identical results for all 6 identities | `pv2-compat` test 1; the PV2 block of the candidate is a verbatim copy (`rules.test` "production snapshot is intact … PV2 part"); rehearsal: PV2 wrote and read continuously through every step with 0 failures |
| P2 | A QD role grants nothing in PV2, and a PV2 write permission grants nothing in QD | matrix (`qdAdmin` cannot write `prodV2_*`; `pv2Writer` cannot write QD); separate role stores (`qdUsers` vs `prodV2_authorizedUsers`) |
| P3 | Admin / Leader / Viewer rights as designed: Leader own Line × Shift and 7-day window; Viewer read-only; inactive users denied; no self-escalation (`qdUsers` writable by Admin only, with server time and the admin's own e-mail) | `rules.test`, `auth.e2e`, `shift-close.test`, `weekly-plan.test` |
| P4 | Scrap writes only through the ledger (slot version + audit event in the same transaction); writes around it refused | `rules.test`, `ledger-load.test`, `no-ledger-bypass` unit |
| P5 | Personal data: public documents may not receive `createdBy` / `updatedBy` / `recordedBy` or action owners; `recordedBy` → `scrapLogPrivate`, owners → `improvementOwners`, both signed-in only; `qdUsers` never public; plan history / review notes signed-in only | `privacy.test`, `privacy-migration.test`, `weekly-plan.test`, `privacy.e2e`, release-readiness §6–7 |
| P6 | Operations (reconcile, baseline, gate, privacy strip) need an audited START record of the same admin and action, at most 12 h old; `qdOpsLog` immutable | `ops-security.test` (forged, expired and borrowed runs refused) |
| P7 | Rules evaluation limits: the heaviest valid writes stay within the access-call and expression limits | `budget.test` |
| P8 | Bridge = candidate + production public QD blocks, nothing else | `build-bridge --check` |
| P9 | Order **Bridge → site in Enforce → Candidate**, with the bridge exit condition (2 audits ≥ 1 production day apart) | rehearsal S1–S5; `approval-package.md` §2 steps 6–9 |
| P10 | Rollback: R2 (re-publish the snapshot), R-bridge, forward again, no data lost; post-rollback audit + reconcile → 0 | rehearsal R; `cutover.md` §4 |
| P11 | Weekly Plan under today's rules: shows "Default · unconfirmed", no errors (safe before the bridge) | release-readiness §3 |

### BLOCKED

**None in the rules.** No rules defect was found that must be fixed before G2 can be decided.

### PENDING APPROVAL (owner decisions)

| # | Item | Severity | Detail | Recommendation | Owner |
|---|---|---|---|---|---|
| A1 | **Shared Spark quota: QD reads can stop PV2** | **High** | The project is on Spark (`freeTier: true`, G1 evidence). Firestore's daily free quota belongs to the **project**, so QD and PV2 share it. When it is exhausted, reads (or writes) fail for **all** apps until the quota resets. The emulator measured client reads (Dashboard 1 day ≈ 156, 31 days ≈ 331, Weekly Plan ≈ 146 estimated reads); the total per day depends on users × views | **Before the bridge [RO]:** read the last 14 days of usage (Console → Usage) and compare peak day + the QD estimate with the current Spark limits (check the Firebase pricing page). Then the owner decides (C1): accept with monitoring, reduce QD usage (e.g. default to 1-day views), or move the project to Blaze with a budget alert **[ACT]** | Cost owner + PV2 owner + Firebase owner |
| A2 | **Reads made by the rules themselves are not in the read estimates** | Medium | `get()` / `exists()` in rules are billed. Every signed-in QD request checks `qdUsers` (`qdActive`: 1 document); a ledger save or close reads several more (slot, events, summary, `qdOpsLog` for operations); limit 10 per single request, 20 per batch / transaction. Public reads (`read: if true`) cost none | Add them to the C1 estimate (upper bound: about +1 per signed-in query, up to +20 per save); measure in the first days after the bridge with Console → Usage (§8 of the checklist) | Cost owner |
| A3 | **Bridge window: today's public write access stays open** | Medium (time-bound) | Under the bridge anyone can still write `scrapLogs`, `targetMaster`, `improvements`, `scrapModelMappings`, as today. That includes writing around the ledger and adding `recordedBy` / owners publicly, because the OR of the production block wins | Keep the bridge ≤ 1 production day; bridge audit ×2; post-candidate audit + reconcile; run M-P1 only **after** the candidate (as planned) | Release owner + Firebase owner |
| A4 | **G4: who may read personal data** | Medium | Candidate: `scrapLogPrivate` (employee codes) and `improvementOwners` (names) are readable by **every active QD user, Viewer included**, not only Admin | Decide in G4: keep "signed-in QD users", or restrict to Admin / Leader (a rules change and re-test, before G2 approval) | Data / policy owner |
| A5 | **Public reads stay public** | Low–Medium | Anyone can read `scrapLogs` (quantities, defects, models), `scrapCloseSummary`, `scrapWeeklyPlans` numbers, `targetMaster`, `improvements` without signing in (G4 option A) | Confirm in G4 (option A), or move to signed-in only (the public Dashboard would then need sign-in) | Data / policy owner |
| A6 | **Pre-existing PV2 exposure (not changed by QD)** | Medium (PV2) | Production makes `prodV2_authorizedUsers` publicly readable (the list of employee login IDs `<code>@prodv2.local`). The QD candidate keeps PV2 rules unchanged on purpose | Out of QD scope: the PV2 owner decides separately. **QD must not change it** | PV2 owner |
| A7 | **Legacy `productionLogs` is world-writable** (pre-existing) | Low–Medium (legacy) | Unchanged by design ("original site keeps working, forever") | Owner confirms that it stays as is | PV2 / legacy owner |
| A8 | **Last-Admin lock-out** | Low | An Admin can deactivate or delete any `qdUsers` document, including the last Admin. Recovery is still possible in the Console, which bypasses rules | B2: at least 2 Admins; recovery procedure = Console edit by the Firebase owner | Production manager + Firebase owner |
| A9 | **No point-in-time recovery, delete protection off** | Medium | `pointInTimeRecoveryEnablement: DISABLED`, `deleteProtectionState: DISABLED` (G1 evidence). A data rollback after M1 / M-P1 depends on the day-0 export | B-1 export is mandatory before step 6; optionally enable delete protection **[ACT]** | Firebase owner |
| A10 | **Smoke tests write to Production** | — | PV2 smoke save, Leader slot save | Approve the test records (content, who, removal) together with G2 | Release owner + PV2 owner |
| A11 | **G2 itself**: publish bridge, then candidate (hashes above) | — | Rules are ready and tested; publishing is a Production change | Approve **after** A1 (and A4 if the rules change) | Firebase owner + PV2 owner + Release owner |

### Observations (no decision needed now)

- The compatibility matrix does not list `scrapLogPrivate`, `improvementOwners` and `qdOpsLog`; their permissions are covered by the dedicated suites (`privacy`, `privacy-migration`, `ops-security`). Adding them to the matrix would be a test change in a later phase.
- `scrapWeeklyReviews` can be deleted by an Admin (intended, for removing a note); plan history cannot be changed or deleted by anyone.

## 3. Readiness per area

| Area | Status |
|---|---|
| Snapshot / bridge / candidate consistency | **PASS** |
| Production V2 compatibility (`prodV2_*`, `prodV2_authorizedUsers`, `productionLogs`) | **PASS** |
| QD roles (Admin / Leader / Viewer) | **PASS** |
| Personal data protection (`qdUsers`, `scrapLogPrivate`, `improvementOwners`) | **PASS** as implemented; who may read: **PENDING APPROVAL** (A4) |
| Order Bridge → Enforce → Candidate and the conditions between them | **PASS** (rehearsed); bridge window risk **PENDING APPROVAL** (A3) |
| Rollback plan | **PASS** (rehearsed); restore point = day-0 export (A9) |
| Smoke tests | plan ready; the writes need approval (A10) |
| Firestore reads / quota | **PENDING APPROVAL, high** (A1, A2) |
| **G2 overall** | **Ready for decision. Not approved.** No BLOCKED item; A1 should be resolved first |
