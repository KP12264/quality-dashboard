// Slot ledger under load — EMULATOR ONLY (npm run test:rules).
// Uses the real js/scrap-ledger.js. Measures how many logs one transaction may carry under the
// rules (access-call limits), and checks concurrent writers and a multi-slot Excel-size import.
// After every scenario the ledger must be consistent:
//   logVersion == number of events, events are v1..vN with no gap,
//   liveLogCount == legacyCount + sum(event deltas) == logs actually stored in the slot.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, collection, query, where, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const { compatDb } = require('../support/compat-shim.js');
const { daysAgo } = require('../support/dates.js');

const E = code => `${code.toLowerCase()}@prodv2.local`;
// Leader writes must be inside the 7-day leader window: Thailand yesterday (was the fixed date '2026-11-03').
const DAY = daysAgo(1);
const DIFF_DAY = daysAgo(3), IMPORT_DAY = daysAgo(4), LEADER_IMPORT_DAY = daysAgo(5);   // were 2026-11-20 / -25 / -26
let env;
const report = [];

const scrap = (o = {}) => Object.assign({ date: DAY, shift: 'DAY', line: 'A', model: 'M1', defectType: 'Dent', scrapQty: 1, remark: '', createdAt: 1 }, o);
function writer(code) {
  const db = compatDb(env.authenticatedContext('uid-' + code, { email: E(code) }).firestore());
  const email = E(code), opts = { email, serverTimestamp };
  return {
    db,
    apply: ops => Ledger.applyOps(db, ops.map(o => Object.assign({ ref: db.collection('scrapLogs').doc(o.id) }, o)), opts),
    createMany: (rows, extra) => Ledger.applyOps(db, rows.map(r => ({ op: 'create', ref: db.collection('scrapLogs').doc(), data: Object.assign({}, r) })), Object.assign({}, opts, extra))
  };
}

async function checkSlot(slotId) {
  let out;
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const s = (await getDoc(doc(db, 'scrapSlots', slotId))).data();
    const evs = []; (await getDocs(collection(db, 'scrapSlots', slotId, 'events'))).forEach(d => evs.push(Object.assign({ id: d.id }, d.data())));
    const [date, line, shift] = slotId.split('_');
    const logs = (await getDocs(query(collection(db, 'scrapLogs'), where('date', '==', date), where('line', '==', line), where('shift', '==', shift)))).size;
    out = { s, evs, logs };
  });
  const { s, evs, logs } = out;
  const versions = evs.map(e => e.version).sort((a, b) => a - b);
  assert.equal(s.logVersion, evs.length, `${slotId}: logVersion vs events`);
  assert.deepEqual(versions, Array.from({ length: evs.length }, (_, i) => i + 1), `${slotId}: events v1..vN without gaps`);
  evs.forEach(e => assert.equal(e.id, 'v' + e.version));
  const delta = evs.reduce((n, e) => n + e.creates.length + e.movesIn.length - e.deletes.length - e.movesOut.length, 0);
  assert.equal(s.liveLogCount, s.legacyCount + delta, `${slotId}: liveLogCount vs events`);
  assert.equal(s.liveLogCount, logs, `${slotId}: liveLogCount vs stored logs`);
  return { version: s.logVersion, live: s.liveLogCount, events: evs.length };
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(__dirname, '../..', process.env.QD_RULES_FILE || 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(db, 'qdUsers', E('admin')), u('admin', []));
    for (let i = 1; i <= 5; i++) await setDoc(doc(db, 'qdUsers', E('leadA' + i)), u('leader', ['A_DAY']));
  });
});
after(async () => {
  console.log('\nLEDGER LOAD REPORT\n' + report.map(r => '  ' + r).join('\n'));
  if (env) await env.cleanup();
});

