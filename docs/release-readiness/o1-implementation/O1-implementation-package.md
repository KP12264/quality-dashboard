# O1 implementation package: PV2 Assembly date query (PROPOSAL, NOT APPLIED)

**Status.**
- Nothing in the PV2 repository has been changed, committed, pushed, merged or deployed.
- No QD code, Firebase Rules, indexes, API keys or Billing touched.
- The O1 code change is **NOT APPROVED**.
- **A1 = HIGH. G2 = NOT APPROVED.**

**Basis.**
- Emulator evidence (QD commit `1cacb24`): 13/13 pass, pv2-compat 7/7 pass, output identical in 363/363 cases, reads 270,435 → 2,202.
- Owner index check (Update 13, `c013f6d`): automatic indexes enabled, no exemptions.
- Readiness checklist: P0 plan, Revision 4.

Base: `KP12264/daily-production-report` `main` at `431836a`. If `main` has moved, re-check both patches (step B3).

## 1. Proposed diff: `production-v2/js/assembly.js` (file `o1-assembly-js.patch`)

```diff
--- a/production-v2/js/assembly.js
+++ b/production-v2/js/assembly.js
@@ -97,7 +97,7 @@
  if(!date)return note("เลือกวันที่ก่อน","plan-warn");
  stat("Loading…");note("กำลังโหลด…");
  try{
-  const logs=await all("prodV2_actualLogs");
+  const logs=(await ProdV2DB.collection("prodV2_actualLogs").where("date","==",date).get()).docs.map(d=>({id:d.id,...d.data()}));
   const matched=logs.filter(x=>x.date===date&&(!shift||x.shift===shift));
   const totals={}; // "Model|||Door" -> qty
   matched.forEach(doc=>{
```

- The result is byte-identical to the tested **After** file: sha256 `b6f28397a7999eda3ed41147e481a6679e097a098dd8ac99095009c23d806c6b`.
- The browser filter on the next line is kept on purpose. It guarantees the same date / shift matching as today.
- `all()` stays in the file, unused, so the diff stays one line. Removing it is optional and outside the tested change.
- Both patches apply cleanly to `431836a` (`patch --dry-run` on a throw-away export).
- The same `ProdV2DB.collection(...).where(...).get()` pattern is already used 9 times in PV2 with SDK 9.23.0 (e.g. `js/dashboard.js:733`).

## 2. Proposed diff: `production-v2/assembly.html` (file `o1-assembly-html.patch`)

```diff
--- a/production-v2/assembly.html
+++ b/production-v2/assembly.html
@@ -19,5 +19,5 @@
 </main>
 </div>
 <script src="js/firebase-v2.js?v=20260902-fix2"></script>…(unchanged)
-<script src="js/assembly.js?v=20260902-fix5"></script>
+<script src="js/assembly.js?v=20261110-o1"></script>
 </body></html>
```

- This is cache-busting only.
- The value `20261110-o1` is a proposal. The owner may use the real release date (e.g. `YYYYMMDD-o1`); any new value works.
- No other HTML change. `assembly.js` is loaded only by this page.

| Patch | sha256 |
|---|---|
| `o1-assembly-js.patch` | `c08b5ce8ce647390f7351be171af3dce180e32d6e954ff105361117dc7c77d9d` |
| `o1-assembly-html.patch` | `69567517682a7d13adb2de2ee515329db84acaeac4bd72734855509031e652ae` |

## 3. Feature branch plan (for the PV2 owner; not done)

| Step | Action | Who / approval |
|---|---|---|
| B1 | Approve the O1 code change | approvers + PV2 owner |
| B2 | `git fetch origin main`, then `git switch -c o1-assembly-date-query origin/main` | PV2 owner or whoever they authorise |
| B3 | If `origin/main` ≠ `431836a`: check that `assembly.js` line 100 and `assembly.html` line 22 are unchanged; otherwise stop and re-test | same |
| B4 | `git apply --check` both patches, then `git apply` them | same |
| B5 | Verify `git diff --stat`: exactly 2 files, 1 line each; sha256 of `production-v2/js/assembly.js` = `b6f28397…6c6b` | same |
| B6 | Run the browser test (section 4) against this branch | approved test run |
| B7 | Commit on the feature branch only: "O1: Assembly reads only the selected date" | PV2 owner |
| B8 | Push the branch and open a pull request into `main`, with the evidence links | PV2 owner |
| B9 | Review and merge, by the PV2 owner's process | PV2 owner |
| B10 | Release (section 5). **Unknown:** this repository shows no hosting config (no `firebase.json`, `CNAME` or workflows), so the PV2 owner must say how `main` reaches the live site | PV2 owner |

## 4. Browser test plan: SDK 9.23.0, real page (needs approval to run)

