// Q1 revised migration gate — equivalence + read count. Firebase EMULATOR ONLY, synthetic data.
// For each scenario: fresh synthetic legacy logs → plan → real applyBaseline → scenario change →
//   OLD path (as ops-console did): full scrapLogs read + completeIfClean(db, plan, id, opts, logs)
//   NEW path (as ops-console does now): full scrapLogs + full scrapSlots read + completeIfClean(..., logs, slots)
// Asserts: NEW problems (without "extra") === OLD problems, same text and order; "extra" only where expected;
// complete === (OLD clean && no extra). Reads are counted on the gate step only.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.QD_ROOT || '/home/user/quality-dashboard';
const T = p => path.join(ROOT, 'tests', p);
const { initializeTestEnvironment } = require(T('node_modules/@firebase/rules-unit-testing'));
const { doc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp } = require(T('node_modules/firebase/firestore'));
const MB = require(path.join(ROOT, 'tools/migration/ledger-baseline.js'));
const Ledger = require(path.join(ROOT, 'js/scrap-ledger.js'));
const { compatDb } = require(T('support/compat-shim.js'));
const OUT = process.env.QD_Q1_OUT || path.join(__dirname, 'q1-gate-equivalence.json');
let env;
const results = [];

// read counter around the compat shim: GET = document get (1 read), LIST = query get (documents, at least 1)
function counting(db) {
  const c = { GET: 0, LIST: 0, billed: 0 };
  const wrapQ = q => ({ where: (...a) => wrapQ(q.where(...a)), get: async () => { const s = await q.get(); c.LIST++; c.billed += Math.max(1, s.size); return s; } });
  const wrapRef = r => Object.assign({}, r, { get: async () => { const s = await r.get(); c.GET++; c.billed += 1; return s; }, collection: n => wrapCol(r.collection(n)) });
  const wrapCol = col => ({ doc: id => wrapRef(col.doc(id)), where: (...a) => wrapQ(col.where(...a)), get: () => wrapQ(col).get() });
  return { db: Object.assign({}, db, { collection: n => wrapCol(db.collection(n)) }), c, reset: () => { c.GET = 0; c.LIST = 0; c.billed = 0; } };
}
const pad = n => String(n).padStart(2, '0');
const day = n => `2026-09-${pad(n)}`;
const row = (date, line, shift, qty, extra = {}) => Object.assign({ date, line, shift, model: 'M-100 FR', defectType: 'Dent', scrapQty: qty, remark: '', createdAt: 1 }, extra);
const opts = { email: 'admin@prodv2.local', serverTimestamp };

async function fresh() {
  await env.clearFirestore();
  const raw = env.unauthenticatedContext().firestore();   // local emulator with open test rules (this test checks gate logic, not rules)
  // legacy logs: 10 days x 6 slots, 1-3 logs each; plus 2 excluded logs (invalid shift / date as number)
  let n = 0;
  for (let d = 1; d <= 10; d++) for (const l of ['A', 'B', 'C']) for (const s of ['DAY', 'NIGHT']) for (let i = 0; i < 1 + ((d + i + l.charCodeAt(0)) % 3); i++)
    await setDoc(doc(raw, 'scrapLogs', `L${String(++n).padStart(4, '0')}`), row(day(d), l, s, 1 + (n % 4)));
  await setDoc(doc(raw, 'scrapLogs', 'X1'), row(day(3), 'A', 'MORNING', 2));
  await setDoc(doc(raw, 'scrapLogs', 'X2'), row(20260903, 'A', 'DAY', 2));
  // one slot already in the ledger before the plan (skipped by the baseline)
  await Ledger.applyOps(compatDb(raw), [{ op: 'create', ref: compatDb(raw).collection('scrapLogs').doc('PRE1'), data: row(day(11), 'A', 'DAY', 3) }], opts);
  const db = compatDb(raw);
  const all = async () => { const o = []; (await getDocs(collection(raw, 'scrapLogs'))).forEach(d => o.push(Object.assign({ id: d.id }, d.data()))); return o; };
  const slotIds = async () => { const o = []; (await getDocs(collection(raw, 'scrapSlots'))).forEach(d => o.push(d.id)); return o; };
  const plan = MB.planBaseline(await all(), await slotIds());
  assert.deepEqual(MB.verifyPlan(plan), []);
  return { raw, db, plan };
}
const ref = (raw, c, id) => doc(raw, c, id);
const firstLog = (plan, k = 0) => plan.slots[k].logIds[0];

