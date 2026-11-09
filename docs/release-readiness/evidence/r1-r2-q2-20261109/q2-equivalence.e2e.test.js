// Q2a / Q2b equivalence — Firebase EMULATOR ONLY. Real compat SDK in a browser page (improvement.html).
// For each synthetic data shape: new ImprovementAdapter.getImprovements(db, { limit: 200 }) must return
// exactly what the OLD algorithm (full read, sort by createdAt||0 desc, slice) returns; reads are counted.
// getImprovementById(id) must match the OLD edit-page lookup (full read + find).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const ROOT = process.env.QD_ROOT || '/home/user/quality-dashboard';
const T = p => path.join(ROOT, 'tests', p);
const { initializeTestEnvironment } = require(T('node_modules/@firebase/rules-unit-testing'));
const { Timestamp } = require(T('node_modules/firebase/firestore'));
const PORT = 5518, BASE = `http://127.0.0.1:${PORT}`, PROJECT = 'demo-quality-dashboard';
const SDK = T('node_modules/firebase-compat');
const OUTFILE = process.env.QD_Q2_OUT || path.join(__dirname, 'q2-equivalence.json');
let env, server, browser, page, context;
const out = [];

const COUNT = () => {
  window.__qdReads = { LIST: 0, GET: 0, billed: 0 };
  const wrap = (o, kind) => new Proxy(o, { get(t, p) {
    const v = t[p];
    if (['where', 'orderBy', 'limit'].includes(p)) return (...a) => wrap(v.apply(t, a), kind);
    if (p === 'doc') return (...a) => wrap(v.apply(t, a), 'GET');
    if (p === 'get') return async (...a) => { const s = await v.apply(t, a); const R = window.__qdReads; R[kind]++; R.billed += kind === 'GET' ? 1 : Math.max(1, s.size); return s; };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  let real = null;
  Object.defineProperty(window, 'qdDb', { configurable: true, get: () => real, set: v => { real = v ? new Proxy(v, { get(t, p) { if (p === 'collection') return n => wrap(t.collection(n), 'LIST'); const x = t[p]; return typeof x === 'function' ? x.bind(t) : x; } }) : v; } });
};

async function seed(docs) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const old = await db.collection('improvements').get();
    for (const d of old.docs) await d.ref.delete();
    for (const [id, data] of docs) await db.collection('improvements').doc(id).set(data);
  });
}
const STAT = ['Monitoring', 'Controlled', 'Not Effective', 'Recurring'];
const mk = (n, f) => Array.from({ length: n }, (_, i) => { const d = { problem: 'p' + i, defectType: 'D' + (i % 3), status: STAT[(i * 7) % 4] }; const c = f(i); if (c !== undefined) d.createdAt = c; return [`imp${String(i).padStart(4, '0')}`, d]; });
const BASE_MS = Date.UTC(2026, 0, 1);
const SCENARIOS = [
  ['I = 0', () => []],
  ['I = 1', () => mk(1, i => BASE_MS + i)],
  ['I = 200, all with createdAt', () => mk(200, i => BASE_MS + i * 1000)],
  ['I = 201, all with createdAt', () => mk(201, i => BASE_MS + i * 1000)],
  ['I = 500, all with createdAt', () => mk(500, i => BASE_MS + i * 1000)],
  ['I = 250, 5 without createdAt', () => mk(250, i => i < 5 ? undefined : BASE_MS + i * 1000)],
  ['I = 205, 10 without createdAt (only 195 have it)', () => mk(205, i => i < 10 ? undefined : BASE_MS + i * 1000)],
  ['I = 260, tie at the cut (#200 and #201 equal)', () => mk(260, i => BASE_MS + (i === 59 ? 60 : i) * 1000)],
  ['I = 260, ties inside the top 200 only', () => mk(260, i => BASE_MS + (i >= 100 && i < 110 ? 100 : i) * 1000)],
  ['I = 260, some createdAt are Timestamps', () => mk(260, i => i % 50 === 0 ? Timestamp.fromMillis(BASE_MS + i * 1000) : BASE_MS + i * 1000)],
  ['I = 260, some createdAt are strings', () => mk(260, i => i % 40 === 0 ? '2026-01-01' : BASE_MS + i * 1000)],
  ['I = 260, some createdAt null / 0 / negative', () => mk(260, i => i % 30 === 0 ? null : i % 31 === 0 ? 0 : i % 37 === 0 ? -5 : BASE_MS + i * 1000)],
  ['I = 260, all createdAt tiny numbers (<= 1)', () => mk(260, i => i % 2)],
];

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
  context = await browser.newContext();
  await context.addInitScript(COUNT);
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith('http://127.0.0.1:9099')) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  page = await context.newPage();
  page.on('request', r => { if (/firestore\.googleapis\.com|identitytoolkit\.googleapis\.com/.test(r.url())) throw new Error('REAL BACKEND REQUEST ' + r.url()); });
  await page.goto(`${BASE}/improvement.html?qdEmulator=1`);
  await page.waitForFunction(() => window.ImprovementAdapter && window.qdDb, null, { timeout: 30000 });
});
after(async () => {
  fs.writeFileSync(OUTFILE, JSON.stringify(out, null, 1));
  if (browser) await browser.close(); if (server) server.kill(); if (env) await env.cleanup();
});