**Goal.** Confirm the patched page works with the browser SDK actually used in PV2 (compat 9.23.0) and renders the same as before. Production is never used.

### Set-up

- Local Firestore emulator only, project `demo-quality-dashboard`, the same synthetic seed as the O1 evidence (745 documents, E1–E19).
- Two local copies of `production-v2/`: **Before** (`431836a`) and **After** (with both patches applied). They are served from `127.0.0.1` with a static file server.
- Playwright with the preinstalled Chromium, deviceScaleFactor 1.
- **Network lock:**
  - every request that does not go to `127.0.0.1` / `localhost` is **aborted**;
  - the 2 gstatic SDK URLs (`firebase-app-compat.js`, `firebase-firestore-compat.js` 9.23.0) are answered from local copies of the same files (npm `firebase@9.23.0`, CDN builds; sha256 recorded);
  - if those exact builds cannot be obtained, stop and report. Do not substitute another version.
- **Production guard:** `js/firebase-v2.js` holds the real project config. In the test it is answered by a **test copy** that keeps the same `ProdV2DB` API but:
  - initialises `demo-quality-dashboard` and calls `useEmulator('127.0.0.1', 8080)`;
  - contains no API key.

  The test fails at once if any request leaves localhost.

### Scenarios (Before and After, same steps)

1. Open `assembly.html`, the page-open load for today.
2. Date change to every edge date (2026-10-05, 2026-10-06, a date without data) × shift All / Day / Night.
3. Load button.
4. Model filter: every group.
5. Empty date.
6. Read failure: stop the emulator, then Load.
7. Hard reload: the network log shows `js/assembly.js?v=20261110-o1` on After.

### Compare

- `#asmResults` innerHTML, `#asmMessage` text (matched count), `#asmStatus`, and `window.currentAsmTotals`: must be identical.
- Screenshots of each scenario, compared pixel by pixel.
- Browser console errors: none new in After.
- Reads: count the Firestore requests through the emulator. The emulator's rules-evaluation endpoint or a counting proxy is acceptable; record the method.

### Pass

- 100 % identical values and HTML, and screenshots identical.
- No request outside localhost.
- No new console errors.
- The SDK 9.23.0 files are verified by hash.
- After reads ≤ documents of the date + 1 per load.

## 5. After deploy: checks and rollback

### Before the release (baseline, owner)

- Pick 2 past dates whose data will not change, e.g. last week, plus All / Day / Night.
- Open Assembly with the **old** version and record the totals per cabinet group and the "รวม N Actual Log" text. Screenshots, no personal data.
- This costs one whole-collection read per load. Keep it to the minimum: 2 dates × 3 shifts = 6 loads.

### After the release (owner)

| # | Check | Pass |
|---|---|---|
| P1 | Hard reload Assembly; DevTools → Network shows `assembly.js?v=20261110-o1` | new file loaded |
| P2 | Same 2 dates × 3 shifts as the baseline | totals and "รวม N" identical to the baseline |
| P3 | Today, All shifts | page loads, no "Load failed" |
| P4 | Browser console | no `FAILED_PRECONDITION` / index or permission error |
| P5 | Other PV2 pages (Dashboard, Entry, Plan, Loss, Exec, Order, Cabinet Coverage, Master): open once | unchanged behaviour (they share no file with the change) |
| P6 | Optional, read-only: Cloud Monitoring `document/read_count` for the hour of use, compared with similar hours | lower, but **attribution is limited**: the API key is shared by QD, PV2 and the legacy app, and usage varies |

### Rollback triggers

Any difference in P2, any error in P3 / P4, or any report of missing Assembly figures.

### Rollback steps (owner)

1. `git revert <O1 commit>` on `main`. This restores line 100 and the old `?v=`.
2. Then **bump `?v=` again** (e.g. `20261110-o1-rb`), so browsers drop the cached O1 file. Reverting to the old value could leave browsers on the cached new file.
3. Release by the same path, then repeat P1–P3.

There are no data, schema, rules or index changes, so a rollback restores the previous state completely.

## 6. Steps that need the PV2 owner's approval

1. Agreement to the O1 change in the PV2 repository (code owner).
2. Who makes the change: the owner, or someone the owner authorises.
3. Creating the feature branch `o1-assembly-date-query` and applying the 2 patches (B2–B5).
4. Running the browser test (section 4). This also needs separate approval from the QD side; only the emulator and synthetic data are used.
5. Commit, push, pull request and review on the PV2 repository (B7–B9).
6. Merge into `main`.
7. Release / deploy of PV2, and naming the release path (B10).
8. The baseline before release and the checks P1–P6 after release (owner, view only, minimal reads).
9. A rollback decision rule: who may revert, and how fast.

Also needed from the QD side:
- the O1 code-change approval (N1);
- separate approval to commit this package into the QD repository (not done).
