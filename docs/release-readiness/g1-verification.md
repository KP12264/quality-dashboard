# G1 Verification Report — Production database and published rules (READ-ONLY)

**Result: G1 = UNVERIFIED.**

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
