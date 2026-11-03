# Public Data Privacy (policy pending G4)

## 1. What a visitor can read today (production snapshot) and with the candidate

| Field | Where | Who/what it identifies | Production today | Candidate (Phase 8) |
|---|---|---|---|---|
| `createdBy` / `updatedBy` | scrapLogs, improvements, targetMaster, scrapModelMappings, scrapWeeklyPlans | sign-in e-mail = employee code | not written (sign-in off) | **never written; rules refuse** (Phase 7) |
| `recordedBy` | scrapLogs (Excel "Emp. Ld") | employee code | **public** | moved to `scrapLogPrivate/{logId}` (signed-in QD users only); rules refuse it on new logs |
| `actions[].owner` | improvements | person's name | **public** | moved to `improvementOwners/{id}` (signed-in only); rules refuse any owner on a public improvement (≤ 20 actions) |
| `remark`, `problem`, `whys`, `rootCause`, `note`, file names | scrapLogs, improvements, targetMaster | whatever people type | public | still public; **hint** on the fields (sign-in on): "no names or employee codes (visible to everyone)" |
| who closed / reasons / notes / audit | scrapSlots + events | e-mail, free text | — | not public (Phase 4) |

## 2. Options considered

| Option | Dashboard / Improvement still work? | Exposure | Effort |
|---|---|---|---|
| A. Keep as production (all public) | yes | employee codes + names public | none |
| **B. Private sidecar (implemented, emulator)** | yes — Dashboard/Executive Report never used these fields; Scrap Detail and Improvement show them to signed-in users | none for new data | done |
| C. Make `improvements` / `scrapLogs` sign-in-only | **no** — the public Dashboard and Executive Report read them | none | large |
| D. Stop storing `recordedBy` / owners | yes, but the information is lost | none | small |

Recommendation: **B** (pending G4). Free text cannot be policed by rules; the hint + a short instruction to leaders is the proportionate measure.

## 3. Behaviour (tested)

- Excel import with an "Emp. Ld" column: public record has no code; `scrapLogPrivate` holds it; written in the same ledger transaction; deleted with the log.
- Scrap Detail: signed-in user sees "Recorded By"; the public sees "–" and the page never requests the private document.
- Improvement with an action owner: public document has an empty owner; signed-in edit shows the name again (merged from `improvementOwners`).
- Anonymous query of every public collection: no employee code, owner name or e-mail. `scrapLogPrivate` / `improvementOwners` refused.
- With sign-in **off** nothing changes (privacy split runs only in enforce mode) — the off-mode Dashboard/Executive Report regression is unchanged.

Tests: `tests/rules/privacy.test.js` (8), `tests/e2e/privacy.e2e.test.js` (5).

## 4. Existing production data (not touched)

Documents saved before go-live keep any `recordedBy` / owner they already have (public today). The rules leave existing values unchanged on edit; an improvement that still carries owners must be saved with owners removed (the page does this when sign-in is on). Removing the old values is a **production data change** → separate approval (**M-P1**), using the same sidecar collections. Not done.

## 5. Limits

- Old improvements with owners: a status-only update is refused until saved once through the page (which strips owners).
- An improvement can have at most 20 actions (rules check each position).
- Free text remains public by nature.
