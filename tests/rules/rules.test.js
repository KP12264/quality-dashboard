// Firestore Security Rules tests — run ONLY against the Firebase Emulator
// (npm run test:rules). Project "demo-quality-dashboard" exists only there.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, serverTimestamp, writeBatch } = require('firebase/firestore');

const RULES = path.join(__dirname, '../../emulator/firestore.rules');
const PV2_SNAPSHOT = path.join(__dirname, '../../emulator/production-v2.firestore.rules.snapshot');
const E = code => `${code.toLowerCase()}@prodv2.local`;   // same as codeToEmail(): always lowercase

let env;
const users = {
  admin: { role: 'admin', active: true, slots: [] },
  leaderA: { role: 'leader', active: true, slots: ['A_DAY', 'A_NIGHT'] },
  viewer: { role: 'viewer', active: true, slots: [] },
  offadmin: { role: 'admin', active: false, slots: [] }
};
const scrap = (o = {}) => Object.assign({ date: '2026-11-02', shift: 'DAY', line: 'A', model: 'M1', defectType: 'Dent', scrapQty: 3, remark: '', createdAt: 1 }, o);
const as = (code, extra) => env.authenticatedContext('uid-' + code, Object.assign({ email: E(code) }, extra)).firestore();
const anon = () => env.unauthenticatedContext().firestore();

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => { if (env) await env.cleanup(); });

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const [code, u] of Object.entries(users)) await setDoc(doc(db, 'qdUsers', E(code)), Object.assign({ displayName: code, updatedAt: 1, updatedBy: E('admin') }, u));
    await setDoc(doc(db, 'prodV2_authorizedUsers', E('pv2user')), { active: true });
    await setDoc(doc(db, 'prodV2_authorizedUsers', E('admin')), { active: true });  // QD admin who is ALSO a PV2 writer
    await setDoc(doc(db, 'prodV2_actualLogs', 'actual_2026-11-02_A_DAY'), { actualByCell: { '0|||M1|||FR': 100 } });
    await setDoc(doc(db, 'scrapLogs', 'sA'), scrap({ createdBy: E('leaderA') }));
    await setDoc(doc(db, 'scrapLogs', 'sB'), scrap({ line: 'B', createdBy: E('admin') }));
    await setDoc(doc(db, 'scrapLogs', 'sLegacy'), scrap({ line: 'A', shift: 'NIGHT' }));     // record saved before sign-in existed (no createdBy)
    await setDoc(doc(db, 'improvements', 'i1'), { problem: 'p', defectType: 'Dent', status: 'Monitoring' });
    await setDoc(doc(db, 'targetMaster', 't1'), { shift: 'DAY', targetQty: 30, effectiveDate: '2026-01-01' });
    await setDoc(doc(db, 'productionLogs', 'p1'), { x: 1 });
  });
}

describe('combined rules file', () => {
  it('Production V2 block is a verbatim copy of production-v2/firestore.rules @ 431836a', () => {
    const combined = fs.readFileSync(RULES, 'utf8');
    const begin = combined.indexOf('// ===== BEGIN Production V2'), end = combined.indexOf('// ===== END Production V2');
    const pv2Block = combined.slice(combined.indexOf('\n', begin) + 1, end).trim();
    const snap = fs.readFileSync(PV2_SNAPSHOT, 'utf8');
    const snapStart = snap.indexOf('    // ── Legacy system'), snapEnd = snap.indexOf('    // ── Everything else');
    assert.equal(pv2Block, snap.slice(snapStart, snapEnd).trim());
    assert.match(combined, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);   // default deny kept
  });
});