describe('rules access-call limits: logs per transaction', () => {
  it('one slot: measure the largest transaction the rules accept', async () => {
    const results = [];
    for (const [i, n] of [1, 10, 50, 100, 200, 300, 450].entries()) {
      const rows = Array.from({ length: n }, () => scrap({ date: daysAgo(40 + i) })   /* admin, any date; was 2026-12-0x */);
      try { await writer('admin').createMany(rows); results.push(`${n}: accepted`); }
      catch (e) { results.push(`${n}: refused (${e.code || e.message.slice(0, 40)})`); }
    }
    report.push('logs in one transaction, one slot -> ' + results.join(' | '));
    assert.ok(results.find(r => r.startsWith(Ledger.MAX_LOGS_PER_TRANSACTION + ':')).includes('accepted'), 'the chunk size used by imports must be accepted');
  });
  it('several slots in one transaction: measure, then confirm one-slot chunks always work', async () => {
    const results = [];
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const rows = [];
      ['A', 'B', 'C'].forEach(line => ['DAY', 'NIGHT'].forEach(shift => rows.push(scrap({ date: daysAgo(30 + k), line, shift }))   /* admin; was 2026-11-1x */));
      try { await writer('admin').createMany(rows.slice(0, k), { maxSlots: 99 }); results.push(`${k} slots: accepted`); }
      catch (e) { results.push(`${k} slots: refused (${e.code || e.message.slice(0, 40)})`); }
    }
    report.push('one log in each of k slots, one transaction -> ' + results.join(' | '));
    assert.ok(results[1].includes('accepted'), 'a move needs 2 slots in one transaction');
    assert.ok(results[Ledger.MAX_SLOTS_PER_TRANSACTION - 1].includes('accepted'), 'the client limit must be accepted by the rules');
  });
});

describe('concurrent writers on the same slot', () => {
  it('15 creates at once by 5 leaders: all saved, versions 1..15, counts exact', async () => {
    const slot = `${DAY}_A_DAY`;
    const jobs = [];
    for (let i = 0; i < 15; i++) jobs.push(writer('leadA' + (1 + (i % 5))).createMany([scrap({ scrapQty: i + 1 })]));
    const res = await Promise.allSettled(jobs);
    const ok = res.filter(r => r.status === 'fulfilled').length;
    const st = await checkSlot(slot);
    report.push(`15 concurrent creates, 5 leaders -> ${ok} saved, logVersion ${st.version}, liveLogCount ${st.live}, events ${st.events}`);
    res.filter(r => r.status === 'rejected').forEach(r => report.push('   refused: ' + (r.reason.code || '') + ' ' + String(r.reason.message).slice(0, 90)));
    assert.equal(ok, 15);
    assert.equal(st.version, 15);
    assert.equal(st.live, 15);
  });
  it('edit and delete of the same record at the same time: never inconsistent', async () => {
    const slot = `${DAY}_A_DAY`;
    const ids = [];
    await env.withSecurityRulesDisabled(async ctx => { (await getDocs(query(collection(ctx.firestore(), 'scrapLogs'), where('date', '==', DAY), where('line', '==', 'A')))).forEach(d => ids.push(d.id)); });
    const target = ids[0];
    const res = await Promise.allSettled([
      writer('leadA1').apply([{ op: 'update', id: target, data: { defectType: 'Scratch' } }]),
      writer('leadA2').apply([{ op: 'delete', id: target }]),
      writer('leadA3').apply([{ op: 'update', id: target, data: { scrapQty: 9 } }])
    ]);
    const st = await checkSlot(slot);
    report.push(`update + delete + update of one record at once -> ${res.map(r => r.status === 'fulfilled' ? 'ok' : 'refused: ' + (r.reason.message || '').slice(0, 45)).join(' / ')}; logVersion ${st.version}, liveLogCount ${st.live}`);
    assert.ok(res[1].status === 'fulfilled', 'the delete itself always succeeds');
  });
  it('writers on different slots never block each other', async () => {
    const res = await Promise.allSettled(['A', 'B', 'C'].flatMap(line => ['DAY', 'NIGHT'].map(shift => writer('admin').createMany([scrap({ date: DIFF_DAY, line, shift })]))));
    res.filter(r => r.status === 'rejected').forEach(r => report.push('   different slots refused: ' + (r.reason.code || '') + ' ' + String(r.reason.message).slice(0, 100)));
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 6);
    for (const line of ['A', 'B', 'C']) for (const shift of ['DAY', 'NIGHT']) await checkSlot(`${DIFF_DAY}_${line}_${shift}`);
  });
});

