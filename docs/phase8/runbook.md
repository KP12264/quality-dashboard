# Production Runbook — Quality Dashboard sign-in + Shift Close

> Do not execute without the approvals in README.md. Each step: who · what · check · stop/rollback.
> Supersedes docs/phase7/README.md §1 (adds step 0b, the ops-tab steps and monitoring).

## Roles
Release owner (GO/NO-GO) · Firebase owner (backup, rules publish) · PV2 owner (PV2 smoke) · QD admin (Operations tab).

## Day −7 … −1
| # | Step | Check |
|---|---|---|
| 0a | All suites green on the release commit; `node tools/rules/build-bridge.js --check` | CI/terminal output attached to the change |
| 0b | **Pre-cutover release**: deploy the site with `QD_AUTH_MODE = "off"` (behaviour unchanged) so open tabs get the reload message later | Dashboard regression unchanged; one save works |
| 0c | Send the user notification (cutover.md §3) | — |

## Day 0 (quiet period, outside shift change)
| # | Step | Check | Stop / rollback |
|---|---|---|---|
| 1 | **Backup**: `gcloud firestore export gs://<bucket>/qd-golive-<date>`; copy Console rules text; SHA-256 = `0967944b…2e2f` | export done; hash equal | hash differs → NO-GO |
| 2 | Create first Admin + roles in `qdUsers` (Console) | admin can sign in on the emulator-tested build | — |
| 3 | **Publish bridge** | PV2 smoke (open dashboard, save one entry); QD old site saves | any PV2 failure → re-publish snapshot (R2) |
| 4 | Deploy site `QD_AUTH_MODE = "enforce"` (with retired-page guard) | sign in as Admin/Leader; save one record; Daily Confirmation opens | site problem → redeploy `off` build (bridge still allows it) |
| 5 | Operations → **bridge audit** now and after one production day | no new problem slots between the two | problems keep appearing → find the client; stay on bridge |

## Day +1 (or when the exit condition holds)
| # | Step | Check | Stop / rollback |
|---|---|---|---|
| 6 | **Publish candidate** | PV2 smoke; QD save as Leader; an old (sign-in off) tab shows the reload message | PV2 failure → R2; QD-only problem → R-bridge |
| 7 | Set `QD_OPS_WRITE_ENABLED = true` (temporary release) → Operations: **post-candidate audit** (since = publish time) → **reconcile** listed slots → leaders reconfirm CHANGED shifts | post-candidate audit = 0 | — |
| 8 | Operations: **baseline dry run → apply → gate** | gate "complete"; Dashboard totals unchanged vs. day-0 export numbers | gate refuses → fix listed slots, re-run; never force |
| 9 | Set `QD_OPS_WRITE_ENABLED = false` again (release) | lock shows LOCKED | — |
| 10 | Smoke QD: Leader own slot ✓ / other slot ✗ / Viewer ✗; close + reconfirm; Executive Report CSV; public Dashboard shows no names | all pass | R-bridge or R1+R2 |

## Later (separate approval B1)
| 11 | Set `QD_CLOSE_REQUIRED_FROM` to the approved (future) date | days before keep the old rules; Dashboard shows "x/6 confirmed" | set back to `null` (R4) |

## Monitoring (first 2 weeks)
| What | How | Alert when |
|---|---|---|
| Writes around the ledger | Operations → post-candidate audit (daily) | > 0 |
| CONFLICT slots | Operations → audit; Daily Confirmation | any new CONFLICT |
| Pending closes | Daily Confirmation matrix each morning | shifts older than 1 day still Pending |
| Failed saves reported by users | leader feedback / browser console screenshot | any permission error for a correct Leader slot |
| Firestore usage & cost | Firebase Console → Usage | reads/day well above the estimate in README |
| PV2 | PV2 owner's normal checks | any write failure |

## Rollback summary
| Code | When | Action |
|---|---|---|
| R2 | PV2 or QD broken after a publish | re-publish the snapshot text (hash-checked) |
| R-bridge | candidate blocks something needed | re-publish bridge; then post-candidate audit + reconcile before moving forward |
| R1 | site problem | deploy `off` build — only together with R2 or R-bridge |
| R4 | target status wrong after B1 | `QD_CLOSE_REQUIRED_FROM = null` |
| R3 | data damage | restore from the day-0 export (approval) |
