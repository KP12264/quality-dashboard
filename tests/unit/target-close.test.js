// Target Evaluator + Shift Close (Phase 4): the daily status from the 6 shift closes, the status
// priority, the rule switch dates, and that nothing changes while QD_CLOSE_REQUIRED_FROM is null.
// Runs the real js/config.js, js/scrap-ledger.js, js/shift-close.js, js/quality-adapter.js and
// js/target-evaluator.js in one vm context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadModules, ROOT } = require('../support/load-browser-modules.js');

const W = loadModules(['js/config.js', 'js/scrap-ledger.js', 'js/shift-close.js', 'js/quality-adapter.js', 'js/target-evaluator.js']);
const plain = x => JSON.parse(JSON.stringify(x));   // values from the vm context → this realm
const TE = W.TargetEvaluator, SC = W.ShiftClose, L = W.ScrapLedger, ST = TE.STATUS;
const FROM = '2026-11-01', D = '2026-11-10';
const KEYS = ['A_DAY', 'A_NIGHT', 'B_DAY', 'B_NIGHT', 'C_DAY', 'C_NIGHT'];
let n = 0;
const log = (key, qty, date = D) => { const [line, shift] = key.split('_'); return { id: 'l' + (++n), date, line, shift, model: 'M', defectType: 'Dent', scrapQty: qty }; };
// Public view of a slot in a given close state for the given logs (what the mirror would hold).
function view(state, logs, o = {}) {
  const base = { logVersion: o.logVersion == null ? (logs.length ? 1 : 0) : o.logVersion, liveLogCount: o.liveLogCount == null ? logs.length : o.liveLogCount };
  if (o.importPending) base.importPending = { importId: 'i' };
  if (state) Object.assign(base, {
    closeState: state, closedVersion: o.closedVersion == null ? base.logVersion : o.closedVersion, closeRevision: 1,
    closedLogCount: logs.length, closedScrapQty: logs.reduce((s, l) => s + l.scrapQty, 0), closedFingerprint: o.fp || SC.fingerprint(logs), closedAt: 1
  });
  return L.publicView(base);
}
// day: { A_DAY: { state, logs, o } ... } -> { scrap, closeContext }
function day(spec, date = D, ctxExtra = {}) {
  const slots = {}, scrap = [];
  Object.entries(spec).forEach(([k, v]) => { const logs = (v.logs || []).map(q => typeof q === 'number' ? log(k, q, date) : q); scrap.push(...logs); if (v.state !== undefined || v.o) slots[k] = view(v.state, logs, v.o || {}); });
  return { scrap, closeContext: Object.assign({ from: FROM, summaries: new Map([[date, { date, slots }]]), failed: false }, ctxExtra) };
}
const all = (state, extra = {}) => Object.fromEntries(KEYS.map(k => [k, Object.assign({ state }, extra[k] || {})]));
function evalDay(spec, opts = {}) {
  const { scrap, closeContext } = day(spec, opts.date || D, opts.ctx);
  const units = TE.evaluate({ dates: [opts.date || D], activeShiftCodes: opts.shifts || ['DAY', 'NIGHT'], production: opts.production || [], scrap: opts.scrap || scrap,
    scrapReadFailed: !!opts.scrapFailed, productionErrors: [], shiftTargets: { histories: {}, failedShifts: [] }, closeContext });
  return units[0];
}

