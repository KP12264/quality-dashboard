// Weekly Plan V5 in the browser — Firebase EMULATOR ONLY (npm run test:e2e).
// weekly-plan.html and the Dashboard "Scrap Budget" card show the SAME numbers from the same
// records; scope = Door A/B/C x DAY/NIGHT; days without a log are not 0; Shift Close decides
// "final"; only Admins change plans (with a reason + history); history and review notes are not
// public; Firestore reads are counted; phone width; the old plan pages redirect.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('../support/compat-shim.js');

const ROOT = path.join(__dirname, '../..');
const PORT = 5514;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'demo-quality-dashboard';
const AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const CHART = path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js');
const PASSWORD = 'test-password-1';
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
// The previous Thailand month: every day has ended, so closes are allowed and the month is complete.
const nowBkk = new Date(Date.now() + 7 * 3600000);
const PREV = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() - 1, 1));
const YM = `${PREV.getUTCFullYear()}-${pad(PREV.getUTCMonth() + 1)}`;
const NDAYS = new Date(Date.UTC(PREV.getUTCFullYear(), PREV.getUTCMonth() + 1, 0)).getUTCDate();
const d = n => `${YM}-${pad(n)}`;
const CLOSE_FROM = d(20);
const KEYS = [['A', 'DAY'], ['A', 'NIGHT'], ['B', 'DAY'], ['B', 'NIGHT'], ['C', 'DAY'], ['C', 'NIGHT']];
let env, server, browser;

// Independent expectation (no shared code with the page): weeks Mon–Sun inside the month.
function expectedWeeks() {
  const out = []; let cur = null;
  for (let i = 1; i <= NDAYS; i++) {
    const wd = (new Date(Date.UTC(PREV.getUTCFullYear(), PREV.getUTCMonth(), i)).getUTCDay() + 6) % 7;
    if (!cur || wd === 0) { cur = { key: 'W' + (out.length + 1), from: i, to: i }; out.push(cur); }
    cur.to = i;
  }
  return out.map(w => Object.assign(w, { days: w.to - w.from + 1, base: 50 * (w.to - w.from + 1) }));
}
const IN = [];   // in-scope logs we seed: { day, line, shift, qty, defect, cause }

