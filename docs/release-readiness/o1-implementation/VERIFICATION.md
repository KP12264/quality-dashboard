# O1 implementation package: pre-commit verification (2026-11-11)

**Status.** This folder holds the package (proposal) and two patches. **Nothing has been applied to PV2.** The O1 code change is **NOT APPROVED**. No QD code, Firebase Rules, indexes, API keys or Billing were changed. **A1 = HIGH. G2 = NOT APPROVED.**

| # | Check | Result |
|---|---|---|
| 1 | Secret scan of all package files: API key, OAuth token, private key, GitHub / AWS / Slack / `sk-` tokens, Bearer, password / secret fields, e-mail addresses, absolute local paths | **0 findings** |
| 2a | Files named in the patches | only `production-v2/js/assembly.js` and `production-v2/assembly.html` |
| 2b | Lines changed | 4 (1 removed and 1 added in each file) |
| 2c | Applied to a throw-away export of PV2 `431836a` | exactly those 2 files differ from `431836a`; all other `production-v2/` files are byte-identical |
| 2d | Patched `production-v2/js/assembly.js` | sha256 `b6f28397a7999eda3ed41147e481a6679e097a098dd8ac99095009c23d806c6b`, identical to the tested **After** of the O1 emulator evidence |
| 3a | PV2 clone | `git status` clean at `431836a`; the hash list of the 34 `production-v2/` files equals `evidence/o1-assembly-20261110/out/pv2-hashes-before.txt` |
| 3b | QD repository | the only change is this new folder; no code file touched |

## SHA-256

The package files and the related test files are listed in [`MANIFEST.sha256`](MANIFEST.sha256). Verify from this folder with `sha256sum -c MANIFEST.sha256`.

| Item | sha256 |
|---|---|
| PV2 `production-v2/js/assembly.js` @ `431836a` (Before) | `4483548586a2dbf0892bb5b2721f8f6305ab271206d2cef29254d0a52f644b4d` |
| Same file after `o1-assembly-js.patch` (= tested After) | `b6f28397a7999eda3ed41147e481a6679e097a098dd8ac99095009c23d806c6b` |
| `o1-assembly-js.patch` | `c08b5ce8ce647390f7351be171af3dce180e32d6e954ff105361117dc7c77d9d` |
| `o1-assembly-html.patch` | `69567517682a7d13adb2de2ee515329db84acaeac4bd72734855509031e652ae` |

Related evidence: [`../evidence/o1-assembly-20261110/`](../evidence/o1-assembly-20261110/README.md) (commit `1cacb24`); A1/A2 report, Update 13 (`c013f6d`).
