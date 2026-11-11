// Browser end-to-end tests for sign-in and roles — Firebase EMULATOR ONLY.
// Run with: npm run test:e2e   (starts the Firestore + Auth emulators for "demo-quality-dashboard")
// Pages are opened on 127.0.0.1 with ?qdEmulator=1, which makes js/firebase-init.js use the
// demo project and the emulator; nothing can reach the real Firebase project.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDocs, collection } = require('firebase/firestore');
const { daysAgo } = require('../support/dates.js');

const ROOT = path.join(__dirname, '../..');
const PORT = 5510;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'demo-quality-dashboard';
const AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const CHART = path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js');
const PASSWORD = 'test-password-1';
const E = code => `${code.toLowerCase()}@prodv2.local`;
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

let env, server, browser;

async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function createAccount(code) {
  await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(code), password: PASSWORD });
}

async function seed() {
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const code of ['ADMIN1', 'LEADA', 'VIEW1', 'PV2ONLY']) await createAccount(code);
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'qdUsers', E('VIEW1')), u('viewer', []));
    await setDoc(doc(db, 'prodV2_authorizedUsers', E('PV2ONLY')), { active: true });   // Production V2 writer, no QD role
    for (const line of ['A', 'B']) {
      await setDoc(doc(db, 'prodV2_dailyPlans', `plan_${today}_${line}_DAY`), { blocks: [{ start: '08:00', end: '17:00', cells: [{ model: 'M-100', door: 'FR', plan: 100 }] }] });
      await setDoc(doc(db, 'prodV2_actualLogs', `actual_${today}_${line}_DAY`), { actualByCell: { '0|||M-100|||FR': 80 } });
    }
    await setDoc(doc(db, 'scrapLogs', 'seed1'), { date: today, shift: 'DAY', line: 'A', model: 'M-100 FR', defectType: 'Dent', scrapQty: 4, remark: '', createdAt: 1 });
  });
}

async function scrapDocs() {
  let rows = [];
  await env.withSecurityRulesDisabled(async ctx => { (await getDocs(collection(ctx.firestore(), 'scrapLogs'))).forEach(d => rows.push(Object.assign({ id: d.id }, d.data()))); });
  return rows;
}

async function newPage(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/chart\.umd(\.min)?\.js/.test(url)) return route.fulfill({ path: CHART, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });   // fonts etc. — no other network
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/permission|PERMISSION_DENIED|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  return { page, context, errors };
}
const open = (page, file) => page.goto(`${BASE}/${file}?qdEmulator=1`);

async function signIn(page, code) {
  await page.click('#qdAuthOpen');
  await page.fill('#qdAuthCode', code);
  await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });   // role read finished
}

async function fillScrapEntry(page, line, qty) {
  await page.locator(`input[name="ctxShift"][value="DAY"]`).check({ force: true });
  await page.locator(`input[name="ctxLine"][value="${line}"]`).check({ force: true });
  await page.waitForFunction(() => !document.getElementById('fModel').disabled && document.getElementById('fModel').options.length > 1, null, { timeout: 15000 });
  await page.selectOption('#fModel', { index: 1 });
  await page.selectOption('#fDefect', { index: 1 });
  await page.fill('#fQty', String(qty));
}
async function save(page) {
  await page.evaluate(() => { document.getElementById('entryMessage').hidden = true; });
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('entryMessage').hidden, null, { timeout: 15000 });
  return (await page.textContent('#entryMessage')).replace(/\s+/g, ' ').trim();
}
// Bypass every client-side check and write straight to Firestore from the page.
// The date is inside the leader window (Thailand yesterday; was the fixed '2026-11-02'), so a refusal is about the Line.
const directWrite = async (page, line) => page.evaluate(async ({ line, email, date }) => {
  try {
    await window.qdDb.collection('scrapLogs').add({ date, shift: 'DAY', line, model: 'M', defectType: 'Dent', scrapQty: 1, createdAt: Date.now() });
    return 'written';
  } catch (e) { return e.code || e.message; }
}, { line, email: await page.evaluate(() => window.QDAuth.getState().email), date: daysAgo(1) });

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

