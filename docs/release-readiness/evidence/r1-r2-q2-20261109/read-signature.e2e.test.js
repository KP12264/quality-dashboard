// R1: QD read signature per action — Firebase EMULATOR ONLY (project demo-quality-dashboard).
// Never connects to Production: the page runs with ?qdEmulator=1, the Firebase SDK is served
// from node_modules, and every request outside 127.0.0.1 is answered locally with an empty body.
// Seed: tests/support/release-seed.js (synthetic month) + synthetic improvements
// (QD_SIG_IMPROVEMENTS, default 250; QD_SIG_NO_CREATED of them without createdAt, default 5).
// Output: JSON with, per action, LIST (query get) / GET (document get) calls, documents returned and
// estimated billed reads, plus the visible text of the sections used to compare before / after.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const ROOT = process.env.QD_ROOT || '/home/user/quality-dashboard';
const T = p => path.join(ROOT, 'tests', p);
const { initializeTestEnvironment } = require(T('node_modules/@firebase/rules-unit-testing'));
const { seedRelease } = require(T('support/release-seed.js'));

const PORT = 5517, BASE = `http://127.0.0.1:${PORT}`, PROJECT = 'demo-quality-dashboard';
const SDK = T('node_modules/firebase-compat'), CHART = T('node_modules/chart.js/dist/chart.umd.min.js');
const OUTFILE = process.env.QD_SIG_OUT || path.join(__dirname, 'signature.json');
const N_IMP = Number(process.env.QD_SIG_IMPROVEMENTS || 250), N_NOCREATED = Number(process.env.QD_SIG_NO_CREATED || 5);
let env, server, browser, M;
const results = [];

// Browser-side counter: LIST = get() on a collection/query, GET = get() on a document reference.
const COUNT = () => {
  window.__qdReads = {};
  const bump = (name, kind, s) => {
    const R = window.__qdReads; const r = R[name] = R[name] || { LIST: 0, GET: 0, docs: 0, billed: 0 };
    r[kind]++; const n = kind === 'GET' ? 1 : (typeof s.size === 'number' ? s.size : 1);
    r.docs += kind === 'GET' ? (s.exists ? 1 : 0) : n; r.billed += Math.max(1, n);
  };
  const wrap = (o, name, kind) => new Proxy(o, { get(t, p) {
    const v = t[p];
    if (['where', 'orderBy', 'limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore'].includes(p)) return (...a) => wrap(v.apply(t, a), name, kind);
    if (p === 'doc') return (...a) => wrap(v.apply(t, a), name, 'GET');
    if (p === 'collection') return (...a) => wrap(v.apply(t, a), name + '/' + a[0], 'LIST');
    if (p === 'get') return async (...a) => { const s = await v.apply(t, a); bump(name, kind, s); return s; };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  let real = null;
  Object.defineProperty(window, 'qdDb', { configurable: true, get: () => real, set: v => { real = v ? new Proxy(v, { get(t, p) { if (p === 'collection') return n => wrap(t.collection(n), n, 'LIST'); const x = t[p]; return typeof x === 'function' ? x.bind(t) : x; } }) : v; } });
};

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(COUNT);
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/chart\.umd(\.min)?\.js/.test(url)) return route.fulfill({ path: CHART, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith('http://127.0.0.1:9099')) return route.continue();
    return route.fulfill({ status: 200, body: '' });   // nothing leaves the machine
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  // hard guard: the page must use the emulator, never a real project
  page.on('request', r => { const u = r.url(); if (/firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/.test(u)) errors.push('REAL BACKEND REQUEST: ' + u); });
  return { page, context, errors };
}
const q = () => `qdEmulator=1&qdCloseFrom=${M.closeFrom}`;
const resetReads = page => page.evaluate(() => { window.__qdReads = {}; });
async function settle(page, ready) {
  if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
  let last = '', same = 0;
  for (let i = 0; i < 120 && same < 6; i++) {
    await page.waitForTimeout(250);
    const now = await page.evaluate(() => JSON.stringify(window.__qdReads));
    same = now === last ? same + 1 : 0; last = now;
  }
}
const reads = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__qdReads)));
const text = (page, ids) => page.evaluate(ids => Object.fromEntries(ids.map(id => { const e = document.getElementById(id); return [id, e ? e.innerText.replace(/\s+/g, ' ').trim() : null]; })), ids);
const dashReady = () => window.__qdPlanCard && window.__qdPlanCard.month && !/Loading/.test(document.getElementById('attentionSummary').textContent);
async function dashRange(page, from, to) {
  await page.evaluate(() => { window.__qdPlanCard = null; });
  await page.evaluate(([f, t]) => { const a = document.getElementById('dateFrom'), z = document.getElementById('dateTo'); z.value = t; a.value = f; z.dispatchEvent(new Event('change')); }, [from, to]);
  await settle(page, dashReady);
}
function record(screen, action, r, view, note = '') { results.push({ screen, action, reads: r, view, note }); }
const DASH_IDS = ['kpiSection', 'planCard', 'topDefectsCard', 'doorLineCard', 'attentionSummary', 'paretoCard'];

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
  await env.clearFirestore();
  M = await seedRelease(env);
  // synthetic improvements: newest first by createdAt; some without createdAt (older data shape)
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const STAT = ['Monitoring', 'Controlled', 'Not Effective', 'Recurring'];
    const DEF = ['บุบ (Dent)', 'รอยขีดข่วน (Scratch)', 'ช่องว่าง/ระดับไม่เสมอ (Gap / Flush NG)'];
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < N_IMP; i++) {
      const d = { problem: `Synthetic improvement ${i}`, defectType: DEF[i % 3], line: ['A', 'B', 'C'][i % 3], model: ['M-100 FR', 'M-200 FR', 'M-300 RR'][i % 3],
        status: STAT[(i * 7) % 4], actions: [], whys: ['', '', '', '', ''] };
      if (i >= N_NOCREATED) d.createdAt = base + i * 3600000;   // the first N_NOCREATED have no createdAt
      await db.collection('improvements').doc(`imp${String(i).padStart(4, '0')}`).set(d);
    }
  });
});
after(async () => {
  fs.writeFileSync(OUTFILE, JSON.stringify({ seed: { ym: M && M.ym, improvements: N_IMP, withoutCreatedAt: N_NOCREATED }, results }, null, 1));
  if (browser) await browser.close();
  if (server) server.kill();
  if (env) await env.cleanup();
});