// scenario: [name, mutate(ctx) , expectExtra]
const S = [
  ['clean after the baseline', async () => {}, false],
  ['log added around the ledger into a planned slot', async ({ raw, plan }) => { const s = plan.slots[0]; await setDoc(ref(raw, 'scrapLogs', 'NEW1'), row(s.date, s.line, s.shift, 2)); }, true],
  ['log added into a brand-new slot (no ledger)', async ({ raw }) => { await setDoc(ref(raw, 'scrapLogs', 'NEW2'), row(day(20), 'B', 'NIGHT', 2)); }, false],
  ['log without createdAt / updatedAt into a planned slot', async ({ raw, plan }) => { const s = plan.slots[3]; await setDoc(ref(raw, 'scrapLogs', 'NOTS1'), { date: s.date, line: s.line, shift: s.shift, model: 'M-100 FR', defectType: 'Dent', scrapQty: 1 }); }, true],
  ['log without timestamps into a new slot', async ({ raw }) => { await setDoc(ref(raw, 'scrapLogs', 'NOTS2'), { date: day(21), line: 'C', shift: 'DAY', model: 'M', defectType: 'D', scrapQty: 1 }); }, false],
  ['log moved between two planned slots', async ({ raw, plan }) => { const b = plan.slots[1]; await updateDoc(ref(raw, 'scrapLogs', firstLog(plan, 0)), { date: b.date, line: b.line, shift: b.shift }); }, true],
  ['swap: two logs exchanged between planned slots, same qty (counts and totals unchanged)', async ({ raw, plan }) => {
    // find two planned slots with a log of the same qty each
    const logs = []; (await getDocs(collection(raw, 'scrapLogs'))).forEach(d => logs.push(Object.assign({ id: d.id }, d.data())));
    const byId = new Map(logs.map(l => [l.id, l]));
    let pair = null;
    for (let i = 0; i < plan.slots.length && !pair; i++) for (let j = i + 1; j < plan.slots.length && !pair; j++)
      for (const a of plan.slots[i].logIds) { const q = byId.get(a).scrapQty; const b = plan.slots[j].logIds.find(x => byId.get(x).scrapQty === q); if (b) { pair = [a, plan.slots[i], b, plan.slots[j]]; break; } }
    const [a, sa, b, sb] = pair;
    await updateDoc(ref(raw, 'scrapLogs', a), { date: sb.date, line: sb.line, shift: sb.shift });
    await updateDoc(ref(raw, 'scrapLogs', b), { date: sa.date, line: sa.line, shift: sa.shift });
  }, true],
  ['model / defect edited around the ledger (count and qty unchanged)', async ({ raw, plan }) => { await updateDoc(ref(raw, 'scrapLogs', firstLog(plan, 2)), { model: 'M-999 XX', defectType: 'Scratch' }); }, true],
  ['quantity edited around the ledger', async ({ raw, plan }) => { await updateDoc(ref(raw, 'scrapLogs', firstLog(plan, 4)), { scrapQty: 99 }); }, true],
  ['log deleted around the ledger', async ({ raw, plan }) => { await deleteDoc(ref(raw, 'scrapLogs', firstLog(plan, 5))); }, true],
  ['excluded log edited into a planned slot', async ({ raw, plan }) => { const s = plan.slots[6]; await updateDoc(ref(raw, 'scrapLogs', 'X1'), { date: s.date, line: s.line, shift: s.shift }); }, true],
  ['excluded log edited into a new slot', async ({ raw }) => { await updateDoc(ref(raw, 'scrapLogs', 'X1'), { shift: 'DAY', date: day(22) }); }, false],
  ['planned slot document deleted', async ({ raw, plan }) => { await deleteDoc(ref(raw, 'scrapSlots', plan.slots[7].slotId)); }, false],
  ['import marker left on a planned slot (CONFLICT)', async ({ raw, plan }) => { await updateDoc(ref(raw, 'scrapSlots', plan.slots[8].slotId), { importPending: 'imp-x' }); }, false],
  ['ledger save after the baseline (logVersion 1: plan is history)', async ({ db, plan }) => { const s = plan.slots[9]; await Ledger.applyOps(db, [{ op: 'create', ref: db.collection('scrapLogs').doc('LED1'), data: row(s.date, s.line, s.shift, 2) }], opts); }, false],
  ['log with date / line of another type in a planned slot (never matches)', async ({ raw, plan }) => { const s = plan.slots[10]; await setDoc(ref(raw, 'scrapLogs', 'TYPE1'), row(s.date, s.line, s.shift, 1, { date: Number(s.date.replace(/-/g, '')) })); }, false],
];

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read, write: if true; } } }", host: '127.0.0.1', port: 8080 } });
});
after(async () => { fs.writeFileSync(OUT, JSON.stringify(results, null, 1)); if (env) await env.cleanup(); });

