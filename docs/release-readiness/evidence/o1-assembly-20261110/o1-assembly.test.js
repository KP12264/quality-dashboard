// O1 — PV2 Assembly Before/After. LOCAL FIRESTORE EMULATOR ONLY, synthetic data. Never Production.
// Before = local copy of production-v2/js/assembly.js @ 431836a (unchanged); After = same copy, line 100 only.
// Both run unchanged in a Node vm with a minimal fake DOM and a read-counting ProdV2DB over the emulator.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.QD_ROOT || path.resolve(__dirname, '../../../..');   // published copy: paths only changed after the run
const T = p => path.join(ROOT, 'tests/node_modules', p);
const W = __dirname;
const OUT = process.env.O1_OUT || path.join(W, 'out');
const PROJECT = 'demo-quality-dashboard';           // demo-* project: the emulator never talks to Google
if (!process.env.FIRESTORE_EMULATOR_HOST || !/^127\.0\.0\.1:/.test(process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('emulator host not set: refusing to run');

const { initializeTestEnvironment, assertSucceeds } = require(T('@firebase/rules-unit-testing'));
const M = require(T('firebase/firestore'));          // modular (seeding, rules matrix)
const fbc = require(T('firebase-compat/compat/app')); const firebase = fbc.default || fbc;
require(T('firebase-compat/compat/firestore'));
const COMPAT_VERSION = require(T('firebase-compat/package.json')).version;

const SRCDIR = process.env.O1_SRC || path.join(W, 'src');   // before.js = PV2 431836a production-v2/js/assembly.js; after.js = before.js + out/o1-after.diff
const SRC = { before: fs.readFileSync(path.join(SRCDIR, 'before.js'), 'utf8'), after: fs.readFileSync(path.join(SRCDIR, 'after.js'), 'utf8') };
const OPEN = "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read, write: if true; } } }";
const RULES = {
  production: fs.readFileSync(path.join(ROOT, 'emulator/production.firestore.rules.snapshot'), 'utf8'),
  repoPv2: fs.readFileSync(path.join(ROOT, 'emulator/production-v2.firestore.rules.snapshot'), 'utf8'),
  candidate: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'),
  bridge: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules.bridge'), 'utf8')
};
const C = 'prodV2_actualLogs';

// ---------- synthetic data ----------
const pad = n => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = localDate();
const DAYS = []; for (let d = new Date('2026-07-01T12:00:00'); localDate(d) <= '2026-10-28'; d.setDate(d.getDate() + 1)) DAYS.push(localDate(d));
// real (Model, Door) pairs from the POOLS table in the file under test, so every cabinet row renders from data
const PAIRS = [...new Set((SRC.before.match(/const POOLS=\{[\s\S]*?\n\};/) || [''])[0].match(/\["[^"]+","[^"]+"\]/g))].map(s => JSON.parse(s));
const LINES = ['A', 'B', 'C'], SHIFTS = ['DAY', 'NIGHT'];
const D1 = '2026-10-05', D2 = '2026-10-06', EMPTY = '2026-11-30';
const mark = id => `m|||ID:${id}|||-`;                  // one marker cell per document → totals reveal exactly which documents matched
function cells(id, seed) {
  const o = { [mark(id)]: 1 };
  for (let i = 0; i < 12; i++) { const [m, d] = PAIRS[(seed * 7 + i * 5) % PAIRS.length]; o[`${i + 1}|||${m}|||${d}`] = ((seed * 13 + i * 3) % 9) + 1; }
  return o;
}
function seedDocs() {
  const docs = []; let n = 0;
  for (const date of [...DAYS, TODAY]) for (const l of LINES) for (const s of SHIFTS) { const id = `actual_${date}_${l}_${s}`; docs.push([id, { date, lineId: l, shift: s, actualByCell: cells(id, n++) }]); }
  const e = (id, data, withMark = true) => docs.push([id, Object.assign({ lineId: 'A' }, data, withMark && !('actualByCell' in data) ? { actualByCell: cells(id, n++) } : {})]);
  e('e01_num', { date: 20261005, shift: 'DAY' });
  e('e02_nodate', { shift: 'DAY' });
  e('e03_ts', { date: M.Timestamp.fromDate(new Date('2026-10-05T00:00:00Z')), shift: 'DAY' });
  e('e04_space', { date: '2026-10-05 ', shift: 'DAY' });
  e('e05_fmt', { date: '05/10/2026', shift: 'DAY' });
  e('e06_arr', { date: ['2026-10-05'], shift: 'DAY' });
  e('e07_noshift', { date: D1 });
  e('e08_lower', { date: D1, shift: 'day' });
  e('e09_morning', { date: D1, shift: 'MORNING' });
  e('e10_missing', { date: D1, shift: 'DAY' }, false);
  e('e10_null', { date: D1, shift: 'DAY', actualByCell: null });
  e('e10_string', { date: D1, shift: 'DAY', actualByCell: 'abc|||x|||y' });
  e('e10_array', { date: D1, shift: 'DAY', actualByCell: [1, 2, 3] });
  e('e11_short', { date: D2, shift: 'DAY', actualByCell: { [mark('e11_short')]: 1, 'M-100': 5, '1|||M-100': 3 } });
  const [pm, pd] = PAIRS[0], [qm, qd] = PAIRS[1], [rm, rd] = PAIRS[2];
  e('e12_values', { date: D2, shift: 'NIGHT', actualByCell: { [mark('e12_values')]: 1, [`1|||${pm}|||${pd}`]: '5', [`2|||${pm}|||${pd}`]: -3, [`3|||${qm}|||${qd}`]: 2.5, [`4|||${qm}|||${qd}`]: 0, [`5|||${qm}|||${qd}`]: null, [`6|||${rm}|||${rd}`]: 'abc' } });
  e('Xk9r2QpL7mNz', { date: D2, shift: 'DAY' });                                   // E13 non-standard id
  e('actual_2026-10-06_A_DAY_dup', { date: D2, shift: 'DAY' });                    // E14 duplicate slot, other id
  const big = { [mark('e16_big')]: 1 }; for (let i = 0; i < 200; i++) { const [m, d] = PAIRS[i % PAIRS.length]; big[`${i}|||${m}|||${d}`] = (i % 7) + 1; }
  e('e16_big', { date: D2, shift: 'NIGHT', actualByCell: big });
  e('e17_text', { date: D1, shift: 'NIGHT', actualByCell: { [mark('e17_text')]: 1, '1|||รุ่น ทดสอบ & <b>"x"\'|||ประตู <i>': 4, [`2|||${pm}|||${pd}`]: 6 } });
  return docs;
}
const DOCS = seedDocs();
const EXTRA = [ // E18 subcollection under an actual document, E19 other prodV2_* collections on the same date
  [`${C}/actual_${D1}_A_DAY/history/h1`, { date: D1, shift: 'DAY', actualByCell: { [mark('E18')]: 1 } }],
  ['prodV2_lossLogs/l1', { date: D1, lineId: 'A', shift: 'DAY', minutes: 5 }],
  ['prodV2_dailyPlans/plan_2026-10-05_A_DAY', { date: D1, lineId: 'A', shift: 'DAY', actualByCell: { [mark('E19')]: 1 } }]
];
async function seed(fs_) {
  const all = DOCS.map(([id, d]) => [`${C}/${id}`, d]).concat(EXTRA);
  for (let i = 0; i < all.length; i += 400) { const b = M.writeBatch(fs_); all.slice(i, i + 400).forEach(([p, d]) => b.set(M.doc(fs_, p), d)); await b.commit(); }
}
// independent expectation from the seed (not from the code under test)
function expected(date, shift) {
  const m = DOCS.filter(([, d]) => d.date === date && (!shift || d.shift === shift));
  return { count: m.length, marked: m.filter(([, d]) => d.actualByCell && typeof d.actualByCell === 'object' && Object.keys(d.actualByCell).some(k => k.startsWith('m|||ID:'))).map(([id]) => id).sort(), sameDate: DOCS.filter(([, d]) => d.date === date).length };
}

// ---------- read-counting ProdV2DB (same shape as production-v2/js/firebase-v2.js) ----------
function countingDb(db) {
  const c = { GET: 0, LIST: 0, billed: 0, fail: false, calls: [] };
  const q = (ref, desc) => ({
    where: (f, o, v) => q(ref.where(f, o, v), desc + `.where(${f}${o}${JSON.stringify(v)})`),
    get: async () => { if (c.fail) throw new Error('simulated read failure'); const s = await ref.get(); c.LIST++; c.billed += Math.max(1, s.size); c.calls.push(desc + ' → ' + s.size); return s; },
    doc: id => ({ get: async () => { const s = await ref.doc(id).get(); c.GET++; c.billed++; return s; } })
  });
  return { c, api: { collection: n => { if (typeof n !== 'string' || !n.startsWith('prodV2_')) throw new Error('SAFETY BLOCK'); return q(db.collection(n), n); } } };
}

// ---------- minimal fake DOM + page runner ----------
function el(id) {
  const e = { id, value: '', innerHTML: '', className: '', _t: '', hist: [], ls: {}, onclick: null, onchange: null,
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); } };
  Object.defineProperty(e, 'textContent', { get() { return this._t; }, set(v) { this._t = String(v); this.hist.push(this._t); } });
  return e;
}
async function page(which, db) {
  const ids = ['asmDate', 'asmShift', 'asmGroupFilter', 'asmLoadBtn', 'asmResults', 'asmStatus', 'asmMessage'];
  const E = Object.fromEntries(ids.map(i => [i, el(i)])); const unknown = [];
  const cdb = countingDb(db);
  const ctx = { document: { readyState: 'complete', getElementById: i => E[i] || (unknown.push(i), null) }, addEventListener: () => {}, ProdV2DB: cdb.api, console };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(SRC[which], ctx, { filename: which + '.js' });
  await settle();
  return { E, ctx, c: cdb.c, unknown, loads: () => E.asmStatus.hist.filter(t => t.startsWith('Loading')).length };
}
const settle = () => new Promise(r => setTimeout(r, 0)).then(() => new Promise(r => setImmediate(r)));
async function waitDone(p) { for (let i = 0; i < 2000; i++) { const s = p.E.asmStatus._t; if (!s.startsWith('Loading')) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('load did not finish'); }
const ser = t => t == null ? null : Object.entries(t).map(([k, v]) => [k, Object.is(v, NaN) ? 'NaN' : v]).sort((a, b) => a[0] < b[0] ? -1 : 1);
function snap(p) {
  const msg = p.E.asmMessage._t; const m = msg.match(/รวม (\d+) Actual Log/);
  const totals = p.ctx.currentAsmTotals;
  return { totals: ser(totals), keyOrder: totals ? Object.keys(totals) : null, matched: m ? Number(m[1]) : null, message: msg, msgClass: p.E.asmMessage.className,
    status: p.E.asmStatus._t, statusClass: p.E.asmStatus.className, html: p.E.asmResults.innerHTML,
    markedIds: totals ? Object.keys(totals).filter(k => k.startsWith('ID:')).map(k => k.split('|||')[0].slice(3)).sort() : null }; // assembly.js keys totals by parts[1]|||parts[2]
}
async function act(p, fn) { const b = { ...p.c }, l = p.loads(); await fn(); await settle(); await waitDone(p);
  return { reads: { GET: p.c.GET - b.GET, LIST: p.c.LIST - b.LIST, billed: p.c.billed - b.billed }, loads: p.loads() - l, ...snap(p) }; }

// ---------- run ----------
let env, app, db; const R = { meta: {}, cases: [], triggers: [], filters: [], rules: [], summary: {} };
const TOTAL_DOCS = DOCS.length;

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: OPEN, host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await seed(env.unauthenticatedContext().firestore());
  app = firebase.initializeApp({ projectId: PROJECT }, 'o1');
  db = app.firestore(); db.useEmulator('127.0.0.1', 8080);
  R.meta = { emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, project: PROJECT, compatSdk: COMPAT_VERSION, node: process.version, today: TODAY,
    baseDays: DAYS.length, firstDay: DAYS[0], lastDay: DAYS[DAYS.length - 1], actualDocs: TOTAL_DOCS, pairsFromPools: PAIRS.length };
});
after(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'o1-results.json'), JSON.stringify(R, null, 1));
  if (app) await app.delete(); if (env) await env.cleanup();
});