// The OLD algorithm, copied from js/improvement-adapter.js before the change.
const compare = () => (async () => {
  const A = window.ImprovementAdapter;
  window.__qdReads = { LIST: 0, GET: 0, billed: 0 };
  const neu = await A.getImprovements(window.qdDb, { limit: 200 });
  const reads = Object.assign({}, window.__qdReads);
  const snap = await window.qdDb.collection('improvements').get();
  const records = []; snap.forEach(doc => { const r = A.normalizeImprovement(doc.id, doc.data()); if (r) records.push(r); });
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const old = records.slice(0, 200);
  const ser = r => JSON.stringify(r, (k, v) => (v && typeof v === 'object' && 'seconds' in v && 'nanoseconds' in v) ? `TS(${v.seconds},${v.nanoseconds})` : v);
  return { equal: neu.records.length === old.length && neu.records.every((r, i) => ser(r) === ser(old[i])),
    newIds: neu.records.map(r => r.id), oldIds: old.map(r => r.id), error: neu.error ? String(neu.error) : null, reads, total: snap.size };
})();

describe('Q2a getImprovements({ limit: 200 }) equals the old full read', () => {
  for (const [name, gen] of SCENARIOS) {
    it(name, async () => {
      await seed(gen());
      const r = await page.evaluate(compare);
      out.push({ test: 'Q2a', scenario: name, equal: r.equal, total: r.total, reads: r.reads, path: r.reads.LIST === 1 && r.reads.billed <= 201 && r.total > 201 ? 'server newest 201' : (r.reads.LIST === 2 ? 'tried newest, fell back to full read' : 'full read') });
      assert.equal(r.error, null);
      assert.ok(r.equal, `${name}: new ${r.newIds.slice(0, 5)}… vs old ${r.oldIds.slice(0, 5)}…`);
    });
  }
});

describe('Q2b getImprovementById equals the old edit-page lookup', () => {
  it('existing, unknown, "/" in id, subcollection-like id', async () => {
    await seed(mk(260, i => BASE_MS + i * 1000));
    for (const id of ['imp0120', 'imp0000', 'does-not-exist', 'a/b', 'imp0001/x/y']) {
      const r = await page.evaluate(async id => {
        const A = window.ImprovementAdapter;
        window.__qdReads = { LIST: 0, GET: 0, billed: 0 };
        const { record, error } = await A.getImprovementById(window.qdDb, id);
        const reads = Object.assign({}, window.__qdReads);
        const { records } = await A.getImprovements(window.qdDb, {});
        const old = records.find(r => r.id === id);
        return { same: JSON.stringify(record || undefined) === JSON.stringify(old), found: !!record, error: error ? String(error) : null, reads };
      }, id);
      out.push({ test: 'Q2b', id, same: r.same, found: r.found, reads: r.reads });
      assert.ok(r.same, id); assert.equal(r.error, null, id);
    }
  });
});