async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
function actor(code) {
  const db = compatDb(env.authenticatedContext('uid-' + code, { email: E(code) }).firestore()), opts = { email: E(code), serverTimestamp };
  return {
    create: async (date, line, shift, qty, defectType = 'Dent', rootCause = '') => { const ref = db.collection('scrapLogs').doc(); await Ledger.applyOps(db, [{ op: 'create', ref, data: { date, line, shift, model: 'M-100 FR', defectType, rootCause, scrapQty: qty, remark: '', createdAt: 1 } }], opts); return ref.id; },
    close: (date, line, shift, state, reason) => SC.closeSlot(db, { date, line, shift, state, reason }, opts)
  };
}
async function seed() {
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const c of ['ADMIN1', 'LEADA', 'VIEW1']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(c), password: PASSWORD });
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'qdUsers', E('VIEW1')), u('viewer', []));
    // before the close date: logs saved as today with sign-in off (no ledger)
    const old = [[2, 'A', 'DAY', 20, 'Dent', 'Jig'], [2, 'B', 'NIGHT', 15, 'Scratch', ''], [3, 'C', 'DAY', 60, 'Dent', 'Handling'], [6, 'A', 'DAY', 5, 'Dent', 'Jig'], [9, 'B', 'DAY', 7, 'Gap', '']];
    let i = 0;
    for (const [day, line, shift, qty, defectType, rootCause] of old) {
      await setDoc(doc(db, 'scrapLogs', 'old' + (++i)), { date: d(day), shift, line, model: 'M', defectType, rootCause, scrapQty: qty, remark: '', createdAt: 1 });
      IN.push({ day, line, shift, qty, defect: defectType, cause: rootCause });
    }
    // out of scope (never counted): Door In Door and an old Thai shift code
    await setDoc(doc(db, 'scrapLogs', 'did'), { date: d(5), shift: 'DAY', line: 'DID', model: 'M', defectType: 'Dent', scrapQty: 99, remark: '', createdAt: 1 });
    await setDoc(doc(db, 'scrapLogs', 'thai'), { date: d(5), shift: 'เช้า', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 99, remark: '', createdAt: 1 });
  });
  const A = actor('ADMIN1');
  // 21: FINAL (6/6 closed)
  await A.create(d(21), 'A', 'DAY', 10, 'Dent', 'Jig'); IN.push({ day: 21, line: 'A', shift: 'DAY', qty: 10, defect: 'Dent', cause: 'Jig' });
  for (const [l, s] of KEYS) await A.close(d(21), l, s, l === 'A' && s === 'DAY' ? 'SUBMITTED' : 'CONFIRMED_ZERO');
  // 22: PENDING (logged, nothing closed)
  await A.create(d(22), 'B', 'DAY', 4, 'Scratch'); IN.push({ day: 22, line: 'B', shift: 'DAY', qty: 4, defect: 'Scratch', cause: '' });
  // 23: FINAL, no production on all 6
  for (const [l, s] of KEYS) await A.close(d(23), l, s, 'NO_PRODUCTION', 'Holiday, approved by LEADA');
  // 24: CONFLICT (closed, then a record written around the ledger)
  await A.create(d(24), 'C', 'NIGHT', 5, 'Dent', 'Handling'); IN.push({ day: 24, line: 'C', shift: 'NIGHT', qty: 5, defect: 'Dent', cause: 'Handling' });
  for (const [l, s] of KEYS) await A.close(d(24), l, s, l === 'C' && s === 'NIGHT' ? 'SUBMITTED' : 'CONFIRMED_ZERO');
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapLogs', 'sneak'), { date: d(24), shift: 'NIGHT', line: 'C', model: 'M', defectType: 'Dent', scrapQty: 2, remark: '', createdAt: 1 }); });
  IN.push({ day: 24, line: 'C', shift: 'NIGHT', qty: 2, defect: 'Dent', cause: '' });
  // a review note (signed-in only)
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapWeeklyReviews', `${YM}_W1`), { ym: YM, week: 'W1', reviewNote: 'SECRET-NOTE jig check', updatedAt: 1, updatedBy: E('ADMIN1') }); });
}

