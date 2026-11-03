// FINAL DEPLOYMENT REHEARSAL (Phase 7) — Firebase EMULATOR ONLY. Nothing touches production.
// Runs the whole proposed rollout in order, with real pages, an old page left open the whole time,
// and Production V2 reading/writing continuously while the rules change:
//   S0 production rules + old site · S1 bridge · S2 admin + roles · S3 sign-in site + Shift Close
//   S4 bridge audit · S5 candidate (rules change while pages are open) · S6 reconcile
//   S7 baseline migration · S8 Shift Close drives the target · R rollback bridge / snapshot / forward
// Every save is checked against the number of scrap logs actually stored (no loss, no phantom).
// Writes docs/phase7/generated/rehearsal-report.md with PASS/FAIL per scenario.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, addDoc, collection, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const MB = require('../../tools/migration/ledger-baseline.js');
const OPS = require('../../tools/ops/bridge-ops.js');
const { op } = require('../support/ops-helper.js');
const { compatDb } = require('../support/compat-shim.js');

const ROOT = path.join(__dirname, '../..');
const PORT = 5514, BASE = `http://127.0.0.1:${PORT}`, PROJECT = 'demo-quality-dashboard', AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const CHART = path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js');
const XLSX = path.join(__dirname, '../node_modules/xlsx/dist/xlsx.full.min.js');
const PASSWORD = 'test-password-1';
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const DAY = bkk(2);
const RULES = { production: 'emulator/production.firestore.rules.snapshot', bridge: 'emulator/firestore.rules.bridge', candidate: 'emulator/firestore.rules' };
let env, server, browser, oldTab, newTab;
const results = [];   // [stage, scenario, PASS|FAIL, detail]
let currentRules = '';

