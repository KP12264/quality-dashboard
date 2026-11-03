// Firestore Rules evaluation budget — EMULATOR ONLY. Runs the heaviest VALID write paths at their
// largest sizes and fails if the rules refuse any of them (access-call limit, 1000-expression
// limit). Re-run after every rules change: Phase 5 found that the order of checks inside a branch
// decides whether a slot create stays under the expression limit.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, writeBatch, serverTimestamp } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const MB = require('../../tools/migration/ledger-baseline.js');
const { op } = require('../support/ops-helper.js');
const { compatDb } = require('../support/compat-shim.js');

const E = c => `${c.toLowerCase()}@prodv2.local`;
const pad = n => String(n).padStart(2, '0');
const bkk = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
let env;
const report = [];
const actor = c => { const db = compatDb(env.authenticatedContext('uid-' + c, { email: E(c) }).firestore()); return { db, opts: { email: E(c), serverTimestamp, maxSlots: 99 } }; };
const row = (date, line, shift, o) => Object.assign({ date, line, shift, model: 'M', defectType: 'Dent', scrapQty: 1, remark: '', createdAt: 1 }, o);
async function legacy(date, line, shift, n) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (let i = 0; i < n; i += 400) { const b = writeBatch(db); for (let k = i; k < Math.min(n, i + 400); k++) b.set(doc(db, 'scrapLogs', `${date}_${line}_${shift}_${k}`), row(date, line, shift)); await b.commit(); }
  });
}
const creates = (a, rows) => Ledger.applyOps(a.db, rows.map(r => ({ op: 'create', ref: a.db.collection('scrapLogs').doc(), data: Object.assign({}, r) })), a.opts);
async function measure(name, fn) { const t = Date.now(); try { await fn(); report.push(`${name}: accepted (${Date.now() - t} ms)`); return true; } catch (e) { report.push(`${name}: REFUSED ${e.code || e.message}`); return false; } }

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(__dirname, '../..', process.env.QD_RULES_FILE || 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(ctx.firestore(), 'qdUsers', E('admin')), u('admin', []));
    await setDoc(doc(ctx.firestore(), 'qdUsers', E('leaderA')), u('leader', ['A_DAY', 'A_NIGHT']));
  });
});
after(async () => { console.log('\nRULES BUDGET REPORT\n' + report.map(r => '  ' + r).join('\n')); if (env) await env.cleanup(); });

