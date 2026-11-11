// KI-1 diagnostic (EMULATOR ONLY, demo project): concurrent ledger writers, record every rejection's code/message.
// Uses the real js/scrap-ledger.js and the candidate rules, unchanged. Writes results to DIAG_OUT.
const { it, before, after } = require('node:test');
const fs = require('fs'), path = require('path');
const Q = process.env.QD_ROOT || '<QD>';
const T = p => path.join(Q, 'tests/node_modules', p);
const { initializeTestEnvironment } = require(T('@firebase/rules-unit-testing'));
const { doc, setDoc, serverTimestamp } = require(T('firebase/firestore'));
const Ledger = require(path.join(Q, 'js/scrap-ledger.js'));
const { compatDb } = require(path.join(Q, 'tests/support/compat-shim.js'));
const E = c => c.toLowerCase() + '@prodv2.local';
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const daysAgo = n => ymd(Date.now() + 7 * 3600e3 - n * 86400e3);
let env; const out = { rounds: [] };
const ROUNDS = Number(process.env.DIAG_ROUNDS || 5);
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(Q, 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => { const db = ctx.firestore();
    await setDoc(doc(db, 'qdUsers', E('admin')), { role: 'admin', active: true, displayName: 'a', slots: [], updatedAt: 1, updatedBy: E('admin') });
    for (let i = 1; i <= 5; i++) await setDoc(doc(db, 'qdUsers', E('leadA' + i)), { role: 'leader', active: true, displayName: 'l', slots: ['A_DAY'], updatedAt: 1, updatedBy: E('admin') }); });
});
after(async () => { fs.writeFileSync(process.env.DIAG_OUT, JSON.stringify(out, null, 1)); await env.cleanup(); });
const writer = code => { const db = compatDb(env.authenticatedContext('uid-' + code, { email: E(code) }).firestore()); return rows => Ledger.applyOps(db, rows.map(r => ({ op: 'create', ref: db.collection('scrapLogs').doc(), data: r })), { email: E(code), serverTimestamp }); };
const row = (date, line, shift) => ({ date, shift, line, model: 'M1', defectType: 'Dent', scrapQty: 1, remark: '', createdAt: 1 });
it('rounds of concurrent writers', async () => {
  for (let r = 0; r < ROUNDS; r++) {
    const date = daysAgo(1 + (r % 6)), t0 = Date.now();
    // (a) 6 admin writers, 6 different slots, same date (one summary document)
    const a = await Promise.allSettled(['A', 'B', 'C'].flatMap(l => ['DAY', 'NIGHT'].map(s => writer('admin')([row(date, l, s)]))));
    // (b) 15 leaders, same slot, a different date
    const d2 = daysAgo(1 + ((r + 3) % 6));
    const b = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => writer('leadA' + (1 + (i % 5)))([row(d2, 'A', 'DAY')])));
    const rej = x => x.filter(y => y.status === 'rejected').map(y => ({ code: y.reason && y.reason.code, name: y.reason && y.reason.name, message: String(y.reason && y.reason.message).slice(0, 160) }));
    out.rounds.push({ r, date, d2, ms: Date.now() - t0, diffSlots: { ok: a.filter(y => y.status === 'fulfilled').length, rejected: rej(a) }, sameSlot: { ok: b.filter(y => y.status === 'fulfilled').length, rejected: rej(b) } });
    await env.clearFirestore().catch(() => {});
    await env.withSecurityRulesDisabled(async ctx => { const db = ctx.firestore();
      await setDoc(doc(db, 'qdUsers', E('admin')), { role: 'admin', active: true, displayName: 'a', slots: [], updatedAt: 1, updatedBy: E('admin') });
      for (let i = 1; i <= 5; i++) await setDoc(doc(db, 'qdUsers', E('leadA' + i)), { role: 'leader', active: true, displayName: 'l', slots: ['A_DAY'], updatedAt: 1, updatedBy: E('admin') }); });
  }
});
