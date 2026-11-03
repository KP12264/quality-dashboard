// Rules compatibility matrix — EMULATOR ONLY (Phase 5, extended in Phase 6).
// The SAME requests (identity x path x operation) against four rule sets:
//   repoPv2    production-v2/firestore.rules @ 431836a (emulator/production-v2.firestore.rules.snapshot)
//   production the rules copied from the Firebase Console (emulator/production.firestore.rules.snapshot;
//              database / publish time UNCONFIRMED, G1)
//   candidate  emulator/firestore.rules (production + Quality Dashboard sign-in, ledger, close)
//   bridge     emulator/firestore.rules.bridge (candidate + production's public QD blocks; transition)
// Asserts: Production V2 and legacy paths identical everywhere; every permission the candidate
// OPENS or CLOSES compared with production is in an explicit, reviewed list; the bridge removes
// nothing production allows. Writes docs/phase6/generated/compatibility-matrix.md (+ phase5 copy).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp } = require('firebase/firestore');

const ROOT = path.join(__dirname, '../..');
const E = c => `${c.toLowerCase()}@prodv2.local`;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VARIANTS = {
  repoPv2: read('emulator/production-v2.firestore.rules.snapshot'),
  production: read('emulator/production.firestore.rules.snapshot'),
  candidate: read('emulator/firestore.rules'),
  bridge: read('emulator/firestore.rules.bridge')
};
const IDS = {
  anonymous: null,
  pv2Writer: 'PV2W',          // in prodV2_authorizedUsers, no QD role
  qdAdmin: 'QDADMIN',         // QD admin, NOT a PV2 writer
  qdLeader: 'QDLEAD',         // QD leader A_DAY
  qdViewer: 'QDVIEW',
  signedInNoRole: 'NOBODY'    // valid account, no role anywhere
};
const PATHS = [
  ['legacy', 'productionLogs/p1'],
  ['pv2', 'prodV2_authorizedUsers/' + E('PV2W')],
  ['pv2', 'prodV2_dailyPlans/plan1'],
  ['pv2', 'prodV2_actualLogs/act1'],
  ['pv2', 'prodV2_dailyPlans/plan1/blocks/b1'],
  ['qd', 'qdUsers/' + E('QDLEAD')],
  ['qd', 'qdConfig/ledger'],
  ['qd', 'scrapLogs/s1'],
  ['qd', 'scrapSlots/2026-06-10_A_DAY'],
  ['qd', 'scrapSlots/2026-06-10_A_DAY/events/v1'],
  ['qd', 'scrapCloseSummary/2026-06-10'],
  ['qd', 'targetMaster/t1'],
  ['qd', 'improvements/i1'],
  ['qd', 'scrapModelMappings/m1'],
  ['qd', 'scrapWeeklyPlans/w1'],
  ['qd', 'scrapWeeklyPlans/w1/history/1'],
  ['qd', 'scrapWeeklyReviews/2026-11_W1'],
  ['other', 'someOtherCollection/x1']
];
const OPS = ['get', 'list', 'create', 'update', 'delete'];
const results = {};   // variant -> path -> id -> op -> 'ALLOW' | 'deny'

async function runVariant(name) {
  const env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: VARIANTS[name], host: '127.0.0.1', port: 8080 } });
  const out = {};
  try {
    for (const [, p] of PATHS) {
      out[p] = {};
      for (const [idName, code] of Object.entries(IDS)) {
        out[p][idName] = {};
        for (const op of OPS) {
          await env.clearFirestore();
          await env.withSecurityRulesDisabled(async ctx => {
            const db = ctx.firestore();
            await setDoc(doc(db, 'prodV2_authorizedUsers', E('PV2W')), { active: true });
            const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('QDADMIN') });
            await setDoc(doc(db, 'qdUsers', E('QDADMIN')), u('admin', []));
            await setDoc(doc(db, 'qdUsers', E('QDLEAD')), u('leader', ['A_DAY']));
            await setDoc(doc(db, 'qdUsers', E('QDVIEW')), u('viewer', []));
            if ((op === 'update' || op === 'delete' || op === 'get') && !p.startsWith('qdUsers/')) await setDoc(doc(db, p), { x: 1 });   // (qdUsers: the role records above)
          });
          const db = code ? env.authenticatedContext('uid-' + code, { email: E(code) }).firestore() : env.unauthenticatedContext().firestore();
          const ref = doc(db, p);
          // A generic payload: real QD write paths (ledger, close, mirror, config) need their full shape
          // and are tested in the other rules tests; this matrix shows who can touch each path at all.
          // qdUsers: a well-formed record granting role "admin" — the escalation attempt itself.
          const payload = p.startsWith('qdUsers/') ? { role: 'admin', active: true, displayName: 'x', slots: [], updatedAt: serverTimestamp(), updatedBy: code ? E(code) : 'x' } : { x: 2 };
          let ok;
          try {
            if (op === 'get') await getDoc(ref);
            else if (op === 'list') await getDocs(collection(db, p.split('/').slice(0, -1).join('/')));
            else if (op === 'create') await setDoc(doc(db, p + '_new'), payload);
            else if (op === 'update') await updateDoc(ref, payload);
            else await deleteDoc(ref);
            ok = true;
          } catch (e) { ok = false; }
          out[p][idName][op] = ok ? 'ALLOW' : 'deny';
        }
      }
    }
  } finally { await env.cleanup(); }
  results[name] = out;
}