describe('heaviest valid paths stay within the rules limits', () => {
  it('before the baseline: Leader first write of 200 logs on a slot with 300 legacy logs', async () => {
    await legacy(bkk(3), 'A', 'DAY', 300);
    assert.ok(await measure('ledger v1, legacy 300 + 200 new (leader)', () => creates(actor('leaderA'), Array.from({ length: 200 }, () => row(bkk(3), 'A', 'DAY')))));
  });
  it('before the baseline: close-create of a slot with 450 legacy logs', async () => {
    await legacy(bkk(3), 'A', 'NIGHT', 450);
    const a = actor('leaderA');
    assert.ok(await measure('close-create, 450 legacy logs (leader)', () => SC.closeSlot(a.db, { date: bkk(3), line: 'A', shift: 'NIGHT', state: 'SUBMITTED' }, a.opts)));
  });
  it('import marker on a slot with 450 legacy logs; then a 450-row import chunk; then clear', async () => {
    await legacy(bkk(4), 'B', 'DAY', 450);
    const a = actor('admin');
    assert.ok(await measure('marker set, 450 legacy', () => Ledger.markImport(a.db, [row(bkk(4), 'B', 'DAY')], 'imp-b', a.opts)));
    assert.ok(await measure('450-row chunk into a marked slot', () => creates(a, Array.from({ length: 450 }, () => row(bkk(4), 'B', 'DAY')))));
    assert.ok(await measure('marker clear', () => Ledger.clearImportMarker(a.db, `${bkk(4)}_B_DAY`, a.opts)));
  });
  it('baseline of a slot with 450 logs, then baselineComplete, then 450 new logs on a new slot', async () => {
    await legacy(bkk(5), 'C', 'DAY', 450);
    const a = actor('admin');
    const logs = Array.from({ length: 450 }, (_, k) => Object.assign({ id: `${bkk(5)}_C_DAY_${k}` }, row(bkk(5), 'C', 'DAY')));
    const plan = MB.planBaseline(logs, []);
    let r;
    assert.ok(await measure('baseline b1 with 450 log ids', async () => { r = await MB.applyBaseline(a.db, plan, Object.assign({ migrationId: 'm' }, await op(a, 'BASELINE_APPLY'))); if (r.failed.length) throw new Error(r.failed[0].error); }));
    await MB.markComplete(a.db, 'm', await op(a, 'BASELINE_GATE'));
    assert.ok(await measure('after baselineComplete: ledger v1 of 450 logs on a new slot', () => creates(a, Array.from({ length: 450 }, () => row(bkk(6), 'C', 'NIGHT')))));
    assert.ok(await measure('after baselineComplete: close of the 450-log baseline slot', () => SC.closeSlot(a.db, { date: bkk(5), line: 'C', shift: 'DAY', state: 'SUBMITTED' }, a.opts)));
  });
  it('Phase 9 paths: reconcile of a 450-log slot and a privacy strip, each under an operation run', async () => {
    const OPS = require('../../tools/ops/bridge-ops.js');
    const a = actor('admin');
    await legacy(bkk(7), 'A', 'NIGHT', 450);
    // after baselineComplete (set above) a slot with old logs gets its baseline first, as in production
    const oldLogs = Array.from({ length: 450 }, (_, k) => Object.assign({ id: `${bkk(7)}_A_NIGHT_${k}` }, row(bkk(7), 'A', 'NIGHT')));
    const bres = await MB.applyBaseline(a.db, MB.planBaseline(oldLogs, []), Object.assign({ migrationId: 'm2' }, await op(a, 'BASELINE_APPLY')));
    assert.equal(bres.created.length, 1);
    await creates(a, [row(bkk(7), 'A', 'NIGHT')]);   // ledger slot: 450 baseline + 1
    await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapLogs', 'strayR'), row(bkk(7), 'A', 'NIGHT')); });
    assert.ok(await measure('reconcile, 452 log ids (RECONCILE + run check)', async () => OPS.reconcileSlot(a.db, `${bkk(7)}_A_NIGHT`, 'budget', await op(a, 'RECONCILE'))));
    await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapLogs', 'pr1'), row(bkk(7), 'A', 'NIGHT', { recordedBy: 'KP1' })); });
    const PM = require('../../tools/migration/privacy-migration.js');
    const { deleteField } = require('firebase/firestore');
    const plan = { logs: [{ id: 'pr1', recordedBy: 'KP1' }], improvements: [] };
    assert.ok(await measure('privacy strip of one log (sidecar + run check)', async () => { const r = await PM.apply(a.db, plan, Object.assign({ fieldValue: { delete: () => deleteField() } }, await op(a, 'PRIVACY_MIGRATION'))); if (r.logs.migrated !== 1) throw new Error(JSON.stringify(r)); }));
  });
  it('a move between two slots (2 slots in one transaction) with the mirror', async () => {
    const a = actor('admin');
    const ref = a.db.collection('scrapLogs').doc('mv1');
    await Ledger.applyOps(a.db, [{ op: 'create', ref, data: Object.assign({}, row(bkk(2), 'B', 'DAY')) }], a.opts);
    assert.ok(await measure('move B Day → C Night (2 slots, one summary doc)', () => Ledger.applyOps(a.db, [{ op: 'update', ref, data: { line: 'C', shift: 'NIGHT' } }], a.opts)));
    assert.ok(await measure('move to another date (2 slots, 2 summary docs)', () => Ledger.applyOps(a.db, [{ op: 'update', ref, data: { date: bkk(1) } }], a.opts)));
  });
});
