// Phase 4 — Firestore Rules (EMULATOR ONLY): the public close summary (scrapCloseSummary) stays
// equal to scrapSlots and carries no personal data; the public can read the summary but not the
// ledger / audit trail; the import marker is audited (m{n}); the rules themselves enforce the
// shift end and the Thailand-date Leader window.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, serverTimestamp, writeBatch } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('../support/compat-shim.js');

const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const D2 = bkk(2), TODAY = bkk(0);
let env;
const fsOf = c => env.authenticatedContext('uid-' + c, { email: E(c) }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
function actor(c) {
  const db = compatDb(fsOf(c)), email = E(c), opts = { email, serverTimestamp };
  return {
    db, opts,
    create: async data => { const ref = db.collection('scrapLogs').doc(); await Ledger.applyOps(db, [{ op: 'create', ref, data: Object.assign({ date: D2, shift: 'DAY', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 3, remark: '', createdAt: 1 }, data) }], opts); return ref.id; },
    update: (id, patch) => Ledger.applyOps(db, [{ op: 'update', ref: db.collection('scrapLogs').doc(id), data: Object.assign({}, patch) }], opts),
    close: req => SC.closeSlot(db, Object.assign({ date: D2, line: 'A', shift: 'DAY' }, req), opts)
  };
}
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }
const summaryOf = date => raw(async db => { const s = await getDoc(doc(db, 'scrapCloseSummary', date)); return s.exists() ? s.data() : null; });
const slotOf = id => raw(async db => { const s = await getDoc(doc(db, 'scrapSlots', id)); return s.exists() ? s.data() : null; });
// After every write the mirror must equal the public view of each slot of that date.
async function assertMirror(date) {
  const sum = await summaryOf(date);
  const slots = await raw(async db => { const o = {}; (await getDocs(query(collection(db, 'scrapSlots'), where('date', '==', date)))).forEach(d => { o[d.id] = d.data(); }); return o; });
  for (const [id, s] of Object.entries(slots)) {
    const key = id.split('_').slice(1).join('_');
    assert.deepEqual(JSON.parse(JSON.stringify(sum.slots[key])), JSON.parse(JSON.stringify(Ledger.publicView(s))), `mirror of ${id}`);
  }
  return sum;
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(__dirname, '../..', process.env.QD_RULES_FILE || 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await raw(async db => {
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(db, 'qdUsers', E('admin')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('leaderA')), u('leader', ['A_DAY', 'A_NIGHT']));
    await setDoc(doc(db, 'qdUsers', E('viewer')), u('viewer', []));
  });
});

