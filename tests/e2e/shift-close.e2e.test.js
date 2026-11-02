// Shift Scrap Close (Phase 3) in the browser — Firebase EMULATOR ONLY (npm run test:e2e).
// Scrap Entry close panel, confirm sheet, CHANGED → Reconfirm, Daily Confirmation matrix,
// import-incomplete conflict, unauthorized users, phone width, and "off" mode staying hidden.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');

const ROOT = path.join(__dirname, '../..');
const PORT = 5511;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'demo-quality-dashboard';
const AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const PASSWORD = 'test-password-1';
const E = code => `${code.toLowerCase()}@prodv2.local`;
// Thailand dates (Asia/Bangkok, UTC+7), like the pages and the rules.
const bkkDate = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
const D1 = bkkDate(2);   // two days ago: both shifts have ended
let env, server, browser;

async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function seed() {
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const code of ['ADMIN1', 'LEADA', 'VIEW1']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(code), password: PASSWORD });
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'qdUsers', E('VIEW1')), u('viewer', []));
    await setDoc(doc(db, 'prodV2_dailyPlans', `plan_${D1}_A_DAY`), { blocks: [{ start: '08:00', end: '17:00', cells: [{ model: 'M-100', door: 'FR', plan: 100 }] }] });
    await setDoc(doc(db, 'scrapLogs', 'seed1'), { date: D1, shift: 'DAY', line: 'A', model: 'M-100 FR', defectType: 'Dent', scrapQty: 4, remark: '', createdAt: 1 });
  });
}
const slot = id => { let out; return env.withSecurityRulesDisabled(async ctx => { const s = await getDoc(doc(ctx.firestore(), 'scrapSlots', id)); out = s.exists() ? s.data() : null; }).then(() => out); };

async function newPage(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/permission|PERMISSION_DENIED|Failed to load resource|shift close failed/i.test(m.text())) errors.push(m.text()); });
  return { page, context, errors };
}
async function signIn(page, code) {
  await page.click('#qdAuthOpen');
  await page.fill('#qdAuthCode', code);
  await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}
const chipOf = (page, scope) => page.waitForSelector(`${scope} .sc-head .sc-chip`, { timeout: 15000 }).then(() => page.getAttribute(`${scope} .sc-head .sc-chip`, 'data-status'));
async function waitChip(page, scope, status) {
  await page.waitForSelector(`${scope} .sc-head .sc-chip[data-status="${status}"]`, { timeout: 15000 });
}
async function blockedText(page, re) {
  await page.waitForFunction(src => { const el = document.querySelector('#shiftClosePanel [data-role="blocked"]'); return el && new RegExp(src).test(el.textContent); }, re.source, { timeout: 15000 });
  return page.textContent('#shiftClosePanel [data-role="blocked"]');
}
async function confirmSheet(page, reason) {
  await page.waitForSelector('.sc-sheet', { timeout: 5000 });
  if (reason !== undefined) await page.fill('#scReason', reason);
  await page.click('#scConfirm');
  await page.waitForSelector('.sc-sheet', { state: 'detached', timeout: 15000 });
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  if (env) await env.cleanup();
});

