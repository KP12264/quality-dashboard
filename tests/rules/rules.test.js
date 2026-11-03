// Firestore Security Rules tests — run ONLY against the Firebase Emulator
// (npm run test:rules). Project "demo-quality-dashboard" exists only there.
// Scrap logs are written through the real js/scrap-ledger.js (via tests/support/compat-shim.js);
// "cheating" writers that skip the ledger are built by hand with writeBatch.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, serverTimestamp, writeBatch, increment } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const { compatDb } = require('../support/compat-shim.js');

const RULES = path.join(__dirname, '../../emulator/firestore.rules');
const PV2_SNAPSHOT = path.join(__dirname, '../../emulator/production-v2.firestore.rules.snapshot');
const E = code => `${code.toLowerCase()}@prodv2.local`;   // same as codeToEmail(): always lowercase
const DAY = '2026-11-02';
const SLOT_A = `${DAY}_A_DAY`;

let env;
const users = {
  admin: { role: 'admin', active: true, slots: [] },
  leaderA: { role: 'leader', active: true, slots: ['A_DAY', 'A_NIGHT'] },
  leaderB: { role: 'leader', active: true, slots: ['B_DAY'] },
  viewer: { role: 'viewer', active: true, slots: [] },
  offadmin: { role: 'admin', active: false, slots: [] }
};
const scrap = (o = {}) => Object.assign({ date: DAY, shift: 'DAY', line: 'A', model: 'M1', defectType: 'Dent', scrapQty: 3, remark: '', createdAt: 1 }, o);
const as = (code, extra) => env.authenticatedContext('uid-' + code, Object.assign({ email: E(code) }, extra)).firestore();
const anon = () => env.unauthenticatedContext().firestore();

// Ledger-aware writer for one signed-in user (the path the pages use).
function ledger(code) {
  const db = compatDb(as(code)), email = E(code);
  const opts = { email, serverTimestamp };
  return {
    create: async data => { const ref = db.collection('scrapLogs').doc(); await Ledger.applyOps(db, [{ op: 'create', ref, data: Object.assign({}, data) }], opts); return ref.id; },
    update: (id, patch) => Ledger.applyOps(db, [{ op: 'update', ref: db.collection('scrapLogs').doc(id), data: Object.assign({}, patch) }], opts),
    del: id => Ledger.applyOps(db, [{ op: 'delete', ref: db.collection('scrapLogs').doc(id) }], opts),
    many: (ops) => Ledger.applyOps(db, ops.map(o => Object.assign({ ref: db.collection('scrapLogs').doc(o.id) }, o)), opts),
    db
  };
}
async function adminRead(fn) { let out; await env.withSecurityRulesDisabled(async ctx => { out = await fn(ctx.firestore()); }); return out; }
const slotDoc = id => adminRead(async db => { const s = await getDoc(doc(db, 'scrapSlots', id)); return s.exists() ? s.data() : null; });
const eventDoc = (id, v) => adminRead(async db => { const s = await getDoc(doc(db, 'scrapSlots', id, 'events', 'v' + v)); return s.exists() ? s.data() : null; });

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
    await setDoc(doc(db, 'prodV2_actualLogs', `actual_${DAY}_A_DAY`), { actualByCell: { '0|||M1|||FR': 100 } });
    // Records saved before the ledger existed (no slot documents yet).
    await setDoc(doc(db, 'scrapLogs', 'sA'), scrap());
    await setDoc(doc(db, 'scrapLogs', 'sB'), scrap({ line: 'B' }));
    await setDoc(doc(db, 'scrapLogs', 'sLegacy'), scrap({ line: 'A', shift: 'NIGHT' }));
    await setDoc(doc(db, 'improvements', 'i1'), { problem: 'p', defectType: 'Dent', status: 'Monitoring' });
    await setDoc(doc(db, 'targetMaster', 't1'), { shift: 'DAY', targetQty: 30, effectiveDate: '2026-01-01' });
    await setDoc(doc(db, 'productionLogs', 'p1'), { x: 1 });
  });
}

