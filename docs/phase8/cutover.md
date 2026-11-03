# Cutover Safety (bridge → candidate)

## 1. Clients that do not go through the ledger

| Client | Under bridge | Under candidate | Handling |
|---|---|---|---|
| Today's site, tab left open (code deployed before the pre-cutover release) | saves (around the ledger) | refused — generic "⚠ Save failed … PERMISSION_DENIED" (entry kept) | reload announcement; post-candidate audit |
| Site from the **pre-cutover release** (step 0b), still sign-in off | saves | refused with: "This page is out of date: saving now requires signing in. Your entries are kept — reload the page and sign in" (EN + TH) | tested (rules-transition, rehearsal S5) |
| Retired copies (`dashboard.html`, `dashboard-classic.html`, `js/scrap-entry.html`) | never connect (notice + redirect) | same | Phase 7 |
| Any other client (scripts, console) | public write open | refused unless signed-in QD role and via ledger | post-candidate audit detects anything that slips |

The cutover message is shown on: Scrap Entry (form + Excel import), Scrap Detail (edit/delete), Improvement, Admin targets. It appears only for a permission refusal while the page runs with sign-in off; nothing else changes.

## 2. Post-candidate audit (new)

Operations tab → audit with "logs created since" = time of the candidate publish. Lists every scrap log created after that time that no ledger event accounts for. Expected: **0**. Tested: before reconcile it found the one log an old page wrote; after reconcile 0.
Run it right after the publish, again after one production day, and after any rollback-and-forward.

## 3. User notification (text ready)

Before step 1 (bridge), to all leaders/admins (LINE group / notice board):
> From <date/time> the Quality Dashboard requires signing in with your employee code (same as Production V2). Please close all open Quality Dashboard tabs and open them again after <time>. If a page says "out of date", reload it — what you typed is kept.

## 4. Recovery after rollback (tested in Phase 7 R + Phase 8)

1. Rollback publish (bridge or snapshot) → old pages can save again.
2. Before moving forward: publish candidate → **post-candidate audit** with "since" = rollback time → reconcile listed slots → leaders reconfirm CHANGED shifts.
3. If the rollback happened before the baseline gate, simply re-run baseline dry run → apply → gate.