describe('Shift Scrap Close in the browser (emulator)', () => {
  before(seed);
  const entry = `scrap-entry.html?qdEmulator=1&date=${D1}&line=A&shift=DAY`;

  it('Leader: PENDING → Submit → SUBMITTED, shows who and when', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/${entry}`);
    await signIn(page, 'LEADA');
    await waitChip(page, '#shiftClosePanel', 'PENDING');
    assert.equal(await page.textContent('#shiftClosePanel [data-role="count"]'), '1');
    await page.click('#shiftClosePanel [data-action="SUBMITTED"]');
    await confirmSheet(page);
    await waitChip(page, '#shiftClosePanel', 'SUBMITTED');
    const by = await page.textContent('#shiftClosePanel [data-role="closed-by"]');
    assert.match(by, /LEADA/); assert.match(by, /revision 1/);
    assert.equal(await page.$('#shiftClosePanel [data-action]'), null);   // leader: no re-close at the same version
    const s = await slot(`${D1}_A_DAY`);
    assert.equal(s.closeState, 'SUBMITTED'); assert.equal(s.closedScrapQty, 4);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Leader saves more scrap after the close → CHANGED → Reconfirm records revision 2', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/${entry}`);
    await signIn(page, 'LEADA');
    await waitChip(page, '#shiftClosePanel', 'SUBMITTED');
    await page.waitForFunction(() => !document.getElementById('fModel').disabled && document.getElementById('fModel').options.length > 1, null, { timeout: 15000 });
    await page.selectOption('#fModel', { index: 1 });
    await page.selectOption('#fDefect', { index: 1 });
    await page.fill('#fQty', '3');
    await page.click('#saveBtn');
    await waitChip(page, '#shiftClosePanel', 'CHANGED');
    assert.match(await page.textContent('#shiftClosePanel [data-role="changed"]'), /Reconfirm is required/);
    const btn = await page.textContent('#shiftClosePanel [data-action="SUBMITTED"]');
    assert.match(btn, /Reconfirm scrap \(2 records, 7 pcs\)/);
    await page.click('#shiftClosePanel [data-action="SUBMITTED"]');
    await confirmSheet(page);
    await waitChip(page, '#shiftClosePanel', 'SUBMITTED');
    const s = await slot(`${D1}_A_DAY`);
    assert.equal(s.closeRevision, 2); assert.equal(s.closedScrapQty, 7); assert.equal(s.closedVersion, s.logVersion);
    await page.click('#shiftClosePanel .sc-history summary');
    await page.waitForFunction(() => /rev 2/.test(document.querySelector('#shiftClosePanel [data-role="history"]').textContent), null, { timeout: 10000 });
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('closing a stale view is refused with a clear message (scrap changed while reviewing)', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${D1}&line=B&shift=NIGHT`);
    await signIn(page, 'ADMIN1');
    await waitChip(page, '#shiftClosePanel', 'PENDING');
    await page.click('#shiftClosePanel [data-action="CONFIRMED_ZERO"]');
    await page.waitForSelector('.sc-sheet');
    // someone saves scrap for that shift while the sheet is open
    await page.evaluate(async d => ScrapDataAdapter.addScrapEntry(window.qdDb, { date: d, shift: 'NIGHT', line: 'B', model: 'M', defectType: 'Dent', scrapQty: 2 }), D1);
    await page.click('#scConfirm');
    await page.waitForSelector('#scSheetErr:not([hidden])', { timeout: 15000 });
    assert.match(await page.textContent('#scSheetErr'), /changed while you were reviewing/);
    assert.equal((await slot(`${D1}_B_NIGHT`)).closeState, undefined);
    await context.close();
  });

  it('Leader on a Line/Shift not assigned, and a viewer: no close buttons', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${D1}&line=C&shift=DAY`);
    await signIn(page, 'LEADA');
    await waitChip(page, '#shiftClosePanel', 'PENDING');
    assert.match(await blockedText(page, /not assigned to you/), /not assigned to you/);
    assert.equal(await page.$('#shiftClosePanel [data-action]'), null);
    await page.click('#qdAuthSignOut'); await page.waitForSelector('#qdAuthOpen');
    await signIn(page, 'VIEW1');
    await waitChip(page, '#shiftClosePanel', 'PENDING');
    assert.match(await blockedText(page, /Viewers cannot close/), /Viewers cannot close/);
    assert.equal(await page.$('#shiftClosePanel [data-action]'), null);
    // the rules refuse it even when the page is bypassed
    const r = await page.evaluate(async d => { try { await ShiftClose.closeSlot(window.qdDb, { date: d, line: 'C', shift: 'DAY', state: 'CONFIRMED_ZERO' }, { email: QDAuth.getState().email, serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp() }); return 'saved'; } catch (e) { return e.code; } }, D1);
    assert.match(r, /permission/);
    await context.close();
  });

  it('a shift that has not ended yet cannot be closed', async () => {
    const { page, context } = await newPage();
    const today = bkkDate(0);
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${today}&line=A&shift=NIGHT`);
    await signIn(page, 'ADMIN1');
    await waitChip(page, '#shiftClosePanel', 'PENDING');
    assert.match(await blockedText(page, /can be closed after it ends/), /can be closed after it ends/);
    await context.close();
  });

  it('a device clock moved forward cannot close a shift early: the server time decides', async () => {
    const { page, context } = await newPage();
    const off = 7 * 3600000, b = new Date(Date.now() + off);
    const today = `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, '0')}-${String(b.getUTCDate()).padStart(2, '0')}`;
    // the device thinks it is tomorrow 09:00 Thailand time: today's NIGHT (ends 08:00 tomorrow) looks ended
    await page.clock.setFixedTime(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + 1, 2, 0)));
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${today}&line=A&shift=NIGHT`);
    await signIn(page, 'ADMIN1');
    await page.waitForSelector('#shiftClosePanel [data-action="CONFIRMED_ZERO"]', { timeout: 15000 });   // the page offers it
    await page.click('#shiftClosePanel [data-action="CONFIRMED_ZERO"]');
    await page.waitForSelector('.sc-sheet');
    await page.click('#scConfirm');
    await page.waitForSelector('#scSheetErr:not([hidden])', { timeout: 15000 });
    assert.match(await page.textContent('#scSheetErr'), /server refused.*not ended yet by server time/);
    assert.equal((await slot(`${today}_A_NIGHT`)), null);
    await context.close();
  });

  it('Daily Confirmation: 3×2 matrix, No Production with a reason, shown with who/when', async () => {
    const { page, context, errors } = await newPage();
    await page.goto(`${BASE}/daily-confirmation.html?qdEmulator=1&date=${D1}`);
    await signIn(page, 'ADMIN1');
    await page.waitForSelector('[data-role="matrix"]', { timeout: 15000 });
    const cells = await page.$$eval('.sc-cell', els => els.map(e => [e.dataset.slot.split('_').slice(1).join('_'), e.querySelector('.sc-chip').dataset.status]));
    assert.equal(cells.length, 6);
    assert.deepEqual(Object.fromEntries(cells), { A_DAY: 'SUBMITTED', A_NIGHT: 'PENDING', B_DAY: 'PENDING', B_NIGHT: 'PENDING', C_DAY: 'PENDING', C_NIGHT: 'PENDING' });
    await page.click(`.sc-cell[data-slot="${D1}_C_NIGHT"]`);
    await waitChip(page, '#dcDetail', 'PENDING');
    await page.click('#dcDetail [data-action="NO_PRODUCTION"]');
    await page.waitForSelector('.sc-sheet');
    await page.click('#scConfirm');                     // empty reason → refused in the sheet
    assert.match(await page.textContent('#scSheetErr'), /reason/);
    await confirmSheet(page, 'Line stopped: planned maintenance');
    await page.waitForSelector(`.sc-cell[data-slot="${D1}_C_NIGHT"] .sc-chip[data-status="NO_PRODUCTION"]`, { timeout: 15000 });
    assert.match(await page.textContent(`.sc-cell[data-slot="${D1}_C_NIGHT"] .sc-cell-who`), /ADMIN1/);
    assert.equal((await slot(`${D1}_C_NIGHT`)).noProductionReason, 'Line stopped: planned maintenance');
    // Admin may reconfirm a closed shift
    await waitChip(page, '#dcDetail', 'NO_PRODUCTION');
    assert.ok(await page.$('#dcDetail [data-action="NO_PRODUCTION"]'));
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('import that partly failed: the slot shows Conflict and only Admin can clear the marker', async () => {
    const { page, context } = await newPage();
    await page.goto(`${BASE}/daily-confirmation.html?qdEmulator=1&date=${D1}`);
    await signIn(page, 'ADMIN1');
    const res = await page.evaluate(async d => {
      const rows = [{ date: d, shift: 'DAY', line: 'B', model: 'M', defectType: 'Dent', scrapQty: 1, remark: '' }, { date: d, shift: 'DAY', line: 'C', model: 'M', defectType: 'Dent', scrapQty: 2, remark: '' }];
      await ScrapLedger.markImport(window.qdDb, rows, 'imp_e2e', { email: QDAuth.getState().email, serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp() });
      return 'marked';
    }, D1);
    assert.equal(res, 'marked');
    await page.click('#dcReload');
    await page.waitForSelector(`.sc-cell[data-slot="${D1}_C_DAY"] .sc-chip[data-status="CONFLICT"]`, { timeout: 15000 });
    await page.click(`.sc-cell[data-slot="${D1}_C_DAY"]`);
    await waitChip(page, '#dcDetail', 'CONFLICT');
    assert.match(await page.textContent('#dcDetail [data-role="conflict"]'), /import/i);
    assert.equal(await page.$('#dcDetail [data-action="CONFIRMED_ZERO"]'), null);
    await page.click('#dcDetail [data-action="clear-import"]');
    await confirmSheet(page);
    await page.waitForSelector(`.sc-cell[data-slot="${D1}_C_DAY"] .sc-chip[data-status="PENDING"]`, { timeout: 15000 });
    await context.close();
  });

  it('phone width: matrix and panel fit without horizontal page scroll', async () => {
    const { page, context } = await newPage({ width: 390, height: 844 });
    await page.goto(`${BASE}/daily-confirmation.html?qdEmulator=1&date=${D1}`);
    await page.evaluate(() => document.getElementById('dashboardMobileToggle').click());
    await signIn(page, 'LEADA');
    await page.evaluate(() => document.getElementById('dashboardSidebarOverlay').click());
    await page.waitForSelector('[data-role="matrix"]', { timeout: 15000 });
    await page.click(`.sc-cell[data-slot="${D1}_A_NIGHT"]`);
    await page.waitForSelector('#dcDetail .sc-chip');
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth, cell: document.querySelector('.sc-cell').getBoundingClientRect().width }));
    assert.ok(w.doc <= w.view, JSON.stringify(w));
    assert.ok(w.cell > 300, 'cells stack full width on a phone');
    await page.screenshot({ path: path.join(__dirname, 'artifacts-daily-confirmation-mobile.png'), fullPage: true });
    await page.goto(`${BASE}/${entry}`);
    await page.waitForSelector('#shiftClosePanel .sc-head', { timeout: 15000 });
    const w2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth, panel: document.getElementById('shiftClosePanel').scrollWidth <= document.getElementById('shiftClosePanel').clientWidth }));
    assert.ok(w2.panel, 'panel content fits');
    await context.close();
  });
});

