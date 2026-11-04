# Production Cutover Approval Package — Quality Dashboard V5 + Weekly Plan V5

**For decision. Nothing in this document has been executed or approved.**
- Code: commit `2a031c0` (all suites green; see `results.md`). Branch `claude/vigilant-pasteur-l91qt3`.
- Nothing has been deployed, published or merged; Firestore Production has not been written; Production V2 is unchanged.
- Detailed checks per gate: `cutover-checklist.md`. Rules: candidate `6fa05b5a…5668`, bridge `d94383fa…98e1`, production snapshot `0967944b…2e2f`.

Marks used below:
- **[RO]** read-only: allowed without approval, changes nothing.
- **[ACT]** changes Firebase Production (Rules, Firestore, Auth, Hosting or an export): needs a written approval for that exact step. That includes any test record ("smoke save").

Approver roles (names to be filled in by the owner):
- **Release owner**: GO / NO-GO for the whole cutover.
- **Firebase owner**: database, backups, rules publish.
- **PV2 owner**: Production V2 and its smoke tests.
- **QD admin**: the Operations tab and the roles.
- **Data / policy owner**: public data and personal data.
- **Production manager**: Shift Close date and the account list.
- **Cost owner**: Firebase usage and budget.

---

## 1. Decisions

| Gate | What must be approved | Current status | Options | Recommended + why | Risk to QD V5 | Risk to Production V2 | Approver | Verify after | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| **G1** Database + published rules | That `(default)` is the database used, and the published rules equal the stored snapshot | ⛔ snapshot stored (sha256 `0967944b…2e2f`); Production not checked | A) Firebase owner checks [RO] and confirms · B) go ahead without checking | **A**: every rules test assumed this snapshot; a different published version would make the bridge / candidate untested | B: the candidate may remove permissions QD relies on | **B: high**: an untested PV2 rule change could stop PV2 writes | Firebase owner | hash of the re-copied published rules = `0967944b…2e2f`; no newer publish in the history | none needed (read-only). On a mismatch: **NO-GO**, re-copy and re-run the rules suites |
| **G2** Bridge + candidate rules and their order | Publishing the bridge, then the candidate (hashes above) | ⛔ not approved; rehearsed in the emulator (29 steps, rollback incl.) | A) bridge for ≥ 1 production day → candidate · B) candidate directly · C) postpone | **A**: open old tabs keep saving during the transition; the audit lists their writes for reconcile; rehearsed end to end | B: open old tabs fail to save at once (entries kept, message shown) | none in A or B: PV2 permissions identical in all rule sets (tested); a PV2 smoke after each publish | Firebase owner + PV2 owner + Release owner | PV2 smoke; QD smoke; bridge audit ×2; post-candidate audit = 0 | **R2**: re-publish the snapshot (any PV2 failure, at once) · **R-bridge**: re-publish the bridge (QD-only problem) |
| **G4** Public data policy | What anyone may read without signing in | ⛔ policy implemented in the candidate, not approved | A) numbers public (scrap, plans, close summary without e-mail); names / codes / history / notes signed-in only · B) everything signed-in only · C) keep today (personal data public) | **A**: keeps today's public Dashboard working and removes personal data from public view | B: the public Dashboard / Executive Report stop working without sign-in | none | Data / policy owner + Release owner | [RO] public pages and CSVs show no names or codes; compatibility matrix | rules rollback (R-bridge / R2) restores today's access |
| **M1** Baseline migration (slot ledger) | Running dry run → apply → gate on production data | ⛔ not run; tool + gate tested (load, half-way failure, re-run) | A) after the candidate + reconcile, with backup, dry run, audited run · B) skip | **A**: without it the ledger is incomplete and Shift Close cannot be required (B1); the gate refuses unclean data | B: Shift Close cannot be enforced; Dashboard unchanged | none (QD collections only) | QD admin + Firebase owner + Release owner | gate "complete"; Dashboard / Executive Report totals for sample dates identical before / after | **no data rollback is needed**: baseline only adds ledger documents; on a refusal fix the listed slots and re-run, never force. Full restore only from the day-0 export (separate approval) |
| **M-P1** Privacy migration | Moving old public `recordedBy` / improvement owners into the private sidecars | ⛔ not run; tool tested (dry run, backup, resume, idempotent, verify, Exception Report) | A) after the candidate, with dry run + backup JSON + verify · B) keep the old personal data public (accept) · C) delete the fields without keeping them | **A**: removes personal data from public view without losing it; the backup JSON is the undo data | none: quantities, ledger counts and close fingerprints never include these fields (tested) | none | Data / policy owner + QD admin | verify: re-scan = 0 personal fields; sidecars equal the backup; Exception Report reviewed | restore the original values from the backup JSON (separate approval); the apply is resumable |
| **M-P2** Exceptions of M-P1 | What happens to rows the tool will not migrate (code > 64 chars, improvement with > 20 actions) | ⛔ count unknown on Production (only after the dry run) | per row: keep public · shorten / correct, then migrate · remove after backup · move manually | **decide per row after the dry run**: the Exception Report lists every row; nothing is skipped silently | none | none | Data / policy owner | every Exception Report row has a decision; verify shows only the agreed rows left | per row, from the backup JSON |
| **B1** Shift Close required date (`QD_CLOSE_REQUIRED_FROM`) | The first date whose daily status needs 6/6 closes | ⛔ `null` (not in use) | A) a future date after M1 and ≥ 1 week of voluntary closing · B) at go-live · C) keep `null` | **A**: leaders practise first, and the ledger is complete (M1); dates before keep today's rule | B: many days show INCOMPLETE / Not final at once · C: Weekly Plan never shows Final | none | Production manager + Release owner | Dashboard shows "x/6 confirmed"; Weekly Plan shows Final for fully closed days | **R4**: set back to `null` and release (configuration only) |
| **B2** Admin / Leader / Viewer | The account list and each Leader's Line × Shift slots | ⛔ list not approved; role matrix tested | A) ≥ 2 Admins; Leaders on their own slots; others Viewer; PV2 users without a QD role read-only · B) one Admin | **A**: no single point of failure; least privilege | B: if that one person is away, nobody can fix roles or run Operations | none: QD roles grant nothing in PV2 and vice versa (tested) | Production manager + QD admin | [RO] list `qdUsers`; [ACT, approved] one Leader test save on the own slot, other slot refused, Viewer refused | change or deactivate the role in the Admin page (`active = false`) |
| **C1** Read cost | Accepting the measured read volume (estimates, not billed numbers) | ⛔ measured in the emulator; no production baseline | A) accept + monitor (C2) · B) require more optimisation first (the big reader is per-date production documents, which would need a PV2 change) | **A**: QD-side reads are already optimised (filter 190 → 0, month switch 3 → 0); B would touch PV2 | B: delays the release | B would change PV2 | Cost owner + Release owner | Console → Usage: reads / day vs the estimate | none needed; if too high: lower usage of 31-day views, or plan an aggregate (new phase) |
| **C2** Monitoring + alert threshold | Who watches usage, for how long, and when to act | ⛔ not set | A) daily Usage check for 2 weeks; alert at > 2 × the estimate · B) plus a billing budget alert [ACT, billing setting] | **A** (+ B if a budget exists): catches a regression or misuse early | none | none | Cost owner | daily note for 2 weeks | — |

