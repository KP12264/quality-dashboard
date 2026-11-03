// Phase 8 — Admin "Operations" tab (production go-live tools) — Firebase EMULATOR ONLY.
// Hidden unless sign-in is on and the user is an Admin; audits and dry runs never write; writes need
// the config unlock + typed "<project>/(default)" + approval reference + reason, and leave an
// immutable qdOpsLog record. Post-candidate audit finds logs written around the ledger.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, addDoc, updateDoc, collection, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('../support/compat-shim.js');

const ROOT = path.join(__dirname, '../..');
const PORT = 5516, BASE = `http://127.0.0.1:${PORT}`, PROJECT = 'demo-quality-dashboard', AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const PASSWORD = 'test-password-1';
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const DAY = bkk(2);
let env, server, browser, sinceIso;

async function publish(file) {
  const res = await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}:securityRules`, { method: 'PUT', body: JSON.stringify({ rules: { files: [{ content: fs.readFileSync(path.join(ROOT, file), 'utf8') }] } }) });
  if (!res.ok) throw new Error(await res.text());
}
async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }
const snapshotAll = () => raw(async db => { const o = {}; for (const c of ['scrapLogs', 'scrapSlots', 'scrapCloseSummary', 'qdOpsLog', 'qdConfig']) { o[c] = []; (await getDocs(collection(db, c))).forEach(d => o[c].push([d.id, JSON.stringify(d.data())])); o[c].sort(); } return JSON.stringify(o); });
const actor = c => { const db = compatDb(env.authenticatedContext('uid-' + c, { email: E(c) }).firestore()); return { db, opts: { email: E(c), serverTimestamp } }; };
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
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
async function openOps(query) {
  const p = await newPage();
  await p.page.goto(`${BASE}/admin.html?qdEmulator=1${query || ''}`);
  await signIn(p.page, 'ADMIN1');
  await p.page.click('#adminTabs button[data-tab="ops"]');
  await p.page.waitForSelector('#opsAuditBtn', { timeout: 10000 });
  return p;
}
const msg = (page, id) => page.waitForFunction(i => { const e = document.getElementById(i); return e && e.style.display !== 'none' && !/Reading/.test(e.textContent); }, id, { timeout: 20000 }).then(() => page.textContent('#' + id));

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules.bridge'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const c of ['ADMIN1', 'LEADA']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(c), password: PASSWORD });
  await raw(async db => {
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    await setDoc(doc(db, 'qdUsers', E('ADMIN1')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('LEADA')), u('leader', ['A_DAY']));
    for (let i = 0; i < 3; i++) await setDoc(doc(db, 'scrapLogs', 'old' + i), { date: bkk(6), line: 'B', shift: 'NIGHT', model: 'M', defectType: 'Dent', scrapQty: 1, remark: '', createdAt: 1 });
  });
  // bridge period: Leader saves + closes; an old page (anonymous) saves into the closed shift
  const L = actor('LEADA');
  await Ledger.applyOps(L.db, [{ op: 'create', ref: L.db.collection('scrapLogs').doc(), data: { date: DAY, line: 'A', shift: 'DAY', model: 'M', defectType: 'Dent', scrapQty: 2, remark: '', createdAt: Date.now() } }], L.opts);
  await SC.closeSlot(L.db, { date: DAY, line: 'A', shift: 'DAY', state: 'SUBMITTED' }, L.opts);
  sinceIso = new Date(Date.now() - 3600000).toISOString().slice(0, 16);   // datetime-local, before the writes (browser runs in UTC here)
  await addDoc(collection(env.unauthenticatedContext().firestore(), 'scrapLogs'), { date: DAY, line: 'A', shift: 'DAY', model: 'M', defectType: 'Dent', scrapQty: 9, remark: '', createdAt: Date.now() });
  await publish('emulator/firestore.rules');   // candidate
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (server) server.kill(); if (env) await env.cleanup(); });

describe('Operations tab', () => {
  it('hidden with sign-in off, and for a Leader', async () => {
    const a = await newPage();
    await a.page.goto(`${BASE}/admin.html?qdEmulator=1&qdAuthMode=off`);
    await a.page.waitForTimeout(1200);
    assert.equal(await a.page.isVisible('#adminTabs button[data-tab="ops"]'), false);
    await a.context.close();
    const b = await newPage();
    await b.page.goto(`${BASE}/admin.html?qdEmulator=1`);
    await signIn(b.page, 'LEADA');
    assert.equal(await b.page.isVisible('#adminTabs button[data-tab="ops"]'), false);
    await b.context.close();
  });
  it('read only by default: audit, post-candidate audit and dry runs write nothing; writes are locked', async () => {
    const before = await snapshotAll();
    const { context, page } = await openOps('');
    assert.match(await page.textContent('[data-role="ops-lock"]'), /LOCKED/);
    assert.match(await page.textContent('[data-role="ops-target"]'), /demo-quality-dashboard.*\(default\)/);
    await page.fill('#opsSince', sinceIso);
    await page.click('#opsAuditBtn');
    const audit = await msg(page, 'opsAuditOut');
    assert.match(audit, /1 problem slot/); assert.match(audit, /1 log\(s\) written around the ledger/);
    await page.click('#opsReconcileDryBtn');
    assert.match(await msg(page, 'opsReconcileOut'), /Dry run — nothing written.*ledger 1 → 2.*becomes CHANGED/);
    await page.click('#opsBaselineDryBtn');
    assert.match(await msg(page, 'opsBaselineOut'), /Dry run — nothing written.*plan check: OK/);
    await page.fill('#opsConfirm', 'demo-quality-dashboard/(default)'); await page.fill('#opsApproval', 'CHG-1'); await page.fill('#opsReason', 'test');
    await page.click('#opsReconcileBtn');
    assert.match(await msg(page, 'opsReconcileOut'), /locked/i);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#opsDownloadBtn')]);
    const report = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    assert.equal(report.audit.problems.length, 1); assert.equal(report.audit.postCandidate.offLedger.length, 1);
    await context.close();
    assert.equal(await snapshotAll(), before, 'nothing was written');
  });
  it('unlocked (emulator only): wrong confirmation refused; correct one reconciles and is logged', async () => {
    const { context, page } = await openOps('&qdOpsWrite=1');
    assert.match(await page.textContent('[data-role="ops-lock"]'), /UNLOCKED/);
    await page.click('#opsAuditBtn'); await msg(page, 'opsAuditOut');
    await page.fill('#opsConfirm', 'daily-production-report-46b60/(default)'); await page.fill('#opsApproval', 'CHG-2'); await page.fill('#opsReason', 'post-bridge clean-up');
    await page.click('#opsReconcileBtn');
    assert.match(await msg(page, 'opsReconcileOut'), /Type exactly: demo-quality-dashboard\/\(default\)/);
    await page.fill('#opsConfirm', 'demo-quality-dashboard/(default)');
    await page.click('#opsReconcileBtn');
    await page.waitForFunction(() => /Done|Failed/.test(document.getElementById('opsReconcileOut').textContent), null, { timeout: 20000 });
    assert.match(await page.textContent('#opsReconcileOut'), /Done/);
    // post-candidate audit after the reconcile: the log is now accounted for
    await page.fill('#opsSince', sinceIso);
    await page.click('#opsAuditBtn');
    assert.match(await msg(page, 'opsAuditOut'), /0 problem slot.*0 log\(s\) written around the ledger/);
    await context.close();
    const st = (await SC.loadSlot(actor('ADMIN1').db, DAY, 'A', 'DAY')).info.status;
    assert.equal(st, 'CHANGED');
    const logs = await raw(async db => { const o = []; (await getDocs(collection(db, 'qdOpsLog'))).forEach(d => o.push(d.data())); return o; });
    assert.equal(logs.length, 1); assert.equal(logs[0].action, 'RECONCILE'); assert.equal(logs[0].approvalRef, 'CHG-2'); assert.equal(logs[0].by, E('ADMIN1'));
  });
  it('baseline: dry run, apply, gate → baselineComplete; each write step logged', async () => {
    const { context, page } = await openOps('&qdOpsWrite=1');
    await page.fill('#opsConfirm', 'demo-quality-dashboard/(default)'); await page.fill('#opsApproval', 'CHG-3'); await page.fill('#opsReason', 'go-live baseline');
    await page.click('#opsBaselineDryBtn'); await msg(page, 'opsBaselineOut');
    await page.click('#opsBaselineBtn');
    await page.waitForFunction(() => /Done|Failed/.test(document.getElementById('opsBaselineOut').textContent), null, { timeout: 20000 });
    assert.match(await page.textContent('#opsBaselineOut'), /Done.*"created":1/);
    await page.click('#opsGateBtn');
    await page.waitForFunction(() => /Done.*complete|Failed/.test(document.getElementById('opsBaselineOut').textContent), null, { timeout: 20000 });
    assert.match(await page.textContent('#opsBaselineOut'), /"complete":true/);
    await context.close();
    assert.equal((await raw(async db => (await getDoc(doc(db, 'qdConfig', 'ledger'))).data())).baselineComplete, true);
    const actions = await raw(async db => { const o = []; (await getDocs(collection(db, 'qdOpsLog'))).forEach(d => o.push(d.data().action)); return o.sort(); });
    assert.deepEqual(actions, ['BASELINE_APPLY', 'BASELINE_GATE', 'RECONCILE']);
  });
  it('the operations log cannot be written by a Leader or changed by anyone', async () => {
    const L = env.authenticatedContext('uid-l', { email: E('LEADA') }).firestore();
    await assert.rejects(addDoc(collection(L, 'qdOpsLog'), { action: 'RECONCILE', projectId: 'x', database: '(default)', approvalRef: 'abc', reason: 'abc', summary: '', at: serverTimestamp(), by: E('LEADA') }));
    const A = env.authenticatedContext('uid-a', { email: E('ADMIN1') }).firestore();
    const ids = await raw(async db => { const o = []; (await getDocs(collection(db, 'qdOpsLog'))).forEach(d => o.push(d.id)); return o; });
    await assert.rejects(updateDoc(doc(A, 'qdOpsLog', ids[0]), { approvalRef: 'changed' }));
    await assert.rejects(getDocs(collection(env.unauthenticatedContext().firestore(), 'qdOpsLog')));
  });
});
