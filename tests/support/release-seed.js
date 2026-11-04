// A realistic month for screenshots and read-cost measurements (EMULATOR ONLY).
// Month M = the previous Thailand month (every day ended, so closes are allowed), plus the first
// days of the current month. Shift Close is required from the first Monday on/after M-15
// (?qdCloseFrom=… on the page) so one whole week is closed and final.
//   before the close date : logs saved like today's live site (no ledger), production documents
//   from the close date   : ledger logs + closes: FINAL / OVER (final) / PENDING / CONFLICT /
//                           NO PRODUCTION / NO DATA
//   weekly plans          : W2 override 120 (OVER plan), W4 default confirmed by an Admin, the rest no document
const { doc, setDoc, serverTimestamp, writeBatch } = require('firebase/firestore');
const Ledger = require('../../js/scrap-ledger.js');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('./compat-shim.js');

const pad = n => String(n).padStart(2, '0');
const E = c => `${c.toLowerCase()}@prodv2.local`;
const KEYS = [['A', 'DAY'], ['A', 'NIGHT'], ['B', 'DAY'], ['B', 'NIGHT'], ['C', 'DAY'], ['C', 'NIGHT']];
const DEFECTS = ['บุบ (Dent)', 'รอยขีดข่วน (Scratch)', 'ช่องว่าง/ระดับไม่เสมอ (Gap / Flush NG)', 'สีไหลย้อย', 'คลิปหาย', 'ยับ (Wrinkle)', 'Burr', 'Dirt / Dust'];
const CAUSES = ['Jig wear', 'Handling', 'Material', 'Setting', ''];
const MODELS = ['M-100 FR', 'M-100 RR', 'M-200 FR', 'M-300 RR'];

