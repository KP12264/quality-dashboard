// Phase 8 privacy policy (pending G4) through the real pages — Firebase EMULATOR ONLY.
// Excel "Emp. Ld" (recordedBy) and improvement action owners are saved to non-public documents;
// signed-in users still see them, the public does not; free-text fields carry a hint; with sign-in
// "off" nothing changes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection } = require('firebase/firestore');

const ROOT = path.join(__dirname, '../..');
const PORT = 5515, BASE = `http://127.0.0.1:${PORT}`, PROJECT = 'demo-quality-dashboard', AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const XLSX = path.join(__dirname, '../node_modules/xlsx/dist/xlsx.full.min.js');
const PASSWORD = 'test-password-1';
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const DAY = bkk(2);
let env, server, browser;

async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/xlsx\.full\.min\.js/.test(url)) return route.fulfill({ path: XLSX, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  const page = await context.newPage();
  const requests = [];
  page.on('request', r => requests.push(r.url() + ' ' + (r.postData() || '')));
  return { context, page, requests };
}
async function signIn(page, code) {
  await page.click('#qdAuthOpen'); await page.fill('#qdAuthCode', code); await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const c of ['ADMIN1', 'LEADA']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(c), password: PASSWORD });
  await raw(async db => {
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'prodV2_dailyPlans', `plan_${DAY}_A_DAY`), { blocks: [{ start: '08:00', end: '17:00', cells: [{ model: 'M-100', door: 'FR', plan: 100 }] }] });
  });
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (server) server.kill(); if (env) await env.cleanup(); });

describe('privacy policy in the pages (sign-in on)', () => {
  let logId;
  it('Excel import with an "Emp. Ld" column: the public record has no employee code; the private doc has it', async () => {
    const { context, page } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1`);
    await signIn(page, 'ADMIN1');
    const f = path.join(os.tmpdir(), `qd-p8-${Date.now()}.csv`);
    fs.writeFileSync(f, ['Date,Shift,Line,Model,Defect,Qty,Remark,EmpLd', `${DAY},DAY,A,M-100 FR,Dent,3,,KP0042`].join('\n'));
    await page.click('#entryTabs button[data-tab="import"]');
    await page.setInputFiles('#importFileInput', f);
    await page.waitForSelector('#continueToValidationBtn', { state: 'visible', timeout: 15000 });
    await page.click('#continueToValidationBtn');
    await page.waitForFunction(() => !document.getElementById('importConfirmBtn').disabled && !/Checking/.test(document.getElementById('importSummaryCards').textContent), null, { timeout: 20000 });
    await page.click('#importConfirmBtn');
    await page.waitForFunction(() => /Imported|failed/.test(document.getElementById('importMessage').textContent), null, { timeout: 30000 });
    assert.match(await page.textContent('#importMessage'), /Imported 1 record/);
    await context.close();
    const logs = await raw(async db => { const o = []; (await getDocs(collection(db, 'scrapLogs'))).forEach(d => o.push(Object.assign({ id: d.id }, d.data()))); return o; });
    assert.equal(logs.length, 1);
    logId = logs[0].id;
    assert.equal(logs[0].recordedBy, undefined);
    assert.doesNotMatch(JSON.stringify(logs[0]), /KP0042|@prodv2/);
    assert.equal((await raw(async db => (await getDoc(doc(db, 'scrapLogPrivate', logId))).data())).recordedBy, 'KP0042');
  });
  it('Scrap Detail: signed-in user sees "Recorded By"; the public sees "–" and never reads the private doc', async () => {
    const open = async signedIn => {
      const p = await newPage();
      await p.page.goto(`${BASE}/scrap-detail.html?qdEmulator=1`);
      if (signedIn) await signIn(p.page, 'LEADA');
      await p.page.waitForSelector('.qd-detail-row', { timeout: 20000 });
      await p.page.click('#applyFilters');   // default range = last 30 days; reload after sign-in
      await p.page.waitForTimeout(1500);     // let the re-render finish before opening a row
      await p.page.waitForSelector('.qd-detail-row', { timeout: 20000 });
      await p.page.click('.qd-detail-row td:nth-child(2)');
      await p.page.waitForTimeout(1500);
      const v = await p.page.textContent('[data-recorded-by]');
      const privReads = p.requests.filter(r => /scrapLogPrivate/.test(r)).length;
      await p.context.close();
      return { v: v.trim(), privReads };
    };
    const signed = await open(true), pub = await open(false);
    assert.equal(signed.v, 'KP0042');
    assert.equal(pub.v, '–'); assert.equal(pub.privReads, 0);
  });
  it('Improvement with an action owner: the public document has no name; signed-in edit shows it again', async () => {
    const { context, page } = await newPage();
    await page.goto(`${BASE}/improvement.html?qdEmulator=1`);
    await signIn(page, 'ADMIN1');
    await page.click('#impTabs button[data-tab="new"]');
    await page.fill('#fProblem', 'Dent on door edge');
    await page.selectOption('#fDefectType', { index: 1 });
    await page.click('#addActionBtn');
    await page.fill('#actionRows .qd-action-row .action-desc', 'Replace jig pad');
    await page.fill('#actionRows .qd-action-row .action-owner', 'Somchai K.');
    await page.click('#saveImprovementBtn');
    await page.waitForFunction(() => /created/i.test((document.querySelector('.qd-form-message') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const imps = await raw(async db => { const o = []; (await getDocs(collection(db, 'improvements'))).forEach(d => o.push(Object.assign({ id: d.id }, d.data()))); return o; });
    assert.equal(imps.length, 1);
    assert.doesNotMatch(JSON.stringify(imps[0]), /Somchai|@prodv2/);
    assert.equal(imps[0].actions[0].action, 'Replace jig pad');
    assert.deepEqual((await raw(async db => (await getDoc(doc(db, 'improvementOwners', imps[0].id))).data())).owners, ['Somchai K.']);
    await page.goto(`${BASE}/improvement.html?qdEmulator=1&id=${imps[0].id}`);
    await page.waitForFunction(() => window.QDAuth && window.QDAuth.getState().profile, null, { timeout: 15000 });
    await page.waitForFunction(() => { const o = document.querySelector('#actionRows .action-owner'); return o && o.value; }, null, { timeout: 15000 });
    assert.equal(await page.inputValue('#actionRows .action-owner'), 'Somchai K.');
    await context.close();
  });
  it('free-text fields carry the hint while sign-in is on, and not with sign-in off', async () => {
    const a = await newPage();
    await a.page.goto(`${BASE}/scrap-entry.html?qdEmulator=1`);
    await a.page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    assert.match(await a.page.getAttribute('#fRemark', 'placeholder'), /no names or employee codes/);
    await a.context.close();
    const b = await newPage();
    await b.page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&qdAuthMode=off`);
    await b.page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    assert.doesNotMatch(await b.page.getAttribute('#fRemark', 'placeholder') || '', /employee codes/);
    await b.context.close();
  });
  it('anonymous query of every public collection: no employee code, owner name or e-mail', async () => {
    const anon = env.unauthenticatedContext().firestore();
    let text = '';
    for (const c of ['scrapLogs', 'improvements', 'scrapCloseSummary', 'targetMaster', 'scrapModelMappings', 'scrapWeeklyPlans']) (await getDocs(collection(anon, c))).forEach(d => { text += JSON.stringify(d.data()); });
    assert.doesNotMatch(text, /KP0042|Somchai|@prodv2/);
    for (const c of ['scrapLogPrivate', 'improvementOwners']) await assert.rejects(getDocs(collection(anon, c)));
  });
});
