// Phase 4 in the browser — Firebase EMULATOR ONLY (npm run test:e2e).
// Dashboard V5, Executive Report and its CSV must show the SAME daily status from the shift
// closes; the Line/Shift filters must not change it; a read failure shows READ ERROR; the public
// pages never reveal who confirmed; Firestore reads are counted; an Excel import with a real
// file marks, writes and clears slots (and a partly failed one leaves a Conflict).
// The close-required date is set only for the test page (?qdCloseFrom=…, emulator mode only).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, query, where, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('../support/compat-shim.js');

const ROOT = path.join(__dirname, '../..');
const PORT = 5512;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'demo-quality-dashboard';
const AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const CHART = path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js');
const XLSX = path.join(__dirname, '../node_modules/xlsx/dist/xlsx.full.min.js');
const PASSWORD = 'test-password-1';
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const FROM = bkk(12);
const D = { pre: bkk(13), within: bkk(10), over: bkk(9), changed: bkk(8), noprod: bkk(7), conflict: bkk(6), nodata: bkk(5), pending: bkk(4) };
const EXPECT = { pre: 'INCOMPLETE', within: 'WITHIN TARGET', over: 'OVER TARGET', changed: 'INCOMPLETE', noprod: 'NO PRODUCTION', conflict: 'CONFLICT', nodata: 'NO DATA', pending: 'INCOMPLETE' };
const KEYS = [['A', 'DAY'], ['A', 'NIGHT'], ['B', 'DAY'], ['B', 'NIGHT'], ['C', 'DAY'], ['C', 'NIGHT']];
let env, server, browser;

async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
function actor(code) {
  const db = compatDb(env.authenticatedContext('uid-' + code, { email: E(code) }).firestore()), email = E(code), opts = { email, serverTimestamp };
  return {
    db, opts,
    create: async (date, line, shift, qty) => { const ref = db.collection('scrapLogs').doc(); await Ledger.applyOps(db, [{ op: 'create', ref, data: { date, line, shift, model: 'M-100 FR', defectType: 'Dent', scrapQty: qty, remark: '', createdAt: 1 } }], opts); return ref.id; },
    update: (id, patch) => Ledger.applyOps(db, [{ op: 'update', ref: db.collection('scrapLogs').doc(id), data: Object.assign({}, patch) }], opts),
    close: (date, line, shift, state, reason) => SC.closeSlot(db, { date, line, shift, state, reason }, opts)
  };
}
async function seed() {
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const c of ['ADMIN1', 'LEADA']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(c), password: PASSWORD });
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'scrapLogs', 'pre1'), { date: D.pre, shift: 'DAY', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 10, remark: '', createdAt: 1 });
    for (const d of [bkk(3), bkk(2)]) for (const [l, s] of [['A', 'DAY'], ['B', 'DAY']]) await setDoc(doc(db, 'prodV2_dailyPlans', `plan_${d}_${l}_${s}`), { blocks: [{ start: '08:00', end: '17:00', cells: [{ model: 'M-100', door: 'FR', plan: 100 }] }] });
  });
  const A = actor('ADMIN1');
  // WITHIN: A Day 20 pcs submitted, the rest confirmed zero
  await A.create(D.within, 'A', 'DAY', 20);   // (10 days back: outside a Leader's window)
  for (const [l, s] of KEYS) await A.close(D.within, l, s, l === 'A' && s === 'DAY' ? 'SUBMITTED' : 'CONFIRMED_ZERO');
  // OVER: 60 pcs, nothing closed
  await A.create(D.over, 'A', 'DAY', 30); await A.create(D.over, 'B', 'NIGHT', 30);
  // CHANGED → INCOMPLETE: closed, then the scrap was edited
  const id = await A.create(D.changed, 'C', 'DAY', 5);
  for (const [l, s] of KEYS) await A.close(D.changed, l, s, l === 'C' && s === 'DAY' ? 'SUBMITTED' : 'CONFIRMED_ZERO');
  await A.update(id, { scrapQty: 7 });
  // NO PRODUCTION on all 6 (reason holds a name, which must never appear publicly)
  for (const [l, s] of KEYS) await A.close(D.noprod, l, s, 'NO_PRODUCTION', 'Holiday, approved by LEADA');
  // CONFLICT: closed with 5 pcs, then a record written around the ledger (as with sign-in off)
  await A.create(D.conflict, 'B', 'DAY', 5);
  for (const [l, s] of KEYS) await A.close(D.conflict, l, s, l === 'B' && s === 'DAY' ? 'SUBMITTED' : 'CONFIRMED_ZERO');
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapLogs', 'sneak'), { date: D.conflict, shift: 'DAY', line: 'B', model: 'M', defectType: 'Dent', scrapQty: 2, remark: '', createdAt: 1 }); });
  // PENDING → INCOMPLETE: one record, nothing closed
  await A.create(D.pending, 'B', 'NIGHT', 3);
}

