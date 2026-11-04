# Production Cutover Checklist — Quality Dashboard V5 + Weekly Plan V5 (READ-ONLY)

Code: `c4a165e` (branch `claude/vigilant-pasteur-l91qt3`).
**This document executes nothing.** Every Production step below is either a read-only check, or an action that needs its own written approval before anyone runs it.
Nothing was deployed, published, merged, migrated or written to Firestore Production; Production V2 untouched.

Legend:
- **EMU ✅** — proven in the Firebase Emulator (`demo-quality-dashboard`) by an automated test.
- **PROD ☐** — must still be checked on the real project; a person with access does it.
- **(RO)** — read-only check, may be done before approval.
- **(ACT)** — changes Production: needs its own approval.

Roles referenced: Release owner (GO / NO-GO) · Firebase owner (backup, rules publish) · PV2 owner (PV2 smoke) · QD admin (Operations tab).
Order and rollback follow `docs/phase8/runbook.md`, which supersedes Phase 7 §1. This checklist adds Weekly Plan V5 and D1.

---

## 1. G1 — Database and published Rules snapshot

| # | Item | Emulator / repo | Production | Pass criterion |
|---|---|---|---|---|
| 1.1 | Snapshot stored byte-exact with metadata | EMU ✅ `emulator/production.firestore.rules.snapshot` sha256 `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f` (unchanged since Phase 6) | — | — |
| 1.2 | Which database the site uses | repo: `js/config.js` (project `daily-production-report-46b60`) sets no database id, so the SDK uses `(default)` | PROD ☐ (RO) Firebase Console → Firestore: list databases; confirm the site and Production V2 both use `(default)` | only `(default)` in use, or the extra one is documented |
| 1.3 | Published rules = snapshot | — | PROD ☐ (RO) Console → Firestore → Rules: copy the **published** text and note the publish time; compute SHA-256 | hash equals `0967944b…2e2f`; otherwise **NO-GO** (re-copy, re-run the rules suites on the new snapshot) |
| 1.4 | Nobody published since | — | PROD ☐ (RO) Rules history in the Console: no publish after the noted time | no newer version |
| 1.5 | Backup possible | — | PROD ☐ (RO) confirm the bucket / IAM for `gcloud firestore export` exists. The export itself is (ACT): day 0 step 1 | owner + bucket named |

## 2. G2 — Bridge / Candidate rules: publish order and rollback

| # | Item | Emulator / repo | Production | Pass criterion |
|---|---|---|---|---|
| 2.1 | Candidate rules (incl. Weekly Plan) | EMU ✅ `emulator/firestore.rules` sha256 `6fa05b5a12ffb6cfe752d312ba8cdef65328b863635b7670a6965b46d2e45668` · Rules suite 144/144 | — | — |
| 2.2 | Bridge = candidate + production public QD blocks | EMU ✅ `firestore.rules.bridge` sha256 `d94383fa53726b55ed80c958456a57dd7a1f57775460af8d2c1aebdbb5e198e1`; `build-bridge.js --check` passes | — | rebuild + `--check` on the release commit |
| 2.3 | PV2 unaffected in all rule sets | EMU ✅ `pv2-compat.test.js` 4/4 (PV2 + legacy paths identical in production / candidate / bridge / repo PV2) | PROD ☐ PV2 smoke (§9) after **each** publish | 0 PV2 failures |
| 2.4 | Rehearsed order | EMU ✅ `rehearsal.e2e` (29 steps): production → bridge → admin → sign-in site → audit → candidate → reconcile → baseline → Shift Close → rollback | — | — |
| 2.5 | Publish order (each step (ACT)) | runbook | 0b pre-cutover release (`off`) → 1 backup → 2 first Admin → 3 **bridge** → 4 site `enforce` → 5 bridge audit ×2 (≥1 production day apart) → 6 **candidate** → 7 reconcile → 8 baseline (M1) → 9 lock ops writes → 10 smoke QD → later 11 `QD_CLOSE_REQUIRED_FROM` (B1) | each step's check passes before the next |
| 2.6 | Bridge exit condition | EMU ✅ `migration-gate.test`, `bridge-risk.md` §4 | PROD ☐ two bridge audits ≥1 production day apart, no new problem slot | condition met |
| 2.7 | Rollback | EMU ✅ rehearsal R: bridge → snapshot → forward, no data lost; post-rollback audit + reconcile → 0 | (ACT) R2 = re-publish the snapshot (any PV2 failure); R-bridge = re-publish the bridge (QD-only problem); R1 = redeploy the previous site build | rollback text and owner ready **before** step 3 |
| 2.8 | Weekly Plan needs bridge / candidate | EMU ✅ under production rules: page and card show "Default · unconfirmed", no crash, no edits | — | accepted as the fallback until step 3 |

## 3. G4 — Public data policy and personal data in old documents

