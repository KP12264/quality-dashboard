# G1 Verification Report — Production database and published rules (READ-ONLY)

**Result (update 2, 2026-11-07):**
- **Published rules = tested snapshot: PASS.** The owner's rules file is byte-identical to the snapshot (SHA-256 `0967944b…2e2f`).
- **G1 overall: UNVERIFIED.** Still open: the database list (R2), the live PV2 config (R3) and the live QD config (R4). See the sections at the end.

This session has **no access to the real Firebase project or its Console**, so no item could be checked on Production. Everything below is evidence from the repository or from the owner's earlier upload, which by itself is **not** enough for PASS.

**Nothing was changed.** No rules published, no site deployed, no Firestore read or write on Production, no `qdUsers` change, no test data, no migration, no merge, Production V2 untouched. No credentials were requested or used.

Date of this check: 2026-11-07 · repository commit at check time: `065e002` (code `2a031c0`).

## Access this session had

| Access path | State | Note |
|---|---|---|
| Firebase Console / Rules API | **none** | not connected |
| `gcloud` | no credentialed account (`gcloud auth list`: "No credentialed accounts") | connecting a Production account / Service Account key is not allowed in this project |
| `firebase-tools` login | none (no user, no tokens) | — |
| Firebase MCP against Production | not used | not allowed in this project |
| Live public site (GitHub Pages) | **blocked**: the session's network policy refused `kp12264.github.io` (proxy 403) | a public read-only GET only; needs an allowlist change to try |
| Production V2 repository (`KP12264/daily-production-report`) | **not attached**: the request to attach it read-only was denied in this session | — |
| This repository incl. `origin/main` | yes (read-only `git fetch`) | — |

## Items

| # | Item | Evidence found (source) | Can it prove the item? | Status |
|---|---|---|---|---|
| 1a | Firebase **project ID** used by Quality Dashboard | `js/config.js` on the development branch **and** on `origin/main` (latest `b118f93`, 2026-10-30): `projectId: "daily-production-report-46b60"`, `authDomain: daily-production-report-46b60.firebaseapp.com` | Shows what the **code** is configured for. Not proof of what the live site runs: Pages source branch / build not checked; live site blocked | **UNVERIFIED** |
| 1b | Firestore **database ID** | `js/firebase-init.js` (dev + `main`): `firebase.firestore(app)` with no database id → the SDK uses `(default)`. Snapshot metadata: `"database": "UNCONFIRMED (expected \"(default)\")"` | Code intent only; whether other databases exist in the project is unknown | **UNVERIFIED** |
| 2 | **Published** rules now, and the last publish time | none from Production. Snapshot metadata: `"lastPublished": "UNCONFIRMED"` | No | **UNVERIFIED** |
| 3 | Published rules vs the tested snapshot (SHA-256) | snapshot `emulator/production.firestore.rules.snapshot`: sha256 `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f` (3,908 bytes, UTF-8, LF). Recomputed today: identical; equal to the hash the owner gave on 2026-11-03 | Proves the file is unchanged since the owner sent it. Does **not** prove it equals what is published **now** | **UNVERIFIED** |
| 4a | Project / database used by **Production V2** | indirect only: (i) the owner's Console copy of the rules (the snapshot) contains the Production V2 block (`prodV2_*` collections) in the same rules file as Quality Dashboard, which suggests one project and one database at copy time; (ii) by design QD uses the same Firebase Auth accounts as PV2 (`<code>@prodv2.local`). PV2 source / live site not inspected | Indirect, not current | **UNVERIFIED** |
| 4b | Project / database used by **Quality Dashboard** live | see 1a / 1b | as above | **UNVERIFIED** |
| 5 | **G1 overall** | — | — | **UNVERIFIED** |

The emulator tests in this repository assumed the snapshot is the published rules of `(default)` in `daily-production-report-46b60`. Until G1 passes, that assumption stays unconfirmed.

## Evidence the Firebase Owner still needs to provide (all read-only)