describe('combined rules file', () => {
  it('production snapshot is intact (sha256 = metadata) and the PV2 block of the candidate equals its PV2 part', () => {
    const crypto = require('crypto');
    const prodPath = path.join(__dirname, '../../emulator/production.firestore.rules.snapshot');
    const meta = JSON.parse(fs.readFileSync(prodPath + '.meta.json', 'utf8'));
    const buf = fs.readFileSync(prodPath);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), meta.sha256);
    assert.equal(meta.sha256, meta.sha256ProvidedByOwner);
    assert.equal(buf.length, meta.bytes);
    const prod = buf.toString('utf8');
    const live = prod.slice(prod.indexOf('    // ── Legacy system'), prod.indexOf('    // ── Quality Dashboard (separate app')).trim();
    const combined = fs.readFileSync(RULES, 'utf8');
    const begin = combined.indexOf('// ===== BEGIN Production V2'), end = combined.indexOf('// ===== END Production V2');
    assert.equal(combined.slice(combined.indexOf('\n', begin) + 1, end).trim(), live);
    // the bridge is generated from the candidate + the snapshot and must be up to date
    const { build } = require('../../tools/rules/build-bridge.js');
    assert.equal(fs.readFileSync(path.join(__dirname, '../../emulator/firestore.rules.bridge'), 'utf8'), build());
  });
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
  it('can read what the public dashboards read, not the ledger', async () => {
    const db = anon();
    for (const c of ['scrapLogs', 'improvements', 'targetMaster', 'scrapModelMappings', 'scrapWeeklyPlans', 'prodV2_actualLogs', 'prodV2_dailyPlans']) await assertSucceeds(getDocs(collection(db, c)));
    await assertFails(getDocs(collection(db, 'scrapSlots')));
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
    await assertFails(setDoc(doc(db, 'scrapSlots', SLOT_A), { logVersion: 1 }));
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
  it('saves scrap on the assigned Line/Shift through the ledger', async () => {
    await assertSucceeds(ledger('leaderA').create(scrap()));
    await assertSucceeds(ledger('leaderA').create(scrap({ shift: 'NIGHT' })));
  });
  it('cannot save on another Line', async () => {
    await assertFails(ledger('leaderA').create(scrap({ line: 'B' })));
  });
  it('cannot put personal data (createdBy / updatedBy) on a public scrap log — who is in the audit event', async () => {
    await assertFails(ledger('leaderA').create(scrap({ createdBy: E('leaderA') })));
    await assertFails(ledger('leaderA').create(scrap({ updatedBy: E('leaderA') })));
    await assertFails(ledger('leaderA').create(scrap({ createdBy: null })));
    const id = await ledger('leaderA').create(scrap({ scrapQty: 2, shift: 'NIGHT' }));
    const slot = await slotDoc(`${DAY}_A_NIGHT`);
    assert.equal((await eventDoc(`${DAY}_A_NIGHT`, slot.logVersion)).by, E('leaderA'));   // accountability kept, not public
    const stored = await adminRead(async db => (await getDoc(doc(db, 'scrapLogs', id))).data());
    assert.equal(JSON.stringify(stored).includes('@'), false);
  });
  it('invalid data is refused even on the assigned slot', async () => {
    for (const bad of [{ scrapQty: 0 }, { scrapQty: -1 }, { scrapQty: '3' }, { date: '02/11/2026' }, { model: '' }])
      await assertFails(ledger('leaderA').create(scrap(bad)));
  });
  it('edits own-slot records (incl. records saved before sign-in) without adding personal data', async () => {
    await assertSucceeds(ledger('leaderA').update('sA', { scrapQty: 5 }));
    await assertSucceeds(ledger('leaderA').update('sLegacy', { scrapQty: 2 }));
    await assertFails(ledger('leaderA').update('sA', { scrapQty: 6, updatedBy: E('leaderA') }));                 // adds personal data
    await assertFails(ledger('leaderA').update('sA', { createdBy: E('someoneelse') }));                           // rewrite creator
  });
  it('cannot move a record to another Line, nor touch another Line', async () => {
    await assertFails(ledger('leaderA').update('sA', { line: 'B' }));
    await assertFails(ledger('leaderA').update('sB', { scrapQty: 1 }));
    await assertFails(ledger('leaderA').del('sB'));
  });
  it('deletes own-slot records', async () => { await assertSucceeds(ledger('leaderA').del('sA')); });
  it('improvements, weekly plans, targets and mappings are read-only', async () => {
    const db = as('leaderA');
    await assertSucceeds(getDocs(collection(db, 'improvements')));
    await assertFails(addDoc(collection(db, 'improvements'), { problem: 'p', defectType: 'Dent' }));
    await assertFails(updateDoc(doc(db, 'improvements', 'i1'), { status: 'Controlled' }));
    await assertFails(deleteDoc(doc(db, 'improvements', 'i1')));
    await assertSucceeds(getDocs(collection(db, 'scrapWeeklyPlans')));
    await assertFails(setDoc(doc(db, 'scrapWeeklyPlans', '2026-11_W1'), { ym: '2026-11', week: 1 }, { merge: true }));
    await assertFails(addDoc(collection(db, 'targetMaster'), { shift: 'DAY', targetQty: 1, effectiveDate: '2026-11-01' }));
    await assertFails(setDoc(doc(db, 'scrapModelMappings', 'm'), { excelModel: 'x', productionModel: 'y' }));
  });
  it('one row outside the slot fails the whole write', async () => {
    await assertFails(ledger('leaderA').many([{ op: 'create', data: scrap() }, { op: 'create', data: scrap({ line: 'C' }) }]));
  });
  it('roles: reads own only, cannot promote self or list users', async () => {
    const db = as('leaderA');
    await assertSucceeds(getDoc(doc(db, 'qdUsers', E('leaderA'))));
    await assertFails(getDoc(doc(db, 'qdUsers', E('admin'))));
    await assertFails(getDocs(collection(db, 'qdUsers')));
    await assertFails(updateDoc(doc(db, 'qdUsers', E('leaderA')), { role: 'admin', updatedAt: serverTimestamp(), updatedBy: E('leaderA') }));
  });
  it('a Quality Dashboard role grants nothing in Production V2', async () => {
    await assertFails(setDoc(doc(as('leaderA'), 'prodV2_actualLogs', `actual_${DAY}_A_DAY`), { actualByCell: {} }, { merge: true }));
  });
  it('email case in the sign-in token does not matter', async () => {
    const fs2 = env.authenticatedContext('uid-upper', { email: 'LEADERA@PRODV2.LOCAL' }).firestore();
    const db = compatDb(fs2);
    const ref = db.collection('scrapLogs').doc();
    await assertSucceeds(Ledger.applyOps(db, [{ op: 'create', ref, data: scrap() }], { email: E('leadera'), serverTimestamp }));
  });
});

