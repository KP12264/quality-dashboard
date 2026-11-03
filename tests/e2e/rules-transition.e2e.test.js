// Phase 6 — the real pages under each rules version, EMULATOR ONLY:
//   production  emulator/production.firestore.rules.snapshot (what the Console shows today)
//   bridge      emulator/firestore.rules.bridge (transition)
//   candidate   emulator/firestore.rules (final)
// with the site as it is live today (sign-in "off", via ?qdAuthMode=off — emulator only) and the
// new site (sign-in enforced). Shows exactly when saving fails during a rollout, and the risk of
// old pages writing around the ledger while the bridge is in place.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDocs, getDoc, collection, query, where } = require('firebase/firestore');

const ROOT = path.join(__dirname, '../..');
const PORT = 5513, BASE = `http://127.0.0.1:${PORT}`, PROJECT = 'demo-quality-dashboard', AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const CHART = path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js');
const XLSX = path.join(__dirname, '../node_modules/xlsx/dist/xlsx.full.min.js');
const PASSWORD = 'test-password-1';
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const DAY = bkk(2);
const RULES = { production: 'emulator/production.firestore.rules.snapshot', bridge: 'emulator/firestore.rules.bridge', candidate: 'emulator/firestore.rules' };
let env, server, browser;
const summary = [];

async function useRules(name) {
  if (env) await env.cleanup();
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, RULES[name]), 'utf8'), host: '127.0.0.1', port: 8080 } });
}
async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
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
    for (const l of ['A', 'B']) await setDoc(doc(db, 'prodV2_dailyPlans', `plan_${DAY}_${l}_DAY`), { blocks: [{ start: '08:00', end: '17:00', cells: [{ model: 'M-100', door: 'FR', plan: 100 }] }] });
  });
}
const logsOf = () => { let n; return env.withSecurityRulesDisabled(async ctx => { n = (await getDocs(query(collection(ctx.firestore(), 'scrapLogs'), where('date', '==', DAY)))).size; }).then(() => n); };

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/chart\.umd(\.min)?\.js/.test(url)) return route.fulfill({ path: CHART, contentType: 'application/javascript' });
    if (/xlsx\.full\.min\.js/.test(url)) return route.fulfill({ path: XLSX, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  return { context, page: await context.newPage() };
}
async function signIn(page, code) {
  await page.click('#qdAuthOpen'); await page.fill('#qdAuthCode', code); await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}
// Scrap Entry: one record through the form. Returns the message shown.
async function saveViaForm(page) {
  await page.locator('input[name="ctxLine"][value="A"]').check({ force: true });
  await page.waitForFunction(() => !document.getElementById('fModel').disabled && document.getElementById('fModel').options.length > 1, null, { timeout: 15000 });
  await page.selectOption('#fModel', { index: 1 }); await page.selectOption('#fDefect', { index: 1 }); await page.fill('#fQty', '2');
  await page.evaluate(() => { document.getElementById('entryMessage').hidden = true; });
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('entryMessage').hidden, null, { timeout: 30000 });
  return (await page.textContent('#entryMessage')).replace(/\s+/g, ' ').trim();
}
async function importCsv(page) {
  const f = path.join(os.tmpdir(), `qd-p6-${Date.now()}.csv`);
  fs.writeFileSync(f, ['Date,Shift,Line,Model,Defect,Qty,Remark', `${DAY},DAY,B,M-100 FR,Dent,3,`, `${DAY},DAY,B,M-100 FR,Scratch,1,`].join('\n'));
  await page.click('#entryTabs button[data-tab="import"]');
  await page.setInputFiles('#importFileInput', f);
  await page.waitForSelector('#continueToValidationBtn', { state: 'visible', timeout: 15000 });
  await page.click('#continueToValidationBtn');
  await page.waitForFunction(() => !document.getElementById('importConfirmBtn').disabled && !/Checking/.test(document.getElementById('importSummaryCards').textContent), null, { timeout: 20000 });
  await page.click('#importConfirmBtn');
  await page.waitForFunction(() => /Imported|not started|failed/.test(document.getElementById('importMessage').textContent), null, { timeout: 40000 });
  await page.click('#entryTabs button[data-tab="manual"]');
  return (await page.textContent('#importMessage')).replace(/\s+/g, ' ').trim();
}
// The old site (sign-in off) does: scrap form, Excel import, model mapping save, public dashboard read.
async function oldSite() {
  const { context, page } = await newPage();
  await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&qdAuthMode=off&date=${DAY}&line=A&shift=DAY`);
  await page.waitForFunction(() => window.qdDb && window.qdAuthMode === 'off', null, { timeout: 15000 });
  const before = await logsOf();
  const form = await saveViaForm(page);
  const imp = await importCsv(page);
  const mapping = await page.evaluate(async () => { const r = await ScrapModelMappingAdapter.saveMappings(window.qdDb, [{ excelModel: 'XL-1', productionModel: 'M-100 FR' }]); return r.error ? 'refused' : 'saved'; });
  const saved = (await logsOf()) - before;
  await page.goto(`${BASE}/index.html?qdEmulator=1&qdAuthMode=off`);
  await page.waitForFunction(() => window.qdDb && !['–', ''].includes(document.getElementById('kpiStatus').textContent.trim()), null, { timeout: 20000 });
  const dashboardBanner = await page.evaluate(() => document.getElementById('connectionBanner').style.display === 'none' ? 'ok' : document.getElementById('connectionBanner').textContent);
  await context.close();
  return { form: /Saved/.test(form) ? 'saved' : 'refused', import: /Imported \d+ record/.test(imp) && !/failed/.test(imp) ? 'saved' : 'refused', mapping, logsWritten: saved, dashboard: dashboardBanner, formText: form };
}
// The new site (sign-in enforced) as Leader: save (ledger) + close.
async function newSite() {
  const { context, page } = await newPage();
  await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${DAY}&line=A&shift=DAY`);
  let signedIn = 'ok';
  try { await signIn(page, 'LEADA'); } catch (e) { signedIn = 'failed'; }
  const role = await page.evaluate(() => { const s = window.QDAuth.getState(); return s.profile ? s.profile.role : (s.profileError || 'no role'); });
  const form = signedIn === 'ok' ? await saveViaForm(page) : 'not signed in';
  const close = await page.evaluate(async d => {
    try { await ShiftClose.closeSlot(window.qdDb, { date: d, line: 'A', shift: 'DAY', state: 'SUBMITTED', reconfirm: true }, { email: QDAuth.getState().email, serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp() }); return 'closed'; }
    catch (e) { return 'refused'; }
  }, DAY);
  await context.close();
  return { role, form: /Saved/.test(form) ? 'saved' : 'refused', close };
}