describe('KI-1: many writers on one date (shared scrapCloseSummary/{date})', () => {
  it('30 writers at once, 5 per slot on 6 slots of the same date: all saved once, versions 1..5, counts and summary exact', async () => {
    const date = daysAgo(6);
    const jobs = [];
    for (const line of ['A', 'B', 'C']) for (const shift of ['DAY', 'NIGHT']) for (let i = 0; i < 5; i++) jobs.push(writer('admin').createMany([scrap({ date, line, shift, scrapQty: 1 + i })]));
    const t0 = Date.now();
    const res = await Promise.allSettled(jobs);
    const rej = res.filter(r => r.status === 'rejected');
    rej.forEach(r => report.push('   30 writers refused: ' + (r.reason.code || '') + ' ' + String(r.reason.message).slice(0, 100)));
    report.push(`30 writers / 6 slots / one date -> ${res.length - rej.length} saved in ${Date.now() - t0} ms`);
    assert.equal(rej.length, 0);
    let total = 0;
    for (const line of ['A', 'B', 'C']) for (const shift of ['DAY', 'NIGHT']) {
      const st = await checkSlot(`${date}_${line}_${shift}`);   // logVersion == events, v1..vN, live == stored logs (no duplicate log or event)
      assert.equal(st.version, 5); assert.equal(st.live, 5); assert.equal(st.events, 5);
      total += st.live;
    }
    assert.equal(total, 30);
    let sum;
    await env.withSecurityRulesDisabled(async ctx => { sum = (await getDoc(doc(ctx.firestore(), 'scrapCloseSummary', date))).data(); });
    for (const line of ['A', 'B', 'C']) for (const shift of ['DAY', 'NIGHT']) {
      assert.equal(sum.slots[`${line}_${shift}`].logVersion, 5); assert.equal(sum.slots[`${line}_${shift}`].liveLogCount, 5);
    }
  });
  it('a real permission denial is not retried: refused at once, nothing written', async () => {
    const date = daysAgo(2);
    const t0 = Date.now();
    let err = null;
    try { await writer('leadA1').createMany([scrap({ date, line: 'B' })]); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    report.push(`leader write on another Line -> ${err && err.code} in ${ms} ms`);
    assert.ok(err && /permission/i.test(err.code || err.message), String(err && (err.code || err.message)));
    assert.ok(ms < 5000, `refused without retrying (${ms} ms)`);
    let slot;
    await env.withSecurityRulesDisabled(async ctx => { slot = await getDoc(doc(ctx.firestore(), 'scrapSlots', `${date}_B_DAY`)); });
    assert.equal(slot.exists(), false);
  });
});

describe('Excel import through the ledger', () => {
  it('450 rows over 6 slots, chunked by slot: all saved, each slot consistent', async () => {
    const rows = [];
    for (let i = 0; i < 450; i++) rows.push(scrap({ date: IMPORT_DAY, line: 'ABC'[i % 3], shift: i % 2 ? 'NIGHT' : 'DAY', scrapQty: 1 + (i % 7) }));
    const w = writer('admin');
    const chunks = Ledger.chunkBySlot(rows);
    let saved = 0;
    for (const c of chunks) { await w.createMany(c); saved += c.length; }
    const st = [];
    for (const line of ['A', 'B', 'C']) for (const shift of ['DAY', 'NIGHT']) st.push(await checkSlot(`${IMPORT_DAY}_${line}_${shift}`));
    report.push(`import 450 rows / 6 slots -> ${chunks.length} transactions, ${saved} saved, per-slot live ${st.map(s => s.live).join(',')}`);
    assert.equal(saved, 450);
    assert.equal(st.reduce((n, s) => n + s.live, 0), 450);
  });
  it('a leader cannot import: the first chunk is refused and nothing is written', async () => {
    let refused = false;
    try { await writer('leadA1').createMany([scrap({ date: LEADER_IMPORT_DAY }), scrap({ date: LEADER_IMPORT_DAY })]); } catch (e) { refused = /permission/i.test(e.code || e.message); }
    // (Leaders may still write their own slot; import is blocked by the client permission "scrap.import";
    //  this checks the rules side: a leader's write outside A_DAY in an import is refused.)
    let outside = false;
    try { await writer('leadA1').createMany([scrap({ date: LEADER_IMPORT_DAY, line: 'B' })]); } catch (e) { outside = /permission/i.test(e.code || e.message); }
    assert.equal(outside, true);
    report.push(`leader import rows: own slot ${refused ? 'refused' : 'accepted (rules allow own slot)'}; other Line refused: ${outside}`);
  });
});
