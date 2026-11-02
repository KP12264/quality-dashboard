// Data integrity: with sign-in enforced, no page code can write a scrap log except through the
// ledger (js/scrap-ledger.js). Static scan of every script + a dynamic check of
// js/scrap-adapter.js with a database that throws on any direct write.
// (Firestore Rules refuse such writes anyway — tests/rules/rules.test.js — this checks the code.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadModules, ROOT } = require('../support/load-browser-modules.js');

test('static: only scrap-adapter.js and scrap-ledger.js touch scrapLogs for writing', () => {
  const files = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    if (['scrap-adapter.js', 'scrap-ledger.js', 'config.js'].includes(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    if (/SCRAP_COLLECTION/.test(src)) offenders.push(f + ': uses SCRAP_COLLECTION');
    if (/collection\((LOG_COLLECTION|["']scrapLogs["'])\)(\.doc\([^)]*\))?\.(add|set|update|delete)\(/.test(src)) offenders.push(f + ': writes scrapLogs');
  }
  assert.deepEqual(offenders, []);
});

test('dynamic: in enforce mode every scrap write of the adapter goes through ScrapLedger.applyOps', async () => {
  const calls = [];
  const forbidden = () => { throw new Error('direct Firestore write outside the ledger'); };
  const ref = id => ({ id, set: forbidden, update: forbidden, delete: forbidden, get: async () => ({ exists: true, data: () => ({}) }) });
  let n = 0;
  const db = { collection: () => ({ doc: id => ref(id || 'new' + (++n)), add: forbidden }), batch: () => ({ set: forbidden, commit: forbidden }) };
  const W = loadModules(['js/config.js', 'js/scrap-adapter.js'], {
    qdAuthMode: 'enforce',
    qdGuardWrite: () => ({ email: 'kp1@prodv2.local' }),
    ScrapLedger: { applyOps: async (d, ops) => { calls.push(ops.map(o => o.op)); return { slots: [] }; }, chunkBySlot: es => [es] },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } }
  });
  const A = W.ScrapDataAdapter;
  const e = { date: '2026-11-01', shift: 'DAY', line: 'A', model: 'M', defectType: 'Dent', scrapQty: 2 };
  await A.addScrapEntry(db, e);
  await A.updateScrapEntry(db, 'x1', Object.assign({}, e, { scrapQty: 3 }));
  await A.deleteScrapEntry(db, 'x1');
  const r = await A.addScrapEntryBatch(db, [e, e]);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['create'], ['update'], ['delete'], ['create', 'create']]);
  // without the ledger module the adapter refuses instead of writing directly
  const W2 = loadModules(['js/config.js', 'js/scrap-adapter.js'], { qdAuthMode: 'enforce', qdGuardWrite: () => ({ email: 'x' }), firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } } });
  await assert.rejects(W2.ScrapDataAdapter.addScrapEntry(db, e), err => err.code === 'qd/ledger-missing');
});