describe('viewer', () => {
  before(seed);
  it('reads like the public (plus the ledger), writes nothing', async () => {
    const db = as('viewer');
    await assertSucceeds(getDocs(collection(db, 'scrapLogs')));
    await assertSucceeds(getDocs(collection(db, 'scrapSlots')));
    await assertSucceeds(getDoc(doc(db, 'qdUsers', E('viewer'))));
    await assertFails(ledger('viewer').create(scrap()));
    await assertFails(ledger('viewer').update('sA', { scrapQty: 1 }));
    await assertFails(ledger('viewer').del('sA'));
    await assertFails(addDoc(collection(db, 'improvements'), { problem: 'p' }));
    await assertFails(setDoc(doc(db, 'scrapWeeklyPlans', 'w'), { a: 1 }));
  });
});

describe('admin', () => {
  before(seed);
  it('writes scrap on any Line/Shift, targets, mappings, improvements, weekly plans', async () => {
    const db = as('admin');
    await assertSucceeds(ledger('admin').create(scrap({ line: 'C', shift: 'NIGHT' })));
    await assertSucceeds(ledger('admin').update('sA', { line: 'B' }));   // move between slots
    await assertSucceeds(ledger('admin').del('sB'));
    await assertSucceeds(addDoc(collection(db, 'targetMaster'), { shift: 'DAY', targetQty: 25, effectiveDate: '2026-11-01' }));
    await assertSucceeds(setDoc(doc(db, 'scrapModelMappings', 'm'), { excelModel: 'x', productionModel: 'y' }));
    await assertSucceeds(addDoc(collection(db, 'improvements'), { problem: 'p', defectType: 'Dent' }));
    await assertSucceeds(updateDoc(doc(db, 'improvements', 'i1'), { status: 'Controlled' }));
    await assertSucceeds(deleteDoc(doc(db, 'improvements', 'i1')));
    await assertSucceeds(setDoc(doc(db, 'scrapWeeklyPlans', '2026-11_W1'), { ym: '2026-11', week: 1 }, { merge: true }));
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
    await assertSucceeds(setDoc(doc(as('admin'), 'prodV2_actualLogs', `actual_${DAY}_A_DAY`), { actualByCell: { a: 1 } }, { merge: true }));
    await assertFails(ledger('pv2user').create(scrap()));
    await assertSucceeds(setDoc(doc(as('pv2user'), 'prodV2_actualLogs', `actual_${DAY}_B_DAY`), { actualByCell: {} }));
    await assertFails(setDoc(doc(as('admin'), 'prodV2_authorizedUsers', E('leaderA')), { active: true }));
  });
});