| # | Item | Emulator / repo | Production | Pass criterion |
|---|---|---|---|---|
| 3.1 | Policy implemented | EMU ✅ public: scrap numbers, plan numbers, close summary (no e-mail); signed-in only: `scrapLogPrivate`, `improvementOwners`, plan history, review notes, `scrapSlots`; `qdNoNewPersonal` forbids new personal fields on public docs | — | owner approves the list in `docs/phase7/public-data.md` + Weekly Plan rows |
| 3.2 | Nothing private on public pages / CSV | EMU ✅ privacy e2e, target-close e2e (no e-mail / reason), weekly-plan e2e (history / notes hidden), release-readiness §6–7 (sign-out clears, storage empty) | PROD ☐ (RO) after step 10: public Dashboard, Executive Report CSV, Weekly Plan contain no names / codes | none found |
| 3.3 | Old documents still holding personal data | EMU ✅ scan finds them (`privacy-migration.test.js`) | PROD ☐ (RO) count old `scrapLogs.recordedBy` and `improvements.actions[].owner` with the **dry run** (Operations tab, scan only; needs the `enforce` site + Admin after step 4), or offline from the day-0 export | counts recorded in the change |
| 3.4 | Which old fields are public today | repo: production rules allow public read of QD collections | PROD ☐ (RO) confirm that **until M-P1**, old `recordedBy` / owners remain publicly readable | accepted risk, or M-P1 scheduled |

## 4. M1 — Baseline migration (slot ledger)

| # | Item | Emulator | Production | Pass criterion |
|---|---|---|---|---|
| 4.1 | Dry run → apply → verify → gate | EMU ✅ `migration.test`, `migration-gate.test` (load, half-way failure, re-run, gate refuses when not clean), rehearsal S7 | PROD ☐ (ACT) step 8 after the candidate + reconcile | gate "complete" |
| 4.2 | Backup before | EMU n/a | PROD ☐ (ACT) day-0 export exists and is listed | export path recorded |
| 4.3 | Audited run | EMU ✅ `ops-security.test` (needs a START record of the same admin / action ≤ 12 h; borrowed / expired runs refused) | PROD ☐ approval reference + reason typed in the Operations tab | qdOpsLog START + RESULT present |
| 4.4 | Verify totals unchanged | EMU ✅ regression + matrix: Dashboard numbers identical | PROD ☐ (RO) Dashboard / Executive Report totals for 3 sample dates before vs after | identical |

## 5. M-P1 / M-P2 — Privacy migration

| # | Item | Emulator | Production | Pass criterion |
|---|---|---|---|---|
| 5.1 | Dry run (scan only) | EMU ✅ | PROD ☐ (RO, after step 4) Operations → Privacy migration → Dry run | counts recorded |
| 5.2 | Backup JSON before apply (button refuses otherwise) | EMU ✅ | PROD ☐ (ACT) download and store the backup with the change | file stored |
| 5.3 | Apply (idempotent, resumable) | EMU ✅ interrupted run + resume; re-run = 0 changes | PROD ☐ (ACT) needs M-P1 approval | — |
| 5.4 | Exception Report — nothing skipped silently | EMU ✅ every skipped / failed / unmigratable document listed with a reason (code > 64 chars, > 20 actions, changed since scan, failed) | PROD ☐ (RO) download the report after the dry run; **M-P2 decision** per exception (keep / shorten / remove) | every row has a decision |
| 5.5 | Verify | EMU ✅ re-scan = 0 personal fields; sidecars equal the backup | PROD ☐ (ACT, RO check) verify after apply | clean, or only M-P2 rows left |

## 6. B1 — Shift Close required date

| # | Item | Emulator | Production | Pass criterion |
|---|---|---|---|---|
| 6.1 | Behaviour before / after the date | EMU ✅ target-close e2e, unit; Weekly Plan: days final only through Shift Close; before the date all figures "so far" | — | — |
| 6.2 | Choose the date | — | owner decision: a **future** date after M1 is complete and leaders have closed shifts voluntarily for ≥ 1 week | date approved |
| 6.3 | Set it | repo `QD_CLOSE_REQUIRED_FROM = null` | (ACT) release with the date; rollback R4 = set back to `null` | Dashboard shows "x/6 confirmed"; Weekly Plan starts showing Final |

## 7. B2 — Admin / Leader / Viewer and access

| # | Item | Emulator | Production | Pass criterion |
|---|---|---|---|---|
| 7.1 | Role matrix | EMU ✅ rules + auth e2e: Admin all; Leader own Line × Shift only, 7-day window; Viewer read-only; PV2 user without QD role read-only; Weekly Plan: Admin edits with reason + history, Leader / Viewer read-only | — | — |
| 7.2 | Account list | — | owner decision: who is Admin (≥ 2), each Leader's slots, Viewers | list approved |
| 7.3 | Create roles | EMU ✅ Admin page (`users.manage`) | (ACT) step 2: first Admin via Console, the rest via the Admin page | — |
| 7.4 | Verify | — | PROD ☐ (RO) list `qdUsers`; sign in as one of each role on the live site: Leader saves own slot ✓, other slot ✗; Viewer ✗; Admin opens Daily Confirmation | all as expected |
| 7.5 | Sign-out / account switch clears private data | EMU ✅ §6–7 (same tab, other tab, Back / Forward, storage empty) | PROD ☐ (RO) quick check on a shared PC | no private value after sign-out |