describe('Shift Close stays hidden with sign-in "off" (live default)', () => {
  it('Scrap Entry panel hidden; Daily Confirmation says not enabled; nothing read from scrapSlots', async () => {
    const { page, context } = await newPage();
    const slotReads = [];
    page.on('request', r => { if (/scrapSlots/.test(r.url()) || /scrapSlots/.test(r.postData() || '')) slotReads.push(r.url()); });
    await page.goto(`${BASE}/scrap-entry.html`);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => document.getElementById('shiftClosePanel').hidden), true);
    await page.goto(`${BASE}/daily-confirmation.html`);
    await page.waitForSelector('#dcMatrix .sc-note');
    assert.match(await page.textContent('#dcMatrix'), /not enabled yet/);
    assert.deepEqual(slotReads, []);
    await context.close();
  });
});

describe('network failure and retry (emulator)', () => {
  it('saving or closing while offline fails cleanly (nothing half-written); after reconnecting it works', async () => {
    await seed();
    const { page, context } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${D1}&line=A&shift=DAY`);
    await signIn(page, 'LEADA');
    await waitChip(page, '#shiftClosePanel', 'PENDING');
    const before = await slot(`${D1}_A_DAY`);
    await context.setOffline(true);
    const offline = await page.evaluate(async d => {
      const t = Date.now();
      try { await ScrapDataAdapter.addScrapEntry(window.qdDb, { date: d, shift: 'DAY', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 2 }); return 'saved'; }
      catch (e) { return `${e.code || e.message} after ${Math.round((Date.now() - t) / 1000)}s`; }
    }, D1);
    assert.match(offline, /unavailable|offline|network|failed/i, offline);
    await context.setOffline(false);
    assert.deepEqual(await slot(`${D1}_A_DAY`), before, 'no ledger change while offline');
    const online = await page.evaluate(async d => { await ScrapDataAdapter.addScrapEntry(window.qdDb, { date: d, shift: 'DAY', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 2 }); return 'saved'; }, D1);
    assert.equal(online, 'saved');
    const s = await slot(`${D1}_A_DAY`);
    assert.equal(s.liveLogCount, 2); assert.equal(s.logVersion, 1);
    console.log('  offline save result:', offline);
    await context.close();
  });
});
