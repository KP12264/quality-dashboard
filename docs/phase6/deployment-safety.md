# Deployment Safety — Sequence, Windows, Rollback, GO / NO-GO

> Nothing here may be executed without approval. Supersedes the order in `docs/phase5/deployment-runbook.md` §"ขั้นตอน" (roles, backup and smoke tests there still apply).

## 1. Why order matters (tested, see compatibility.md §B)

| State | Old pages (sign-in off) | New pages (sign-in on) |
|---|---|---|
| Production rules | save ✓ | save ✗ |
| Candidate rules | save ✗ | save ✓ |
| Bridge rules | save ✓ | save ✓ |

A one-step switch (publish candidate + deploy site) always leaves a window where one kind of page cannot save. The bridge removes that window.

## 2. Recommended sequence (zero write-failure window)

| Step | Action | Who can save | Window / risk |
|---|---|---|---|
| 0 | Backup: `gcloud firestore export` + keep the exact current rules text (= snapshot; confirm hash) | everyone | — |
| 1 | Create first QD admin in `qdUsers` (Console) | unchanged | none |
| 2 | **Publish BRIDGE rules** | old ✓ new ✓ | PV2 identical (tested). Public write still open = same as today |
| 3 | Smoke PV2 + old site save | | if anything fails → re-publish snapshot (R2) |
| 4 | Deploy site with `QD_AUTH_MODE = "enforce"` | old tabs ✓ (until reloaded) · new ✓ | Old tabs/HTML still in "off" write around the ledger → slots may show CONFLICT; ask everyone to reload; GitHub Pages HTML cache ≈ 10 min |
| 5 | Wait until no old pages save (announce; check that new `scrapLogs` have `createdBy`) | | |
| 6 | **Publish CANDIDATE rules** (closes public write) | new ✓ · any old tab ✗ ("Save failed", nothing silently lost) | Only users who never reloaded are affected; their entry stays in the form |
| 7 | Migration baseline + `markComplete` (after 6, so nothing can write around the ledger any more) | | Run as admin; verify 0 mismatches |
| 8 | Smoke QD (Leader/Admin/Viewer, close, Dashboard, Executive Report) | | |
| 9 | Later, separate approval: `QD_CLOSE_REQUIRED_FROM` | | not retroactive |

Alternative (single step, shorter but with a window): announce a freeze of QD saving → publish candidate → deploy the enforce site → unfreeze. Between the publish and each user's reload, old pages cannot save; if the site is deployed before the publish, new pages cannot save. Acceptable only with an announced freeze.

## 3. Write-failure windows

| Window | Cause | Mitigation |
|---|---|---|
| Site enforce before rules allow QD collections | production rules deny `qdUsers`/`scrapSlots` | never deploy the enforce site before the bridge (or candidate) is published |
| Candidate published while pages still "off" | public write closed | bridge first; announce reload; step 5 check |
| Rules publish propagation (≈ up to a minute per Firebase docs — NOT VERIFIED here) | mixed rule versions briefly | do steps 2 and 6 in a quiet period |

## 4. Old pages still reachable

| Page | Under bridge | Under candidate |
|---|---|---|
| Open tabs of today's site (off) | save ✓ but around the ledger → CONFLICT on closed slots | save ✗ |
| `dashboard.html`, `js/scrap-entry.html`, `dashboard-classic.html` (legacy copies on Pages) | same as above (no ledger module; off mode) | save ✗; once the site is enforce they fail closed (`qd/ledger-missing`) |

Recommendation: before step 6, remove or redirect the legacy copies (needs approval; not done).

## 5. Backup & rollback

| Code | Trigger | Action | Result |
|---|---|---|---|
| R2 | PV2 or QD broken after a publish | Re-publish the snapshot text (`emulator/production.firestore.rules.snapshot`, hash-checked) | Exactly today's state |
| R-bridge | Candidate published, old pages must save again | Re-publish the bridge | Both page kinds save; public write reopened |
| R1 | Site problem | Deploy site with `QD_AUTH_MODE = "off"` — **only together with R2 or R-bridge**, otherwise off pages cannot save under the candidate | |
| R3 | Data damage | Restore from the step-0 export (approval) | |

Data created by the new site (`scrapSlots`, events, `scrapCloseSummary`, `qdUsers`, `qdConfig`) is additive and harmless after a rollback.

## 6. GO / NO-GO

GO only when every item is ✔:

- [ ] G1 closed: owner confirms the snapshot is the **published** rules of database `(default)` (hash `0967944b…2e2f`), with publish time
- [ ] No rules publish since the snapshot (re-copy and re-hash on the day; must match)
- [ ] Owners of PV2 and QD approve the candidate + bridge diffs (G2)
- [ ] Public read policy approved, incl. `scrapCloseSummary` and `scrapWeeklyPlans` (G4)
- [ ] First QD admin + role list ready (B2)
- [ ] All suites green on the commit to deploy (unit, rules incl. pv2-compat / budget / shift-time, e2e incl. rules-transition, regression)
- [ ] Backup done; snapshot text ready for R2
- [ ] Reload announcement sent; legacy copies handled

NO-GO immediately if: the re-copied rules differ from the snapshot; any PV2 smoke test fails after a publish (→ R2); any suite fails.