describe('disabled account / tokens without email', () => {
  before(seed);
  it('a disabled admin can write nothing', async () => {
    await assertFails(ledger('offadmin').create(scrap()));
    await assertFails(addDoc(collection(as('offadmin'), 'targetMaster'), { shift: 'DAY' }));
    await assertFails(getDocs(collection(as('offadmin'), 'qdUsers')));
  });
  it('a signed-in user without email (e.g. anonymous sign-in) can write nothing', async () => {
    const db = env.authenticatedContext('anon-uid', {}).firestore();
    await assertFails(addDoc(collection(db, 'scrapLogs'), scrap({ createdBy: 'x' })));
    await assertSucceeds(getDocs(collection(db, 'scrapLogs')));
  });
});

// ======================= Phase 2: slot ledger =======================
describe('slot ledger: every scrap write moves the version and leaves an audit event', () => {
  before(seed);
  it('first write counts the logs saved before the ledger (legacyCount) and creates v1', async () => {
    const id = await ledger('leaderA').create(scrap({ scrapQty: 4 }));
    const s = await slotDoc(SLOT_A);
    assert.equal(s.logVersion, 1);
    assert.equal(s.legacyCount, 1);         // sA existed before the ledger
    assert.equal(s.liveLogCount, 2);
    assert.equal(s.updatedBy, E('leaderA'));
    const e = await eventDoc(SLOT_A, 1);
    assert.deepEqual(e.creates, [id]);
    assert.equal(e.by, E('leaderA'));
    assert.equal(e.changes[0].after.scrapQty, 4);
  });
  it('an edit that keeps the total quantity and the log count still makes a new version', async () => {
    const before = await slotDoc(SLOT_A);
    await ledger('leaderA').update('sA', { defectType: 'Scratch' });   // same qty, same count
    const after = await slotDoc(SLOT_A);
    assert.equal(after.logVersion, before.logVersion + 1);
    assert.equal(after.liveLogCount, before.liveLogCount);
    const e = await eventDoc(SLOT_A, after.logVersion);
    assert.deepEqual(e.updates, ['sA']);
    assert.equal(e.changes[0].before.defectType, 'Dent');
    assert.equal(e.changes[0].after.defectType, 'Scratch');
  });
  it('a swap of two quantities (total unchanged) is two recorded updates', async () => {
    const a = await ledger('leaderA').create(scrap({ scrapQty: 2 }));
    const b = await ledger('leaderA').create(scrap({ scrapQty: 5 }));
    const v0 = (await slotDoc(SLOT_A)).logVersion;
    await ledger('leaderA').many([{ op: 'update', id: a, data: { scrapQty: 5 } }, { op: 'update', id: b, data: { scrapQty: 2 } }]);
    const s = await slotDoc(SLOT_A);
    assert.equal(s.logVersion, v0 + 1);
    assert.deepEqual((await eventDoc(SLOT_A, s.logVersion)).updates.sort(), [a, b].sort());
  });
  it('delete lowers liveLogCount; a move updates both slots (movesOut / movesIn)', async () => {
    const id = await ledger('admin').create(scrap({ scrapQty: 1 }));
    const live0 = (await slotDoc(SLOT_A)).liveLogCount;
    await ledger('admin').update(id, { line: 'B' });
    const a = await slotDoc(SLOT_A), b = await slotDoc(`${DAY}_B_DAY`);
    assert.equal(a.liveLogCount, live0 - 1);
    assert.deepEqual((await eventDoc(SLOT_A, a.logVersion)).movesOut, [id]);
    assert.deepEqual((await eventDoc(`${DAY}_B_DAY`, b.logVersion)).movesIn, [id]);
    await ledger('admin').del(id);
    const b2 = await slotDoc(`${DAY}_B_DAY`);
    assert.equal(b2.liveLogCount, b.liveLogCount - 1);
    assert.deepEqual((await eventDoc(`${DAY}_B_DAY`, b2.logVersion)).deletes, [id]);
  });
});