describe('sign-in and roles in the browser (emulator)', () => {
  before(seed);

  it('test mode really uses the demo project and the emulator', async () => {
    const { page, context } = await newPage();
    await open(page, 'index.html');
    const info = await page.evaluate(() => ({ mode: window.qdAuthMode, emu: window.qdEmulator, project: firebase.app('qualityDashboardReadOnly').options.projectId }));
    assert.deepEqual(info, { mode: 'enforce', emu: true, project: 'demo-quality-dashboard' });
    await context.close();
  });

  it('public dashboard and Executive Report still load without signing in', async () => {
    const { page, context, errors } = await newPage();
    await open(page, 'index.html');
    await page.waitForFunction(() => /\d/.test(document.getElementById('kpiScrap').textContent), null, { timeout: 15000 });
    assert.equal((await page.textContent('#kpiScrap')).trim(), '4');
    assert.match(await page.textContent('#qdAuthBox'), /Read-only/);
    await open(page, 'executive-report.html');
    await page.waitForTimeout(2500);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('not signed in: saving scrap is refused with a clear message', async () => {
    const { page, context } = await newPage();
    await open(page, 'scrap-entry.html');
    await fillScrapEntry(page, 'A', 2);
    assert.match(await save(page), /Sign in with your employee code/);
    assert.equal((await scrapDocs()).length, 1);
    await context.close();
  });

  it('leader saves on the assigned Line only; the rules block a direct write to another Line', async () => {
    const { page, context, errors } = await newPage();
    await open(page, 'scrap-entry.html');
    await signIn(page, 'LEADA');
    assert.match(await page.textContent('#qdAuthBox'), /Leader · A Day/);
    await fillScrapEntry(page, 'A', 3);
    assert.match(await save(page), /Saved/);
    const mine = (await scrapDocs()).filter(r => r.id !== 'seed1');
    assert.equal(mine.length, 1);
    assert.equal(JSON.stringify(mine[0]).includes('@'), false);   // no e-mail on the public record (it is in the audit event)
    assert.equal(mine[0].line, 'A');
    await fillScrapEntry(page, 'B', 3);
    assert.match(await save(page), /cannot save scrap records for Door B · Day/);
    assert.equal(await directWrite(page, 'B'), 'permission-denied');   // server-side, not just the UI
    assert.equal((await scrapDocs()).filter(r => r.line === 'B').length, 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('viewer and a Production V2 user without a QD role cannot write', async () => {
    for (const [code, text] of [['VIEW1', /Viewer/], ['PV2ONLY', /No Quality Dashboard role\s*Read-only in the Quality Dashboard/]]) {
      const { page, context } = await newPage();
      await open(page, 'scrap-entry.html');
      await signIn(page, code);
      assert.match(await page.textContent('#qdAuthBox'), text);
      await fillScrapEntry(page, 'A', 1);
      assert.match(await save(page), /cannot save scrap records|no Quality Dashboard role/);
      assert.equal(await directWrite(page, 'A'), 'permission-denied');
      await context.close();
    }
  });

  it('admin manages roles on the Admin page; a leader cannot', async () => {
    const { page, context } = await newPage();
    await open(page, 'admin.html');
    await signIn(page, 'ADMIN1');
    await page.click('#adminTabs button[data-tab="permission"]');
    await page.waitForFunction(() => !document.getElementById('usersPanel').hidden && /LEADA/.test(document.getElementById('usersBody').textContent), null, { timeout: 15000 });
    await page.fill('#uCode', 'NEW1');
    await page.fill('#uName', 'New Leader');
    await page.selectOption('#uRole', 'leader');
    await page.check('#uSlots input[value="B_DAY"]');
    await page.click('#uSave');
    await page.waitForFunction(() => /NEW1/.test(document.getElementById('usersBody').textContent), null, { timeout: 15000 });
    let saved;
    await env.withSecurityRulesDisabled(async ctx => { (await getDocs(collection(ctx.firestore(), 'qdUsers'))).forEach(d => { if (d.id === E('NEW1')) saved = d.data(); }); });
    assert.equal(saved.role, 'leader');
    assert.deepEqual(saved.slots, ['B_DAY']);
    assert.equal(saved.updatedBy, E('ADMIN1'));
    await page.click('#qdAuthSignOut');
    await page.waitForSelector('#qdAuthOpen');
    await signIn(page, 'LEADA');
    await page.click('#adminTabs button[data-tab="permission"]');
    await page.waitForFunction(() => /Only a Quality Dashboard admin/.test(document.getElementById('usersStatus').textContent), null, { timeout: 15000 });
    assert.equal(await page.isVisible('#usersPanel'), false);
    await context.close();
  });

  it('sign out returns to read-only', async () => {
    const { page, context } = await newPage();
    await open(page, 'scrap-entry.html');
    await signIn(page, 'LEADA');
    await page.click('#qdAuthSignOut');
    await page.waitForSelector('#qdAuthOpen');
    await fillScrapEntry(page, 'A', 1);
    assert.match(await save(page), /Sign in with your employee code/);
    await context.close();
  });

  it('sign-in box works at phone width without horizontal page scroll', async () => {
    const { page, context } = await newPage({ width: 390, height: 844 });
    for (const file of ['index.html', 'scrap-entry.html', 'scrap-detail.html', 'admin.html']) {
      await open(page, file);
      // V5 pages keep the sign-in box in the sidebar, which is the ☰ drawer on phones.
      // (scrap-entry.html has two ☰ buttons with this id since before this work; the first one is wired.)
      if (await page.isVisible('#dashboardMobileToggle')) { await page.evaluate(() => document.getElementById('dashboardMobileToggle').click()); await page.waitForTimeout(400); }
      await page.click('#qdAuthOpen');
      await page.waitForTimeout(400);
      if (file === 'scrap-entry.html') await page.screenshot({ path: path.join(__dirname, 'artifacts-mobile-signin.png') }).catch(() => {});
      // admin.html already scrolls sideways at 390px on the baseline (f174eb4) because of its Target table;
      // there we only check that the new sign-in box and Users table do not stick out of the screen.
      const r = await page.evaluate(() => {
        const w = document.documentElement.clientWidth, box = document.getElementById('qdAuthBox');
        const users = document.getElementById('usersTable');
        return { overflow: document.documentElement.scrollWidth > w,
                 boxInside: !!box && box.getBoundingClientRect().right <= w + 1 && box.getBoundingClientRect().left >= -1,
                 usersScroll: !users || !!users.closest('.qd-table-scroll') };
      });
      if (file !== 'admin.html') assert.equal(r.overflow, false, file);
      assert.equal(r.boxInside, true, file + ' sign-in box');
      assert.equal(r.usersScroll, true, file + ' users table in its own scroll box');
    }
    await context.close();
  });
});

async function slotState(slotId) {
  let out = null;
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const { getDoc } = require('firebase/firestore');
    const snap = await getDoc(doc(db, 'scrapSlots', slotId));
    if (!snap.exists()) return;
    const events = [];
    (await getDocs(collection(db, 'scrapSlots', slotId, 'events'))).forEach(d => events.push(Object.assign({ id: d.id }, d.data())));
    out = Object.assign({ events: events.sort((a, b) => a.version - b.version) }, snap.data());
  });
  return out;
}

describe('slot ledger through the pages (emulator)', () => {
  before(seed);
  const slotA = () => `${today}_A_DAY`;

  it('Scrap Entry: a leader save creates the ledger version and audit event', async () => {
    const { page, context, errors } = await newPage();
    await open(page, 'scrap-entry.html');
    await signIn(page, 'LEADA');
    await fillScrapEntry(page, 'A', 6);
    assert.match(await save(page), /Saved/);
    const st = await slotState(slotA());
    assert.equal(st.logVersion, 1);
    assert.equal(st.legacyCount, 1);            // the seeded record saved before the ledger
    assert.equal(st.liveLogCount, 2);
    assert.equal(st.events[0].by, E('LEADA'));
    assert.equal(st.events[0].creates.length, 1);
    assert.equal(st.events[0].changes[0].after.scrapQty, 6);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Scrap Detail: an edit that keeps the quantity, then a delete, each add a version', async () => {
    const { page, context, errors } = await newPage();
    await open(page, 'scrap-detail.html');
    await signIn(page, 'LEADA');
    const id = (await scrapDocs()).find(r => r.id !== 'seed1' && r.line === 'A').id;
    const r2 = await page.evaluate(async ({ id, date }) => {
      await ScrapDataAdapter.updateScrapEntry(window.qdDb, id, { date, shift: 'DAY', line: 'A', model: 'M-100 FR', defectType: 'Scratch', scrapQty: 6, remark: '' });
      await ScrapDataAdapter.deleteScrapEntry(window.qdDb, id);
      return 'ok';
    }, { id, date: today });
    assert.equal(r2, 'ok');
    const st = await slotState(slotA());
    assert.equal(st.logVersion, 3);
    assert.deepEqual(st.events[1].updates, [id]);
    assert.equal(st.events[1].changes[0].before.defectType !== st.events[1].changes[0].after.defectType, true);
    assert.equal(st.events[1].changes[0].before.scrapQty, st.events[1].changes[0].after.scrapQty);   // same quantity, still recorded
    assert.deepEqual(st.events[2].deletes, [id]);
    assert.equal(st.liveLogCount, 1);
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Excel import path: admin imports 30 rows over 3 slots; a leader is refused', async () => {
    const { page, context } = await newPage();
    await open(page, 'scrap-entry.html');
    await signIn(page, 'ADMIN1');
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: '2026-10-15',   // fixed-date-ok: admin import (any date); the leader is refused by the client import permission, not by date
      shift: 'DAY', line: 'ABC'[i % 3], model: 'M-1', defectType: 'Dent', scrapQty: 1 + (i % 4), remark: '' }));
    const res = await page.evaluate(async rows => { const r = await ScrapDataAdapter.addScrapEntryBatch(window.qdDb, rows); return { ok: r.succeeded.length, failed: r.failed.length }; }, rows);
    assert.deepEqual(res, { ok: 30, failed: 0 });
    for (const line of ['A', 'B', 'C']) {
      const st = await slotState(`2026-10-15_${line}_DAY`);   // fixed-date-ok: same admin import date as above
      assert.equal(st.logVersion, 1);
      assert.equal(st.liveLogCount, 10);
      assert.equal(st.events[0].creates.length, 10);
    }
    await page.click('#qdAuthSignOut'); await page.waitForSelector('#qdAuthOpen');
    await signIn(page, 'LEADA');
    const leader = await page.evaluate(async rows => { try { await ScrapDataAdapter.addScrapEntryBatch(window.qdDb, rows); return 'saved'; } catch (e) { return e.message; } }, rows.slice(0, 3));
    assert.match(leader, /cannot import scrap from Excel/);
    await context.close();
  });

  it('a page without the ledger module refuses scrap writes while sign-in is on', async () => {
    const { page, context } = await newPage();
    await open(page, 'scrap-entry.html');
    await signIn(page, 'LEADA');
    const r = await page.evaluate(async today => {
      const keep = window.ScrapLedger; window.ScrapLedger = undefined;
      try { await ScrapDataAdapter.addScrapEntry(window.qdDb, { date: today, shift: 'DAY', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 1 }); return 'saved'; }
      catch (e) { return e.code; } finally { window.ScrapLedger = keep; }
    }, today);
    assert.equal(r, 'qd/ledger-missing');
    await context.close();
  });
});

describe('sign-in off (the live default)', () => {
  it('without ?qdEmulator=1 the page stays in "off" mode: no sign-in box, no auth instance', async () => {
    const { page, context } = await newPage();
    // Read-only checks only; nothing is written in this test.
    await page.goto(`${BASE}/scrap-entry.html`);
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => ({ mode: window.qdAuthMode, auth: !!window.qdAuth, box: !!document.getElementById('qdAuthBox'), guard: JSON.stringify(window.qdGuardWrite('scrap.write', { line: 'B', shift: 'DAY' })) }));
    assert.deepEqual(st, { mode: 'off', auth: false, box: false, guard: '{}' });
    await context.close();
  });
});
