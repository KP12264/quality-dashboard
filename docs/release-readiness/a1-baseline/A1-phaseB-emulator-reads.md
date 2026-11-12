# A1 Phase B: reads per page and per action in the Firebase Emulator (QD, PV2, legacy app), 2026-11-12

**Status.** A1 = HIGH. Billed reads = UNVERIFIED. G2 = NOT APPROVED. O1 = NOT APPROVED. Production = NO-GO. **Root cause: NOT established.**

## Emulator estimates are not billed reads

| | Emulator estimate (`est`, this report) | Billed reads (production) |
|---|---|---|
| Source | A counter in the test browser, on synthetic data in the local emulator | Firebase billing / quota for project `daily-production-report-46b60` |
| What it counts | Documents delivered to the app code, priced by the documented rule (query: max(1, documents); document get: 1; listener: first snapshot, then changes) | What Firestore actually bills, including cases the counter cannot see (for example listener resumes after 30 minutes offline, retries, reads by the Console and other tools) |
| Data size | Synthetic: 30 / 90 days, 3 lines | Real, **unknown** |
| Status | Measured in the test only | **UNVERIFIED** |

The figures below show the **shape** of each page's reads and how they grow. They are **not** production read counts and must not be added up as a daily total.

## Method and limits

- **Environment.**
  - Local Firestore emulator only (project `demo-quality-dashboard`) with synthetic data.
  - No production code, rules or data were changed. Nothing was deployed or merged. RC `357806d` is unchanged.
- **Pages tested.**
  - QD: served from the development branch with `?qdEmulator=1&qdAuthMode=off`.
  - PV2 (`431836a`) and the legacy root app: local test copies, where only the Firebase configuration was replaced (emulator, demo project). PV2 writes were disabled.
  - A guard confirmed that no served file contains the production key or project id.
  - Requests to Firebase backends were blocked and recorded; none occurred.