describe('public (not signed in)', () => {
  before(seed);
  it('can read what the public dashboards read', async () => {
    const db = anon();
    for (const c of ['scrapLogs', 'improvements', 'targetMaster', 'scrapModelMappings', 'scrapWeeklyPlans', 'prodV2_actualLogs', 'prodV2_dailyPlans']) await assertSucceeds(getDocs(collection(db, c)));
  });
  it('cannot write any Quality Dashboard collection', async () => {
    const db = anon();
    await assertFails(addDoc(collection(db, 'scrapLogs'), scrap({ createdBy: E('x') })));
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sA'), { scrapQty: 9 }));
    await assertFails(deleteDoc(doc(db, 'scrapLogs', 'sA')));
    await assertFails(addDoc(collection(db, 'improvements'), { problem: 'p' }));
    await assertFails(addDoc(collection(db, 'targetMaster'), { shift: 'DAY' }));
    await assertFails(setDoc(doc(db, 'scrapModelMappings', 'm'), { a: 1 }));
    await assertFails(setDoc(doc(db, 'scrapWeeklyPlans', 'w'), { a: 1 }));
  });
  it('cannot read roles; unknown collections stay closed', async () => {
    const db = anon();
    await assertFails(getDoc(doc(db, 'qdUsers', E('admin'))));
    await assertFails(getDocs(collection(db, 'qdUsers')));
    await assertFails(getDocs(collection(db, 'somethingElse')));
  });
  it('Production V2 behaviour unchanged: prodV2 write closed, legacy productionLogs open', async () => {
    const db = anon();
    await assertFails(setDoc(doc(db, 'prodV2_actualLogs', 'x'), { a: 1 }));
    await assertSucceeds(setDoc(doc(db, 'productionLogs', 'p2'), { a: 1 }));
    await assertSucceeds(getDoc(doc(db, 'prodV2_authorizedUsers', E('pv2user'))));
  });
});