describe('R1 read signature', () => {
  it('Dashboard: open (today), 1 day, 31 days, Refresh (31 days)', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/index.html?${q()}`); await settle(page, dashReady);
    record('Dashboard', 'open (default today)', await reads(page), await text(page, DASH_IDS));
    await resetReads(page); await dashRange(page, M.d(M.nDays), M.d(M.nDays));
    record('Dashboard', '1 day', await reads(page), await text(page, DASH_IDS));
    await resetReads(page); await dashRange(page, M.d(1), M.d(M.nDays));
    record('Dashboard', `${M.nDays} days`, await reads(page), await text(page, DASH_IDS));
    await resetReads(page); await page.evaluate(() => { window.__qdPlanCard = null; }); await page.click('#refreshBtn'); await settle(page, dashReady);
    record('Dashboard', `Refresh (${M.nDays} days)`, await reads(page), await text(page, DASH_IDS));
    await resetReads(page);
    await page.click('#shiftFilter [data-shift="DAY"]'); await page.click('#lineFilter [data-line="A"]'); await settle(page, dashReady);
    record('Dashboard', 'filters Shift=Day + Line=Door A', await reads(page), await text(page, DASH_IDS));
    await page.click('#shiftFilter [data-shift="all"]'); await page.click('#lineFilter [data-line="all"]'); await settle(page, dashReady);
    assert.deepEqual(errors, []);
    await context.close();
  });
  it('Weekly Plan: open the seeded month', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/weekly-plan.html?${q()}&ym=${M.ym}`);
    await settle(page, () => window.__qdWeeklyPlan && window.__qdWeeklyPlan.month && document.getElementById('wpWeeksTable'));
    await page.click('#wpImprove [data-scope="month"]').catch(() => {});
    await page.waitForTimeout(300);
    record('Weekly Plan', 'open month', await reads(page), await text(page, ['wpMonth', 'wpWeeks', 'wpImprove']));
    assert.deepEqual(errors, []);
    await context.close();
  });
  it('Scrap Detail: open (default range), then the whole month', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/scrap-detail.html?${q()}`);
    await settle(page, () => document.getElementById('fStartDate').value && document.getElementById('scrapDetailBody'));
    record('Scrap Detail', 'open (default range)', await reads(page), await text(page, ['topDefectRow', 'scrapDetailTable']));
    await resetReads(page);
    await page.fill('#fStartDate', M.d(1)); await page.fill('#fEndDate', M.d(M.nDays)); await page.click('#applyFilters');
    await settle(page);
    record('Scrap Detail', `${M.nDays} days`, await reads(page), await text(page, ['topDefectRow', 'scrapDetailTable']));
    assert.deepEqual(errors, []);
    await context.close();
  });
  it('Improvement: list page, edit page of one record', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/improvement.html?${q()}`);
    await settle(page, () => document.getElementById('improvementTableBody') && document.getElementById('improvementTableBody').children.length > 0);
    record('Improvement', 'list', await reads(page), await text(page, ['improvementTableBody']));
    await context.close();
    const p2 = await newPage();
    await p2.page.goto(`${BASE}/improvement.html?${q()}&id=imp0120`);
    await settle(p2.page, () => document.getElementById('fProblem') && document.getElementById('fProblem').value);
    const form = await p2.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('input,select,textarea')].filter(e => e.id && e.id.startsWith('f')).map(e => [e.id, e.value])));
    record('Improvement', 'edit page (id=imp0120)', await reads(p2.page), { form });
    await p2.page.goto(`${BASE}/improvement.html?${q()}&id=does-not-exist`);
    await settle(p2.page);
    record('Improvement', 'edit page (unknown id)', await reads(p2.page), await text(p2.page, ['connectionBanner']));
    assert.deepEqual(errors.concat(p2.errors).filter(e => /REAL BACKEND/.test(e)), []);
    await p2.context.close();
  });
  it('Executive Report: open', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/executive-report.html?${q()}`);
    await settle(page);
    record('Executive Report', 'open', await reads(page), {});
    assert.deepEqual(errors.filter(e => /REAL BACKEND/.test(e)), []);
    await context.close();
  });
});