| # | Evidence | How (read-only) | Pass condition |
|---|---|---|---|
| E1 | Project ID | Console → Project settings → General: *Project ID* (screenshot) | `daily-production-report-46b60` |
| E2 | List of Firestore databases | Console → Firestore → database selector (screenshot), or `gcloud firestore databases list --project=daily-production-report-46b60` | which databases exist; `(default)` present |
| E3 | Which database Production V2 uses | PV2 owner: the Firebase config in the live PV2 site (`projectId`) and whether its code passes a database id (screenshot of the source or the file) | same project; `(default)` (or the named one, documented) |
| E4 | Which project / database the live Quality Dashboard uses | the live site's `js/config.js` and `js/firebase-init.js` (browser → View source), and the GitHub Pages source branch | same as E1 / `(default)` |
| E5 | **Published** rules text of the database from E3 / E4 | Console → Firestore → Rules → copy the text into a file, saved **UTF-8 with LF line endings**; or the Rules API (read-only): `GET https://firebaserules.googleapis.com/v1/projects/daily-production-report-46b60/releases/cloud.firestore` (gives `rulesetName`, `updateTime`), then `GET https://firebaserules.googleapis.com/v1/<rulesetName>` (gives the source) | — |
| E6 | **Last publish time** (and who) | Console → Rules → history (screenshot showing the top entry), or `updateTime` from E5 | the time is recorded |
| E7 | SHA-256 of the E5 file | `sha256sum rules.txt` (Linux / macOS: `shasum -a 256 rules.txt`; Windows PowerShell: `Get-FileHash rules.txt -Algorithm SHA256`), or send the file and the hash is computed here | **= `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f`** |
| E8 | No publish after E6 until cutover | re-check E6 right before cutover day step 1 | no newer entry |
| E9 | (only if E2 shows more than one database) rules of each, and which one each site uses | as E5 / E3 / E4 | documented |

If E7 differs only because of line endings (CRLF vs LF) or a trailing newline, the owner sends the file as copied. The difference is then checked here without changing the snapshot. Any other difference is **NO-GO** until the snapshot is replaced by the published text and the rules suites are re-run on it.

## What would let this session verify part of it (optional; each needs the owner's decision)

- **Upload E1–E7** (screenshots + the rules file) to this session: the hash and the text comparison can be done here, read-only.
- **Allow the public host `kp12264.github.io`** for this session's network: lets it read the live Quality Dashboard config (E4) with a public GET.
- **Allow attaching `KP12264/daily-production-report` read-only**: lets it read PV2's Firebase config (part of E3). The live PV2 site remains the stronger evidence.

None of these would give this session write access, and none is needed to make the G1 decision if the owner provides E1–E8 directly.

---

## Update 2026-11-07 — evidence from Firebase Console screenshots

Received from the owner: 2 Console screenshots (taken 2026-11-07, 09:07–09:08, browser local time) and a written summary.

**Not received:** the rules text as a file. **SHA-256 was therefore NOT compared**, and no hash match is claimed.

### Screenshot 1 — Firestore → Database `(default)` → Rules
- URL: `console.firebase.google.com/project/daily-production-report-46b60/firestore/databases/-default-/security/rules`.
- Version history: **Sep 29, 2026 · 9:47 PM** (top, starred, selected), Sep 10 2026 · 2:25 PM, Sep 2 2026 · 10:53 AM, Aug 15 2026 · 6:58 PM.
- Rules text lines 1–30 visible.

### Screenshot 2 — Firestore → Database `(default)` → Data
- Collections: `improvements`, `prodV2_actualLogs`, `prodV2_authorizedUsers`, `prodV2_dailyPlans`, `prodV2_doorMapping`, `prodV2_jigLayouts`, `prodV2_lines`, `prodV2_lossCategories`, `prodV2_lossDetailCauses`, `prodV2_lossLogs`, `prodV2_modelOrderPrefs`, `prodV2_models`, `prodV2_shiftMaster`, `productionLogs` (the list continues below the visible part).
- Footer: "Database location: asia-southeast1".
- Plan shown: **Spark (No-cost)**.

### 1. Confirmed from the Console