// Every difference candidate vs production must be one of these (reviewed in docs/phase6).
const CLOSED_OK = new Set();   // "path|identity|op" that production allows and the candidate refuses
for (const p of ['scrapLogs/s1', 'targetMaster/t1', 'improvements/i1', 'scrapModelMappings/m1'])
  for (const id of Object.keys(IDS)) for (const op of ['create', 'update', 'delete']) CLOSED_OK.add(`${p}|${id}|${op}`);
const OPENED_OK = path_ => ['qdUsers/', 'qdConfig/', 'scrapSlots/', 'scrapCloseSummary/', 'scrapWeeklyPlans/', 'scrapWeeklyReviews/'].some(x => path_.startsWith(x));
const diffs = () => {
  const opened = [], closed = [];
  for (const [, p] of PATHS) for (const id of Object.keys(IDS)) for (const op of OPS) {
    const a = results.production[p][id][op], b = results.candidate[p][id][op];
    if (a === 'deny' && b === 'ALLOW') opened.push(`${p}|${id}|${op}`);
    if (a === 'ALLOW' && b === 'deny') closed.push(`${p}|${id}|${op}`);
  }
  return { opened, closed };
};

before(async () => { for (const v of Object.keys(VARIANTS)) await runVariant(v); });
after(() => {
  if (Object.keys(results).length < 4) return;
  const short = r => OPS.map(op => `${op[0].toUpperCase()}${r[op] === 'ALLOW' ? '✓' : '·'}`).join(' ');
  const change = (p, id) => {
    const a = results.production[p][id], b = results.candidate[p][id];
    const opened = OPS.filter(op => a[op] === 'deny' && b[op] === 'ALLOW'), closed = OPS.filter(op => a[op] === 'ALLOW' && b[op] === 'deny');
    return [opened.length ? '**opened** ' + opened.join(',') : '', closed.length ? '**closed** ' + closed.join(',') : ''].filter(Boolean).join(' · ');
  };
  let md = '# Rules Compatibility Matrix (generated)\n\n'
    + 'Generated by `tests/rules/pv2-compat.test.js` in the Firebase Emulator. G=get L=list C=create U=update D=delete; ✓ allowed, · denied.\n\n'
    + '- **Production** = `emulator/production.firestore.rules.snapshot` (copied from the Firebase Console; database / publish time UNCONFIRMED — G1)\n'
    + '- **Candidate** = `emulator/firestore.rules` · **Bridge** = `emulator/firestore.rules.bridge` (transition) · **Repo PV2** = production-v2/firestore.rules @ 431836a\n'
    + '- "Change" compares Candidate with Production. QD writes use a generic payload: the real QD write paths are tested separately.\n\n'
    + '| System | Path | Identity | Production | Candidate | Bridge | Repo PV2 | Change (candidate vs production) |\n|---|---|---|---|---|---|---|---|\n';
  for (const [sys, p] of PATHS) for (const id of Object.keys(IDS))
    md += `| ${sys} | \`${p}\` | ${id} | ${short(results.production[p][id])} | ${short(results.candidate[p][id])} | ${short(results.bridge[p][id])} | ${short(results.repoPv2[p][id])} | ${change(p, id)} |\n`;
  const d = diffs();
  md += `\nTotals: ${d.closed.length} permissions closed, ${d.opened.length} opened (candidate vs production), out of ${PATHS.length * Object.keys(IDS).length * OPS.length} checked.\n`;
  fs.mkdirSync(path.join(ROOT, 'docs/phase6/generated'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/phase6/generated/compatibility-matrix.md'), md);
});

describe('rules compatibility: production snapshot vs candidate vs bridge', () => {
  it('Production V2 and legacy paths behave identically in all four rule sets', () => {
    for (const [sys, p] of PATHS) if (sys === 'pv2' || sys === 'legacy')
      for (const v of ['repoPv2', 'candidate', 'bridge']) assert.deepEqual(results[v][p], results.production[p], `${v} ${p}`);
  });
  it('production today: the four QD collections are writable by ANYONE (no sign-in) — the gap the candidate closes', () => {
    for (const p of ['scrapLogs/s1', 'targetMaster/t1', 'improvements/i1', 'scrapModelMappings/m1'])
      for (const op of ['create', 'update', 'delete']) assert.equal(results.production[p].anonymous[op], 'ALLOW', `${p} ${op}`);
    for (const p of ['qdUsers/' + E('QDLEAD'), 'scrapSlots/2026-06-10_A_DAY', 'scrapCloseSummary/2026-06-10', 'scrapWeeklyPlans/w1', 'scrapWeeklyPlans/w1/history/1', 'scrapWeeklyReviews/2026-11_W1', 'qdConfig/ledger'])
      for (const id of Object.keys(IDS)) for (const op of OPS) assert.equal(results.production[p][id][op], 'deny', `${p} ${id} ${op}`);
  });
  it('every permission the candidate closes or opens is in the reviewed list', () => {
    const d = diffs();
    assert.deepEqual(d.closed.filter(k => !CLOSED_OK.has(k)), [], 'unexpected closed');
    assert.deepEqual(d.opened.filter(k => !OPENED_OK(k)), [], 'unexpected opened');
    // and the closing is real: no anonymous / no-role write remains on those collections
    for (const p of ['scrapLogs/s1', 'targetMaster/t1', 'improvements/i1', 'scrapModelMappings/m1'])
      for (const id of ['anonymous', 'signedInNoRole', 'pv2Writer', 'qdViewer']) for (const op of ['create', 'update', 'delete'])
        assert.equal(results.candidate[p][id][op], 'deny', `${p} ${id} ${op}`);
  });
  it('the candidate keeps every public READ the dashboards use today', () => {
    for (const p of ['scrapLogs/s1', 'targetMaster/t1', 'improvements/i1', 'scrapModelMappings/m1', 'productionLogs/p1', 'prodV2_dailyPlans/plan1', 'prodV2_actualLogs/act1'])
      for (const op of ['get', 'list']) assert.equal(results.candidate[p].anonymous[op], 'ALLOW', `${p} ${op}`);
  });
  it('the bridge removes nothing production allows (no write-failure window) and adds only the QD paths', () => {
    for (const [, p] of PATHS) for (const id of Object.keys(IDS)) for (const op of OPS) {
      if (results.production[p][id][op] === 'ALLOW') assert.equal(results.bridge[p][id][op], 'ALLOW', `${p} ${id} ${op}`);
      if (results.bridge[p][id][op] === 'ALLOW' && results.production[p][id][op] === 'deny') assert.ok(OPENED_OK(p), `${p} ${id} ${op}`);
    }
  });
  it('no cross-system writes and no privilege escalation in the candidate', () => {
    for (const [sys, p] of PATHS) for (const op of ['create', 'update', 'delete']) {
      if (sys === 'pv2') for (const id of ['qdAdmin', 'qdLeader', 'qdViewer', 'signedInNoRole', 'anonymous']) assert.equal(results.candidate[p][id][op], 'deny', `${p} ${id} ${op}`);
      if (sys === 'qd') assert.equal(results.candidate[p].pv2Writer[op], 'deny', `${p} pv2Writer ${op}`);
    }
    const q = results.candidate['qdUsers/' + E('QDLEAD')];
    for (const id of ['anonymous', 'pv2Writer', 'qdLeader', 'qdViewer', 'signedInNoRole']) for (const op of ['create', 'update', 'delete']) assert.equal(q[id][op], 'deny', `${id} ${op}`);
    assert.equal(q.qdAdmin.update, 'ALLOW');
    for (const id of Object.keys(IDS)) for (const op of ['create', 'update', 'delete']) assert.equal(results.candidate['prodV2_authorizedUsers/' + E('PV2W')][id][op], 'deny');
  });
  it('public (anonymous) never reads qdUsers, ledger slots, audit events or qdConfig in the candidate', () => {
    for (const p of ['qdUsers/' + E('QDLEAD'), 'scrapSlots/2026-06-10_A_DAY', 'scrapSlots/2026-06-10_A_DAY/events/v1', 'qdConfig/ledger'])
      for (const op of ['get', 'list']) assert.equal(results.candidate[p].anonymous[op], 'deny', `${p} ${op}`);
  });
});