// Publish rules in the emulator WITHOUT tearing down clients (like a Console publish).
async function publish(name) {
  const res = await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}:securityRules`, { method: 'PUT', body: JSON.stringify({ rules: { files: [{ content: fs.readFileSync(path.join(ROOT, RULES[name]), 'utf8') }] } }) });
  if (!res.ok) throw new Error(await res.text());
  currentRules = name;
}
async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }
const countLogs = () => raw(async db => (await getDocs(collection(db, 'scrapLogs'))).size);
const actor = c => { const db = compatDb(env.authenticatedContext('uid-' + c, { email: E(c) }).firestore()); return { db, opts: { email: E(c), serverTimestamp } }; };
const row = (line, shift, qty = 2, date = DAY) => ({ date, line, shift, model: 'M-100 FR', defectType: 'Dent', scrapQty: qty, remark: '', createdAt: Date.now() });
const sdkSave = (a, r) => Ledger.applyOps(a.db, [{ op: 'create', ref: a.db.collection('scrapLogs').doc(), data: r }], a.opts);
const statusOf = async (date, line, shift) => (await SC.loadSlot(actor('ADMIN1').db, date, line, shift)).info.status;

// Records a scenario; `delta` = how many scrap logs the step must add (checked against the store).
async function scenario(stage, name, fn, delta) {
  const before = delta === undefined ? 0 : await countLogs();
  let detail = '', ok = true;
  try {
    detail = (await fn()) || '';
    if (delta !== undefined) { const got = (await countLogs()) - before; if (got !== delta) { ok = false; detail += ` · stored ${got} logs, expected ${delta}`; } }
  } catch (e) { ok = false; detail = (e && e.message ? e.message : String(e)).slice(0, 200); }
  results.push([stage, name, ok ? 'PASS' : 'FAIL', `${detail} [rules: ${currentRules}]`]);
  assert.ok(ok, `${stage} ${name}: ${detail}`);
}

// ---- Production V2 client, reading and writing all the time ----
const pv2 = { writes: 0, reads: 0, failures: [], stop: false };
async function pv2Loop() {
  const db = env.authenticatedContext('uid-pv2', { email: E('PV2W') }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  let i = 0;
  while (!pv2.stop) {
    try { await setDoc(doc(db, 'prodV2_actualLogs', `actual_${DAY}_A_DAY`), { actualByCell: { ['0|||M-100|||FR']: 100 + (i++ % 50) } }, { merge: true }); pv2.writes++; }
    catch (e) { pv2.failures.push(`write@${currentRules}: ${e.code}`); }
    try { await getDoc(doc(anon, 'prodV2_dailyPlans', `plan_${DAY}_A_DAY`)); await getDoc(doc(anon, 'productionLogs', 'p1')); pv2.reads += 2; }
    catch (e) { pv2.failures.push(`read@${currentRules}: ${e.code}`); }
    await new Promise(r => setTimeout(r, 150));
  }
}

async function newPage(viewport = { width: 1280, height: 900 }) {
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
  return { context, page: await context.newPage() };
}
async function signIn(page, code) {
  await page.click('#qdAuthOpen'); await page.fill('#qdAuthCode', code); await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}
async function formSave(page, line = 'A') {
  await page.evaluate(() => { const t = document.querySelector('#entryTabs button[data-tab="manual"]'); if (t) t.click(); });
  await page.locator(`input[name="ctxLine"][value="${line}"]`).check({ force: true });
  await page.waitForFunction(() => !document.getElementById('fModel').disabled && document.getElementById('fModel').options.length > 1, null, { timeout: 15000 });
  await page.selectOption('#fModel', { index: 1 }); await page.selectOption('#fDefect', { index: 1 }); await page.fill('#fQty', '2');
  await page.evaluate(() => { document.getElementById('entryMessage').hidden = true; });
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('entryMessage').hidden, null, { timeout: 40000 });
  return (await page.textContent('#entryMessage')).replace(/\s+/g, ' ').trim();
}
async function importCsv(page, rows) {
  const f = path.join(os.tmpdir(), `qd-p7-${Date.now()}.csv`);
  fs.writeFileSync(f, ['Date,Shift,Line,Model,Defect,Qty,Remark', ...rows.map(r => `${r.date},${r.shift},${r.line},M-100 FR,Dent,${r.scrapQty},`)].join('\n'));
  await page.click('#entryTabs button[data-tab="import"]');
  await page.setInputFiles('#importFileInput', f);
  await page.waitForSelector('#continueToValidationBtn', { state: 'visible', timeout: 15000 });
  await page.click('#continueToValidationBtn');
  await page.waitForFunction(() => !document.getElementById('importConfirmBtn').disabled && !/Checking/.test(document.getElementById('importSummaryCards').textContent), null, { timeout: 20000 });
  await page.click('#importConfirmBtn');
  await page.waitForFunction(() => /Imported|not started|failed/.test(document.getElementById('importMessage').textContent), null, { timeout: 40000 });
  return (await page.textContent('#importMessage')).replace(/\s+/g, ' ').trim();
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, RULES.production), 'utf8'), host: '127.0.0.1', port: 8080 } });
  currentRules = 'production';
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const c of ['ADMIN1', 'LEADA', 'LEADB', 'LEADC', 'VIEW1']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(c), password: PASSWORD });
  await raw(async db => {
    await setDoc(doc(db, 'prodV2_authorizedUsers', E('PV2W')), { active: true });
    await setDoc(doc(db, 'productionLogs', 'p1'), { x: 1 });
    for (const d of [DAY, bkk(3)]) for (const l of ['A', 'B', 'C']) for (const s of ['DAY', 'NIGHT']) await setDoc(doc(db, 'prodV2_dailyPlans', `plan_${d}_${l}_${s}`), { blocks: [{ start: '08:00', end: '17:00', cells: [{ model: 'M-100', door: 'FR', plan: 100 }] }] });
  });
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
  pv2Loop();
});
after(async () => {
  pv2.stop = true;
  await new Promise(r => setTimeout(r, 400));
  const md = ['# Final Deployment Rehearsal (generated)', '', 'Generated by `tests/e2e/rehearsal.e2e.test.js` in the Firebase Emulator (no production access).', '',
    `Production V2 during the whole rehearsal: ${pv2.writes} writes + ${pv2.reads} reads, ${pv2.failures.length} failures${pv2.failures.length ? ' — ' + pv2.failures.slice(0, 5).join('; ') : ''}.`, '',
    '| Stage | Scenario | Result | Detail |', '|---|---|---|---|', ...results.map(r => `| ${r[0]} | ${r[1]} | **${r[2]}** | ${String(r[3]).replace(/\|/g, '/')} |`)].join('\n');
  fs.mkdirSync(path.join(ROOT, 'docs/phase7/generated'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/phase7/generated/rehearsal-report.md'), md + '\n');
  if (browser) await browser.close();
  if (server) server.kill();
  if (env) await env.cleanup();
});

describe('final rehearsal: the whole rollout in order', () => {
  it('S0 production rules: today\'s site saves; an old tab stays open for the whole rehearsal', async () => {
    oldTab = await newPage();
    await oldTab.page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&qdAuthMode=off&date=${DAY}&line=A&shift=DAY`);
    await oldTab.page.waitForFunction(() => window.qdDb && window.qdAuthMode === 'off', null, { timeout: 15000 });
    await scenario('S0', 'Old site saves (form)', async () => { const m = await formSave(oldTab.page); if (!/Saved/.test(m)) throw new Error(m); return 'saved'; }, 1);
    await scenario('S0', 'Old site Excel import (real CSV)', async () => { const m = await importCsv(oldTab.page, [row('B', 'DAY', 3), row('C', 'NIGHT', 1)]); if (!/Imported 2 records/.test(m)) throw new Error(m); return m; }, 2);
    await scenario('S0', 'New site (sign-in) cannot work yet', async () => {
      const r = await sdkSave(actor('LEADA'), row('A', 'NIGHT')).then(() => 'saved', e => e.code || e.message);
      if (!/permission/i.test(r)) throw new Error('expected refused, got ' + r); return 'refused (no QD rules yet) — never deploy the site before the rules';
    }, 0);
  });

  it('S1 publish BRIDGE: old site keeps saving, PV2 unaffected', async () => {
    await publish('bridge');
    await scenario('S1', 'Old tab saves after the publish (no reload)', async () => { const m = await formSave(oldTab.page); if (!/Saved/.test(m)) throw new Error(m); return 'saved'; }, 1);
  });

  it('S2 create first admin and roles (Console)', async () => {
    await scenario('S2', 'Admin + Leaders + Viewer created', async () => {
      await raw(async db => {
        const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: Date.now(), updatedBy: 'console' });
        await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
        await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY', 'A_NIGHT']));
        await setDoc(doc(db, 'qdUsers', E('LEADB')), u('leader', ['B_DAY', 'B_NIGHT']));
        await setDoc(doc(db, 'qdUsers', E('LEADC')), u('leader', ['C_DAY', 'C_NIGHT']));
        await setDoc(doc(db, 'qdUsers', E('VIEW1')), u('viewer', []));
      });
      return '5 roles';
    }, 0);
  });

  it('S3 sign-in site live (bridge): saves, closes, imports, concurrency, network failure, old tab interference', async () => {
    newTab = await newPage();
    await newTab.page.goto(`${BASE}/scrap-entry.html?qdEmulator=1&date=${DAY}&line=A&shift=DAY`);
    await signIn(newTab.page, 'LEADA');
    await scenario('S3', 'Leader saves on the new site', async () => { const m = await formSave(newTab.page); if (!/Saved/.test(m)) throw new Error(m); return 'saved through the ledger'; }, 1);
    await scenario('S3', 'Leader closes A Day', async () => { await SC.closeSlot(actor('LEADA').db, { date: DAY, line: 'A', shift: 'DAY', state: 'SUBMITTED' }, actor('LEADA').opts); return await statusOf(DAY, 'A', 'DAY'); }, 0);
    await scenario('S3', 'Viewer and unassigned Leader cannot save', async () => {
      for (const [c, l] of [['VIEW1', 'A'], ['LEADB', 'A']]) { const r = await sdkSave(actor(c), row(l, 'NIGHT')).then(() => 'saved', e => e.code); if (!/permission/.test(r)) throw new Error(c + ' ' + r); }
      return 'refused';
    }, 0);
    await scenario('S3', 'Many users save at the same time (3 Leaders x 3 + page)', async () => {
      const jobs = [];
      for (let i = 0; i < 3; i++) for (const [c, l] of [['LEADA', 'A'], ['LEADB', 'B'], ['LEADC', 'C']]) jobs.push(sdkSave(actor(c), row(l, 'NIGHT', 1 + i)));
      jobs.push(formSave(newTab.page).then(m => { if (!/Saved/.test(m)) throw new Error(m); }));
      const r = await Promise.allSettled(jobs);
      const bad = r.filter(x => x.status === 'rejected'); if (bad.length) throw new Error(bad.length + ' failed: ' + bad[0].reason);
      return '10 saved';
    }, 10);
    await scenario('S3', 'Network failure while saving, then retry', async () => {
      await newTab.context.setOffline(true);
      const m = await newTab.page.evaluate(async d => { try { await ScrapDataAdapter.addScrapEntry(window.qdDb, { date: d, shift: 'DAY', line: 'A', model: 'M-100 FR', defectType: 'Dent', scrapQty: 2 }); return 'saved'; } catch (e) { return e.code || e.message; } }, DAY);
      await newTab.context.setOffline(false);
      if (m === 'saved') throw new Error('saved while offline');
      const again = await newTab.page.evaluate(async d => { await ScrapDataAdapter.addScrapEntry(window.qdDb, { date: d, shift: 'NIGHT', line: 'A', model: 'M-100 FR', defectType: 'Dent', scrapQty: 2 }); return 'saved'; }, DAY);
      return `offline: ${m}; retry: ${again}`;
    }, 1);
    await scenario('S3', 'Leader closes during an Excel import (refused until the import finishes)', async () => {
      const A = actor('ADMIN1'), L = actor('LEADB');
      await Ledger.markImport(A.db, [row('B', 'DAY', 1, bkk(3))], 'imp-live', A.opts);
      const during = await SC.closeSlot(L.db, { date: bkk(3), line: 'B', shift: 'DAY', state: 'CONFIRMED_ZERO' }, L.opts).then(() => 'closed', e => e.code);
      await sdkSave(A, row('B', 'DAY', 1, bkk(3)));
      await Ledger.finishImport(A.db, 'imp-live', [row('B', 'DAY', 1, bkk(3))], [], A.opts);
      const afterImp = await SC.closeSlot(L.db, { date: bkk(3), line: 'B', shift: 'DAY', state: 'SUBMITTED' }, L.opts).then(() => 'closed', e => e.code);
      if (during !== 'qd/import-pending' || afterImp !== 'closed') throw new Error(`${during} / ${afterImp}`);
      return 'during import: refused (import-pending) · after: closed';
    }, 1);
    await scenario('S3', 'Excel import partial failure (real CSV through the page)', async () => {
      const admin = await newPage();
      await admin.page.goto(`${BASE}/scrap-entry.html?qdEmulator=1`);
      await signIn(admin.page, 'ADMIN1');
      await admin.page.evaluate(() => { const orig = ScrapLedger.applyOps; ScrapLedger.applyOps = (db, ops, o) => ops.some(x => x.op === 'create' && x.data.line === 'C') ? Promise.reject(new Error('simulated failure')) : orig(db, ops, o); });
      const m = await importCsv(admin.page, [row('B', 'NIGHT', 2, bkk(3)), row('C', 'NIGHT', 2, bkk(3))]);
      await admin.context.close();
      const st = await statusOf(bkk(3), 'C', 'NIGHT');
      if (!/1 failed/.test(m) || st !== 'CONFLICT') throw new Error(`${m} / ${st}`);
      return `"${m.slice(0, 60)}…" · C Night = CONFLICT (import marker kept)`;
    }, 1);
    await scenario('S3', 'Old tab (still open, sign-in off) saves into the CLOSED shift', async () => {
      const m = await formSave(oldTab.page);
      if (!/Saved/.test(m)) throw new Error(m);
      const st = await statusOf(DAY, 'A', 'DAY'); if (st !== 'CONFLICT') throw new Error('status ' + st);
      return 'accepted by the bridge, detected: A Day = CONFLICT';
    }, 1);
  });

  it('S4 bridge audit lists every problem (measurable exit condition)', async () => {
    await scenario('S4', 'bridgeAudit #1', async () => {
      const a = await OPS.bridgeAudit(actor('ADMIN1').db, { from: bkk(9), to: bkk(0) });
      const ids = a.problems.map(p => p.slotId).sort();
      if (!ids.includes(`${DAY}_A_DAY`) || !ids.includes(`${bkk(3)}_C_NIGHT`)) throw new Error(JSON.stringify(ids));
      return `${a.problems.length} problem slots: ${ids.join(', ')}`;
    }, 0);
  });

  it('S5 publish CANDIDATE while both pages are open (rules change during use)', async () => {
    await publish('candidate');
    await scenario('S5', 'New tab keeps saving without reload', async () => { const m = await formSave(newTab.page); if (!/Saved/.test(m)) throw new Error(m); return 'saved'; }, 1);
    await scenario('S5', 'Old tab is refused, with the reload message (entry kept)', async () => { const m = await formSave(oldTab.page); if (!/out of date.*reload/.test(m)) throw new Error(m); return m.slice(0, 90); }, 0);
    await scenario('S5', 'Anonymous public write is closed', async () => {
      const r = await addDoc(collection(env.unauthenticatedContext().firestore(), 'scrapLogs'), row('A', 'DAY')).then(() => 'written', e => e.code);
      if (!/permission/.test(r)) throw new Error(r); return 'refused';
    }, 0);
  });

  it('S6 reconcile the bridge problems, clear the failed import, reconfirm', async () => {
    const A = actor('ADMIN1');
    await scenario('S6', 'Admin reconciles + clears the import marker; audit = 0 problems', async () => {
      await Ledger.clearImportMarker(A.db, `${bkk(3)}_C_NIGHT`, A.opts);
      for (const p of (await OPS.bridgeAudit(A.db, { from: bkk(9), to: bkk(0) })).problems) await OPS.reconcileSlot(A.db, p.slotId, 'post-bridge clean-up', await op(A, 'RECONCILE'));
      const again = await OPS.bridgeAudit(A.db, { from: bkk(9), to: bkk(0) });
      if (again.problems.length) throw new Error(JSON.stringify(again.problems));
      return 'reconciled; A Day = ' + await statusOf(DAY, 'A', 'DAY');
    }, 0);
    await scenario('S6', 'Leader reconfirms the shift changed by the old tab', async () => {
      const L = actor('LEADA');
      await SC.closeSlot(L.db, { date: DAY, line: 'A', shift: 'DAY', state: 'SUBMITTED' }, L.opts);
      return await statusOf(DAY, 'A', 'DAY');
    }, 0);
  });

  it('S7 baseline migration while a Leader is saving; gate then opens', async () => {
    const A = actor('ADMIN1');
    await scenario('S7', 'Baseline (plan → apply with concurrent saves → completeIfClean)', async () => {
      const logs = []; (await raw(async db => getDocs(collection(db, 'scrapLogs')))).forEach(d => logs.push(Object.assign({ id: d.id }, d.data())));
      const existing = []; (await raw(async db => getDocs(collection(db, 'scrapSlots')))).forEach(d => existing.push(d.id));
      const plan = MB.planBaseline(logs, existing);
      if (MB.verifyPlan(plan).length) throw new Error('plan');
      await Promise.all([MB.applyBaseline(A.db, plan, Object.assign({ migrationId: 'rehearsal' }, await op(A, 'BASELINE_APPLY'))), sdkSave(actor('LEADC'), row('C', 'DAY', 1))]);
      const now = []; (await raw(async db => getDocs(collection(db, 'scrapLogs')))).forEach(d => now.push(Object.assign({ id: d.id }, d.data())));
      const gate = await MB.completeIfClean(A.db, plan, 'rehearsal', await op(A, 'BASELINE_GATE'), now);
      if (!gate.complete) throw new Error(JSON.stringify(gate.problems));
      return `${plan.slots.length} slots baselined, ${plan.skipped.length} already in the ledger, baselineComplete`;
    }, 1);
    await scenario('S7', 'Saving after the baseline (new slot, legacy 0)', async () => { await sdkSave(actor('LEADB'), row('B', 'DAY', 2, bkk(1))); return 'saved'; }, 1);
  });

  it('S8 Shift Close drives the target; public pages and CSV carry no personal data', async () => {
    await scenario('S8', 'Dashboard with QD_CLOSE_REQUIRED_FROM: day status from the closes', async () => {
      const p = await newPage();
      await p.page.goto(`${BASE}/index.html?qdEmulator=1&qdCloseFrom=${bkk(3)}`);
      await p.page.waitForFunction(() => window.qdDb, null, { timeout: 15000 });
      await p.page.evaluate(({ f, t }) => { document.getElementById('dateFrom').value = f; document.getElementById('dateTo').value = t; document.getElementById('kpiStatus').textContent = '…'; document.getElementById('dateTo').dispatchEvent(new Event('change')); }, { f: DAY, t: DAY });
      await p.page.waitForFunction(() => !['…', '–'].includes(document.getElementById('kpiStatus').textContent.trim()), null, { timeout: 20000 });
      const st = await p.page.textContent('#kpiStatus'), line = await p.page.textContent('#kpiCloseLine'), text = await p.page.evaluate(() => document.body.innerText);
      await p.context.close();
      if (/@prodv2|LEADA|ADMIN1/.test(text)) throw new Error('personal data on the public dashboard');
      return `${st.trim()} · ${line.trim()}`;
    }, 0);
    await scenario('S8', 'No e-mail in any publicly readable collection (anonymous query of everything)', async () => {
      const anon = env.unauthenticatedContext().firestore();
      const found = [];
      for (const c of ['scrapLogs', 'scrapCloseSummary', 'targetMaster', 'improvements', 'scrapModelMappings', 'scrapWeeklyPlans', 'prodV2_dailyPlans', 'prodV2_actualLogs', 'productionLogs']) {
        (await getDocs(collection(anon, c))).forEach(d => { const t = JSON.stringify(d.data()); if (/@prodv2\.local/.test(t)) found.push(c + '/' + d.id); });
      }
      for (const c of ['scrapSlots', 'qdUsers', 'qdConfig']) { const r = await getDocs(collection(anon, c)).then(() => 'readable', () => 'denied'); if (r !== 'denied') found.push(c + ' readable'); }
      if (found.length) throw new Error(found.join(', '));
      return 'none (QD collections); scrapSlots / events / qdUsers / qdConfig not readable';
    }, 0);
    await scenario('S8', 'Executive Report CSV carries no personal data', async () => {
      const p = await newPage();
      await p.page.goto(`${BASE}/executive-report.html?qdEmulator=1&qdCloseFrom=${bkk(3)}`);
      await p.page.waitForFunction(() => window.qdDb && document.querySelectorAll('#rDailyTableBody tr').length > 0, null, { timeout: 15000 });
      await p.page.click('#periodTabs button[data-period="weekly"]');
      await p.page.waitForTimeout(1500);
      const [dl] = await Promise.all([p.page.waitForEvent('download'), p.page.click('#exportCsv')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      await p.context.close();
      if (/@prodv2|LEADA|ADMIN1|post-bridge/.test(csv)) throw new Error('personal data in CSV');
      return `${csv.split('\n').length} lines, none personal`;
    }, 0);
  });

  it('R rollback: bridge, production snapshot, then forward again — no data lost', async () => {
    const total = await countLogs();
    await publish('bridge');
    await scenario('R', 'Rollback to BRIDGE: old tab saves again, new tab still saves', async () => {
      const o = await formSave(oldTab.page), n = await formSave(newTab.page);
      if (!/Saved/.test(o) || !/Saved/.test(n)) throw new Error(`${o} / ${n}`); return 'both saved';
    }, 2);
    await publish('production');
    await scenario('R', 'Rollback to PRODUCTION snapshot: old tab saves; new site cannot', async () => {
      const o = await formSave(oldTab.page);
      const n = await sdkSave(actor('LEADA'), row('A', 'NIGHT')).then(() => 'saved', e => e.code);
      if (!/Saved/.test(o) || !/permission/.test(n)) throw new Error(`${o} / ${n}`); return 'old saved, new refused (as before the rollout)';
    }, 1);
    await publish('candidate');
    await scenario('R', 'Forward again to CANDIDATE: new tab saves; data intact', async () => {
      const n = await formSave(newTab.page); if (!/Saved/.test(n)) throw new Error(n);
      const now = await countLogs(); if (now !== total + 4) throw new Error(`${now} != ${total + 4}`);
      return `all ${now} logs present`;
    }, 1);
    await scenario('R', 'After a rollback: audit lists what the old tab saved around the ledger; reconcile → 0 problems', async () => {
      const A = actor('ADMIN1');
      const a = await OPS.bridgeAudit(A.db, { from: bkk(9), to: bkk(0) });
      for (const p of a.problems) await OPS.reconcileSlot(A.db, p.slotId, 'clean-up after rollback', await op(A, 'RECONCILE'));
      const b = await OPS.bridgeAudit(A.db, { from: bkk(9), to: bkk(0) });
      if (b.problems.length) throw new Error(JSON.stringify(b.problems));
      return `${a.problems.length} slot(s) reconciled: ${a.problems.map(p => p.slotId).join(', ')}`;
    }, 0);
    await scenario('R', 'Production V2 read/write continuously through every publish', async () => {
      if (pv2.failures.length) throw new Error(pv2.failures.slice(0, 3).join('; '));
      return `${pv2.writes} writes, ${pv2.reads} reads, 0 failures`;
    }, 0);
  });
});