| Item | Evidence | Status |
|---|---|---|
| Project ID = `daily-production-report-46b60` | Console URL of both screenshots; project selector "daily-production-report" | **CONFIRMED** |
| The rules and data shown are the `(default)` database | URL `/databases/-default-/`; breadcrumb "Database (default)"; the Data panel's root "(default)" | **CONFIRMED** |
| Database location = `asia-southeast1` | footer of screenshot 2 | **CONFIRMED** |
| Latest rules version in the history = **Sep 29, 2026 · 9:47 PM** (browser local time) | screenshot 1, top entry starred and selected | **CONFIRMED** as the latest *shown*. It predates the snapshot upload (2026-11-03), so no newer publish was visible on 2026-11-07 |
| Production V2 and Quality Dashboard data in the **same** database | `prodV2_*` collections and the QD collection `improvements` (and the legacy `productionLogs`) in one `(default)` list | **CONFIRMED** (co-located). `scrapLogs` is not in the visible part of the list |
| Published rules, lines 1–30 = snapshot lines 1–30 | screenshot text compared line by line with `emulator/production.firestore.rules.snapshot` lines 1–30: identical (header comments, `service cloud.firestore`, the database match, start of the legacy block) | **CONFIRMED for lines 1–30 only** |

### 2. Not yet confirmed

| Item | Why | Status |
|---|---|---|
| Rules lines 31–85 (55 of 85 lines: the legacy, Production V2 and Quality Dashboard permission blocks) | not visible in the screenshot | **UNVERIFIED** |
| **SHA-256** of the published rules = `0967944b…2e2f` | no rules file received | **NOT COMPARED** |
| No other database in the project | only `(default)` is shown; the database list was not shown | **UNVERIFIED** |
| Who published the Sep 29 version | not shown (optional) | not required for G1 |
| Live **Production V2** site config | see §4 | **UNVERIFIED** |
| Live **Quality Dashboard** site config | the live site's `js/config.js` / Pages source branch not shown; the code on `main` uses `daily-production-report-46b60` and `(default)` (repository evidence only) | **UNVERIFIED** |

### 3. Rules vs snapshot

| Check | Result |
|---|---|
| Line-by-line, lines 1–30 (screenshot vs snapshot) | **identical** |
| Lines 31–85 | not compared (not visible) |
| SHA-256 | **not compared** (no source file) |
| Full diff | not possible without the file |

### 4. Production V2 live config: evidence still missing

The Console proves where PV2's **data** is (`prodV2_*` in `(default)` of `daily-production-report-46b60`). It does not show which project / database the **live PV2 web app** connects to. Still needed from the PV2 owner, read-only:
1. The Firebase config of the live PV2 site (`projectId`, `authDomain`), e.g. from the browser's *View source* of the live page or its config script (e.g. `firebase-v2.js`).
2. Whether the PV2 code passes a database id to Firestore (no id = `(default)`).
3. The live PV2 URL and its deploy source (branch / hosting).

### 5. G1 decision

**G1 = UNVERIFIED** (not FAIL, not PASS).
- Not FAIL: nothing contradicts the snapshot. Project, database, location, co-location and lines 1–30 match; the latest version (Sep 29) predates the snapshot upload.
- Not PASS: the full published text / SHA-256 and the live site configs are not yet evidenced.

### Remaining evidence needed (read-only)

| # | Evidence | Pass condition |
|---|---|---|
| R1 | The **published rules (Sep 29, 2026 · 9:47 PM version) as a file**: Console → Rules → select all → paste into a plain-text file saved UTF-8 with LF; upload the file (not pasted into the chat, which can change line endings) | SHA-256 = `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f`, or a full diff showing only line-ending / trailing-newline differences |
| R2 | Firestore **database list** (Console → Firestore → databases) | only `(default)`, or every other database documented |
| R3 | **PV2 live config** (§4, items 1–3) | `daily-production-report-46b60`, no database id (or `(default)`) |
| R4 | **QD live config**: the live site's `js/config.js` + `js/firebase-init.js` (View source) and the Pages source branch | same project, `(default)` |
| R5 | Right before cutover day step 1: the Rules history still shows Sep 29, 2026 · 9:47 PM on top | no newer version |

### Observations for other gates (not part of G1; no action taken)

- **C1 / C2:** the project is on the **Spark (no-cost) plan**. Spark has fixed daily Firestore quotas, and requests over a quota fail until it resets instead of being billed. The read estimates in `generated/read-cost.md` should be compared with the current Spark limits (check the Firebase pricing page) before the C1 decision.
- **G4 / M-P1:** a public `improvements` document visible in screenshot 2 has `actions[0].owner: "MT"`. Old public documents do contain owner values, which is in scope of the privacy migration (dry-run count still needed).