function months() {
  const now = new Date(Date.now() + 7 * 3600000);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const ym = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}`;
  const nDays = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
  const curYm = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
  const today = now.toISOString().slice(0, 10);
  const d = n => `${ym}-${pad(n)}`;
  // first Monday on or after the 15th
  let closeDay = 15; while (new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), closeDay)).getUTCDay() !== 1) closeDay++;
  return { ym, nDays, curYm, today, d, closeDay, closeFrom: d(closeDay) };
}

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

async function seedRelease(env, opts = {}) {
  const M = months();
  const R = rng(20261104);
  const users = [['ADMIN1', 'admin', []], ['LEADA', 'leader', ['A_DAY', 'A_NIGHT']], ['VIEW1', 'viewer', []]];
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const [c, role, slots] of users) await setDoc(doc(db, 'qdUsers', E(c)), { role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('ADMIN1') });
    let b = writeBatch(db), n = 0;
    const put = async (ref, data) => { b.set(ref, data); if (++n % 400 === 0) { await b.commit(); b = writeBatch(db); } };
    const noProduction = new Set([M.d(11)]);   // a non-working day before the close date
    const noLog = new Set([M.d(4), M.d(12)]);   // production but no scrap log (unknown, not 0)
    const prodDays = [];
    for (let i = 1; i <= M.nDays; i++) prodDays.push(M.d(i));
    for (let i = 1; i <= 3; i++) prodDays.push(`${M.curYm}-${pad(i)}`);
    for (const date of prodDays) {
      if (noProduction.has(date)) continue;
      for (const [l, s] of KEYS) await put(doc(db, 'prodV2_actualLogs', `actual_${date}_${l}_${s}`), { actualByCell: { '0|||M-100|||FR': 280 + Math.floor(R() * 120), '1|||M-200|||RR': 150 + Math.floor(R() * 90) } });
    }
    // logs before the close date (and the current month): like the live site today
    let id = 0;
    const legacyDays = [];
    for (let i = 1; i < M.closeDay; i++) legacyDays.push(M.d(i));
    for (let i = 1; i <= 3; i++) legacyDays.push(`${M.curYm}-${pad(i)}`);
    for (const date of legacyDays) {
      if (noProduction.has(date) || noLog.has(date)) continue;
      const over = date === M.d(7);   // one day over 50
      for (const [l, s] of KEYS) {
        const k = over ? 3 : Math.floor(R() * 3);
        for (let j = 0; j < k; j++) {
          const qty = over ? 3 + Math.floor(R() * 2) : 1 + Math.floor(R() * 4);
          await put(doc(db, 'scrapLogs', 'rel' + (++id)), { date, shift: s, line: l, model: MODELS[Math.floor(R() * MODELS.length)], defectType: DEFECTS[Math.min(DEFECTS.length - 1, Math.floor(Math.pow(R(), 1.8) * DEFECTS.length))], rootCause: CAUSES[Math.floor(R() * CAUSES.length)], scrapQty: qty, remark: '', createdAt: 1 });
        }
      }
    }
    // Door In Door (never counted in the budget)
    await put(doc(db, 'scrapLogs', 'reldid'), { date: M.d(5), shift: 'DAY', line: 'DID', model: 'MD', defectType: 'บุบ (Dent)', scrapQty: 9, remark: '', createdAt: 1 });
    await b.commit();
  });
  // from the close date: ledger logs + closes (the way Scrap Entry / Daily Confirmation write them)
  const adb = compatDb(env.authenticatedContext('uid-ADMIN1', { email: E('ADMIN1') }).firestore()), aopts = { email: E('ADMIN1'), serverTimestamp };
  const create = (date, line, shift, qty, defectType, rootCause) => Ledger.applyOps(adb, [{ op: 'create', ref: adb.collection('scrapLogs').doc(), data: { date, line, shift, model: 'M-100 FR', defectType, rootCause, scrapQty: qty, remark: '', createdAt: 1 } }], aopts);
  const close = (date, line, shift, state, reason) => SC.closeSlot(adb, { date, line, shift, state, reason }, aopts);
  const plan = {};
  for (let i = M.closeDay; i <= M.nDays; i++) {
    const date = M.d(i), off = i - M.closeDay;
    if (off === 7) plan[date] = 'PENDING';
    else if (off === 8) plan[date] = 'CONFLICT';
    else if (off === 9) plan[date] = 'NO_PRODUCTION';
    else if (off === 10) plan[date] = 'NO_DATA';
    else plan[date] = off === 3 ? 'OVER' : 'FINAL';
  }
  for (const [date, kind] of Object.entries(plan)) {
    if (kind === 'NO_DATA') continue;
    if (kind === 'NO_PRODUCTION') { for (const [l, s] of KEYS) await close(date, l, s, 'NO_PRODUCTION', 'Planned stop'); continue; }
    const withScrap = new Set();
    const rows = kind === 'OVER' ? [['A', 'DAY', 20, 0], ['B', 'DAY', 18, 1], ['C', 'NIGHT', 17, 2]] : [['A', 'DAY', 3 + Math.floor(R() * 6), 0], ['B', 'NIGHT', 2 + Math.floor(R() * 5), 1], ['C', 'DAY', 1 + Math.floor(R() * 4), 2]];
    for (const [l, s, q, k] of rows) { await create(date, l, s, q, DEFECTS[k], CAUSES[k]); withScrap.add(l + s); }
    if (kind === 'PENDING') continue;
    for (const [l, s] of KEYS) await close(date, l, s, withScrap.has(l + s) ? 'SUBMITTED' : 'CONFIRMED_ZERO');
    if (kind === 'CONFLICT') await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapLogs', 'relsneak'), { date, shift: 'NIGHT', line: 'B', model: 'M', defectType: DEFECTS[0], scrapQty: 2, remark: '', createdAt: 1 }); });
  }
  // weekly plans (as js/weekly-plan-data.js writes them) + a review note
  if (!opts.noPlans) {
    const fs = env.authenticatedContext('uid-ADMIN1', { email: E('ADMIN1') }).firestore();
    const setPlan = async (week, planOverride, rev, from, reason) => {
      const wb = writeBatch(fs);
      wb.set(doc(fs, 'scrapWeeklyPlans', `${M.ym}_${week}`), { ym: M.ym, week, planOverride, historyRev: rev, updatedAt: serverTimestamp() });
      wb.set(doc(fs, 'scrapWeeklyPlans', `${M.ym}_${week}`, 'history', String(rev)), { from, to: planOverride, reason, at: serverTimestamp(), by: E('ADMIN1') });
      await wb.commit();
    };
    await setPlan('W2', 200, 1, null, 'Line B trial run');
    await setPlan('W2', 120, 2, 200, 'Stricter target after review');
    await setPlan('W4', null, 1, null, 'Confirmed: default plan');
    await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'scrapWeeklyReviews', `${M.ym}_W2`), { ym: M.ym, week: 'W2', reviewNote: 'W2 over plan: Dent on Door A after the jig change. Action: jig check every shift (owner: QC).', updatedAt: 1, updatedBy: E('ADMIN1') }); });
  }
  return Object.assign(M, { dayKinds: plan });
}

module.exports = { seedRelease, months, E, KEYS };