---

## 2. Deployment sequence (checked against the real dependencies)

The 10-step order in the request was compared with the dependencies in the code and the rules. **This is a proposal; nothing in it is approved.**

Changes to the requested order, and why:

| # | Change | Dependency |
|---|---|---|
| a | **Added "pre-cutover release" before the bridge** (site still `off`, but able to show the "reload and sign in" message) | Tabs left open must already have this code before the candidate, or they only see a generic error |
| b | **Admin and roles split in two**: the first Admin before the bridge (Console), all other roles after the new site | Today's production rules deny `qdUsers` entirely: only the Console (which bypasses rules) can create the first Admin. The Admin page can save roles only under the bridge / candidate rules and on the `enforce` site |
| c | **Smoke tests are not one step at the end** | A PV2 smoke is needed before the first rules change and right after **each** publish (that is when R2 must be decided). A QD smoke is needed after the site deploy and after the candidate |
| d | **Bridge exit condition added between the bridge and the candidate** | Two bridge audits, ≥ 1 production day apart, with no new problem slot |
| e | **Migrations after the candidate, in the order: reconcile → M1 → M-P1** | M1 needs the candidate + reconcile so no client writes around the ledger. M-P1 needs the candidate because under the bridge an old page could write `recordedBy` publicly again; it does not depend on M1 (independent, tested). Both need the Operations write lock opened and closed again |
| f | **Shift Close after M1, as its own release** | The close status relies on a complete ledger (M1) |
| g | Weekly Plan needs no step of its own | It works once the bridge is published; before that it shows "Default · unconfirmed" (tested) |

### Proposed sequence