describe('Q1 gate: new path equals old path (problems), extra checks only where expected', () => {
  for (const [name, mutate, expectExtra] of [...S, ['apply failed half-way (one planned slot missing)', null, false]]) {
    it(name, async () => {
      const ctx = await fresh();
      // baseline (all slots), or with one slot missing for the half-way case
      const slotsToApply = mutate === null ? Object.assign({}, ctx.plan, { slots: ctx.plan.slots.slice(1) }) : ctx.plan;
      const ap = await MB.applyBaseline(ctx.db, slotsToApply, Object.assign({ migrationId: 'q1' }, opts));
      assert.equal(ap.failed.length, 0);
      if (mutate) await mutate(ctx);
      // OLD path
      const o = counting(ctx.db);
      const logsOld = []; (await o.db.collection('scrapLogs').get()).forEach(d => logsOld.push(Object.assign({ id: d.id }, d.data())));
      const oldRes = await MB.completeIfClean(o.db, ctx.plan, 'q1', opts, logsOld);
      const oldReads = Object.assign({}, o.c);
      // reset the completion flag the old path may have written, then NEW path on the same data
      await deleteDoc(doc(ctx.raw, 'qdConfig', 'ledger'));
      const n = counting(ctx.db);
      const logsNew = []; (await n.db.collection('scrapLogs').get()).forEach(d => logsNew.push(Object.assign({ id: d.id }, d.data())));
      const slotsNew = []; (await n.db.collection('scrapSlots').get()).forEach(d => slotsNew.push(Object.assign({ id: d.id }, d.data())));
      const g = MB.gateProblems(ctx.plan, logsNew, slotsNew);
      const newRes = await MB.completeIfClean(n.db, ctx.plan, 'q1', opts, logsNew, slotsNew);
      const newReads = Object.assign({}, n.c);
      const oldProblems = oldRes.complete ? [] : oldRes.problems;
      results.push({ scenario: name, plannedSlots: ctx.plan.slots.length, logs: logsOld.length, old: { complete: oldRes.complete, problems: oldProblems, reads: oldReads },
        new: { complete: newRes.complete, problems: g.problems, extra: g.extra, reads: newReads }, sameProblems: JSON.stringify(g.problems) === JSON.stringify(oldProblems) });
      assert.deepEqual(g.problems, oldProblems, 'same problems, same text and order');
      assert.equal(g.extra.length > 0, expectExtra, 'extra: ' + JSON.stringify(g.extra));
      assert.equal(newRes.complete, oldRes.complete && g.extra.length === 0);
      if (!newRes.complete) assert.deepEqual(newRes.problems, g.problems.concat(g.extra));
    });
  }
});