describe('leader (Door A, Day + Night)', () => {
  before(seed);
  it('saves scrap on the assigned Line/Shift, stamped with own email', async () => {
    await assertSucceeds(addDoc(collection(as('leaderA'), 'scrapLogs'), scrap({ createdBy: E('leaderA') })));
    await assertSucceeds(addDoc(collection(as('leaderA'), 'scrapLogs'), scrap({ shift: 'NIGHT', createdBy: E('leaderA') })));
  });
  it('cannot save on another Line', async () => {
    await assertFails(addDoc(collection(as('leaderA'), 'scrapLogs'), scrap({ line: 'B', createdBy: E('leaderA') })));
  });
  it('cannot fake or omit createdBy', async () => {
    await assertFails(addDoc(collection(as('leaderA'), 'scrapLogs'), scrap({ createdBy: E('admin') })));
    await assertFails(addDoc(collection(as('leaderA'), 'scrapLogs'), scrap()));
  });
  it('invalid data is refused even on the assigned slot', async () => {
    const db = as('leaderA');
    for (const bad of [{ scrapQty: 0 }, { scrapQty: -1 }, { scrapQty: '3' }, { date: '02/11/2026' }, { line: 'D' }, { shift: 'EVENING' }, { model: '' }])
      await assertFails(addDoc(collection(db, 'scrapLogs'), scrap(Object.assign({ createdBy: E('leaderA') }, bad))));
  });
  it('edits own-slot records (incl. records saved before sign-in) with updatedBy', async () => {
    const db = as('leaderA');
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sLegacy'), { scrapQty: 2 }));                                   // no updatedBy on a record nobody stamped yet
    await assertSucceeds(updateDoc(doc(db, 'scrapLogs', 'sA'), { scrapQty: 5, updatedBy: E('leaderA') }));
    await assertSucceeds(updateDoc(doc(db, 'scrapLogs', 'sLegacy'), { scrapQty: 2, updatedBy: E('leaderA') }));
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sA'), { scrapQty: 6, updatedBy: E('admin') }));                 // fake updatedBy
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sA'), { createdBy: E('leaderA2'), updatedBy: E('leaderA') }));  // rewrite creator
  });
  it('editing a record last stamped by someone else must stamp own email', async () => {
    await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'scrapLogs', 'sA'), { updatedBy: E('admin') }); });
    await assertFails(updateDoc(doc(as('leaderA'), 'scrapLogs', 'sA'), { scrapQty: 7 }));
    await assertSucceeds(updateDoc(doc(as('leaderA'), 'scrapLogs', 'sA'), { scrapQty: 7, updatedBy: E('leaderA') }));
  });
  it('cannot move a record to another Line, nor touch another Line', async () => {
    const db = as('leaderA');
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sA'), { line: 'B', updatedBy: E('leaderA') }));
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sB'), { scrapQty: 1, updatedBy: E('leaderA') }));
    await assertFails(deleteDoc(doc(db, 'scrapLogs', 'sB')));
  });
  it('deletes own-slot records', async () => { await assertSucceeds(deleteDoc(doc(as('leaderA'), 'scrapLogs', 'sA'))); });
  it('improvements and weekly plans: yes; targets, mappings, import batch: no', async () => {
    const db = as('leaderA');
    await assertSucceeds(addDoc(collection(db, 'improvements'), { problem: 'p', defectType: 'Dent' }));
    await assertSucceeds(updateDoc(doc(db, 'improvements', 'i1'), { status: 'Controlled' }));
    await assertFails(deleteDoc(doc(db, 'improvements', 'i1')));
    await assertSucceeds(setDoc(doc(db, 'scrapWeeklyPlans', '2026-11_W1'), { ym: '2026-11', week: 1 }, { merge: true }));
    await assertFails(addDoc(collection(db, 'targetMaster'), { shift: 'DAY', targetQty: 1, effectiveDate: '2026-11-01' }));
    await assertFails(setDoc(doc(db, 'scrapModelMappings', 'm'), { excelModel: 'x', productionModel: 'y' }));
    const b = writeBatch(db);
    b.set(doc(collection(db, 'scrapLogs')), scrap({ createdBy: E('leaderA') }));
    b.set(doc(collection(db, 'scrapLogs')), scrap({ line: 'C', createdBy: E('leaderA') }));
    await assertFails(b.commit());   // one row outside the slot fails the whole batch
  });
  it('roles: reads own only, cannot promote self or list users', async () => {
    const db = as('leaderA');
    await assertSucceeds(getDoc(doc(db, 'qdUsers', E('leaderA'))));
    await assertFails(getDoc(doc(db, 'qdUsers', E('admin'))));
    await assertFails(getDocs(collection(db, 'qdUsers')));
    await assertFails(updateDoc(doc(db, 'qdUsers', E('leaderA')), { role: 'admin', updatedAt: serverTimestamp(), updatedBy: E('leaderA') }));
    await assertFails(setDoc(doc(db, 'qdUsers', E('leaderA')), { role: 'leader', active: true, slots: ['A_DAY', 'B_DAY', 'C_DAY'], updatedAt: serverTimestamp(), updatedBy: E('leaderA') }));
  });
  it('a Quality Dashboard role grants nothing in Production V2', async () => {
    await assertFails(setDoc(doc(as('leaderA'), 'prodV2_actualLogs', 'actual_2026-11-02_A_DAY'), { actualByCell: {} }, { merge: true }));
  });
  it('email case in the sign-in token does not matter', async () => {
    const db = env.authenticatedContext('uid-upper', { email: 'LEADERA@PRODV2.LOCAL' }).firestore();
    await assertSucceeds(addDoc(collection(db, 'scrapLogs'), scrap({ createdBy: E('leadera') })));
  });
});

describe('viewer', () => {
  before(seed);
  it('reads like the public, writes nothing', async () => {
    const db = as('viewer');
    await assertSucceeds(getDocs(collection(db, 'scrapLogs')));
    await assertSucceeds(getDoc(doc(db, 'qdUsers', E('viewer'))));
    await assertFails(addDoc(collection(db, 'scrapLogs'), scrap({ createdBy: E('viewer') })));
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'sA'), { scrapQty: 1, updatedBy: E('viewer') }));
    await assertFails(deleteDoc(doc(db, 'scrapLogs', 'sA')));
    await assertFails(addDoc(collection(db, 'improvements'), { problem: 'p' }));
    await assertFails(setDoc(doc(db, 'scrapWeeklyPlans', 'w'), { a: 1 }));
  });
});