---

## Update 2, 2026-11-07: published rules file received

Received: `production-firestore-rules.txt`, uploaded by the owner as the current published Firestore rules of `(default)`. It is stored only in this session's upload folder; it was not added to the repository. Compared read-only with `emulator/production.firestore.rules.snapshot`:

| Check | Owner's file | Snapshot | Result |
|---|---|---|---|
| SHA-256 | `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f` | `0967944bcf8bbe6f2051004424bd5819fd656018165b1aaca9982f13e3a22e2f` | **identical** |
| Size / lines | 3,908 bytes · 85 lines | 3,908 bytes · 85 lines | identical |
| Encoding | UTF-8, LF, no CR, no BOM, ends with `}` + LF | same | identical |
| `cmp` (byte by byte) | — | — | **no difference** |
| `diff` (text), and normalised diff (CRLF / trailing spaces / trailing newlines) | — | — | **no difference** |
| Lines 1–30 vs the Console screenshot | — | — | identical (update 1) |

The comparison was mechanical: `sha256sum`, `cmp`, `diff`.

What the rules contain (the version that is published), all as tested in the emulator:
- the **legacy** `productionLogs` collection: public read / write;
- **Production V2**: `prodV2_*` publicly readable; writes need sign-in plus a document in `prodV2_authorizedUsers`; `prodV2_authorizedUsers` itself is never writable from an app;
- **Quality Dashboard**: `scrapLogs`, `targetMaster`, `improvements`, `scrapModelMappings` public read / write;
- **everything else** denied, which includes `qdUsers`, `scrapSlots`, `scrapCloseSummary`, `scrapWeeklyPlans` and the private sidecars.

### Status per G1 item

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | Project ID `daily-production-report-46b60` | Console screenshots | **PASS** |
| 1 | Database `(default)`, location `asia-southeast1` | Console screenshots | **PASS** for `(default)` |
| 1 | No other database in the project | not shown | **UNVERIFIED** (R2) |
| 2 | Published rules = tested snapshot | owner's file: byte-identical, SHA-256 equal | **PASS** |
| 3 | SHA-256 and rules diff | equal; no diff | **PASS** |
| 4 | Last publish time | Console history: **Sep 29, 2026 · 9:47 PM** (browser local time), before the snapshot was received (2026-11-03); nothing newer on 2026-11-07 | **PASS** as of 2026-11-07. Re-check right before cutover day (R5) |
| 5 | Production V2 consistency: **rules** | the published rules carry the PV2 block. `pv2-compat.test.js` (4/4) shows PV2 and legacy permissions identical in production (= this file), candidate, bridge and the PV2 repository rules | **PASS** |
| 5 | Production V2 consistency: **data location** | `prodV2_*` and the QD collections in the same `(default)` database | **PASS** |
| 5 | Production V2 consistency: **live web config** | not provided (project / database the live PV2 app connects to) | **UNVERIFIED** (R3) |
| — | Quality Dashboard live web config | not provided | **UNVERIFIED** (R4) |
| 6 | **G1 overall** | — | **UNVERIFIED** (R2, R3, R4 open) |

Provenance note: the file is the owner's copy. This session confirms that it is identical to the snapshot and that its first 30 lines match the Console screenshot of the Sep 29 version. It cannot independently prove that the file was copied from that published version: that is the owner's statement.

### Still needed for G1 = PASS (read-only)

| # | Evidence | Pass condition |
|---|---|---|
| R2 | Firestore database list (Console → Firestore → databases) | only `(default)`, or every other database documented with what uses it |
| R3 | Live **PV2** web app: Firebase config (`projectId`, `authDomain`); whether its code passes a database id; the live URL / deploy source | `daily-production-report-46b60`, no database id (= `(default)`) |
| R4 | Live **Quality Dashboard**: the live site's `js/config.js` + `js/firebase-init.js` (View source) and the GitHub Pages source branch | same project, `(default)` |
| R5 | Right before cutover day step 1: the Rules history still has Sep 29, 2026 · 9:47 PM on top (or the SHA-256 of a fresh copy is still `0967944b…`) | unchanged |
