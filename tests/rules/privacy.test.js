// Phase 8 privacy policy (pending G4) — Firestore Rules, EMULATOR ONLY.
// Personal data never goes on publicly readable documents:
//   scrapLogs.recordedBy        → scrapLogPrivate/{logId}   (signed-in QD users only)
//   improvements.actions[].owner → improvementOwners/{id}    (signed-in QD users only)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const { compatDb } = require('../support/compat-shim.js');

const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const DAY = bkk(2);
let env;
const fsOf = c => c ? env.authenticatedContext('uid-' + c, { email: E(c) }).firestore() : env.unauthenticatedContext().firestore();
const actor = c => { const db = compatDb(fsOf(c)); return { db, opts: { email: E(c), serverTimestamp } }; };
const row = (o = {}) => Object.assign({ date: DAY, line: 'A', shift: 'DAY', model: 'M', defectType: 'Dent', scrapQty: 2, remark: '', createdAt: 1 }, o);
async function create(c, data, priv, id) { const a = actor(c); const ref = a.db.collection('scrapLogs').doc(id); const op = { op: 'create', ref, data }; if (priv) op.private = priv; await Ledger.applyOps(a.db, [op], a.opts); return ref.id; }
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(__dirname, '../..', process.env.QD_RULES_FILE || 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await raw(async db => {
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(db, 'qdUsers', E('admin')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('leaderA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'qdUsers', E('viewer')), u('viewer', []));
    // a record saved before Phase 8 (sign-in off) that already carries recordedBy publicly
    await setDoc(doc(db, 'scrapLogs', 'old1'), row({ recordedBy: 'KP0099' }));
    await setDoc(doc(db, 'improvements', 'imp-old'), { problem: 'p', defectType: 'Dent', actions: [{ action: 'x', owner: 'Somchai' }], status: 'Monitoring' });
  });
});
after(async () => { if (env) await env.cleanup(); });

describe('recordedBy is not public', () => {
  it('a new public scrap log may not carry recordedBy', async () => {
    await assert.rejects(create('admin', row({ recordedBy: 'KP0001' })), /permission/i);
  });
  it('it goes to scrapLogPrivate in the same transaction; public cannot read it, QD users can', async () => {
    const id = await create('admin', row(), { recordedBy: 'KP0001' });
    const pub = await raw(async db => (await getDoc(doc(db, 'scrapLogs', id))).data());
    assert.equal(pub.recordedBy, undefined);
    await assertFails(getDoc(doc(fsOf(null), 'scrapLogPrivate', id)));
    await assertFails(getDoc(doc(fsOf('nobody'), 'scrapLogPrivate', id)));
    assert.equal((await getDoc(doc(fsOf('viewer'), 'scrapLogPrivate', id))).data().recordedBy, 'KP0001');
  });
  it('a private doc needs its log in the same commit, the writer\'s slot, one short string', async () => {
    await assertFails(setDoc(doc(fsOf('admin'), 'scrapLogPrivate', 'nolog'), { recordedBy: 'KP1' }));
    await assert.rejects(create('leaderA', row({ line: 'B' }), { recordedBy: 'KP1' }), /permission/i);   // not the leader's slot
    await assert.rejects(create('admin', row(), { recordedBy: 'X'.repeat(65) }), /permission/i);
    await assert.rejects(create('admin', row(), { recordedBy: 'KP1', email: 'a@b' }), /permission/i);
    await create('leaderA', row(), { recordedBy: 'KP2' });                                               // own slot: fine
  });
  it('deleting the log deletes its private doc; the private doc alone cannot be deleted by a Leader', async () => {
    const id = await create('leaderA', row(), { recordedBy: 'KP3' });
    await assertFails(deleteDoc(doc(fsOf('leaderA'), 'scrapLogPrivate', id)));
    const a = actor('leaderA');
    await Ledger.applyOps(a.db, [{ op: 'delete', ref: a.db.collection('scrapLogs').doc(id), dropPrivate: true }], a.opts);
    assert.equal(await raw(async db => (await getDoc(doc(db, 'scrapLogPrivate', id))).exists()), false);
  });
  it('an old record keeps its existing recordedBy on edit (no production data rewritten), but none can be added', async () => {
    const a = actor('admin');
    await Ledger.applyOps(a.db, [{ op: 'update', ref: a.db.collection('scrapLogs').doc('old1'), data: { scrapQty: 3 } }], a.opts);
    const id = await create('admin', row());
    await assert.rejects(Ledger.applyOps(a.db, [{ op: 'update', ref: a.db.collection('scrapLogs').doc(id), data: { recordedBy: 'KP9' } }], a.opts), /permission/i);
  });
});

describe('improvement action owners are not public', () => {
  const imp = (actions) => ({ problem: 'p', defectType: 'Dent', actions, status: 'Monitoring', createdAt: 1, updatedAt: 1 });
  it('an improvement with an owner name is refused; without owners it is saved; owners go to improvementOwners', async () => {
    await assertFails(setDoc(doc(fsOf('admin'), 'improvements', 'i1'), imp([{ action: 'fix jig', owner: 'Somchai' }])));
    const adb = fsOf('admin'), b = writeBatch(adb);
    b.set(doc(adb, 'improvements', 'i1'), imp([{ action: 'fix jig', owner: '' }]));
    b.set(doc(adb, 'improvementOwners', 'i1'), { owners: ['Somchai'], updatedAt: 1 });
    await assertSucceeds(b.commit());
    await assertFails(getDoc(doc(fsOf(null), 'improvementOwners', 'i1')));
    assert.deepEqual((await getDoc(doc(fsOf('leaderA'), 'improvementOwners', 'i1'))).data().owners, ['Somchai']);
    await assertFails(setDoc(doc(fsOf('leaderA'), 'improvementOwners', 'i1'), { owners: ['x'], updatedAt: 1 }));
  });
  it('owner hidden at any action position (up to 20 actions); more than 20 actions refused', async () => {
    const many = n => Array.from({ length: n }, () => ({ action: 'a', owner: '' }));
    const withOwnerAt = i => many(20).map((a, k) => k === i ? { action: 'a', owner: 'Name' } : a);
    for (const i of [0, 7, 19]) await assertFails(setDoc(doc(fsOf('admin'), 'improvements', 'i2'), imp(withOwnerAt(i))));
    await assertSucceeds(setDoc(doc(fsOf('admin'), 'improvements', 'i2'), imp(many(20))));
    await assertFails(setDoc(doc(fsOf('admin'), 'improvements', 'i3'), imp(many(21))));
  });
  it('an old improvement with owners must be saved without them (status-only update of such a doc is refused)', async () => {
    await assertFails(updateDoc(doc(fsOf('admin'), 'improvements', 'imp-old'), { status: 'Controlled' }));
    await assertSucceeds(updateDoc(doc(fsOf('admin'), 'improvements', 'imp-old'), { status: 'Controlled', actions: [{ action: 'x', owner: '' }] }));
  });
});