describe('admin', () => {
  before(seed);
  it('writes scrap on any Line/Shift, targets, mappings, deletes improvements', async () => {
    const db = as('admin');
    await assertSucceeds(addDoc(collection(db, 'scrapLogs'), scrap({ line: 'C', shift: 'NIGHT', createdBy: E('admin') })));
    await assertSucceeds(updateDoc(doc(db, 'scrapLogs', 'sA'), { line: 'B', updatedBy: E('admin') }));
    await assertSucceeds(deleteDoc(doc(db, 'scrapLogs', 'sB')));
    await assertSucceeds(addDoc(collection(db, 'targetMaster'), { shift: 'DAY', targetQty: 25, effectiveDate: '2026-11-01' }));
    await assertSucceeds(setDoc(doc(db, 'scrapModelMappings', 'm'), { excelModel: 'x', productionModel: 'y' }));
    await assertSucceeds(deleteDoc(doc(db, 'improvements', 'i1')));
  });
  it('imports a batch across Lines', async () => {
    const db = as('admin');
    const b = writeBatch(db);
    for (const line of ['A', 'B', 'C']) for (const shift of ['DAY', 'NIGHT']) b.set(doc(collection(db, 'scrapLogs')), scrap({ line, shift, createdBy: E('admin') }));
    await assertSucceeds(b.commit());
  });
  it('manages roles with server time and own email; bad role documents are refused', async () => {
    const db = as('admin');
    const ok = { role: 'leader', active: true, displayName: 'New leader', slots: ['B_DAY'], updatedAt: serverTimestamp(), updatedBy: E('admin') };
    await assertSucceeds(setDoc(doc(db, 'qdUsers', E('newleader')), ok));
    await assertSucceeds(getDocs(collection(db, 'qdUsers')));
    await assertFails(setDoc(doc(db, 'qdUsers', E('x1')), Object.assign({}, ok, { role: 'superuser' })));
    await assertFails(setDoc(doc(db, 'qdUsers', E('x2')), Object.assign({}, ok, { slots: ['D_DAY'] })));
    await assertFails(setDoc(doc(db, 'qdUsers', E('x3')), Object.assign({}, ok, { isAdmin: true })));
    await assertFails(setDoc(doc(db, 'qdUsers', E('x4')), Object.assign({}, ok, { updatedBy: E('someoneelse') })));
    await assertFails(setDoc(doc(db, 'qdUsers', E('x5')), Object.assign({}, ok, { updatedAt: 12345 })));
    await assertFails(setDoc(doc(db, 'qdUsers', 'MixedCase@prodv2.local'), ok));
    await assertSucceeds(deleteDoc(doc(db, 'qdUsers', E('newleader'))));
  });
  it('QD admin role and Production V2 allowlist stay independent', async () => {
    // This admin IS in prodV2_authorizedUsers too, so PV2 writes succeed because of PV2's own rule …
    await assertSucceeds(setDoc(doc(as('admin'), 'prodV2_actualLogs', 'actual_2026-11-02_A_DAY'), { actualByCell: { a: 1 } }, { merge: true }));
    // … but a PV2 writer without a QD role cannot write Quality Dashboard data …
    await assertFails(addDoc(collection(as('pv2user'), 'scrapLogs'), scrap({ createdBy: E('pv2user') })));
    await assertSucceeds(setDoc(doc(as('pv2user'), 'prodV2_actualLogs', 'actual_2026-11-02_B_DAY'), { actualByCell: {} }));
    // … and no QD role can edit the PV2 allowlist.
    await assertFails(setDoc(doc(as('admin'), 'prodV2_authorizedUsers', E('leaderA')), { active: true }));
  });
});

describe('disabled account / tokens without email', () => {
  before(seed);
  it('a disabled admin can write nothing', async () => {
    const db = as('offadmin');
    await assertFails(addDoc(collection(db, 'scrapLogs'), scrap({ createdBy: E('offadmin') })));
    await assertFails(addDoc(collection(db, 'targetMaster'), { shift: 'DAY' }));
    await assertFails(getDocs(collection(db, 'qdUsers')));
  });
  it('a signed-in user without email (e.g. anonymous sign-in) can write nothing', async () => {
    const db = env.authenticatedContext('anon-uid', {}).firestore();
    await assertFails(addDoc(collection(db, 'scrapLogs'), scrap({ createdBy: 'x' })));
    await assertSucceeds(getDocs(collection(db, 'scrapLogs')));
  });
});