test('OVER although closes are missing (scrap > 50 is certain)', () => {
  const u = evalDay({ A_DAY: { logs: [30, 31] } });
  assert.equal(u.status, ST.OVER); assert.equal(u.totalScrap, 61); assert.equal(u.close.closed, 0); assert.equal(u.judged, true);
  assert.ok(u.reasons.some(r => r.startsWith('close-pending:')));
});
test('WITHIN only when all 6 closed and <= 50', () => {
  const u = evalDay(all('CONFIRMED_ZERO', { A_DAY: { state: 'SUBMITTED', logs: [20, 30] } }));
  assert.equal(u.status, ST.WITHIN); assert.equal(u.totalScrap, 50); assert.equal(u.gap, 0); assert.equal(TE.closeCompleteness(u), '6/6');
  const five = all('CONFIRMED_ZERO'); delete five.C_NIGHT.state;
  assert.equal(evalDay(five).status, ST.INCOMPLETE);
});
test('Pending, Changed and Conflict never count as closed', () => {
  const pend = evalDay(Object.assign(all('CONFIRMED_ZERO'), { B_DAY: { logs: [4] } }));
  assert.equal(pend.status, ST.INCOMPLETE); assert.equal(pend.close.closed, 5); assert.deepEqual(plain(pend.close.pending), ['B_DAY']);
  // scrap edited after the close: version moved past the confirmed one
  const changed = evalDay(Object.assign(all('CONFIRMED_ZERO'), { A_DAY: { state: 'SUBMITTED', logs: [5, 6], o: { logVersion: 3, closedVersion: 2 } } }));
  assert.equal(changed.status, ST.INCOMPLETE); assert.deepEqual(plain(changed.close.changed), ['A_DAY']); assert.equal(changed.close.closed, 5);
  assert.match(TE.reasonText(changed.reasons[0]), /Changed after close.*A Day/);
  const conflict = evalDay(Object.assign(all('CONFIRMED_ZERO'), { C_DAY: { state: 'SUBMITTED', logs: [5], o: { fp: 'f1-1-deadbeef' } } }));
  assert.equal(conflict.status, ST.CONFLICT); assert.equal(conflict.close.closed, 5); assert.equal(conflict.judged, false);
});
test('status is checked against the real scrap logs, not closedScrapQty / counters', () => {
  // the mirror claims 1 log, but 2 are stored → ledger count mismatch → CONFLICT
  const u = evalDay(Object.assign(all('CONFIRMED_ZERO'), { A_DAY: { state: 'SUBMITTED', logs: [3, 4], o: { liveLogCount: 1 } } }));
  assert.equal(u.status, ST.CONFLICT);
  // a close that says 0 while logs exist (written around the ledger) → CONFLICT
  const z = evalDay(Object.assign(all('CONFIRMED_ZERO'), { B_NIGHT: { state: 'CONFIRMED_ZERO' } }), { scrap: [log('B_NIGHT', 2)] });
  assert.equal(z.status, ST.CONFLICT);
});
test('Confirmed Zero on every shift: WITHIN with a known 0', () => {
  const u = evalDay(all('CONFIRMED_ZERO'));
  assert.equal(u.status, ST.WITHIN); assert.equal(u.totalScrap, 0); assert.equal(u.scrapKnown, true); assert.equal(u.judged, true);
});
test('No Production on every shift: NO PRODUCTION; mixed with Zero: WITHIN', () => {
  assert.equal(evalDay(all('NO_PRODUCTION')).status, ST.NO_PRODUCTION);
  assert.equal(evalDay(all('NO_PRODUCTION')).judged, false);
  assert.equal(evalDay(all('NO_PRODUCTION', { A_DAY: { state: 'CONFIRMED_ZERO' } })).status, ST.WITHIN);
});
test('READ ERROR: scrap or close status unreadable; never 0 or WITHIN, even over 50', () => {
  const s = evalDay(all('CONFIRMED_ZERO'), { scrapFailed: true });
  assert.equal(s.status, ST.READ_ERROR); assert.equal(s.totalScrap, null); assert.equal(s.judged, false);
  const c = evalDay({ A_DAY: { logs: [60] } }, { ctx: { failed: true, summaries: new Map() } });
  assert.equal(c.status, ST.READ_ERROR); assert.deepEqual(plain(c.reasons), ['close-read-failed']);
});
test('NO DATA only when there is nothing at all', () => {
  assert.equal(evalDay({}).status, ST.NO_DATA);
  assert.equal(evalDay({}, { production: [{ date: D, line: 'A', shift: 'DAY', productionQty: 10 }] }).status, ST.INCOMPLETE);
  assert.equal(evalDay({ A_DAY: { state: 'CONFIRMED_ZERO' } }).status, ST.INCOMPLETE);
});
test('day priority when several statuses meet: READ ERROR > OVER > CONFLICT > INCOMPLETE > NO PRODUCTION / WITHIN', () => {
  // conflict slot + reliable scrap > 50 elsewhere → OVER (the conflict slot cannot lower it)
  const over = evalDay({ A_DAY: { logs: [51] }, B_DAY: { state: 'SUBMITTED', logs: [1], o: { fp: 'x' } }, C_DAY: { logs: [1] } });
  assert.equal(over.status, ST.OVER); assert.equal(over.reliableScrap, 52);
  // the only scrap > 50 is in the conflict slot → CONFLICT, not OVER
  const conf = evalDay({ A_DAY: { state: 'SUBMITTED', logs: [60], o: { fp: 'x' } }, B_DAY: { logs: [1] } });
  assert.equal(conf.status, ST.CONFLICT);
  // conflict + pending + changed together → CONFLICT
  assert.equal(evalDay({ A_DAY: { state: 'SUBMITTED', logs: [1], o: { fp: 'x' } }, B_DAY: { logs: [1] }, C_DAY: { state: 'SUBMITTED', logs: [2], o: { logVersion: 2, closedVersion: 1 } } }).status, ST.CONFLICT);
  // import marker → CONFLICT
  assert.equal(evalDay(Object.assign(all('CONFIRMED_ZERO'), { A_NIGHT: { o: { importPending: true } } })).status, ST.CONFLICT);
  // read error beats everything
  assert.equal(evalDay({ A_DAY: { logs: [99] } }, { ctx: { failed: true } }).status, ST.READ_ERROR);
});
test('range priority: OVER > READ ERROR > CONFLICT > INCOMPLETE > WITHIN > NO PRODUCTION > NO DATA', () => {
  const u = st => ({ status: st });
  const order = [ST.OVER, ST.READ_ERROR, ST.CONFLICT, ST.INCOMPLETE, ST.WITHIN, ST.NO_PRODUCTION, ST.NO_DATA];
  for (let i = 0; i < order.length; i++) assert.equal(TE.combineStatuses(order.slice(i).reverse().map(u)), order[i]);
  assert.equal(TE.combineStatuses([]), ST.NO_DATA);
});
test('Line / Shift filter never changes the day: all 6 slots are always judged', () => {
  const spec = all('CONFIRMED_ZERO', { A_DAY: { state: 'SUBMITTED', logs: [10] }, C_NIGHT: { state: undefined, logs: [45] } });   // C Night not closed yet
  const a = evalDay(spec), b = evalDay(spec, { shifts: ['DAY'] });
  assert.equal(a.status, ST.OVER); assert.equal(b.status, a.status); assert.equal(b.totalScrap, 55);
});
test('before QD_CLOSE_REQUIRED_FROM the previous rules apply; null = nothing changes', () => {
  const prev = '2026-10-31';
  const prod = [{ date: prev, line: 'A', shift: 'DAY', productionQty: 10 }, { date: prev, line: 'A', shift: 'NIGHT', productionQty: 10 }];
  const args = { dates: [prev, D], activeShiftCodes: ['DAY', 'NIGHT'], production: prod, scrap: [], scrapReadFailed: false, productionErrors: [], shiftTargets: { histories: {}, failedShifts: [] } };
  const withClose = TE.evaluate(Object.assign({}, args, { closeContext: { from: FROM, summaries: new Map(), failed: false } }));
  assert.equal(withClose[0].closeRule, undefined); assert.equal(withClose[0].status, ST.INCOMPLETE); assert.deepEqual(plain(withClose[0].reasons), ['no-scrap-log']);
  assert.equal(withClose[1].closeRule, true);
  const none = TE.evaluate(Object.assign({}, args, { closeContext: { from: null, summaries: new Map(), failed: false } }));
  const legacy = TE.evaluate(args);
  assert.deepEqual(JSON.parse(JSON.stringify(none)), JSON.parse(JSON.stringify(legacy)));
  assert.ok(legacy.every(x => !x.closeRule));
  // pre-01 Oct 2026 per-shift rule is never replaced, even with an earlier close date
  assert.equal(TE.closeRequired('2026-09-15', '2026-09-01'), false);
  assert.equal(TE.closeRequired('2026-11-10', null), false);
});
test('config: QD_CLOSE_REQUIRED_FROM is null and QD_AUTH_MODE "off"', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  assert.match(cfg, /const QD_CLOSE_REQUIRED_FROM = null;/);
  assert.match(cfg, /const QD_AUTH_MODE = "off";/);
});
test('shift end and Thailand time agree with the rules', () => {
  const rules = fs.readFileSync(path.join(ROOT, 'emulator/firestore.rules'), 'utf8');
  const m = rules.match(/function qdShiftEndMinutes\(shift\) \{\s*return shift == 'DAY' \? (\d+) : (\d+);/);
  const cfg = vmConfig();
  const mins = sh => cfg.QD_SHIFT_END[sh].dayOffset * 1440 + Number(cfg.QD_SHIFT_END[sh].time.split(':')[0]) * 60 + Number(cfg.QD_SHIFT_END[sh].time.split(':')[1]);
  assert.equal(mins('DAY'), Number(m[1])); assert.equal(mins('NIGHT'), Number(m[2]));
  assert.equal(mins('DAY'), 19 * 60 + 50); assert.equal(mins('NIGHT'), 24 * 60 + 8 * 60);
  assert.match(rules, /function qdBkkNow\(\) \{\s*return request\.time \+ duration\.value\((\d+), 'h'\);/);
  assert.equal(Number(rules.match(/request\.time \+ duration\.value\((\d+), 'h'\)/)[1]), cfg.QD_TZ_OFFSET_HOURS);
  // 18:00 UTC is already the next day in Thailand
  const QA = require('../../js/qd-auth.js');
  assert.equal(QA.localToday(new Date('2026-11-02T16:59:00Z')), '2026-11-02');
  assert.equal(QA.localToday(new Date('2026-11-02T17:00:00Z')), '2026-11-03');
  // DAY of 2026-11-02 ends 19:50 Thailand = 12:50 UTC; NIGHT ends 2026-11-03 08:00 = 01:00 UTC
  assert.equal(SC.shiftEnd('2026-11-02', 'DAY').toISOString(), '2026-11-02T12:50:00.000Z');
  // minute boundaries (client): DAY 19:49 no / 19:50 yes; NIGHT 07:59 no / 08:00 yes (next day)
  assert.equal(SC.shiftEnded('2026-11-02', 'DAY', new Date('2026-11-02T12:49:59Z')), false);
  assert.equal(SC.shiftEnded('2026-11-02', 'DAY', new Date('2026-11-02T12:50:00Z')), true);
  assert.equal(SC.shiftEnded('2026-11-02', 'NIGHT', new Date('2026-11-03T00:59:59Z')), false);
  assert.equal(SC.shiftEnded('2026-11-02', 'NIGHT', new Date('2026-11-03T01:00:00Z')), true);
  assert.equal(SC.shiftEnded('2026-11-02', 'NIGHT', new Date('2026-11-02T12:50:00Z')), false);   // NIGHT belongs to its start date
  assert.equal(SC.shiftEnd('2026-11-02', 'NIGHT').toISOString(), '2026-11-03T01:00:00.000Z');
});
function vmConfig() {
  const vm = require('vm');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8') + '\n;this.__c = { QD_SHIFT_END, QD_TZ_OFFSET_HOURS };', ctx);
  return ctx.__c;
}
test('public mirror carries no e-mail, note or reason', () => {
  const v = L.publicView({ logVersion: 2, liveLogCount: 1, closeState: 'NO_PRODUCTION', closedBy: 'kp1@prodv2.local', closeNote: 'x', noProductionReason: 'holiday', updatedBy: 'kp1@prodv2.local', importPending: { by: 'a@prodv2.local' } });
  assert.doesNotMatch(JSON.stringify(v), /@|holiday|"x"/);
  assert.deepEqual(Object.keys(v).sort(), ['closeRevision', 'closeState', 'closedAt', 'closedFingerprint', 'closedLogCount', 'closedScrapQty', 'closedVersion', 'importPending', 'liveLogCount', 'logVersion']);
});