describe('public close summary (mirror)', () => {
  it('every ledger write, close, reconfirm and marker change keeps the mirror equal to the slot', async () => {
    const L = actor('leaderA'), A = actor('admin');
    const id = await L.create({});
    await assertMirror(D2);
    await L.close({ state: 'SUBMITTED' });
    let sum = await assertMirror(D2);
    assert.equal(sum.slots.A_DAY.closeState, 'SUBMITTED');
    await L.update(id, { scrapQty: 9 });
    sum = await assertMirror(D2);
    assert.equal(sum.slots.A_DAY.logVersion, 2); assert.equal(sum.slots.A_DAY.closedVersion, 1);   // → CHANGED
    await A.close({ state: 'SUBMITTED', reconfirm: true });
    await L.close({ state: 'CONFIRMED_ZERO', shift: 'NIGHT' });
    await Ledger.markImport(A.db, [{ date: D2, line: 'B', shift: 'DAY' }], 'imp1', A.opts);
    sum = await assertMirror(D2);
    assert.equal(sum.slots.B_DAY.importPending, true);
    await Ledger.clearImportMarker(A.db, `${D2}_B_DAY`, A.opts);
    sum = await assertMirror(D2);
    assert.equal(sum.slots.B_DAY.importPending, false);
    assert.deepEqual(Object.keys(sum.slots).sort(), ['A_DAY', 'A_NIGHT', 'B_DAY']);
  });
  it('the mirror carries no e-mail, note or reason', async () => {
    const L = actor('leaderA');
    await L.close({ state: 'NO_PRODUCTION', reason: 'Line stopped for KP001 training', note: 'call KP002' });
    const text = JSON.stringify(await summaryOf(D2));
    assert.doesNotMatch(text, /@|KP00|training/i);
  });
  it('a slot write without the matching mirror is refused; a mirror that disagrees with the slot is refused', async () => {
    const L = actor('leaderA');
    await L.create({});
    const db = fsOf('leaderA'), id = `${D2}_A_DAY`, s = await slotOf(id);
    const closeFields = { closeState: 'SUBMITTED', closedVersion: s.logVersion, closeRevision: 1, closedBy: E('leaderA'), closedAt: serverTimestamp(), closedLogCount: 1, closedScrapQty: 3, closedLogIds: ['x'], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('leaderA') };
    const ev = { type: 'CLOSE', revision: 1, closeState: 'SUBMITTED', version: s.logVersion, logCount: 1, scrapQty: 3, logIds: ['x'], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('leaderA') };
    const attempt = async mirror => {
      const b = writeBatch(db);
      b.update(doc(db, 'scrapSlots', id), closeFields);
      b.set(doc(db, 'scrapSlots', id, 'events', 'c1'), ev);
      if (mirror) b.set(doc(db, 'scrapCloseSummary', D2), { date: D2, slots: { A_DAY: mirror }, updatedAt: serverTimestamp() }, { merge: true });
      return b.commit();
    };
    const good = Ledger.publicView(Object.assign({}, s, closeFields));
    await assertFails(attempt(null));                                               // no mirror
    await assertFails(attempt(Object.assign({}, good, { closeState: 'CONFIRMED_ZERO' })));   // mirror lies
    await assertFails(attempt(Object.assign({}, good, { closedBy: E('leaderA') })));     // extra (personal) field
    await assertSucceeds(attempt(good));                                            // positive control
  });
  it('nobody can write the mirror on its own: not to a false value, not for another Line, not anonymously', async () => {
    const L = actor('leaderA');
    await L.create({});
    await actor('admin').create({ line: 'B' });
    const cur = (await summaryOf(D2)).slots;
    await assertFails(updateDoc(doc(fsOf('leaderA'), 'scrapCloseSummary', D2), { 'slots.A_DAY.closeState': 'CONFIRMED_ZERO', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(fsOf('leaderA'), 'scrapCloseSummary', D2), { 'slots.B_DAY': Object.assign({}, cur.B_DAY, { closeState: 'CONFIRMED_ZERO' }), updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(anon(), 'scrapCloseSummary', D2), { date: D2, slots: {}, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(fsOf('admin'), 'scrapCloseSummary', '2026-01-01'), { date: '2026-01-02', slots: {}, updatedAt: serverTimestamp() }));
    // rewriting an entry to exactly the slot's current view is harmless and allowed
    await assertSucceeds(updateDoc(doc(fsOf('leaderA'), 'scrapCloseSummary', D2), { 'slots.A_DAY': cur.A_DAY, updatedAt: serverTimestamp() }));
  });
  it('public (signed out) can read the summary and scrap logs, but not slots, events or users', async () => {
    const L = actor('leaderA');
    await L.create({});
    await L.close({ state: 'SUBMITTED' });
    const p = anon();
    await assertSucceeds(getDoc(doc(p, 'scrapCloseSummary', D2)));
    await assertSucceeds(getDocs(query(collection(p, 'scrapCloseSummary'), where('date', '>=', D2), where('date', '<=', D2))));
    await assertFails(getDoc(doc(p, 'scrapSlots', `${D2}_A_DAY`)));
    await assertFails(getDocs(collection(p, 'scrapSlots', `${D2}_A_DAY`, 'events')));
    await assertFails(getDoc(doc(p, 'qdUsers', E('leaderA'))));
  });
});

describe('import marker audit trail', () => {
  it('set and clear each write an event m{n}; markerRevision counts them', async () => {
    const A = actor('admin');
    await Ledger.markImport(A.db, [{ date: D2, line: 'C', shift: 'DAY' }, { date: D2, line: 'C', shift: 'DAY' }], 'impX', A.opts);
    await Ledger.markImport(A.db, [{ date: D2, line: 'C', shift: 'DAY' }], 'impX', A.opts);   // same import again: no change
    await Ledger.clearImportMarker(A.db, `${D2}_C_DAY`, A.opts, 'impX');
    const id = `${D2}_C_DAY`;
    const ev = await raw(async db => { const o = {}; (await getDocs(collection(db, 'scrapSlots', id, 'events'))).forEach(d => { o[d.id] = d.data(); }); return o; });
    assert.deepEqual(Object.keys(ev).sort(), ['m1', 'm2']);
    assert.equal(ev.m1.action, 'SET'); assert.equal(ev.m1.rows, 2); assert.equal(ev.m1.importId, 'impX');
    assert.equal(ev.m2.action, 'CLEAR'); assert.equal(ev.m2.importId, 'impX'); assert.equal(ev.m2.by, E('admin'));
    assert.equal((await slotOf(id)).markerRevision, 2);
  });
  it('a marker cannot be cleared or replaced without its audit event, or with a false one', async () => {
    const A = actor('admin');
    await Ledger.markImport(A.db, [{ date: D2, line: 'C', shift: 'DAY' }], 'impY', A.opts);
    const id = `${D2}_C_DAY`, s = await slotOf(id), db = fsOf('admin');
    const attempt = async (slotPatch, event) => {
      const b = writeBatch(db);
      b.update(doc(db, 'scrapSlots', id), Object.assign({ updatedAt: serverTimestamp(), updatedBy: E('admin') }, slotPatch));
      if (event) b.set(doc(db, 'scrapSlots', id, 'events', event.id), event.data);
      b.set(doc(db, 'scrapCloseSummary', D2), { date: D2, slots: { C_DAY: Ledger.publicView(Object.assign({}, s, slotPatch)) }, updatedAt: serverTimestamp() }, { merge: true });
      return b.commit();
    };
    const clear = { importPending: null, markerRevision: 2 };
    const evOk = { id: 'm2', data: { type: 'IMPORT_MARKER', action: 'CLEAR', revision: 2, importId: 'impY', rows: 1, at: serverTimestamp(), by: E('admin') } };
    await assertFails(attempt({ importPending: null }, null));                                                  // old style: no revision, no event
    await assertFails(attempt(clear, null));                                                                    // no event
    await assertFails(attempt(clear, { id: 'm2', data: Object.assign({}, evOk.data, { importId: 'other' }) })); // false import id
    await assertFails(attempt({ importPending: { importId: 'impZ', rows: 1, at: serverTimestamp(), by: E('admin') }, markerRevision: 2 },
      { id: 'm2', data: { type: 'IMPORT_MARKER', action: 'SET', revision: 2, importId: 'impZ', rows: 1, at: serverTimestamp(), by: E('admin') } }));   // overwrite another import's marker
    await assertSucceeds(attempt(clear, evOk));                                                                 // positive control
  });
  it('a ledger write can no longer clear the marker by itself', async () => {
    const A = actor('admin');
    await Ledger.markImport(A.db, [{ date: D2, line: 'C', shift: 'DAY' }], 'impW', A.opts);
    // (the import's own rows are written through the ledger and leave the marker set)
    await A.create({ line: 'C' });
    assert.equal((await slotOf(`${D2}_C_DAY`)).importPending.importId, 'impW');
  });
});

describe('time rules enforced by Firestore Rules (Thailand time)', () => {
  it('a shift that has not ended cannot be closed, even when the page is bypassed', async () => {
    // Today's NIGHT shift always ends tomorrow 08:00 Thailand time.
    await assert.rejects(actor('admin').close({ date: TODAY, shift: 'NIGHT', state: 'CONFIRMED_ZERO' }), /permission/i);
    await actor('admin').close({ date: D2, shift: 'NIGHT', state: 'CONFIRMED_ZERO' });   // ended 2 days ago
  });
  it('Leader window counts Thailand dates: 7 days back yes, 8 no (scrap and close)', async () => {
    const L = actor('leaderA');
    await L.create({ date: bkk(7) });
    await assert.rejects(L.create({ date: bkk(8) }), /permission/i);
    await L.close({ date: bkk(7), state: 'SUBMITTED' });
    await assert.rejects(L.close({ date: bkk(8), state: 'CONFIRMED_ZERO' }), /permission/i);
  });
});
