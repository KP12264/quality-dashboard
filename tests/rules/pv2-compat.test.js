// Production V2 compatibility + Rules Impact Matrix — EMULATOR ONLY.
// Runs the SAME requests against (1) the Production V2 rules alone (repository snapshot @ 431836a)
// and (2) the combined draft (emulator/firestore.rules), then:
//   * asserts every Production V2 / legacy collection behaves identically under both;
//   * asserts no cross-system write and no privilege escalation;
//   * writes docs/phase5/generated/rules-impact-matrix.md (allow/deny for every identity and op).
// NOTE: neither file is verified to equal the rules deployed on the real project (BLOCKED G1).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp } = require('firebase/firestore');

const ROOT = path.join(__dirname, '../..');
const E = c => `${c.toLowerCase()}@prodv2.local`;
const VARIANTS = {
  pv2: fs.readFileSync(path.join(ROOT, 'emulator/production-v2.firestore.rules.snapshot'), 'utf8'),
  combined: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8')
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
  ['qd', 'scrapLogs/s1'],
  ['qd', 'scrapSlots/2026-06-10_A_DAY'],
  ['qd', 'scrapSlots/2026-06-10_A_DAY/events/v1'],
  ['qd', 'scrapCloseSummary/2026-06-10'],
  ['qd', 'targetMaster/t1'],
  ['qd', 'improvements/i1'],
  ['qd', 'scrapModelMappings/m1'],
  ['qd', 'scrapWeeklyPlans/w1'],
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
          // A generic payload: valid QD writes need their full shape (covered elsewhere); this matrix shows
          // which identities can touch each collection at all, the same for both rule sets.
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

before(async () => { await runVariant('pv2'); await runVariant('combined'); });
after(() => {
  if (!results.pv2 || !results.combined) return;
  const short = r => OPS.map(op => `${op[0].toUpperCase()}${r[op] === 'ALLOW' ? '✓' : '·'}`).join(' ');
  let md = '# Security Rules Impact Matrix (generated)\n\n'
    + 'Generated by `tests/rules/pv2-compat.test.js` against the Firebase Emulator. Ops: G=get, L=list, C=create, U=update, D=delete; ✓ allowed, · denied.\n'
    + '"PV2 only" = repository snapshot of production-v2/firestore.rules @ 431836a; "Combined" = emulator/firestore.rules (draft).\n'
    + 'Neither is verified to be what is deployed (BLOCKED G1). QD writes are shown with a generic payload: the real QD write paths (ledger, close, mirror) are tested in the other rules tests.\n\n'
    + '| System | Path | Identity | PV2 only | Combined | Changed |\n|---|---|---|---|---|---|\n';
  for (const [sys, p] of PATHS) for (const idName of Object.keys(IDS)) {
    const a = short(results.pv2[p][idName]), b = short(results.combined[p][idName]);
    md += `| ${sys} | \`${p}\` | ${idName} | ${a} | ${b} | ${a === b ? '' : '**yes**'} |\n`;
  }
  fs.writeFileSync(path.join(ROOT, 'docs/phase5/generated/rules-impact-matrix.md'), md);
});

describe('Production V2 compatibility (snapshot rules vs combined draft)', () => {
  it('every Production V2 and legacy path behaves exactly the same for every identity and operation', () => {
    for (const [sys, p] of PATHS) if (sys === 'pv2' || sys === 'legacy') assert.deepEqual(results.combined[p], results.pv2[p], p);
  });
  it('the PV2 rules alone would block every Quality Dashboard collection (deploying them alone breaks QD)', () => {
    for (const [sys, p] of PATHS) if (sys === 'qd') for (const id of Object.keys(IDS)) for (const op of OPS) assert.equal(results.pv2[p][id][op], 'deny', `${p} ${id} ${op}`);
  });
  it('no cross-system writes: QD roles cannot write PV2, a PV2 writer cannot write QD', () => {
    for (const [sys, p] of PATHS) for (const op of ['create', 'update', 'delete']) {
      if (sys === 'pv2') for (const id of ['qdAdmin', 'qdLeader', 'qdViewer', 'signedInNoRole', 'anonymous']) assert.equal(results.combined[p][id][op], 'deny', `${p} ${id} ${op}`);
      if (sys === 'qd') assert.equal(results.combined[p].pv2Writer[op], 'deny', `${p} pv2Writer ${op}`);
    }
  });
  it('no privilege escalation: only a QD admin can write qdUsers; nobody can write the PV2 allowlist', () => {
    const q = results.combined['qdUsers/' + E('QDLEAD')];
    for (const id of ['anonymous', 'pv2Writer', 'qdLeader', 'qdViewer', 'signedInNoRole']) for (const op of ['create', 'update', 'delete']) assert.equal(q[id][op], 'deny', `${id} ${op}`);
    assert.equal(q.qdAdmin.update, 'ALLOW'); assert.equal(q.qdAdmin.create, 'ALLOW');   // admin manages roles
    assert.equal(q.qdLeader.update, 'deny');                                          // a leader cannot make itself admin
    const a = results.combined['prodV2_authorizedUsers/' + E('PV2W')];
    for (const id of Object.keys(IDS)) for (const op of ['create', 'update', 'delete']) assert.equal(a[id][op], 'deny');
  });
  it('public (anonymous) reads: dashboard data yes; qdUsers, ledger slots and audit events no', () => {
    const r = (p, op = 'get') => results.combined[p].anonymous[op];
    for (const p of ['scrapLogs/s1', 'scrapCloseSummary/2026-06-10', 'targetMaster/t1', 'improvements/i1', 'prodV2_dailyPlans/plan1', 'productionLogs/p1']) assert.equal(r(p), 'ALLOW', p);
    for (const p of ['qdUsers/' + E('QDLEAD'), 'scrapSlots/2026-06-10_A_DAY', 'scrapSlots/2026-06-10_A_DAY/events/v1']) { assert.equal(r(p), 'deny', p); assert.equal(r(p, 'list'), 'deny', p); }
    assert.equal(r('someOtherCollection/x1'), 'deny');
  });
});