// Read counter installed before the page's scripts: per collection, queries (get calls) and documents.
const COUNT = () => {
  window.__qdReads = {};
  const bump = (name, s) => { const R = window.__qdReads; const r = R[name] = R[name] || { gets: 0, docs: 0 }; r.gets++; r.docs += typeof s.size === 'number' ? s.size : 1; };
  const wrap = (o, name) => new Proxy(o, { get(t, p) {
    const v = t[p];
    if (['where', 'orderBy', 'limit', 'doc'].includes(p)) return (...a) => wrap(v.apply(t, a), name);
    if (p === 'collection') return (...a) => wrap(v.apply(t, a), name + '/' + a[0]);
    if (p === 'get') return async (...a) => { const s = await v.apply(t, a); bump(name, s); return s; };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  let real = null;
  Object.defineProperty(window, 'qdDb', { configurable: true, get: () => real, set: v => { real = v ? new Proxy(v, { get(t, p) { if (p === 'collection') return n => wrap(t.collection(n), n); const x = t[p]; return typeof x === 'function' ? x.bind(t) : x; } }) : v; } });
};

async function newPage(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(COUNT);
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/chart\.umd(\.min)?\.js/.test(url)) return route.fulfill({ path: CHART, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/permission|PERMISSION_DENIED|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  return { page, context, errors };
}
const q = `qdEmulator=1&qdCloseFrom=${CLOSE_FROM}`;
async function signIn(page, code) {
  await page.click('#qdAuthOpen'); await page.fill('#qdAuthCode', code); await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}
async function openPlan(page, extra = '') {
  await page.goto(`${BASE}/weekly-plan.html?${q}&ym=${YM}${extra}`);
  await page.waitForFunction(() => window.__qdWeeklyPlan && window.__qdWeeklyPlan.month && document.getElementById('wpWeeksTable'), null, { timeout: 20000 });
}
const monthOf = page => page.evaluate(() => { const m = window.__qdWeeklyPlan.month; return JSON.parse(JSON.stringify({ budget: m.budget, actual: m.actual, remaining: m.remaining, used: m.used, budgetStatus: m.budgetStatus, dailyCompliance: m.dailyCompliance, completeness: m.completeness, counts: m.counts, weeks: m.weeks.map(w => ({ key: w.key, plan: w.plan, actual: w.actual, budgetStatus: w.budgetStatus, dailyCompliance: w.dailyCompliance, completeness: w.completeness, ls: w.lineShift })), days: m.days.map(x => ({ date: x.date, state: x.state, qty: x.qty })), ls: m.lineShift })); });

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

describe('Weekly Plan V5 (emulator)', () => {
  let pageMonth;
  it('weekly-plan.html (public): budget, actual, remaining, weeks and Line × Shift match an independent count', async () => {
    const { page, context, errors } = await newPage();
    await openPlan(page);
    pageMonth = await monthOf(page);
    const weeks = expectedWeeks();
    const total = IN.reduce((s, x) => s + x.qty, 0);
    assert.equal(pageMonth.actual, total, 'Door In Door and the old shift code are not counted');
    assert.equal(pageMonth.budget, 50 * NDAYS); assert.equal(pageMonth.remaining, 50 * NDAYS - total);
    assert.deepEqual(pageMonth.weeks.map(w => [w.key, w.plan]), weeks.map(w => [w.key, w.base]));
    for (const w of weeks) assert.equal(pageMonth.weeks.find(x => x.key === w.key).actual, IN.filter(x => x.day >= w.from && x.day <= w.to).reduce((s, x) => s + x.qty, 0), w.key);
    for (const l of ['A', 'B', 'C']) for (const s of ['DAY', 'NIGHT']) assert.equal(pageMonth.ls[l][s], IN.filter(x => x.line === l && x.shift === s).reduce((t, x) => t + x.qty, 0), l + s);
    assert.equal(pageMonth.ls.total.total, total);
    // day states: before the close date = logged / no data (never 0); from it: Shift Close
    const st = Object.fromEntries(pageMonth.days.map(x => [x.date, x]));
    assert.equal(st[d(2)].state, 'LOGGED'); assert.equal(st[d(4)].state, 'NO_DATA'); assert.equal(st[d(4)].qty, null);
    assert.equal(st[d(21)].state, 'FINAL'); assert.equal(st[d(22)].state, 'PENDING'); assert.equal(st[d(23)].state, 'FINAL'); assert.equal(st[d(23)].qty, 0);
    assert.equal(st[d(24)].state, 'CONFLICT'); assert.equal(st[d(25)].state, 'NO_DATA');
    assert.equal(pageMonth.completeness, 'NOT_FINAL'); assert.equal(pageMonth.budgetStatus, 'WITHIN_PLAN');
    // weeks table as shown: Days column = number of days of each week; the plan sentence names it too
    const shownDays = await page.$$eval('#wpWeeksTable tbody tr', trs => trs.map(tr => tr.children[2].textContent.trim()));
    assert.deepEqual(shownDays, weeks.map(w => String(w.days)));
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\[object|undefined|NaN/);
    // a week with no scrap log on any day shows "No log", never an actual of 0
    const noLogWeeks = weeks.filter(w => !IN.some(x => x.day >= w.from && x.day <= w.to)).map(w => w.key);
    for (const k of noLogWeeks) assert.equal(await page.textContent(`#wpWeeksTable tr[data-week="${k}"] td:nth-child(6)`), 'No log', k);
    // what the user sees
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /Monthly budget/); assert.match(text, /so far/); assert.match(text, /not counted as 0/);
    assert.match(await page.textContent('#wpRule'), /≤50 pcs\/day/);
    assert.doesNotMatch(text, /@prodv2|SECRET-NOTE|Holiday|ADMIN1/, 'no e-mail, review note or close reason on the public page');
    assert.equal(await page.$('[data-edit]'), null, 'no Edit button for the public');
    await page.screenshot({ path: path.join(__dirname, 'artifacts-weekly-plan-desktop.png'), fullPage: true });
    // reads: one scrap query, one plan query, one close-summary query, no production, no reviews / history
    const r = await page.evaluate(() => window.__qdReads);
    console.log('  reads weekly-plan.html (public):', JSON.stringify(r));
    assert.equal(r.scrapLogs.gets, 1); assert.equal(r.scrapWeeklyPlans.gets, 1); assert.ok(r.scrapWeeklyPlans.docs <= 6);
    assert.equal(r.scrapCloseSummary.gets, 1); assert.ok(r.scrapCloseSummary.docs <= NDAYS);
    assert.ok(!r.prodV2_actualLogs && !r.scrapWeeklyReviews && !r.scrapSlots && !r.qdUsers, JSON.stringify(r));
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Improve: Top defects across all lines — one row per defect, Door A/B/C and sub-causes inside', async () => {
    const { page, context } = await newPage();
    await openPlan(page);
    await page.click('#wpImprove [data-scope="month"]');
    const rows = await page.$$eval('#wpDefects .wp-defect', li => li.map(x => ({ name: x.dataset.defect, lines: Object.fromEntries([...x.querySelectorAll('.wp-line')].map(s => [s.dataset.line, Number(s.querySelector('b').textContent.replace(/,/g, ''))])), causes: x.querySelectorAll('.wp-causes tbody tr').length })));
    const names = rows.map(x => x.name);
    assert.equal(new Set(names).size, names.length, 'a defect appears once');
    assert.equal(names[0], 'Dent');
    const dent = IN.filter(x => x.defect === 'Dent');
    assert.deepEqual(rows[0].lines, { A: dent.filter(x => x.line === 'A').reduce((s, x) => s + x.qty, 0), B: 0, C: dent.filter(x => x.line === 'C').reduce((s, x) => s + x.qty, 0) });
    assert.equal(rows[0].causes, 3, 'Jig, Handling, (cause not recorded)');
    assert.ok(rows.length <= 5);
    await context.close();
  });

  it('Dashboard card = weekly-plan.html for the same month (single day = month end: no extra scrap query)', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/index.html?${q}`);
    await page.waitForFunction(() => window.__qdPlanCard && window.__qdPlanCard.month && !/Loading/.test(document.getElementById('attentionSummary').textContent), null, { timeout: 20000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__qdReads = {}; window.__qdPlanCard = null; });
    await page.evaluate(day => { const f = document.getElementById('dateFrom'), t = document.getElementById('dateTo'); f.value = day; t.value = day; t.dispatchEvent(new Event('change')); }, d(NDAYS));
    await page.waitForFunction(ym => window.__qdPlanCard && window.__qdPlanCard.ym === ym && window.__qdPlanCard.month, YM, { timeout: 20000 });
    const card = await page.evaluate(() => JSON.parse(JSON.stringify(window.__qdPlanCard)));
    assert.equal(card.ym, YM); assert.equal(card.asOf, d(NDAYS));
    assert.equal(card.extraScrapQuery, null, 'the Attention look-back already covers the month');
    for (const k of ['budget', 'actual', 'remaining', 'budgetStatus', 'dailyCompliance', 'completeness']) assert.equal(card.month[k], pageMonth[k], k);
    assert.equal(card.month.final, pageMonth.counts.final);
    const lastWeek = pageMonth.weeks[pageMonth.weeks.length - 1];
    assert.equal(card.week.key, lastWeek.key); assert.equal(card.week.actual, lastWeek.actual); assert.equal(card.week.plan, lastWeek.plan);
    await (await page.$('#planCard')).screenshot({ path: path.join(__dirname, 'artifacts-dashboard-budget-card.png') });
    const shown = await page.textContent('#planCard');
    assert.match(shown, /Scrap Budget/); assert.match(shown, /Weekly Plan →/);
    assert.match(shown, new RegExp(pageMonth.actual.toLocaleString('en-US')));
    assert.match(await page.getAttribute('#planCard .v5-budget-link', 'href'), new RegExp(`^weekly-plan\\.html\\?ym=${YM}&week=${lastWeek.key}`));
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('attentionSummary').textContent), null, { timeout: 20000 });
    const r = await page.evaluate(() => window.__qdReads);
    console.log('  reads Dashboard, one day (month end):', JSON.stringify(r));
    assert.equal(r.scrapLogs.gets, 2, 'range + the existing look-back — nothing more');
    assert.equal(r.scrapWeeklyPlans.gets, 1); assert.ok(r.scrapWeeklyPlans.docs <= 6);
    assert.ok(r.scrapCloseSummary.gets <= 2, 'the day itself + the month (only missing dates)');
    assert.ok(!r.scrapWeeklyReviews && !r['scrapWeeklyPlans/history']);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Dashboard range starting mid-month: only the missing days are read (one query), numbers unchanged', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/index.html?${q}`);
    await page.waitForFunction(() => window.__qdPlanCard && window.__qdPlanCard.month && !/Loading/.test(document.getElementById('attentionSummary').textContent), null, { timeout: 20000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__qdReads = {}; window.__qdPlanCard = null; });
    await page.evaluate(([a, b]) => { const f = document.getElementById('dateFrom'), t = document.getElementById('dateTo'); t.value = b; f.value = a; t.dispatchEvent(new Event('change')); }, [d(15), d(NDAYS)]);
    await page.waitForFunction(ym => window.__qdPlanCard && window.__qdPlanCard.ym === ym && window.__qdPlanCard.month, YM, { timeout: 20000 });
    const card = await page.evaluate(() => JSON.parse(JSON.stringify(window.__qdPlanCard)));
    assert.deepEqual(card.extraScrapQuery, [d(1), d(14)]);
    assert.equal(card.month.actual, pageMonth.actual); assert.equal(card.month.budgetStatus, pageMonth.budgetStatus); assert.equal(card.month.dailyCompliance, pageMonth.dailyCompliance); assert.equal(card.month.completeness, pageMonth.completeness);
    const r = await page.evaluate(() => window.__qdReads);
    console.log('  reads Dashboard, range 15 → end:', JSON.stringify(r));
    assert.equal(r.scrapLogs.gets, 2, 'range + the gap (1 … 14)');
    await context.close();
  });

  it('Admin: sets a weekly override with a reason → plan, budget and history; no e-mail on the public document', async () => {
    const { page, context, errors } = await newPage();
    await openPlan(page);
    await signIn(page, 'ADMIN1');
    await page.waitForSelector('[data-edit="W2"]', { timeout: 15000 });
    const base = expectedWeeks()[1].base;
    await page.click('[data-edit="W2"]');
    await page.fill('#wpEditInput', String(base + 1)); await page.fill('#wpEditReason', 'trial');
    await page.click('#wpEditSave');
    assert.match(await page.textContent('#wpEditMsg'), /≤50\/day/, 'above 50/day is refused in the page');
    await page.fill('#wpEditInput', '200'); await page.fill('#wpEditReason', '');
    await page.click('#wpEditSave');
    assert.match(await page.textContent('#wpEditMsg'), /reason is required/i);
    await page.fill('#wpEditReason', 'Line B trial run');
    await page.click('#wpEditSave');
    await page.waitForFunction(() => window.__qdWeeklyPlan.month.weeks[1].plan === 200, null, { timeout: 15000 });
    const m = await monthOf(page);
    assert.equal(m.budget, 50 * NDAYS - base + 200, 'monthly budget = sum of the weekly plans');
    let p, h = [];
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      p = (await getDoc(doc(db, 'scrapWeeklyPlans', `${YM}_W2`))).data();
      (await getDocs(collection(db, 'scrapWeeklyPlans', `${YM}_W2`, 'history'))).forEach(x => h.push(x.data()));
    });
    assert.deepEqual(Object.keys(p).sort(), ['historyRev', 'planOverride', 'updatedAt', 'week', 'ym']);
    assert.equal(p.planOverride, 200); assert.equal(p.historyRev, 1);
    assert.equal(h.length, 1); assert.equal(h[0].by, E('ADMIN1')); assert.equal(h[0].from, null); assert.equal(h[0].to, 200); assert.equal(h[0].reason, 'Line B trial run');
    // history shows in the editor; reset to default writes revision 2
    await page.click('[data-edit="W2"]');
    await page.waitForFunction(() => /Line B trial run/.test(document.getElementById('wpEditHistory').textContent), null, { timeout: 15000 });
    await page.fill('#wpEditReason', 'trial finished'); await page.click('#wpEditClear');
    await page.waitForFunction(() => window.__qdWeeklyPlan.month.weeks[1].override === null, null, { timeout: 15000 });
    // the Admin sees the review note and can edit it
    await page.click('#wpWeeks tr[data-week="W1"]');
    await page.waitForFunction(() => /SECRET-NOTE/.test((document.getElementById('wpReviewText') || {}).value || ''), null, { timeout: 15000 });
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Leader / Viewer: read plans, history and review notes, cannot edit; the public sees neither', async () => {
    for (const code of ['LEADA', 'VIEW1']) {
      const { page, context } = await newPage();
      await openPlan(page, '&week=W1');
      await signIn(page, code);
      await page.waitForFunction(() => /SECRET-NOTE/.test(document.getElementById('wpReview').textContent), null, { timeout: 15000 });
      assert.equal(await page.$('[data-edit]'), null, code + ' has no Edit button');
      // direct SDK write from the page is refused by the rules
      const res = await page.evaluate(async () => { try { await window.qdDb.collection('scrapWeeklyPlans').doc(window.__qdWeeklyPlan.ym + '_W1').set({ ym: window.__qdWeeklyPlan.ym, week: 'W1', planOverride: 1, historyRev: 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }); return 'written'; } catch (e) { return e.code || e.message; } });
      assert.match(res, /permission/i, code);
      await context.close();
    }
    const { page, context } = await newPage();
    await openPlan(page, '&week=W1');
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, /SECRET-NOTE|Line B trial run|@prodv2/);
    const res = await page.evaluate(async () => { try { await window.qdDb.collection('scrapWeeklyPlans').doc(window.__qdWeeklyPlan.ym + '_W2').collection('history').get(); return 'read'; } catch (e) { return e.code || e.message; } });
    assert.match(res, /permission/i, 'history is not public');
    await context.close();
  });

  it('previous-month reduction goal: loaded only when opened, separate from the daily limit, provisional when not confirmed', async () => {
    const { page, context } = await newPage();
    await openPlan(page);
    const before = await page.evaluate(() => window.__qdReads.scrapLogs.gets);
    await page.click('#wpGoal summary');
    await page.waitForSelector('#wpGoalStatus', { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__qdReads.scrapLogs.gets), before + 1, 'one more scrap query, only on demand');
    const st = await page.getAttribute('#wpGoalStatus', 'data-status');
    assert.ok(['PROVISIONAL', 'NO_DATA'].includes(st), st);
    assert.doesNotMatch(await page.textContent('#wpGoalStatus'), /^Confirmed/);
    assert.match(await page.textContent('#wpGoalBody'), /separate from the daily operational limit/);
    await context.close();
  });

  it('phone width (390 px): no horizontal page scroll on weekly-plan.html and the Dashboard card', async () => {
    for (const url of [`weekly-plan.html?${q}&ym=${YM}`, `index.html?${q}`]) {
      const { page, context } = await newPage({ width: 390, height: 844 });
      await page.goto(`${BASE}/${url}`);
      await page.waitForFunction(() => (window.__qdWeeklyPlan && window.__qdWeeklyPlan.month) || (window.__qdPlanCard && window.__qdPlanCard.month), null, { timeout: 20000 });
      await page.waitForTimeout(300);
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(w.sw <= w.cw + 1, `${url}: ${JSON.stringify(w)}`);
      await page.screenshot({ path: path.join(__dirname, `artifacts-weekly-plan-mobile-${url.startsWith('index') ? 'card' : 'page'}.png`), fullPage: true });
      await context.close();
    }
  });

  it('the old plan pages are retired: they redirect to weekly-plan.html and never connect', async () => {
    for (const old of ['plan-tracking.html', 'weekly-review.html']) {
      const { page, context } = await newPage();
      await page.goto(`${BASE}/${old}?ym=${YM}`);
      await page.waitForURL(/weekly-plan\.html\?ym=/, { timeout: 15000 });
      assert.match(page.url(), new RegExp(`weekly-plan\\.html\\?ym=${YM}`));
      await context.close();
    }
  });
});