describe('slot ledger: writes that skip or fake the ledger are refused', () => {
  before(seed);
  // Builds a ledger write by hand so each test can break exactly one rule.
  // The public mirror (scrapCloseSummary, Phase 4) is written too, from the numbers the slot is
  // meant to end at (`view` when they are not plain numbers), so each test breaks only one rule.
  async function handWrite(code, { logs = [], slot, event, eventId, skipSlot, skipEvent, slotId = SLOT_A, view }) {
    const db = as(code);
    const b = writeBatch(db);
    logs.forEach(l => l.del ? b.delete(doc(db, 'scrapLogs', l.id)) : l.update ? b.update(doc(db, 'scrapLogs', l.id), l.data) : b.set(doc(db, 'scrapLogs', l.id), l.data));
    if (!skipSlot) {
      b.set(doc(db, 'scrapSlots', slotId), slot, { merge: true });
      const v = view || { logVersion: slot.logVersion, liveLogCount: slot.liveLogCount };
      const [date, line, shift] = slotId.split('_');
      b.set(doc(db, 'scrapCloseSummary', date), { date, slots: { [`${line}_${shift}`]: Ledger.publicView(v) }, updatedAt: serverTimestamp() }, { merge: true });
    }
    if (!skipEvent) b.set(doc(db, 'scrapSlots', slotId, 'events', eventId), event);
    return b.commit();
  }
  const ev = (o = {}) => Object.assign({ type: 'LOG_WRITE', version: 1, at: serverTimestamp(), by: E('leaderA'), creates: ['n1'], updates: [], deletes: [], movesIn: [], movesOut: [], changes: [] }, o);
  const newSlot = (o = {}) => Object.assign({ date: DAY, line: 'A', shift: 'DAY', logVersion: 1, liveLogCount: 2, legacyCount: 1, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, o);
  const log = (id, o) => ({ id, data: scrap(Object.assign({}, o)) });

  it('control: a correct hand-built ledger write is accepted', async () => {
    await assertSucceeds(handWrite('leaderA', { logs: [log('n1')], slot: newSlot(), event: ev(), eventId: 'v1' }));
  });
  it('scrap create / update / delete without any ledger write', async () => {
    const db = as('leaderA');
    await assertFails(setDoc(doc(db, 'scrapLogs', 'x1'), scrap()));
    await assertFails(updateDoc(doc(db, 'scrapLogs', 'n1'), { defectType: 'Other' }));
    await assertFails(deleteDoc(doc(db, 'scrapLogs', 'n1')));
  });
  it('ledger bumped but no audit event', async () => {
    await assertFails(handWrite('leaderA', { logs: [log('x2')], slot: { logVersion: 2, liveLogCount: 3, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, skipEvent: true }));
  });
  it('audit event without a version bump', async () => {
    await assertFails(handWrite('leaderA', { logs: [log('x3')], skipSlot: true, event: ev({ version: 2, creates: ['x3'] }), eventId: 'v2' }));
  });
  it('version skipped (+2) or not raised', async () => {
    const s = { liveLogCount: 3, updatedAt: serverTimestamp(), updatedBy: E('leaderA') };
    await assertFails(handWrite('leaderA', { logs: [log('x4')], slot: Object.assign({ logVersion: 3 }, s), event: ev({ version: 3, creates: ['x4'] }), eventId: 'v3' }));
    await assertFails(handWrite('leaderA', { logs: [log('x5')], slot: Object.assign({ logVersion: 1 }, s), event: ev({ version: 1, creates: ['x5'] }), eventId: 'v1' }));
  });
  it('event that does not list the log, or lists it under the wrong action', async () => {
    const s = { logVersion: 2, liveLogCount: 3, updatedAt: serverTimestamp(), updatedBy: E('leaderA') };
    await assertFails(handWrite('leaderA', { logs: [log('x6')], slot: s, event: ev({ version: 2, creates: ['other'] }), eventId: 'v2' }));
    await assertFails(handWrite('leaderA', { logs: [log('x7')], slot: s, event: ev({ version: 2, creates: [], updates: ['x7'] }), eventId: 'v2' }));
  });
  it('liveLogCount that does not match the event', async () => {
    await assertFails(handWrite('leaderA', { logs: [log('x8')], slot: { logVersion: 2, liveLogCount: 9, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, event: ev({ version: 2, creates: ['x8'] }), eventId: 'v2' }));
  });
  it('event stamped with someone else, a client time, or extra fields', async () => {
    const s = { logVersion: 2, liveLogCount: 3, updatedAt: serverTimestamp(), updatedBy: E('leaderA') };
    await assertFails(handWrite('leaderA', { logs: [log('x9')], slot: s, event: ev({ version: 2, creates: ['x9'], by: E('admin') }), eventId: 'v2' }));
    await assertFails(handWrite('leaderA', { logs: [log('x9')], slot: s, event: ev({ version: 2, creates: ['x9'], at: 5 }), eventId: 'v2' }));
    await assertFails(handWrite('leaderA', { logs: [log('x9')], slot: s, event: ev({ version: 2, creates: ['x9'], approved: true }), eventId: 'v2' }));
  });
  it('slot document cannot be retargeted, deleted, or written for another Line', async () => {
    const db = as('leaderA');
    await assertFails(updateDoc(doc(db, 'scrapSlots', SLOT_A), { line: 'B', updatedAt: serverTimestamp(), updatedBy: E('leaderA') }));
    await assertFails(deleteDoc(doc(db, 'scrapSlots', SLOT_A)));
    await assertFails(handWrite('leaderB', { logs: [log('y1')], slot: { logVersion: 2, liveLogCount: 3, updatedAt: serverTimestamp(), updatedBy: E('leaderB') }, event: ev({ version: 2, creates: ['y1'], by: E('leaderB') }), eventId: 'v2' }));
  });
  it('audit events cannot be changed or deleted, even by an admin', async () => {
    const db = as('admin');
    await assertFails(updateDoc(doc(db, 'scrapSlots', SLOT_A, 'events', 'v1'), { by: E('admin') }));
    await assertFails(deleteDoc(doc(db, 'scrapSlots', SLOT_A, 'events', 'v1')));
  });
  it('increment(): Rules see the value after the transform (observed: accepted)', async () => {
    // A correct write that uses FieldValue.increment instead of an explicit number.
    const v = (await slotDoc(SLOT_A)).logVersion, live = (await slotDoc(SLOT_A)).liveLogCount;
    await assertSucceeds(handWrite('leaderA', { logs: [log('inc1')], slot: { logVersion: increment(1), liveLogCount: increment(1), updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, view: { logVersion: v + 1, liveLogCount: live + 1 }, event: ev({ version: v + 1, creates: ['inc1'] }), eventId: 'v' + (v + 1) }));
    assert.equal((await slotDoc(SLOT_A)).liveLogCount, live + 1);
  });
});