## 8. C1 / C2 — Firestore reads, monitoring and cost

Measured in the emulator. Est. reads = documents returned (≥ 1 per query); **not billed reads**. Sources: `generated/read-cost.md`, `generated/read-cost-before-after.md`.

| Screen / action | Queries | Est. reads |
|---|---|---|
| Dashboard open (1 day) | 12 | ≈ 141–156 |
| Dashboard 31-day range | 189 | ≈ 331 |
| Dashboard filter change (≤ 5 min) | 0 | 0 |
| Dashboard Refresh (31 days) | 190 | ≈ 333 |
| Weekly Plan open a month | 3 | ≈ 146 (grows with the month's scrap logs) |
| Weekly Plan previous-month goal | 2 | ≈ 144 |

| # | Item | Production |
|---|---|---|
| 8.1 | Estimate | owner: users × opens / day × the rows above → reads / day; compare with the plan / quota (C1) |
| 8.2 | Baseline before go-live | PROD ☐ (RO) Console → Usage: reads / day for the last 14 days (today's site) |
| 8.3 | Monitoring for 2 weeks | PROD ☐ (RO) daily Usage reads vs the estimate; alert when > 2 × the estimate (C2: threshold to approve) |
| 8.4 | Known big readers (unchanged design) | Dashboard production docs per date / line / shift (186 for 31 days); look-back 30 days for a 1-day view |

## 9. Production V2 smoke test — before and after every rules change

| # | When | Check (PV2 owner, real authorised account) | Pass | On failure |
|---|---|---|---|---|
| 9.1 | Before step 3 (baseline) | open the PV2 dashboard; save **one** entry; read it back; note the time | works | NO-GO |
| 9.2 | Within 10 min after the **bridge** publish | same as 9.1 | works | **R2 now** (re-publish snapshot) |
| 9.3 | Within 10 min after the **candidate** publish | same + an unauthorised PV2 user still cannot write | works | **R2 now** |
| 9.4 | After any rollback | same as 9.1 | works | escalate |
| — | Emulator evidence | EMU ✅ `pv2-compat.test` (identical PV2 permissions in all rule sets), rehearsal (PV2 writing / reading continuously through every step: 0 failures) | | |

## 10. Final GO / NO-GO criteria

**GO** only when **all** hold:

1. G1 1.2–1.4 checked: hash equal, database confirmed, no newer publish.
2. G2 approved: candidate + bridge rules (hashes above) and the publish / rollback order (§2); rollback owner on duty.
3. G4 approved: public data list (3.1); old personal data handled or accepted (3.3–3.4; M-P1 / M-P2 decisions).
4. M1 approved, with backup (4.2) and the audited run (4.3).
5. B1 date decided, or explicitly "not yet" (stays `null`).
6. B2 account list approved (7.2).
7. C1 / C2 estimate and alert threshold accepted (§8).
8. All suites green on the release commit: Unit, Rules, E2E, Regression, matrix, ix, `build-bridge --check`.
9. PV2 smoke 9.1 passed; PV2 owner available for 9.2–9.3.
10. User notification sent (`docs/phase8/cutover.md` §3).

**NO-GO**, or stop / roll back, if any of these happens:
- the re-copied rules hash differs from the snapshot;
- any suite fails on the release commit;
- any PV2 smoke fails after a publish → R2 immediately;
- the bridge exit condition is not met;
- the baseline gate refuses (fix the listed slots, never force);
- a private value appears on a public page or in a CSV.

## Status now

| Gate | Emulator | Production |
|---|---|---|
| G1 | ✅ snapshot stored | ⛔ not checked |
| G2 | ✅ rules + bridge + rehearsal | ⛔ not approved |
| G4 | ✅ policy implemented and tested | ⛔ decision + old-data count |
| M1 | ✅ tool + gate tested | ⛔ not run |
| M-P1 / M-P2 | ✅ tool + Exception Report tested | ⛔ not run; decisions pending |
| B1 | ✅ behaviour tested | ⛔ date not decided |
| B2 | ✅ roles tested | ⛔ account list not approved |
| C1 / C2 | ✅ measured (estimate) | ⛔ not accepted; no production baseline |
| PV2 smoke | ✅ emulator compatibility | ⛔ to run at each publish |
| D1 | ✅ implemented (`c4a165e`) | — |

**Overall: NO-GO** until every ⛔ above is resolved.
