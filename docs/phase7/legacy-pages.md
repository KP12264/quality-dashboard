# Legacy Page Inventory & Handling

Full generated table: [generated/legacy-page-inventory.md](generated/legacy-page-inventory.md) (`tests/unit/page-inventory.test.js`).

| Page | What it is | Linked from V5? | Writes without sign-in? | Phase 7 handling |
|---|---|---|---|---|
| `dashboard.html` | old copy of Scrap Entry | no | yes (form, Excel import, mappings) | **retired** → redirects to `scrap-entry.html` |
| `dashboard-classic.html` | old dashboard | no | yes (scrap, improvements, targets via adapters) | **retired** → `index.html` |
| `js/scrap-entry.html` | old copy inside `js/`; its relative paths were already broken (never loaded Firebase) | no | — | **retired** → `../scrap-entry.html` |
| `plan-tracking.html`, `weekly-review.html` | current pages with sign-in | only from `dashboard-classic.html` | no | kept — **P7-2**: add to V5 navigation or retire |
| all other pages | V5 pages | yes | no — every writing page loads sign-in (test-enforced); scrap only through the ledger | — |

## The retire guard (`js/retired-page.js`)

Loaded as the first script of a retired copy:
1. sets `window.QD_RETIRED_PAGE` → `js/firebase-init.js` does not connect at all (no reads, no writes);
2. shows "This page has moved" (Thai + English) and redirects to the current page, keeping the query string.

Nothing is deleted; reverting = removing one `<script>` line. Tested: no request to Firestore from the retired page, notice shown, redirect target reached, no scrap written.

## Pages left open in a browser (cannot be changed remotely)

A tab opened before the switch keeps its old code until reloaded. Tested in the rehearsal:
- bridge period: it still saves (detected as CONFLICT where a ledger slot exists);
- after the candidate: its saves are refused with "⚠ Save failed. Your entries have been kept" — nothing is silently lost.
GitHub Pages may serve cached HTML for ~10 minutes (NOT VERIFIED for this site), hence the reload announcement and the bridge exit condition.