describe('O1 Assembly: Before vs After (emulator, synthetic data)', () => {
  let B, A;
  it('S5: the two copies differ in exactly one line (line 100)', () => {
    const b = SRC.before.split('\n'), a = SRC.after.split('\n');
    assert.equal(b.length, a.length);
    const d = b.map((x, i) => x === a[i] ? null : i + 1).filter(Boolean);
    assert.deepEqual(d, [100]);
  });

  it('page open (init → load for today): same output, After reads only today', async () => {
    B = await page('before', db); A = await page('after', db);
    await waitDone(B); await waitDone(A);
    const sb = snap(B), sa = snap(A), ex = expected(TODAY, '');
    R.triggers.push({ trigger: 'page open', date: TODAY, before: { reads: { ...B.c, calls: undefined, fail: undefined }, loads: B.loads() }, after: { reads: { ...A.c, calls: undefined, fail: undefined }, loads: A.loads() }, same: JSON.stringify({ ...sb, keyOrder: 0 }) === JSON.stringify({ ...sa, keyOrder: 0 }) });
    assert.deepEqual(B.unknown, []); assert.deepEqual(A.unknown, []);
    assert.equal(B.loads(), 1); assert.equal(A.loads(), 1);
    assert.equal(B.c.billed, TOTAL_DOCS); assert.equal(A.c.billed, Math.max(1, ex.sameDate));
    assert.deepEqual({ ...sa, keyOrder: 0 }, { ...sb, keyOrder: 0 });
    assert.equal(sb.matched, ex.count); assert.deepEqual(sb.markedIds, ex.marked);
  });

  it('S1–S3: every date × shift (Date change, Shift change): identical output, matched set = seed, reads', async () => {
    let diffs = 0, orderDiff = 0;
    for (const date of [...DAYS, EMPTY]) {
      for (const [i, shift] of ['', 'DAY', 'NIGHT'].entries()) {
        const step = async p => { if (i === 0) { p.E.asmShift.value = ''; p.E.asmDate.value = date; await p.E.asmDate.onchange(); } else { p.E.asmShift.value = shift; await p.E.asmShift.onchange(); } };
        const rb = await act(B, () => step(B)), ra = await act(A, () => step(A));
        const ex = expected(date, shift);
        const same = JSON.stringify({ ...rb, reads: 0, keyOrder: 0 }) === JSON.stringify({ ...ra, reads: 0, keyOrder: 0 });
        if (!same) diffs++; if (JSON.stringify(rb.keyOrder) !== JSON.stringify(ra.keyOrder)) orderDiff++;
        R.cases.push({ date, shift: shift || 'ALL', trigger: i === 0 ? 'date change' : 'shift change', before: rb.reads, after: ra.reads, loadsBefore: rb.loads, loadsAfter: ra.loads, matched: rb.matched, expected: ex.count, same, setOk: JSON.stringify(rb.markedIds) === JSON.stringify(ex.marked) && rb.matched === ex.count });
        assert.ok(same, `output differs for ${date} ${shift || 'ALL'}`);
        assert.equal(rb.matched, ex.count, `matched count ${date} ${shift}`); assert.deepEqual(rb.markedIds, ex.marked, `matched set ${date} ${shift}`);
        assert.equal(rb.loads, 1); assert.equal(ra.loads, 1);
        assert.equal(rb.reads.billed, TOTAL_DOCS); assert.equal(ra.reads.billed, Math.max(1, ex.sameDate));
        assert.equal(rb.reads.LIST, 1); assert.equal(ra.reads.LIST, 1); assert.equal(ra.reads.GET + rb.reads.GET, 0);
      }
    }
    R.summary.cases = R.cases.length; R.summary.caseDiffs = diffs; R.summary.keyOrderDiffs = orderDiff;
  });

  it('E1–E17 edge dates in detail (D1, D2) incl. shift "", DAY, NIGHT: identical and as expected', async () => {
    for (const date of [D1, D2]) for (const shift of ['', 'DAY', 'NIGHT']) {
      const step = async p => { p.E.asmShift.value = shift; p.E.asmDate.value = date; await p.E.asmLoadBtn.onclick(); };
      const rb = await act(B, () => step(B)), ra = await act(A, () => step(A)), ex = expected(date, shift);
      R.triggers.push({ trigger: 'Load button', date, shift: shift || 'ALL', before: rb.reads, after: ra.reads, loads: [rb.loads, ra.loads], matched: rb.matched, expected: ex.count, markedIds: rb.markedIds });
      assert.deepEqual({ ...ra, reads: 0, keyOrder: 0 }, { ...rb, reads: 0, keyOrder: 0 });
      assert.equal(rb.matched, ex.count); assert.deepEqual(rb.markedIds, ex.marked);
      assert.equal(rb.loads, 1); assert.equal(ra.loads, 1);
    }
    // explicit edge expectations
    const ids = s => expected(D1, s).marked;
    for (const x of ['e01_num', 'e02_nodate', 'e03_ts', 'e04_space', 'e05_fmt', 'e06_arr']) assert.ok(!ids('').includes(x), x + ' must never match');
    for (const x of ['e07_noshift', 'e08_lower', 'e09_morning']) { assert.ok(ids('').includes(x)); assert.ok(!ids('DAY').includes(x) && !ids('NIGHT').includes(x)); }
    assert.ok(expected(D2, 'DAY').marked.includes('Xk9r2QpL7mNz'), 'E13 non-standard id counted');
    assert.ok(expected(D2, 'DAY').marked.includes('actual_2026-10-06_A_DAY_dup'), 'E14 duplicate counted');
    assert.equal(expected(D1, 'DAY').count - expected(D1, 'DAY').marked.length, 4, 'E10: four documents without usable cells still counted');
  });

  it('E12 values and E17 text: NaN / strings / negatives give the same totals and escaped HTML', async () => {
    for (const [date, shift] of [[D2, 'NIGHT'], [D1, 'NIGHT']]) {
      const step = async p => { p.E.asmShift.value = shift; p.E.asmDate.value = date; await p.E.asmLoadBtn.onclick(); };
      const rb = await act(B, () => step(B)), ra = await act(A, () => step(A));
      assert.deepEqual(ra.totals, rb.totals); assert.equal(ra.html, rb.html);
      if (date === D2) R.summary.e12NaNInTotals = rb.totals.some(([, v]) => v === 'NaN');   // (x||0) turns an earlier NaN back into 0, so NaN need not remain
      if (date === D1) assert.ok(!/<b>"x"/.test(rb.html), 'E17 text is not rendered raw');
    }
  });

  it('E18 / E19: subcollection and other collections never counted', () => {
    const all = R.cases.filter(c => c.date === D1);
    assert.ok(all.every(c => c.setOk));
    assert.ok(!expected(D1, '').marked.includes('E18') && !expected(D1, '').marked.includes('E19'));
  });

  it('Model filter change: 0 reads, same HTML for every group', async () => {
    for (const p of [B, A]) { p.E.asmShift.value = ''; p.E.asmDate.value = D2; await p.E.asmLoadBtn.onclick(); await waitDone(p); }
    const groups = [...B.E.asmGroupFilter.innerHTML.matchAll(/value="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    assert.ok(groups.length > 5);
    for (const g of groups) {
      const r = {};
      for (const [k, p] of [['before', B], ['after', A]]) { const b = p.c.billed; p.E.asmGroupFilter.value = g; (p.E.asmGroupFilter.ls.change || []).forEach(f => f()); r[k] = { html: p.E.asmResults.innerHTML, reads: p.c.billed - b }; }
      R.filters.push({ group: g || 'ALL', readsBefore: r.before.reads, readsAfter: r.after.reads, same: r.before.html === r.after.html });
      assert.equal(r.before.reads, 0); assert.equal(r.after.reads, 0); assert.equal(r.after.html, r.before.html);
    }
    for (const p of [B, A]) p.E.asmGroupFilter.value = '';
  });

  it('empty date: early return, 0 reads, same message in both', async () => {
    const r = {};
    for (const [k, p] of [['before', B], ['after', A]]) { const b = p.c.billed, l = p.loads(); p.E.asmDate.value = ''; await p.E.asmDate.onchange(); r[k] = { reads: p.c.billed - b, loads: p.loads() - l, msg: p.E.asmMessage._t, cls: p.E.asmMessage.className }; }
    R.triggers.push({ trigger: 'empty date', before: r.before, after: r.after });
    assert.deepEqual(r.after, r.before); assert.equal(r.before.reads, 0); assert.equal(r.before.loads, 0);
  });

  it('read failure: both show the same "Load failed" path', async () => {
    const r = {};
    for (const [k, p] of [['before', B], ['after', A]]) { p.c.fail = true; p.E.asmDate.value = D1; await p.E.asmLoadBtn.onclick(); await settle(); r[k] = { status: p.E.asmStatus._t, cls: p.E.asmStatus.className, msg: p.E.asmMessage._t }; p.c.fail = false; }
    R.triggers.push({ trigger: 'read failure', before: r.before, after: r.after });
    assert.deepEqual(r.after, r.before); assert.equal(r.before.status, 'Load failed');
  });
});

describe('S6: the After query under the four rules files (unchanged), anonymous and signed in', () => {
  for (const [name, rules] of Object.entries(RULES)) {
    it(`${name}: whole collection (Before) and where date== (After) both allowed; same documents for the date`, async () => {
      const e = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules, host: '127.0.0.1', port: 8080 } });
      try {
        await e.clearFirestore();
        await e.withSecurityRulesDisabled(async ctx => { const f = ctx.firestore(); const b = M.writeBatch(f);
          DOCS.filter(([, d]) => d.date === D1 || d.date === D2).forEach(([id, d]) => b.set(M.doc(f, C, id), d));
          b.set(M.doc(f, C, 'actual_2026-10-07_A_DAY'), { date: '2026-10-07', shift: 'DAY', lineId: 'A' });
          b.set(M.doc(f, 'prodV2_authorizedUsers', 'pv2w@prodv2.local'), { active: true }); await b.commit(); });
        const ctxs = { anonymous: e.unauthenticatedContext(), signedInListed: e.authenticatedContext('PV2W', { email: 'pv2w@prodv2.local', email_verified: true }), signedInOther: e.authenticatedContext('OTHER', { email: 'other@prodv2.local', email_verified: true }) };
        for (const [who, ctx] of Object.entries(ctxs)) {
          const f = ctx.firestore();
          const whole = await assertSucceeds(M.getDocs(M.collection(f, C)));
          const q = await assertSucceeds(M.getDocs(M.query(M.collection(f, C), M.where('date', '==', D1))));
          const exp = whole.docs.filter(d => d.data().date === D1).map(d => d.id).sort();
          R.rules.push({ rules: name, who, wholeOk: true, queryOk: true, queryDocs: q.size, matchesClientFilter: JSON.stringify(q.docs.map(d => d.id).sort()) === JSON.stringify(exp) });
          assert.deepEqual(q.docs.map(d => d.id).sort(), exp);
        }
      } finally { await e.cleanup(); }
    });
  }
});
