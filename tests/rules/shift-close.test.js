// Shift Scrap Close (Phase 3) — Firestore Rules + js/shift-close.js against the EMULATOR only.
// Close / reconfirm, CHANGED after a later edit, duplicates, the Leader date window, edits that
// race a close, and Excel imports that partly fail (import marker).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, collection, serverTimestamp, writeBatch } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('../support/compat-shim.js');

const E = code => `${code.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
// Thailand dates (Asia/Bangkok, UTC+7), like the client and the rules.
const daysAgo = n => ymd(new Date(Date.now() + 7 * 3600000 - n * 86400000));
const D1 = daysAgo(2);           // two days ago: both shifts have ended, inside every window
const S = SC.STATUS;
let env;
const users = {
  admin: { role: 'admin', active: true, slots: [] },
  leaderA: { role: 'leader', active: true, slots: ['A_DAY', 'A_NIGHT'] },
  leaderA2: { role: 'leader', active: true, slots: ['A_DAY'] },
  leaderB: { role: 'leader', active: true, slots: ['B_DAY'] },
  viewer: { role: 'viewer', active: true, slots: [] }
};
const scrap = (o = {}) => Object.assign({ date: D1, shift: 'DAY', line: 'A', model: 'M1', defectType: 'Dent', scrapQty: 3, remark: '', createdAt: 1 }, o);
const fsOf = code => env.authenticatedContext('uid-' + code, { email: E(code) }).firestore();
function actor(code) {
  const db = compatDb(fsOf(code)), email = E(code), opts = { email, serverTimestamp };
  return {
    db, email, opts,
    create: async data => { const ref = db.collection('scrapLogs').doc(); await Ledger.applyOps(db, [{ op: 'create', ref, data: Object.assign({ createdBy: email }, data) }], opts); return ref.id; },
    update: (id, patch) => Ledger.applyOps(db, [{ op: 'update', ref: db.collection('scrapLogs').doc(id), data: Object.assign({ updatedBy: email }, patch) }], opts),
    del: id => Ledger.applyOps(db, [{ op: 'delete', ref: db.collection('scrapLogs').doc(id) }], opts),
    close: req => SC.closeSlot(db, Object.assign({ date: D1, line: 'A', shift: 'DAY' }, req), opts),
    load: (date = D1, line = 'A', shift = 'DAY') => SC.loadSlot(db, date, line, shift)
  };
}
// Hand-made slot write + its public mirror (scrapCloseSummary) from the merged result, so a
// hand-made test write breaks only the rule it is aimed at.
async function slotPut(b, db, id, data, op) {
  const cur = (await slotOf(id)) || {};
  if (op === 'set') b.set(doc(db, 'scrapSlots', id), data); else b.update(doc(db, 'scrapSlots', id), data);
  const [date, line, shift] = id.split('_');
  b.set(doc(db, 'scrapCloseSummary', date), { date, slots: { [`${line}_${shift}`]: Ledger.publicView(Object.assign({}, cur, data)) }, updatedAt: serverTimestamp() }, { merge: true });
}
async function raw(fn) { let out; await env.withSecurityRulesDisabled(async ctx => { out = await fn(ctx.firestore()); }); return out; }
const slotOf = id => raw(async db => { const s = await getDoc(doc(db, 'scrapSlots', id)); return s.exists() ? s.data() : null; });
const eventsOf = id => raw(async db => { const out = {}; (await getDocs(collection(db, 'scrapSlots', id, 'events'))).forEach(d => { out[d.id] = d.data(); }); return out; });
const code = e => e && (e.code || e.message);

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(__dirname, '../..', process.env.QD_RULES_FILE || 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await raw(async db => { for (const [c, u] of Object.entries(users)) await setDoc(doc(db, 'qdUsers', E(c)), Object.assign({ displayName: c, updatedAt: 1, updatedBy: E('admin') }, u)); });
});

describe('close states', () => {
  it('Leader submits scrap on the assigned slot: snapshot, close event c1, status SUBMITTED', async () => {
    const L = actor('leaderA');
    await L.create(scrap({ scrapQty: 4 })); await L.create(scrap({ scrapQty: 6 }));
    const r = await L.close({ state: S.SUBMITTED });
    assert.equal(r.verified, true);
    const s = await slotOf(`${D1}_A_DAY`);
    assert.equal(s.closeState, S.SUBMITTED); assert.equal(s.closedVersion, 2); assert.equal(s.closeRevision, 1);
    assert.equal(s.closedLogCount, 2); assert.equal(s.closedScrapQty, 10); assert.equal(s.closedBy, E('leaderA'));
    const ev = await eventsOf(`${D1}_A_DAY`);
    assert.equal(ev.c1.type, 'CLOSE'); assert.equal(ev.c1.version, 2); assert.equal(ev.c1.previous, null);
    assert.equal((await L.load()).info.status, S.SUBMITTED);
  });
  it('zero scrap must be CONFIRMED_ZERO; no production needs a reason; neither is accepted with scrap', async () => {
    const L = actor('leaderA');
    await L.close({ state: S.CONFIRMED_ZERO, line: 'A', shift: 'NIGHT' });
    assert.equal((await L.load(D1, 'A', 'NIGHT')).info.status, S.CONFIRMED_ZERO);
    const s = await slotOf(`${D1}_A_NIGHT`);
    assert.equal(s.logVersion, 0); assert.equal(s.liveLogCount, 0);
    await assert.rejects(L.close({ state: S.NO_PRODUCTION }), /reason/i);
    await L.close({ state: S.NO_PRODUCTION, reason: 'Planned maintenance' });
    assert.equal((await L.load()).info.status, S.NO_PRODUCTION);
    await L.create(scrap());
    assert.equal((await L.load()).info.status, S.CHANGED);
    await assert.rejects(L.close({ state: S.CONFIRMED_ZERO }), /scrap records/);
  });
  it('rules refuse a hand-made zero close on a slot that has scrap, and SUBMITTED with no scrap', async () => {
    const L = actor('leaderA');
    await L.create(scrap());
    const id = `${D1}_A_DAY`, s = await slotOf(id);
    const db = fsOf('leaderA');
    const fields = st => ({ closeState: st, closedVersion: s.logVersion, closeRevision: 1, closedBy: E('leaderA'), closedAt: serverTimestamp(), closedLogCount: 1, closedScrapQty: 0, closedLogIds: ['x'], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('leaderA') });
    const ev = st => ({ type: 'CLOSE', revision: 1, closeState: st, version: s.logVersion, logCount: 1, scrapQty: 0, logIds: ['x'], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('leaderA') });
    for (const st of [S.CONFIRMED_ZERO, S.SUBMITTED]) {
      const b = writeBatch(db); await slotPut(b, db, id, fields(st), 'update'); b.set(doc(db, 'scrapSlots', id, 'events', 'c1'), ev(st));
      await assertFails(b.commit());
    }
  });
  it('no close event = no close; a close cannot change logVersion or counters', async () => {
    const L = actor('leaderA');
    await L.create(scrap());
    const id = `${D1}_A_DAY`, s = await slotOf(id);
    const db = fsOf('leaderA');
    await assertFails(updateDoc(doc(db, 'scrapSlots', id), { closeState: S.SUBMITTED, closedVersion: 1, closeRevision: 1, closedBy: E('leaderA'), closedAt: serverTimestamp(), closedLogCount: 1, closedScrapQty: 3, closedLogIds: ['a'], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }));
    const b = writeBatch(db);
    await slotPut(b, db, id, { logVersion: 5, closeState: S.SUBMITTED, closedVersion: 5, closeRevision: 1, closedBy: E('leaderA'), closedAt: serverTimestamp(), closedLogCount: 1, closedScrapQty: 3, closedLogIds: ['a'], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, 'update');
    b.set(doc(db, 'scrapSlots', id, 'events', 'c1'), { type: 'CLOSE', revision: 1, closeState: S.SUBMITTED, version: 5, logCount: 1, scrapQty: 3, logIds: ['a'], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('leaderA') });
    await assertFails(b.commit());
    assert.equal(s.logVersion, (await slotOf(id)).logVersion);
  });
});

describe('who may close', () => {
  it('Leader only on the assigned Line/Shift; viewer never; admin any slot', async () => {
    await actor('admin').create(scrap({ line: 'B' }));
    await assert.rejects(actor('leaderA').close({ state: S.SUBMITTED, line: 'B' }), /permission/i);
    await assert.rejects(actor('viewer').close({ state: S.CONFIRMED_ZERO, line: 'C' }), /permission/i);
    await assert.rejects(actor('leaderB').close({ state: S.CONFIRMED_ZERO, line: 'C' }), /permission/i);
    const r = await actor('admin').close({ state: S.SUBMITTED, line: 'B' });
    assert.equal(r.verified, true);
  });
  it('Leader date window (Thailand dates): 7 days back yes, 8 days back no; future never; admin any past date', async () => {
    const L = actor('leaderA');
    await L.close({ state: S.CONFIRMED_ZERO, date: daysAgo(7) });
    await assert.rejects(L.close({ state: S.CONFIRMED_ZERO, date: daysAgo(8) }), /permission/i);
    await assert.rejects(L.close({ state: S.CONFIRMED_ZERO, date: daysAgo(-3) }), /permission/i);
    await assert.rejects(actor('admin').close({ state: S.CONFIRMED_ZERO, date: daysAgo(-3) }), /permission/i);
    await actor('admin').close({ state: S.CONFIRMED_ZERO, date: daysAgo(40) });
  });
  it('Leader scrap writes follow the same window (create / edit / delete of an old date refused)', async () => {
    const A = actor('admin');
    const oldId = await A.create(scrap({ date: daysAgo(12) }));
    const L = actor('leaderA');
    await assert.rejects(L.create(scrap({ date: daysAgo(12) })), /permission/i);
    await assert.rejects(L.update(oldId, { scrapQty: 9 }), /permission/i);
    await assert.rejects(L.del(oldId), /permission/i);
    const newId = await L.create(scrap({ date: daysAgo(2) }));
    await assert.rejects(L.update(newId, { date: daysAgo(12) }), /permission/i);   // cannot move a record out of the window
  });
});

describe('changes after close, reconfirm, duplicates', () => {
  it('edit after close → CHANGED; reconfirm records who/when/version and the previous close', async () => {
    const L = actor('leaderA');
    const id1 = await L.create(scrap({ scrapQty: 2 }));
    await L.close({ state: S.SUBMITTED });
    await actor('leaderA2').update(id1, { scrapQty: 5 });
    const st = (await L.load()).info;
    assert.equal(st.status, S.CHANGED); assert.equal(st.closed.version, 1); assert.equal(st.version, 2);
    await actor('leaderA2').close({ state: S.SUBMITTED, reconfirm: true });
    const s = await slotOf(`${D1}_A_DAY`);
    assert.equal(s.closeRevision, 2); assert.equal(s.closedVersion, 2); assert.equal(s.closedScrapQty, 5); assert.equal(s.closedBy, E('leaderA2'));
    const ev = await eventsOf(`${D1}_A_DAY`);
    assert.deepEqual(Object.keys(ev).sort(), ['c1', 'c2', 'v1', 'v2']);
    assert.deepEqual(ev.c2.previous, { state: S.SUBMITTED, version: 1, revision: 1, by: E('leaderA') });
    // the audit trail cannot lie about the close it replaced
    const db = fsOf('admin'), id = `${D1}_A_DAY`, cur = await slotOf(id);
    const mk = async prev => { const b = writeBatch(db);
      await slotPut(b, db, id, { closeState: S.SUBMITTED, closedVersion: cur.logVersion, closeRevision: 3, closedBy: E('admin'), closedAt: serverTimestamp(), closedLogCount: cur.closedLogCount, closedScrapQty: cur.closedScrapQty, closedLogIds: cur.closedLogIds, closedFingerprint: cur.closedFingerprint, closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('admin') }, 'update');
      b.set(doc(db, 'scrapSlots', id, 'events', 'c3'), { type: 'CLOSE', revision: 3, closeState: S.SUBMITTED, version: cur.logVersion, logCount: cur.closedLogCount, scrapQty: cur.closedScrapQty, logIds: cur.closedLogIds, fingerprint: cur.closedFingerprint, note: null, noProductionReason: null, previous: prev, at: serverTimestamp(), by: E('admin') });
      return b.commit(); };
    await assertFails(mk(null));
    await assertFails(mk({ state: S.CONFIRMED_ZERO, version: 2, revision: 2, by: E('leaderA2') }));
    await assertSucceeds(mk({ state: S.SUBMITTED, version: 2, revision: 2, by: E('leaderA2') }));
  });
  it('duplicate close at the same version: client says already-closed; rules refuse a Leader; Admin may reconfirm', async () => {
    const L = actor('leaderA');
    await L.close({ state: S.CONFIRMED_ZERO });
    await assert.rejects(L.close({ state: S.CONFIRMED_ZERO }), e => code(e) === 'qd/already-closed');
    await assert.rejects(L.close({ state: S.CONFIRMED_ZERO, reconfirm: true }), /permission/i);   // rules: same version, leader
    await actor('admin').close({ state: S.CONFIRMED_ZERO, reconfirm: true });
    assert.equal((await slotOf(`${D1}_A_DAY`)).closeRevision, 2);
  });
  it('two people close the same shift at the same moment: exactly one close is saved', async () => {
    const res = await Promise.allSettled([actor('leaderA').close({ state: S.CONFIRMED_ZERO }), actor('leaderA2').close({ state: S.CONFIRMED_ZERO })]);
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
    const s = await slotOf(`${D1}_A_DAY`);
    assert.equal(s.closeRevision, 1);
    assert.deepEqual(Object.keys(await eventsOf(`${D1}_A_DAY`)), ['c1']);
  });
  it('close events cannot be edited or deleted, and cannot be overwritten', async () => {
    await actor('admin').close({ state: S.CONFIRMED_ZERO });
    const db = fsOf('admin');
    await assertFails(updateDoc(doc(db, 'scrapSlots', `${D1}_A_DAY`, 'events', 'c1'), { by: E('admin') }));
    await assertFails(setDoc(doc(db, 'scrapSlots', `${D1}_A_DAY`, 'events', 'c1'), { type: 'CLOSE' }));
  });
});

describe('scrap edited while closing', () => {
  it('what the person reviewed is stale → nothing saved (qd/changed-while-closing)', async () => {
    const L = actor('leaderA');
    await L.create(scrap());
    const seen = (await L.load()).info.version;
    await actor('leaderA2').create(scrap({ scrapQty: 8 }));
    await assert.rejects(L.close({ state: S.SUBMITTED, expectedVersion: seen }), e => code(e) === 'qd/changed-while-closing');
    assert.equal((await slotOf(`${D1}_A_DAY`)).closeState, undefined);
  });
  it('edits racing closes (20 rounds): a close is never saved for a version other than the one it counted', async () => {
    const L = actor('leaderA'), W = actor('leaderA2');
    await L.create(scrap());
    let closedOk = 0, refused = 0;
    for (let i = 0; i < 20; i++) {
      const [c] = await Promise.allSettled([L.close({ state: S.SUBMITTED, reconfirm: true }), W.create(scrap({ scrapQty: 1 + (i % 4) }))]);
      if (c.status === 'fulfilled') closedOk++; else { refused++; assert.ok(['qd/changed-while-closing', 'qd/already-closed'].includes(code(c.reason)) || /permission/i.test(code(c.reason)), code(c.reason)); }
      const s = await slotOf(`${D1}_A_DAY`);
      if (s.closeState) {
        const ev = await eventsOf(`${D1}_A_DAY`);
        const close = ev['c' + s.closeRevision];
        // the close's count/qty equal the ledger state at the confirmed version
        const logsAt = Object.values(ev).filter(e => e.type === 'LOG_WRITE' && e.version <= s.closedVersion).reduce((n, e) => n + e.creates.length - e.deletes.length, 0);
        assert.equal(close.logCount, logsAt, `round ${i}`);
        assert.equal(s.closedLogCount, logsAt);
      }
    }
    const st = (await L.load()).info;
    assert.ok([S.SUBMITTED, S.CHANGED].includes(st.status), st.status);
    console.log(`  edit-vs-close: ${closedOk} closes saved, ${refused} refused; final status ${st.status}`);
  });
});

describe('Excel import partial failure (import marker)', () => {
  const rows = (date, line, n, o = {}) => Array.from({ length: n }, (_, i) => scrap(Object.assign({ date, line, scrapQty: 1 + i }, o)));
  async function runImport(entries, failSlot) {
    const A = actor('admin');
    await Ledger.markImport(A.db, entries, 'imp_t1', A.opts);
    const failed = [];
    for (const chunk of Ledger.chunkBySlot(entries)) {
      if (failSlot && Ledger.slotIdOf(chunk[0]) === failSlot) { failed.push(...chunk); continue; }   // e.g. a network error on that chunk
      const ops = chunk.map(e => ({ op: 'create', ref: A.db.collection('scrapLogs').doc(), data: Object.assign({ createdBy: A.email }, e) }));
      try { await Ledger.applyOps(A.db, ops, A.opts); } catch (e) { failed.push(...chunk); }
    }
    return { failed, fin: await Ledger.finishImport(A.db, 'imp_t1', entries, failed, A.opts) };
  }
  it('all rows saved → markers cleared → closable', async () => {
    const { fin } = await runImport([...rows(D1, 'A', 3), ...rows(D1, 'B', 2)]);
    assert.equal(fin.kept.length, 0);
    assert.equal((await actor('leaderA').load()).info.status, S.PENDING);
    await actor('leaderA').close({ state: S.SUBMITTED });
  });
  it('one slot fails → that slot stays CONFLICT (import-incomplete) and cannot be closed, by Leader or Admin; others close', async () => {
    const { fin } = await runImport([...rows(D1, 'A', 3), ...rows(D1, 'B', 2)], `${D1}_A_DAY`);
    assert.deepEqual(fin.kept, [`${D1}_A_DAY`]);
    const L = actor('leaderA');
    const st = (await L.load()).info;
    assert.equal(st.status, S.CONFLICT); assert.deepEqual(st.reasons, ['import-incomplete']);
    await assert.rejects(L.close({ state: S.CONFIRMED_ZERO }), e => code(e) === 'qd/import-pending');
    await assert.rejects(actor('admin').close({ state: S.CONFIRMED_ZERO }), e => code(e) === 'qd/import-pending');
    await actor('admin').close({ state: S.SUBMITTED, line: 'B' });
  });
  it('rules refuse a close that skips the client check while the marker is set', async () => {
    await runImport(rows(D1, 'A', 2), `${D1}_A_DAY`);
    const id = `${D1}_A_DAY`, s = await slotOf(id), db = fsOf('admin');
    const b = writeBatch(db);
    await slotPut(b, db, id, { closeState: S.CONFIRMED_ZERO, closedVersion: s.logVersion, closeRevision: 1, closedBy: E('admin'), closedAt: serverTimestamp(), closedLogCount: 0, closedScrapQty: 0, closedLogIds: [], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('admin') }, 'update');
    b.set(doc(db, 'scrapSlots', id, 'events', 'c1'), { type: 'CLOSE', revision: 1, closeState: S.CONFIRMED_ZERO, version: s.logVersion, logCount: 0, scrapQty: 0, logIds: [], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('admin') });
    await assertFails(b.commit());
    // positive control: the very same writes pass once the marker is cleared
    const A = actor('admin');
    await Ledger.clearImportMarker(A.db, id, A.opts);
    const b2 = writeBatch(db);
    await slotPut(b2, db, id, { closeState: S.CONFIRMED_ZERO, closedVersion: s.logVersion, closeRevision: 1, closedBy: E('admin'), closedAt: serverTimestamp(), closedLogCount: 0, closedScrapQty: 0, closedLogIds: [], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('admin') }, 'update');
    b2.set(doc(db, 'scrapSlots', id, 'events', 'c1'), { type: 'CLOSE', revision: 1, closeState: S.CONFIRMED_ZERO, version: s.logVersion, logCount: 0, scrapQty: 0, logIds: [], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('admin') });
    await assertSucceeds(b2.commit());
  });
  it('a row the rules refuse (bad date) fails its slot; a second import is blocked until Admin clears the marker', async () => {
    const entries = [...rows(D1, 'C', 2), scrap({ line: 'C', date: D1, scrapQty: -1 })];   // qty -1 fails the rules
    const { failed, fin } = await runImport(entries);
    assert.equal(failed.length, 3);   // the whole slot transaction is refused: all or nothing per slot
    assert.deepEqual(fin.kept, [`${D1}_C_DAY`]);
    assert.equal((await actor('admin').load(D1, 'C')).logs.length, 0);
    const A = actor('admin');
    await assert.rejects(Ledger.markImport(A.db, rows(D1, 'C', 1), 'imp_t2', A.opts), e => code(e) === 'qd/import-pending');
    await assertFails(updateDoc(doc(fsOf('leaderA'), 'scrapSlots', `${D1}_A_DAY`), { importPending: null }));   // (not a leader's to clear)
    assert.equal(await Ledger.clearImportMarker(A.db, `${D1}_C_DAY`, A.opts), true);
    assert.equal((await A.load(D1, 'C')).info.status, S.PENDING);
  });
  it('Leaders cannot set or clear import markers', async () => {
    const L = actor('leaderA');
    await assert.rejects(Ledger.markImport(L.db, rows(D1, 'A', 1), 'imp_x', L.opts), /permission/i);
    await runImport(rows(D1, 'A', 1), `${D1}_A_DAY`);
    await assert.rejects(Ledger.clearImportMarker(L.db, `${D1}_A_DAY`, L.opts), /permission/i);
  });
});

describe('legacy logs and writes outside the ledger', () => {
  it('logs saved before the ledger: close counts them from the real query, status re-checks every load', async () => {
    await raw(async db => { await setDoc(doc(db, 'scrapLogs', 'old1'), scrap({ scrapQty: 4 })); await setDoc(doc(db, 'scrapLogs', 'old2'), scrap({ scrapQty: 1 })); });
    const L = actor('leaderA');
    await L.close({ state: S.SUBMITTED });
    const s = await slotOf(`${D1}_A_DAY`);
    assert.equal(s.closedLogCount, 2); assert.equal(s.closedScrapQty, 5); assert.deepEqual(s.closedLogIds, ['old1', 'old2']);
    assert.equal((await L.load()).info.status, S.SUBMITTED);
    // a record written around the ledger (e.g. with sign-in "off") is caught as CONFLICT
    await raw(async db => { await setDoc(doc(db, 'scrapLogs', 'sneak'), scrap({ scrapQty: 9 })); });
    const st = (await L.load()).info;
    assert.equal(st.status, S.CONFLICT); assert.ok(st.reasons.includes('ledger-count-mismatch'));
    await assert.rejects(L.close({ state: S.SUBMITTED, reconfirm: true }), e => code(e) === 'qd/conflict');
  });
  it('a closing client cannot state a legacyCount different from what it closes', async () => {
    await raw(async db => { await setDoc(doc(db, 'scrapLogs', 'old1'), scrap()); });
    const db = fsOf('leaderA'), id = `${D1}_A_DAY`;
    const b = writeBatch(db);
    await slotPut(b, db, id, { date: D1, line: 'A', shift: 'DAY', logVersion: 0, liveLogCount: 0, legacyCount: 1, closeState: S.CONFIRMED_ZERO, closedVersion: 0, closeRevision: 1, closedBy: E('leaderA'), closedAt: serverTimestamp(), closedLogCount: 0, closedScrapQty: 0, closedLogIds: [], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, 'set');
    b.set(doc(db, 'scrapSlots', id, 'events', 'c1'), { type: 'CLOSE', revision: 1, closeState: S.CONFIRMED_ZERO, version: 0, logCount: 0, scrapQty: 0, logIds: [], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('leaderA') });
    await assertFails(b.commit());
    // positive control: stating the count it closes passes
    const b2 = writeBatch(db);
    await slotPut(b2, db, id, { date: D1, line: 'A', shift: 'DAY', logVersion: 0, liveLogCount: 1, legacyCount: 1, closeState: S.SUBMITTED, closedVersion: 0, closeRevision: 1, closedBy: E('leaderA'), closedAt: serverTimestamp(), closedLogCount: 1, closedScrapQty: 3, closedLogIds: ['old1'], closedFingerprint: 'f', closeNote: null, noProductionReason: null, updatedAt: serverTimestamp(), updatedBy: E('leaderA') }, 'set');
    b2.set(doc(db, 'scrapSlots', id, 'events', 'c1'), { type: 'CLOSE', revision: 1, closeState: S.SUBMITTED, version: 0, logCount: 1, scrapQty: 3, logIds: ['old1'], fingerprint: 'f', note: null, noProductionReason: null, previous: null, at: serverTimestamp(), by: E('leaderA') });
    await assertSucceeds(b2.commit());
  });
});
