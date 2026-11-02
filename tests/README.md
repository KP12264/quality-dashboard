# Quality Dashboard tests

Nothing here touches the real Firebase project (`daily-production-report-46b60`).
Rules and browser tests run against the Firebase Emulator with the project
`demo-quality-dashboard`, which exists only inside the emulator. The regression test
uses an in-page mock of Firestore and opens the pages straight from disk.

```bash
cd tests
npm install            # firebase-tools, @firebase/rules-unit-testing, firebase (compat 10.13.0 for the browser), chart.js
npm run test:unit      # permission matrix (js/qd-auth.js)
npm run test:rules     # Firestore Security Rules, emulator/firestore.rules (starts the emulator)
npm run test:e2e       # pages in Chromium against the Auth + Firestore emulators (?qdEmulator=1)
npm run test:regression            # Dashboard V5 vs an independent oracle, sign-in off (≈10 min)
QD_REGRESSION_QUICK=1 npm run test:regression   # subset (≈2 min)
```

Needs Node 20+, Java 11+ (for the emulator) and Playwright's Chromium.

## Trying sign-in by hand

```bash
cd tests && npx firebase emulators:start --config ../emulator/firebase.json --project demo-quality-dashboard
node tools/seed-emulator.js                       # in a second terminal
cd .. && python3 -m http.server 5510 --bind 127.0.0.1
```

Open `http://127.0.0.1:5510/scrap-entry.html?qdEmulator=1` and sign in with `LEADA` / `demo1234`
(Leader, Door A Day + Night), `ADMIN1` (admin), `VIEW1` (viewer) or `PV2ONLY` (Production V2 only).
`?qdEmulator=1` works only on localhost and forces the demo project, so the page cannot reach real data.