| # | Step | Type | Depends on | Check | Stop / rollback |
|---|---|---|---|---|---|
| 1 | Verify the database and the published rules (G1) | [RO] | — | hash = snapshot; no newer publish | mismatch → **NO-GO** |
| 2 | Backup: copy the published rules text; `gcloud firestore export` of the database | rules copy [RO] · export **[ACT]** | 1 | export listed; rules file stored with its hash | export fails → stop |
| 3 | Pre-cutover release: site `QD_AUTH_MODE = "off"` with the cutover message; send the user notice | **[ACT]** Hosting | 2 | Dashboard regression unchanged; a save works as today | R1 redeploy the previous build |
| 4 | First Admin in `qdUsers` (Console); prepare the role list (B2) | **[ACT]** Firestore | B2 approved | the document exists; nothing else changed | delete that document |
| 5 | **PV2 smoke, baseline** (before any rules change): one agreed test entry | **[ACT]** PV2 data | — | PV2 save + read OK | PV2 already failing → **NO-GO** (not caused by QD) |
| 6 | **Publish bridge rules** (G2), then within 10 min: PV2 smoke + an old (off) QD page still saves | **[ACT]** Rules + test entries | 1–5 | PV2 OK; QD old page OK; Weekly Plan readable | PV2 failure → **R2** at once |
| 7 | **Deploy the site `enforce`**; QD smoke: Admin signs in, a Leader saves on the own slot (approved test record), Daily Confirmation opens; create the remaining roles in the Admin page | **[ACT]** Hosting + Firestore | 4, 6 | as listed; public Dashboard unchanged | **R1** (the bridge still accepts the old build) |
| 8 | Bridge audits ×2, ≥ 1 production day apart (Operations tab) | [RO] | 7 | no new problem slot between the two | problems keep appearing → find the client; stay on the bridge |
| 9 | **Publish candidate rules** (G2), then within 10 min: PV2 smoke; QD smoke (Leader own slot ✓, other ✗, Viewer ✗); an old tab shows the reload message | **[ACT]** Rules + test entries | 8 | as listed | PV2 failure → **R2**; QD-only problem → **R-bridge** |
| 10 | Operations write unlock; **post-candidate audit**; **reconcile** listed slots; leaders reconfirm CHANGED shifts | **[ACT]** Hosting + Firestore | 9 | post-candidate audit = 0 | — |
| 11 | **M1 baseline**: dry run [RO] → apply → gate | **[ACT]** Firestore | 10, M1 approved, backup (2) | gate "complete"; sample totals identical | gate refuses → fix slots, re-run (never force) |
| 12 | **M-P1 privacy**: dry run + Exception Report [RO] → M-P2 decisions → backup JSON → apply → verify | **[ACT]** Firestore | 9, M-P1 + M-P2 approved | verify clean (only agreed exception rows left) | restore from the backup JSON (separate approval) |
| 13 | Operations write lock again | **[ACT]** Hosting | 11–12 | lock shows LOCKED | — |
| 14 | **Shift Close date** (B1), a future date, as its own release | **[ACT]** Hosting | 11 (gate complete) + B1 approved | "x/6 confirmed"; Final appears on fully closed days | **R4**: back to `null` |
| 15 | Monitoring for 2 weeks (below) | [RO] | 9 | daily notes | criteria below |

### Monitoring and rollback criteria

| Watch | How | Act when | Action |
|---|---|---|---|
| PV2 writes | PV2 owner's normal checks; smoke after each publish | any PV2 write failure after a QD rules publish | **R2 immediately** (re-publish the snapshot), then investigate |
| Writes around the ledger | Operations → post-candidate audit (daily) | > 0 | reconcile; find the client |
| CONFLICT slots / old pending closes | Operations audit; Daily Confirmation each morning | a new CONFLICT; shifts older than 1 day still pending | reconcile / remind the leaders |
| Failed saves by correct users | leader feedback | any permission error on the user's own slot | check the role (`qdUsers`); if it is a rules problem → R-bridge |
| Private data in public | [RO] public pages and CSVs | any name or code visible | R-bridge, then fix |
| Firestore reads | Console → Usage | > 2 × the estimate (C2) | find the screen / user; no rollback needed unless abuse |
| Site errors | users / browser console | the Dashboard or Scrap Entry does not load | **R1** (previous build) |

**GO** = all gates in §1 approved, steps 1 and 5 passed, the PV2 owner available during steps 6 and 9, and the rollback text ready before step 6.
**NO-GO** = any of these:
- G1 mismatch;
- a failing suite on the release commit;
- a PV2 smoke failure that cannot be explained;
- the bridge exit condition not met;
- a refused baseline gate.

---

## 3. Read-only vs. changes (summary)

| Read-only — no approval needed | Changes Firebase Production — approval per step |
|---|---|
| 1 rules / database check · 8 bridge audits · 11 / 12 dry runs and the Exception Report · 15 monitoring · checking public pages / CSVs · Usage figures · listing `qdUsers` | 2 export · 3 site release · 4 first Admin · 5 / 6 / 9 PV2 smoke saves · 6 bridge publish · 7 site deploy, Leader test save, roles · 9 candidate publish · 10 reconcile + unlock · 11 M1 apply · 12 M-P1 apply · 13 lock · 14 Shift Close date · any rollback |

**Waiting for decisions on:** G1, G2, G4, M1, M-P1, M-P2, B1, B2, C1, C2, and on the proposed sequence (§2).