async function newPage(viewport = { width: 1440, height: 900 }, opts = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/chart\.umd(\.min)?\.js/.test(url)) return route.fulfill({ path: CHART, contentType: 'application/javascript' });
    if (/xlsx\.full\.min\.js/.test(url)) return route.fulfill({ path: XLSX, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/permission|PERMISSION_DENIED|Failed to load resource|simulated|shift close summary/i.test(m.text())) errors.push(m.text()); });
  page.on('request', r => requests.push(r.url() + ' ' + (r.postData() || '')));
  return { page, context, errors, requests };
}
const q = `qdEmulator=1&qdCloseFrom=${FROM}`;
async function signIn(page, code) {
  await page.click('#qdAuthOpen'); await page.fill('#qdAuthCode', code); await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}
// Read counter: wraps window.qdDb so every get() is counted the way Firestore bills it
// (a query = its documents, at least 1; a document get = 1).
const COUNT_READS = () => {
  const reads = window.__qdReads = {};
  const wrap = (o, name) => new Proxy(o, { get(t, p) {
    const v = t[p];
    if (['where', 'orderBy', 'limit', 'doc', 'collection'].includes(p)) return (...a) => wrap(v.apply(t, a), p === 'collection' ? a[0] : name);
    if (p === 'get') return async (...a) => { const s = await v.apply(t, a); reads[name] = (reads[name] || 0) + (typeof s.size === 'number' ? Math.max(1, s.size) : 1); return s; };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  const db = window.qdDb;
  window.qdDb = new Proxy(db, { get(t, p) { if (p === 'collection') return n => wrap(t.collection(n), n); const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
};
// Same counter, installed before the page's scripts run (counts the first render too).
const COUNT_READS_FROM_START = () => {
  const reads = window.__qdReads = {};
  const wrap = (o, name) => new Proxy(o, { get(t, p) {
    const v = t[p];
    if (['where', 'orderBy', 'limit', 'doc', 'collection'].includes(p)) return (...a) => wrap(v.apply(t, a), p === 'collection' ? a[0] : name);
    if (p === 'get') return async (...a) => { const s = await v.apply(t, a); reads[name] = (reads[name] || 0) + (typeof s.size === 'number' ? Math.max(1, s.size) : 1); return s; };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  let real = null;
  Object.defineProperty(window, 'qdDb', { configurable: true, get: () => real, set: v => { real = v ? new Proxy(v, { get(t, p) { if (p === 'collection') return n => wrap(t.collection(n), n); const x = t[p]; return typeof x === 'function' ? x.bind(t) : x; } }) : v; } });
};
async function dashboardStatuses(page, from, to) {
  await page.evaluate(({ from, to }) => {
    document.getElementById('dateFrom').value = from; document.getElementById('dateTo').value = to;
    document.getElementById('kpiStatus').textContent = '…';
    document.getElementById('dateTo').dispatchEvent(new Event('change'));
  }, { from, to });
  await page.waitForFunction(() => !['…', '–'].includes(document.getElementById('kpiStatus').textContent.trim()), null, { timeout: 20000 });
  return page.evaluate(() => {
    const rows = {};
    document.querySelectorAll('#targetPerfDetailBody tr').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      rows[cells[0].textContent.trim()] = { status: tr.querySelector('.qd-status-pill').textContent.trim(), close: (tr.querySelector('.v5-close-cell') || {}).textContent || '', scrap: cells[2].textContent.trim() };
    });
    return { overall: document.getElementById('kpiStatus').textContent.trim(), rows, closeLine: document.getElementById('kpiCloseLine').textContent.trim(), closeHidden: document.getElementById('kpiCloseLine').hidden };
  });
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dashKey = d => `${d.slice(8)} ${MON[parseInt(d.slice(5, 7), 10) - 1]}`;

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
  await seed();
});
after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  if (env) await env.cleanup();
});

describe('Dashboard, Executive Report and CSV agree (emulator)', () => {
  let dash;
  it('Dashboard V5 (public, signed out): one status per day from the 6 closes', async () => {
    const { page, context, errors, requests } = await newPage();
    await page.goto(`${BASE}/index.html?${q}`);
    await page.waitForFunction(() => window.qdDb && document.getElementById('kpiStatus'), null, { timeout: 15000 });
    dash = await dashboardStatuses(page, D.pre, D.pending);
    for (const [k, d] of Object.entries(D)) assert.equal(dash.rows[dashKey(d)] && dash.rows[dashKey(d)].status, EXPECT[k], `${k} ${d}`);
    assert.equal(dash.overall, 'OVER TARGET');
    assert.match(dash.rows[dashKey(D.within)].close, /6\/6/);
    assert.match(dash.rows[dashKey(D.changed)].close, /5\/6/);
    assert.equal(dash.rows[dashKey(D.pre)].close, '');                          // before the close date: previous rule
    assert.equal(dash.closeHidden, false); assert.match(dash.closeLine, /days fully confirmed/);
    // public page: nobody's e-mail, code or reason is shown or even read
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, /@prodv2|LEADA|ADMIN1|Holiday/);
    assert.equal(requests.filter(r => /scrapSlots|qdUsers/.test(r)).length, 0, 'no ledger / user reads from the public dashboard');
    // the link opens Daily Confirmation for the day
    assert.match(await page.getAttribute('#kpiCloseLink', 'href'), /^daily-confirmation\.html\?date=/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Line / Shift filters change what is shown, never the day status', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/index.html?${q}`);
    await page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    await dashboardStatuses(page, D.pre, D.pending);
    await page.click('#lineFilter button[data-line="B"]');
    await page.click('#shiftFilter button[data-shift="NIGHT"]');
    const filtered = await dashboardStatuses(page, D.pre, D.pending);
    for (const d of Object.values(D)) assert.equal(filtered.rows[dashKey(d)].status, dash.rows[dashKey(d)].status, d);
    assert.equal(filtered.overall, dash.overall);
    await context.close();
  });

  it('Executive Report table and CSV export show the same statuses as the Dashboard', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/executive-report.html?${q}`);
    await page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    await page.click('#periodTabs button[data-period="monthly"]');
    await page.fill('#rEndDate', D.pending);
    await page.click('#refreshReport');
    await page.waitForFunction(d => [...document.querySelectorAll('#rDailyTableBody tr')].some(tr => tr.firstElementChild.textContent === d), D.pending, { timeout: 20000 });
    const table = await page.evaluate(() => { const o = {}; document.querySelectorAll('#rDailyTableBody tr').forEach(tr => { const c = tr.querySelectorAll('td'); o[c[0].textContent] = { status: c[5].textContent, close: c[6].textContent }; }); return o; });
    const head = await page.evaluate(() => document.querySelector('#rTargetTable thead tr').textContent);
    assert.match(head, /Conflict.*No Production.*Read Error.*Fully Confirmed/);
    for (const d of Object.values(D)) assert.equal(table[d].status, dash.rows[dashKey(d)].status, `exec vs dashboard ${d}`);
    assert.equal(table[D.within].close, '6/6'); assert.equal(table[D.pre].close, '–');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    const lines = csv.split('\n');
    const start = lines.indexOf('Daily Target Evaluation');
    const header = lines[start + 1].split(',');
    assert.deepEqual(header.slice(-3), ['Notes', 'Shifts Confirmed', 'Close Detail']);
    const rows = {};
    for (let i = start + 2; i < lines.length && lines[i]; i++) { const c = lines[i].match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, '')); rows[c[0]] = { status: c[7], close: c[9], detail: c[10] }; }
    for (const d of Object.values(D)) assert.equal(rows[d].status, table[d].status, `csv vs page ${d}`);
    assert.equal(rows[D.within].close, '6/6');
    assert.match(rows[D.changed].detail, /C Day: CHANGED/);
    assert.doesNotMatch(csv, /@prodv2|LEADA|ADMIN1|Holiday/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('a close-status read failure shows READ ERROR (never 0 / WITHIN) on both pages', async () => {
    const block = () => {
      const orig = window.qdDb.collection.bind(window.qdDb);
      window.qdDb.collection = n => n === 'scrapCloseSummary' ? { where: () => ({ where: () => ({ get: () => Promise.reject(new Error('simulated read failure')) }) }) } : orig(n);
    };
    const { page, context } = await newPage();
    await page.goto(`${BASE}/index.html?${q}`);
    await page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    await page.evaluate(block);
    const r = await dashboardStatuses(page, D.pre, D.pending);
    for (const [k, d] of Object.entries(D)) assert.equal(r.rows[dashKey(d)].status, k === 'pre' ? 'INCOMPLETE' : k === 'over' ? 'READ ERROR' : 'READ ERROR', d);
    assert.equal(r.overall, 'READ ERROR');
    assert.match(await page.textContent('#connectionBanner'), /could not be read/);
    await page.goto(`${BASE}/executive-report.html?${q}`);
    await page.waitForFunction(() => window.qdDb && document.querySelectorAll('#rDailyTableBody tr').length > 0, null, { timeout: 15000 });
    await page.evaluate(block);
    await page.click('#periodTabs button[data-period="weekly"]');
    await page.fill('#rEndDate', D.pending); await page.click('#refreshReport');
    await page.waitForFunction(() => [...document.querySelectorAll('#rDailyTableBody tr td:nth-child(6)')].some(td => td.textContent === 'READ ERROR'), null, { timeout: 20000 });
    const st = await page.$$eval('#rDailyTableBody tr td:nth-child(6)', tds => tds.map(t => t.textContent));
    assert.ok(!st.includes('WITHIN TARGET'));
    await context.close();
  });

  it('Firestore reads: the close summary adds at most one read per day and no extra scrap-log reads', async () => {
    const measure = async extra => {
      const { page, context } = await newPage();
      await page.goto(`${BASE}/index.html?qdEmulator=1${extra}`);
      await page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
      await page.evaluate(COUNT_READS);
      await dashboardStatuses(page, D.pre, D.pending);
      // wait until the whole page has settled (Attention Required + the Weekly Plan V5 card), so both
      // measurements count the same reads
      await page.waitForFunction(() => window.__qdPlanCard && window.__qdPlanCard.month && !/Loading/.test(document.getElementById('attentionSummary').textContent), null, { timeout: 20000 });
      await page.waitForTimeout(300);
      const reads = await page.evaluate(() => window.__qdReads);
      await context.close();
      return reads;
    };
    const off = await measure('');
    const on = await measure(`&qdCloseFrom=${FROM}`);
    console.log('  reads, 9-day range, close off:', JSON.stringify(off), ' close on:', JSON.stringify(on));
    assert.equal(on.scrapLogs, off.scrapLogs, 'scrap logs are read once, whatever the close rule');
    assert.ok(!off.scrapCloseSummary);
    assert.ok(on.scrapCloseSummary >= 1 && on.scrapCloseSummary <= 8, 'summary: one document per close-required day at most');
    assert.ok(!on.scrapSlots && !on.qdUsers);
  });

  it('Firestore reads of Daily Confirmation and the Scrap Entry close panel (signed in)', async () => {
    const run = async (url, ready) => {
      const { page, context } = await newPage();
      await page.addInitScript(COUNT_READS_FROM_START);
      await page.goto(`${BASE}/${url}`);
      await signIn(page, 'ADMIN1');
      await page.waitForSelector(ready, { timeout: 20000 });
      await page.waitForTimeout(1500);   // let any duplicate refresh finish
      const r = await page.evaluate(() => window.__qdReads);
      await context.close();
      return r;
    };
    const dc = await run(`daily-confirmation.html?qdEmulator=1&date=${D.within}`, '[data-role="matrix"]');
    const se = await run(`scrap-entry.html?qdEmulator=1&date=${D.within}&line=A&shift=DAY`, '#shiftClosePanel .sc-chip');
    console.log('  reads after sign-in — Daily Confirmation:', JSON.stringify(dc), ' Scrap Entry:', JSON.stringify(se));
    assert.ok(dc.scrapSlots <= 6, 'one load of the 6 slots (no duplicate refresh)');
    assert.ok(dc.scrapLogs <= 2, 'one scrap-log query for the day');
    assert.ok(se.scrapSlots <= 1, 'one slot read for the panel');
  });

  it('phone width: status, close line and detail fit without horizontal scroll', async () => {
    const { page, context } = await newPage({ width: 390, height: 844 });
    await page.goto(`${BASE}/index.html?${q}`);
    await page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    await dashboardStatuses(page, D.within, D.within);
    await page.click('#targetPerfDetailBtn');
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth, line: document.getElementById('kpiCloseLine').textContent }));
    assert.ok(w.doc <= w.view, JSON.stringify(w));
    assert.match(w.line, /6\/6 shifts confirmed/);
    await page.screenshot({ path: path.join(__dirname, 'artifacts-dashboard-close-mobile.png'), fullPage: false });
    await context.close();
  });
});

describe('Excel import with a real file (emulator)', () => {
  let day = bkk(3);
  const csvFile = () => {
    const f = path.join(os.tmpdir(), `qd-import-${Date.now()}.csv`);
    fs.writeFileSync(f, ['Date,Shift,Line,Model,Defect,Qty,Remark', `${day},DAY,A,M-100 FR,Dent,2,`, `${day},DAY,A,M-100 FR,Scratch,3,`, `${day},DAY,B,M-100 FR,Dent,4,`].join('\n'));
    return f;
  };
  async function importFile(page) {
    await page.click('#entryTabs button[data-tab="import"]');
    await page.setInputFiles('#importFileInput', csvFile());
    await page.waitForSelector('#continueToValidationBtn', { state: 'visible', timeout: 15000 });
    await page.click('#continueToValidationBtn');
    // the button stays disabled while the rows are checked against Production V2 (fixed race)
    assert.equal(await page.evaluate(() => document.getElementById('importConfirmBtn').disabled), true);
    await page.waitForFunction(() => !document.getElementById('importConfirmBtn').disabled && !/Checking/.test(document.getElementById('importSummaryCards').textContent), null, { timeout: 20000 });
    await page.click('#importConfirmBtn');
    await page.waitForFunction(() => /Imported|not started|failed/.test(document.getElementById('importMessage').textContent), null, { timeout: 30000 });
    return page.textContent('#importMessage');
  }
  const slot = id => env.withSecurityRulesDisabled(async ctx => { const s = await getDoc(doc(ctx.firestore(), 'scrapSlots', id)); slot.last = s.exists() ? s.data() : null; }).then(() => slot.last);
  const events = id => env.withSecurityRulesDisabled(async ctx => { const o = {}; (await getDocs(collection(ctx.firestore(), 'scrapSlots', id, 'events'))).forEach(d => { o[d.id] = d.data(); }); events.last = o; }).then(() => events.last);

  it('all rows saved: slots marked, written through the ledger, markers cleared (audited)', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1`);
    await signIn(page, 'ADMIN1');
    const msg = await importFile(page);
    assert.match(msg, /Imported 3 records/);
    for (const [id, n] of [[`${day}_A_DAY`, 2], [`${day}_B_DAY`, 1]]) {
      const s = await slot(id);
      assert.equal(s.importPending, null); assert.equal(s.liveLogCount, n); assert.equal(s.markerRevision, 2);
      const ev = await events(id);
      assert.deepEqual(Object.keys(ev).sort(), ['m1', 'm2', 'v1']);
      assert.equal(ev.m1.action, 'SET'); assert.equal(ev.m2.action, 'CLEAR'); assert.equal(ev.v1.creates.length, n);
    }
    await context.close();
  });

  it('a slot whose rows fail keeps its marker → Conflict, cannot be closed; the other slot is fine', async () => {
    day = bkk(2);   // a fresh day (slots and audit events are never deleted)
    const { page, context } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1`);
    await signIn(page, 'ADMIN1');
    // the write of Line B fails (as a network or rules failure would)
    await page.evaluate(() => { const orig = ScrapLedger.applyOps; ScrapLedger.applyOps = (db, ops, o) => ops.some(x => x.op === 'create' && x.data.line === 'B') ? Promise.reject(new Error('simulated failure')) : orig(db, ops, o); });
    const msg = await importFile(page);
    assert.match(msg, /Imported 2 records, but 1 failed/); assert.match(msg, /import incomplete/);
    assert.equal((await slot(`${day}_A_DAY`)).importPending, null);
    assert.equal((await slot(`${day}_B_DAY`)).importPending.rows, 1);
    await page.goto(`${BASE}/daily-confirmation.html?qdEmulator=1&date=${day}`);
    await page.waitForSelector(`.sc-cell[data-slot="${day}_B_DAY"] .sc-chip[data-status="CONFLICT"]`, { timeout: 20000 });
    await page.waitForSelector(`.sc-cell[data-slot="${day}_A_DAY"] .sc-chip[data-status="PENDING"]`);
    await context.close();
  });

  it('a new import into a slot with an unfinished import is refused before anything is written', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1`);
    await signIn(page, 'ADMIN1');
    const countLogs = async () => { let n; await env.withSecurityRulesDisabled(async ctx => { n = (await getDocs(query(collection(ctx.firestore(), 'scrapLogs'), where('date', '==', day)))).size; }); return n; };
    const before = await countLogs();
    const msg = await importFile(page);
    assert.match(msg, /Import not started, nothing was saved.*unfinished import/);
    assert.equal(await countLogs(), before);
    await context.close();
  });
});
