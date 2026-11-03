// Privacy migration of OLD public data (Phase 9) — EMULATOR ONLY, synthetic data. Writes
// docs/phase9/generated/privacy-migration-report.md.
//   scrapLogs.recordedBy → scrapLogPrivate · improvements.actions[].owner → improvementOwners
// Dry run writes nothing; backup = the original values; apply is per document, idempotent and
// resumable after a failure; verify finds no personal field left; closes / totals unaffected;
// the rules refuse the strip without an authorised run, and for anyone but an Admin.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, collection, serverTimestamp, deleteField } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const PM = require('../../tools/migration/privacy-migration.js');
const { op } = require('../support/ops-helper.js');
const { compatDb } = require('../support/compat-shim.js');

const ROOT = path.join(__dirname, '../..');
const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const DAY = bkk(2);
let env;
const report = [];
const actor = c => { const db = compatDb(env.authenticatedContext('uid-' + c, { email: E(c) }).firestore()); return { db, opts: { email: E(c), serverTimestamp } }; };
const FV = { delete: () => deleteField() };
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }
const dump = () => raw(async db => { const o = {}; for (const c of ['scrapLogs', 'improvements', 'scrapLogPrivate', 'improvementOwners']) { o[c] = []; (await getDocs(collection(db, c))).forEach(d => o[c].push([d.id, d.data()])); o[c].sort(); } return o; });
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const publicText = async () => { const anon = env.unauthenticatedContext().firestore(); let t = ''; for (const c of ['scrapLogs', 'improvements']) (await getDocs(collection(anon, c))).forEach(d => { t += JSON.stringify(d.data()); }); return t; };
function failingAt(db, n) { let k = 0; return Object.assign({}, db, { collection: db.collection, runTransaction: fn => (++k === n ? Promise.reject(Object.assign(new Error('simulated failure'), { code: 'unavailable' })) : db.runTransaction(fn)) }); }

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await raw(async db => {
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(db, 'qdUsers', E('admin')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('leaderA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'qdUsers', E('viewer')), u('viewer', []));
    // OLD public data, saved with sign-in off (as in production today)
    const row = (i, o) => Object.assign({ date: bkk(4 + (i % 5)), line: 'ABC'[i % 3], shift: i % 2 ? 'NIGHT' : 'DAY', model: 'M', defectType: 'Dent', scrapQty: 1 + (i % 4), remark: '', createdAt: 1 }, o);
    for (let i = 0; i < 24; i++) await setDoc(doc(db, 'scrapLogs', 'old' + i), row(i, i % 3 === 0 ? {} : { recordedBy: 'KP' + String(1000 + i) }));
    await setDoc(doc(db, 'scrapLogs', 'oldLong'), row(30, { recordedBy: 'X'.repeat(70) }));      // exception: too long
    await setDoc(doc(db, 'scrapLogs', 'oldEmpty'), row(31, { recordedBy: '' }));                  // empty value
    await setDoc(doc(db, 'improvements', 'imp1'), { problem: 'p1', defectType: 'Dent', status: 'Monitoring', actions: [{ action: 'a', owner: 'Somchai' }, { action: 'b', owner: '' }, { action: 'c', owner: 'Malee' }] });
    await setDoc(doc(db, 'improvements', 'imp2'), { problem: 'p2', defectType: 'Dent', status: 'Controlled', actions: [{ action: 'a', owner: 'Anan' }] });
    await setDoc(doc(db, 'improvements', 'imp3'), { problem: 'p3', defectType: 'Dent', status: 'Monitoring', actions: [{ action: 'a', owner: '' }] });
    await setDoc(doc(db, 'improvements', 'impMany'), { problem: 'p4', defectType: 'Dent', status: 'Monitoring', actions: Array.from({ length: 21 }, (_, k) => ({ action: 'a' + k, owner: k === 0 ? 'Big' : '' })) });
  });
  // a shift closed (through the ledger) on old records with recordedBy: its status must not change
  const A = actor('admin');
  await raw(async db => { await setDoc(doc(db, 'scrapLogs', 'closedA'), { date: DAY, line: 'A', shift: 'DAY', model: 'M', defectType: 'Dent', scrapQty: 5, remark: '', createdAt: 1, recordedBy: 'KP7777' }); });
  await SC.closeSlot(A.db, { date: DAY, line: 'A', shift: 'DAY', state: 'SUBMITTED' }, A.opts);
});
after(async () => {
  fs.mkdirSync(path.join(ROOT, 'docs/phase9/generated'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/phase9/generated/privacy-migration-report.md'), '# Privacy Migration — Dry Run / Apply Report (generated)\n\nGenerated by `tests/rules/privacy-migration.test.js` on synthetic data in the Firebase Emulator (no production data).\n\n| Check | Result |\n|---|---|\n' + report.map(r => `| ${r[0]} | ${r[1]} |`).join('\n') + '\n');
  if (env) await env.cleanup();
});

describe('privacy migration (synthetic old data)', () => {
  let plan, bak, before0;
  it('dry run finds every old personal field (not only new data) and writes nothing', async () => {
    before0 = await dump();
    plan = await PM.scan(actor('admin').db);
    assert.equal(plan.totals.logs, 16 + 1 + 1);            // 16 codes + the closed shift's record + 1 empty value
    assert.equal(plan.totals.improvements, 2);             // imp1, imp2 (imp3 has none; impMany is an exception)
    assert.deepEqual(plan.exceptions.map(x => x.id).sort(), ['impMany', 'oldLong']);
    bak = PM.backup(plan, { projectId: 'demo-quality-dashboard' });
    assert.equal(hash(await dump()), hash(before0));
    report.push(['Dry run', `${plan.totals.logs} scrap records with recordedBy (incl. 1 empty), ${plan.totals.improvements} improvements with owners, ${plan.totals.exceptions} exceptions (code > 64 chars; > 20 actions) — nothing written`]);
    report.push(['Backup', `${bak.scrapLogs.length} + ${bak.improvements.length} original values captured (JSON; also the undo data)`]);
  });
  it('the rules refuse the strip without an authorised run, and for a Leader / Viewer / anonymous', async () => {
    const tryStrip = async (who, withOp) => {
      const a = who ? actor(who) : null;
      const db = who ? env.authenticatedContext('uid-' + who, { email: E(who) }).firestore() : env.unauthenticatedContext().firestore();
      const priv = { recordedBy: 'KP1001' };
      if (withOp) priv.opId = (await op(actor('admin'), 'PRIVACY_MIGRATION')).opId;   // an admin's run — not usable by others
      const b = writeBatch(db);
      b.set(doc(db, 'scrapLogPrivate', 'old1'), priv);
      b.update(doc(db, 'scrapLogs', 'old1'), { recordedBy: deleteField() });
      void a;
      return b.commit().then(() => 'done', e => e.code);
    };
    assert.match(await tryStrip('admin', false), /permission/);
    for (const w of ['leaderA', 'viewer', null]) assert.match(await tryStrip(w, true), /permission/);
    report.push(['Strip without an authorised run / by Leader, Viewer, anonymous', 'refused by the rules']);
  });
  it('apply fails half-way, then resumes; a re-run changes nothing', async () => {
    const A = actor('admin');
    const o1 = Object.assign({ fieldValue: FV }, await op(A, 'PRIVACY_MIGRATION'));
    const r1 = await PM.apply(failingAt(A.db, 7), plan, o1);
    assert.equal(r1.logs.failed.length, 1);
    const left = await PM.scan(A.db);                     // resume = scan again, apply what is left
    assert.equal(left.totals.logs, 1);
    const r2 = await PM.apply(A.db, left, Object.assign({ fieldValue: FV }, await op(A, 'PRIVACY_MIGRATION')));
    assert.equal(r2.logs.migrated, 1);
    const r3 = await PM.apply(A.db, plan, Object.assign({ fieldValue: FV }, await op(A, 'PRIVACY_MIGRATION')));   // idempotent
    assert.equal(r3.logs.migrated + r3.improvements.migrated, 0);
    // nothing skipped silently: every planned document is either migrated or listed with a reason
    const planned = plan.logs.length + plan.improvements.length;
    assert.equal(r3.skippedDetails.length + r3.logs.failed.length + r3.improvements.failed.length, planned);
    assert.ok(r3.skippedDetails.every(x => /already migrated/.test(x.reason)));
    const r1listed = r1.logs.migrated + r1.improvements.migrated + r1.skippedDetails.length + r1.logs.failed.length + r1.improvements.failed.length;
    assert.equal(r1listed, planned);
    const ex = PM.exceptionReport(plan, r1, null);
    assert.deepEqual(ex.rows.filter(x => x.stage === 'scan').map(x => x.id).sort(), ['impMany', 'oldLong']);
    assert.equal(ex.rows.filter(x => x.stage === 'apply' && /failed/.test(x.reason)).length, 1);
    report.push(['Exception report', `${ex.count} rows after the interrupted run: 2 scan exceptions (decision M-P2) + 1 failed document (re-apply); a re-run lists all ${planned} planned documents as "already migrated" — nothing dropped silently`]);
    report.push(['Interrupted run (1 failure) + resume', `1st: ${r1.logs.migrated} logs + ${r1.improvements.migrated} improvements migrated, 1 failed · resume: ${r2.logs.migrated} log · re-run: 0 changes (idempotent)`]);
  });
  it('verify: no personal field left on public documents; sidecars hold exactly the backed-up values', async () => {
    const v = await PM.verify(actor('admin').db, bak);
    assert.deepEqual(v.problems, []);
    assert.deepEqual(v.exceptions.map(x => x.id).sort(), ['impMany', 'oldLong']);   // reported, not migrated
    const t = await publicText();
    for (const k of ['KP1001', 'KP7777', 'Somchai', 'Malee', 'Anan']) assert.doesNotMatch(t, new RegExp(k));
    const own = await raw(async db => (await getDoc(doc(db, 'improvementOwners', 'imp1'))).data().owners);
    assert.deepEqual(own, ['Somchai', '', 'Malee']);
    report.push(['Verify', 'no recordedBy / owner left on public documents (except the 2 reported exceptions); every sidecar = backup']);
  });
  it('scrap data unchanged: quantities, ledger counts and the closed shift stay as they were', async () => {
    const now = await dump();
    const strip = rows => rows.map(([id, d]) => { const c = Object.assign({}, d); delete c.recordedBy; if (Array.isArray(c.actions)) c.actions = c.actions.map(a => Object.assign({}, a, { owner: '' })); delete c.updatedAt; return [id, c]; });
    assert.equal(hash(strip(now.scrapLogs)), hash(strip(before0.scrapLogs)));
    assert.equal((await SC.loadSlot(actor('admin').db, DAY, 'A', 'DAY')).info.status, 'SUBMITTED');
    report.push(['Scrap data / closes', 'every record identical apart from the removed field; the closed shift is still SUBMITTED (fingerprint unaffected)']);
  });
  it('signed-in users still see the moved values; the public does not', async () => {
    assert.equal((await getDoc(doc(env.authenticatedContext('uid-v', { email: E('viewer') }).firestore(), 'scrapLogPrivate', 'old1'))).data().recordedBy, 'KP1001');
    await assert.rejects(getDoc(doc(env.unauthenticatedContext().firestore(), 'scrapLogPrivate', 'old1')));
    report.push(['Access after migration', 'Viewer reads the private value; anonymous refused']);
  });
});