before(async () => {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
});
after(async () => {
  console.log('\nRULES TRANSITION REPORT\n' + summary.map(s => '  ' + s).join('\n'));
  fs.mkdirSync(path.join(ROOT, 'docs/phase6/generated'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/phase6/generated/transition-flows.md'), '# Real pages under each rules version (generated)\n\nGenerated by `tests/e2e/rules-transition.e2e.test.js` (Emulator).\n\n| Rules | Site | Result |\n|---|---|---|\n' + summary.map(s => '| ' + s.split(' :: ').join(' | ') + ' |').join('\n') + '\n');
  if (browser) await browser.close();
  if (server) server.kill();
  if (env) await env.cleanup();
});

describe('old site (sign-in off) and new site (sign-in on) under each rules version', () => {
  it('PRODUCTION rules: old site saves everything (public write); new site cannot work (no QD rules yet)', async () => {
    await useRules('production'); await seed();
    const o = await oldSite();
    summary.push(`production :: old site (off) :: form ${o.form}, Excel import ${o.import}, mapping ${o.mapping}, ${o.logsWritten} logs, dashboard ${o.dashboard}`);
    assert.deepEqual([o.form, o.import, o.mapping, o.logsWritten, o.dashboard], ['saved', 'saved', 'saved', 3, 'ok']);
    const n = await newSite();
    summary.push(`production :: new site (enforce, Leader) :: role ${n.role}, form ${n.form}, close ${n.close}`);
    assert.equal(n.form, 'refused'); assert.equal(n.close, 'refused');
  });
  it('BRIDGE rules: old site AND new site both work (no write-failure window)', async () => {
    await useRules('bridge'); await seed();
    const o = await oldSite();
    summary.push(`bridge :: old site (off) :: form ${o.form}, Excel import ${o.import}, mapping ${o.mapping}, ${o.logsWritten} logs, dashboard ${o.dashboard}`);
    assert.deepEqual([o.form, o.import, o.mapping, o.dashboard], ['saved', 'saved', 'saved', 'ok']);
    const n = await newSite();
    summary.push(`bridge :: new site (enforce, Leader) :: role ${n.role}, form ${n.form}, close ${n.close}`);
    assert.deepEqual([n.role, n.form, n.close], ['leader', 'saved', 'closed']);
  });
  it('BRIDGE risk: an old page saving after a close is caught as CONFLICT (not silently counted)', async () => {
    // continues from the bridge state above: A Day is closed; the old site saves one more record
    const { context, page } = await newPage();
    await page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&qdAuthMode=off&date=${DAY}&line=A&shift=DAY`);
    await page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
    assert.match(await saveViaForm(page), /Saved/);
    await context.close();
    let status;
    await env.withSecurityRulesDisabled(async ctx => {
      const SC = require('../../js/shift-close.js');
      const { compatDb } = require('../support/compat-shim.js');
      status = (await SC.loadSlot(compatDb(ctx.firestore()), DAY, 'A', 'DAY')).info;
    });
    summary.push(`bridge :: old page writes after a close :: slot status ${status.status} (${status.reasons.join(',')})`);
    assert.equal(status.status, 'CONFLICT');
  });
  it('CANDIDATE rules: new site works; old site can no longer write (public write closed), but still reads', async () => {
    await useRules('candidate'); await seed();
    const n = await newSite();
    summary.push(`candidate :: new site (enforce, Leader) :: role ${n.role}, form ${n.form}, close ${n.close}`);
    assert.deepEqual([n.role, n.form, n.close], ['leader', 'saved', 'closed']);
    const o = await oldSite();
    summary.push(`candidate :: old site (off) :: form ${o.form}, Excel import ${o.import}, mapping ${o.mapping}, ${o.logsWritten} logs, dashboard ${o.dashboard}`);
    assert.deepEqual([o.form, o.import, o.mapping, o.logsWritten, o.dashboard], ['refused', 'refused', 'refused', 0, 'ok']);
    assert.match(o.formText, /Save failed/);   // the old page tells the user; nothing is lost silently
  });
});
