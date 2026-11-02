// Seeds demo accounts and roles into a RUNNING Firebase Emulator (project demo-quality-dashboard)
// so the sign-in can be tried by hand. Emulator only — refuses to run without the emulator hosts.
//   1) cd tests && npx firebase emulators:start --config ../emulator/firebase.json --project demo-quality-dashboard
//   2) node tools/seed-emulator.js
//   3) cd .. && python3 -m http.server 5510 --bind 127.0.0.1   → open http://127.0.0.1:5510/scrap-entry.html?qdEmulator=1
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

const PROJECT = 'demo-quality-dashboard';
const AUTH = 'http://127.0.0.1:9099';
const PASSWORD = 'demo1234';
const ACCOUNTS = [
  ['ADMIN1', { role: 'admin', slots: [] }],
  ['LEADA', { role: 'leader', slots: ['A_DAY', 'A_NIGHT'] }],
  ['LEADB', { role: 'leader', slots: ['B_DAY'] }],
  ['VIEW1', { role: 'viewer', slots: [] }],
  ['PV2ONLY', null]   // Production V2 account without a Quality Dashboard role
];
const E = c => `${c.toLowerCase()}@prodv2.local`;

(async () => {
  for (const [code] of ACCOUNTS) {
    const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ email: E(code), password: PASSWORD })
    });
    if (!res.ok && !/EMAIL_EXISTS/.test(await res.text())) throw new Error('Auth emulator not reachable or refused ' + code);
  }
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(__dirname, '../../emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const [code, role] of ACCOUNTS) {
      if (role) await setDoc(doc(db, 'qdUsers', E(code)), Object.assign({ active: true, displayName: code, updatedAt: Date.now(), updatedBy: E('ADMIN1') }, role));
      else await setDoc(doc(db, 'prodV2_authorizedUsers', E(code)), { active: true });
    }
  });
  await env.cleanup();
  console.log(`Seeded ${ACCOUNTS.length} demo accounts (password "${PASSWORD}"): ${ACCOUNTS.map(a => a[0]).join(', ')}`);
})().catch(e => { console.error(e.message); process.exit(1); });