- **How reads were counted.** A counter appended to the locally served Firebase SDK recorded every query `get()` (LIST), document `get()` (GET) and `onSnapshot` (LISTEN), with the documents delivered.
  - **`est`** = estimated reads by the documented billing rule:
    - query: max(1, documents);
    - document get: 1;
    - listener: the first snapshot, then changed documents.
  - **The emulator does not measure billable reads.** `est` is an estimate, **not** a billed or actual production figure.
  - Rules evaluations (Monitoring's LIST / GET) were not measured.
- **Seed.**
  - **QD:** the synthetic month from `tests/support/release-seed.js` (October 2026).
  - **PV2:** 3 lines × 2 shifts × **30 days** (one plan and one actual document per line, shift and day; 0–2 loss logs), 12 orders. Assembly was also run with **90 days** for scaling.
  - Production collection sizes are **unknown**. Figures that depend on data size are given with their scaling rule.
- **Not tested.**
  - Signed-in-only PV2 pages (Master, Cabinet).
  - PV2 Entry / Plan / Loss beyond the initial load: they need a selection before they read data.
- **Accuracy check.** The PV2 counts equal what the code computes. For example, Trend 30 = 30 days × 3 lines × 2 shifts × 2 documents = 360 GET.

## 1. Reads per page and per action

### Quality Dashboard (QD)

| Page | Action | LIST | GET | Docs | est | Repeated in action |
|---|---|---|---|---|---|---|
| Dashboard | initial load (default range) | 4 | 6 | 87 | 90 | 0 |
| Dashboard | Refresh | 4 | 6 | 87 | 90 | 0 |
| Dashboard | Refresh again (immediately) | 4 | 6 | 87 | 90 | 0 |
| Dashboard | date: 1 day | 4 | 6 | 143 | 144 | 0 |
| Dashboard | date: 7 days | 3 | 42 | 174 | 175 | 0 |
| Dashboard | date: 31 days (month) | 2 | 186 | 312 | 319 | 0 |
| Dashboard | date: back to 7 days | 2 | 42 | 58 | 59 | 0 |
| Dashboard | Line = A / Shift = Day / back to all | 0 | 0 | 0 | 0 | 0 |
| Dashboard | idle 75 s | 0 | 0 | 0 | 0 | 0 |
| Dashboard | 3 tabs opened together (total) | 12 | 18 | 261 | 270 | — |
| Scrap Detail | initial load | 2 | 0 | 81 | 82 | 0 |
| Executive Report | initial load | 2 | 6 | 6 | 8 | 0 |
| Weekly Plan | initial load | 2 | 0 | 134 | 134 | 0 |
| Improvement | initial load | 1 | 0 | 0 | 1 | 0 |
| Plan Tracking | initial load | 2 | 0 | 23 | 24 | 0 |
| Weekly Review | initial load | 2 | 0 | 23 | 24 | 0 |
| Daily Confirmation | initial load | 0 | 0 | 0 | 0 | 0 |
| Dashboard Classic | initial load | 4 | 6 | 87 | 90 | 0 |

- **Scaling.**
  - The QD lists read `scrapLogs` for the selected period: the number of documents grows with the scrap entries in that period.
  - The month range reads 6 `prodV2_actualLogs` documents per day (GET).

### Production V2 (PV2)

| Page | Action | LIST | GET | Docs | est (30-day seed) | Repeated in action | Scales with |
|---|---|---|---|---|---|---|---|
| Dashboard | initial load (Day mode) | 2 | 8 | 12 | 12 | 2 | lines |
| Dashboard | Refresh / date / Line / Shift (each) | 1 | 8 | 8–9 | 9 | 2 | lines |
| Dashboard | Week | 7 | 56 | 36 | 63 | 14 | days × lines |
| Dashboard | Custom Range 31 days | 31 | 248 | 274 | 279 | 62 | days × lines |
| Dashboard | Refresh (31-day range) | 31 | 248 | 274 | 279 | 62 | days × lines |
| Dashboard | 3 tabs opened together (total) | 6 | 24 | 36 | 36 | — | tabs |
| Exec | initial load (today + Trend 7) | 7 | 96 | 105 | 107 | 12 | days × lines × shifts |
| Exec | **Trend 30** | 0 | **360** | 360 | **360** | 0 | days × lines × shifts |
| Exec | Load (today) again | 6 | 12 | 18 | 20 | 0 | lines × shifts |
| **Assembly** | **initial load** | **1** | 0 | **252** | **252** | 0 | **whole `prodV2_actualLogs` collection** (90-day seed: **540**) |
| **Assembly** | **3 tabs opened together (total)** | 3 | 0 | 756 | **756** | — | collection × tabs (90-day seed: **1,620**) |
| Order Tracking | initial load | 1 | 0 | 3 | 3 | 0 | — |
| Order Tracking | Load Orders (each click) | 1 | 108 | 120 | 120 | 0 | orders × days running × 2 shifts |
| Entry / Plan | initial load | 1 | 0 | 3 | 3 | 0 | — |
| Entry | idle 75 s | 0 | 0 | 0 | 0 | 0 | — |
| Loss | initial load | 3 | 0 | 12 | 12 | 0 | — |

### Legacy root app (`/daily-production-report/`)

| Action | GET | LISTEN | Docs | est |
|---|---|---|---|---|
| initial load | 4 | 1 listener opened | 1 | 5 |
| switch line (old listener closed, new one opened) | 4 | 1 (live listeners stay 1) | 1 | 5 |
| another user saves the open document | 0 | 1 update | 1 | 1 |
| idle 60 s | 0 | 0 | 0 | 0 |

## 2. Repeated-read and high-read risk points

1. **PV2 Assembly reads the whole `prodV2_actualLogs` collection on every open.**
   - 1 query returns every document. Reads grow with the length of history and never stop growing.
   - Each extra tab or reopen repeats it: 30-day seed 252 per open, 90-day seed 540, 3 tabs = 3×.
   - It is the only action in either app with this pattern; it is what O1 addresses.
2. **Fan-out of document gets.** Many small GETs, with about 1 read each:
   - PV2 Exec **Trend 30**: 360 per click.
   - PV2 Dashboard 31-day range: 279 per load **and per Refresh**.
   - PV2 Order Tracking: 120 per **Load Orders** click.
   - QD month range: 186 GET.
   - These grow with lines × shifts × days, not with history.
3. **Re-reads inside one action.**
   - PV2 Dashboard reads the selected line's plan / actual again for "other lines" and the 7-day trend: 2 repeats in Day mode, 14 in Week mode, **62 of 279 (22 %)** in a 31-day range.
   - PV2 Exec reads today's 12 documents again for the trend.
4. **No reuse between actions.**
   - Refresh re-reads everything: QD 90 at the default range; PV2 279 at a 31-day range.
   - Order Tracking re-reads all 120 on every click.
   - Going back to an earlier range re-reads (QD 59).
   - QD Line / Shift filters re-use loaded data (0 reads).
5. **Multiple tabs** multiply reads linearly. There is no shared cache and no offline persistence.
6. **Not a risk in this test:**
   - idle tabs (0 reads for QD Dashboard 75 s, PV2 Entry 75 s, legacy app 60 s): the 30-second timers in QD and PV2 read nothing;
   - QD Line / Shift filters.

## 3. Evidence for the hypotheses of the 7 Nov burst (see `A1-spike-detail-2026-11-07.md`)

- **Listeners (supports a fact, narrows H2).**
  - QD and PV2 open **no** snapshot listeners (code and test).
  - The up-to-3 listeners Monitoring reported on 7 Nov therefore came from other clients: the legacy app (1 listener per open tab, test) or the Console's real-time Data viewer.
  - Which of the two is **not** established.
- **H1 / H3, made more specific (support, not proof).**
  - On 7 Nov, reads were type QUERY and tracked rules LIST evaluations (r = 0.91, ≈ 29 reads per LIST in the 11:00 hour).
  - In the test, the actions whose reads come from a **few large query results** are PV2 Assembly (whole collection) and QD's `scrapLogs` lists (Dashboard, Scrap Detail, Weekly Plan: 40–130 documents per query).
  - The GET fan-out actions (PV2 Trend 30, PV2 range Dashboard, Order Tracking) produce about 1 read per request and would show mainly as GET evaluations.
  - This makes LIST-heavy pages, PV2 Assembly first, the better candidates.
  - **Not proven**, because:
    1. the real collection sizes are unknown;
    2. how Monitoring classifies SDK document gets (rules GET vs LIST, read type QUERY vs LOOKUP) was not verified;
    3. the 11:00 hour had 731 LIST evaluations, so many queries took part, not only one page.
- **H4 (sessions before 11:26).** Not tested in the emulator.
- **Idle tabs** do not explain a burst: no idle reads were found in any app.

## 4. Limits and unconfirmed hypotheses

**Limits of this test.**
- Synthetic data. Production collection sizes, numbers of lines and orders, and usage patterns are not known.
- The emulator does not bill reads or report Monitoring metrics: no rules evaluations, no read type (QUERY / LOOKUP).
- Signed-out sessions only (QD `qdAuthMode=off`, as currently in production); PV2 sign-in-only pages were not tested.
- One browser engine (Chromium), no network loss, no long offline periods (listener resumes are not covered).
- PV2 and the legacy app were tested from their repository at `431836a`. The deployed copies were not compared.

**Not confirmed.**
- H1 / H3 (rules-evaluated, LIST-heavy client queries made most of the 7 Nov 11:00-hour reads; PV2 Assembly a leading candidate). Supported in shape only.
- How Monitoring classifies SDK document gets (rules GET vs LIST; read type).
- Whether the legacy app or the Console made the listeners seen on 7 Nov.
- Any link between a specific person, page or device and the burst.

## 5. Possible fixes (NOT implemented; each needs separate approval)

The PV2 items (F1–F4) are changes to **Production V2**. They belong to **O1** (or later O-items), which is **NOT APPROVED**. F1 is the O1 change already prepared and tested in the emulator.

| # | Fix | App | Expected effect (emulator scale) | Approval track |
|---|---|---|---|---|
| F1 | Assembly: read `prodV2_actualLogs` for the needed date range only | PV2 | 252 / 540 → about the selected days' documents; stops growing with history | **O1 — NOT APPROVED** |
| F2 | Dashboard: re-use the selected line's documents in "other lines" and the 7-day trend | PV2 | −2 per Day load, −62 per 31-day load | O-item, PV2 owner — not approved |
| F3 | Exec: re-use today's documents in the trend; keep per-day results for the session (Trend 7 → 30 reads only the 23 new days) | PV2 | −12 per open; Trend 30 360 → 276 after Trend 7 | O-item, PV2 owner — not approved |
| F4 | Order Tracking: keep the loaded actuals for the session; read only new keys on the next click | PV2 | 2nd click 120 → 12 | O-item, PV2 owner — not approved |
| F5 | Refresh: re-use data younger than a short age before re-reading everything | QD / PV2 | depends on use | QD change: separate approval; PV2 part: O-item |
| F6 | Operational (no code): avoid several Assembly tabs and the Console Data viewer during work | Owner | — | owner decision |

The priority of F1–F6 is set in a later update, after the real collection sizes are known.

## 6. Still needed to confirm the root cause

1. **Real collection sizes** of `prodV2_actualLogs` and `scrapLogs`: aggregate count only, run by the owner (this session has no production credentials). Assembly reads per open equal the size of `prodV2_actualLogs`.
2. **Who opened which page on 7 Nov 10:50–12:00 ICT**, especially PV2 Assembly, Exec Trend 30, Order Tracking, the Dashboard range, and QD Weekly Plan / Scrap Detail. Also the number of tabs and devices.
3. **Chrome history** for that window (times and paths only): QD, PV2, the legacy app, the Console.
4. **Emulator check, optional:** how SDK document and query gets appear as rules GET / LIST evaluations (the emulator rules-coverage report).
