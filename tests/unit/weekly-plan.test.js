// Weekly Plan V5 — pure calculations (js/weekly-plan-calc.js), run with the real js/config.js,
// js/shift-close.js and js/target-evaluator.js so day finality comes from the real Shift Close status.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('../support/load-browser-modules.js');

const W = loadModules(['js/config.js', 'js/scrap-ledger.js', 'js/shift-close.js', 'js/quality-adapter.js', 'js/target-evaluator.js', 'js/weekly-plan-calc.js']);
const P = W.WeeklyPlanCalc, TE = W.TargetEvaluator, SC = W.ShiftClose, L = W.ScrapLedger;
const plain = x => JSON.parse(JSON.stringify(x));
const K = name => require('vm').runInContext(name, W);   // a const from js/config.js
let n = 0;
const rec = (date, line, shift, qty, o = {}) => Object.assign({ id: 'r' + (++n), date, line, shift, model: 'M1', defectType: 'Dent', rootCause: '', scrapQty: qty }, o);
const KEYS = ['A_DAY', 'A_NIGHT', 'B_DAY', 'B_NIGHT', 'C_DAY', 'C_NIGHT'];

// Close units for dates (closed = every slot closed as SUBMITTED / CONFIRMED_ZERO).
function summariesFor(dates, records, spec = {}) {
  const summaries = new Map();
  dates.forEach(date => {
    const slots = {};
    KEYS.forEach(k => {
      const [line, shift] = k.split('_');
      const logs = records.filter(r => r.date === date && r.line === line && r.shift === shift);
      const st = (spec[date] || {})[k] !== undefined ? spec[date][k] : (spec[date] && spec[date].all !== undefined ? spec[date].all : (logs.length ? 'SUBMITTED' : 'CONFIRMED_ZERO'));
      const base = { logVersion: logs.length ? 1 : 0, liveLogCount: logs.length };
      if (st) Object.assign(base, { closeState: st, closedVersion: base.logVersion, closeRevision: 1, closedLogCount: logs.length, closedScrapQty: logs.reduce((s, l) => s + l.scrapQty, 0), closedFingerprint: SC.fingerprint(logs), closedAt: 1 });
      slots[k] = L.publicView(base);
    });
    summaries.set(date, { date, slots });
  });
  return summaries;
}
function closeUnits(dates, records, spec = {}) {
  return TE.evaluate({ dates, activeShiftCodes: ['DAY', 'NIGHT'], production: [], scrap: records, scrapReadFailed: false, productionErrors: [], shiftTargets: { histories: {}, failedShifts: [] }, closeContext: { from: dates[0], summaries: summariesFor(dates, records, spec), failed: false } });
}

test('weeks: Mon–Sun clipped to the month, every day in exactly one week, months of 28/29/30/31 days', () => {
  for (const [ym, days, weeks] of [['2026-02', 28, 5], ['2027-02', 28, 4], ['2028-02', 29, 5], ['2026-11', 30, 6], ['2026-10', 31, 5], ['2026-03', 31, 6]]) {
    const w = P.buildWeeks(ym);
    assert.equal(w.length, weeks, ym);
    assert.equal(w.reduce((s, x) => s + x.days, 0), days, ym);
    assert.equal(w[0].start, ym + '-01'); assert.equal(w[w.length - 1].end, ym + '-' + days);
    for (let i = 1; i < w.length; i++) { assert.equal(P.util.addDays(w[i - 1].end, 1), w[i].start); assert.equal(new Date(w[i].start + 'T00:00:00Z').getUTCDay(), 1, 'weeks start on Monday'); }
  }
  // Nov 2026 starts on a Sunday: W1 = 1 day; Mar 2026 ends on Tuesday: W6 = 30–31.
  assert.deepEqual(plain(P.buildWeeks('2026-11').map(w => [w.start, w.days])), [['2026-11-01', 1], ['2026-11-02', 7], ['2026-11-09', 7], ['2026-11-16', 7], ['2026-11-23', 7], ['2026-11-30', 1]]);
});

test('a week across a month end is split: no day counted in two months', () => {
  const r = [rec('2026-10-31', 'A', 'DAY', 10), rec('2026-11-01', 'A', 'DAY', 7)];
  const oct = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: r }), nov = P.buildMonth({ ym: '2026-11', asOf: '2026-11-01', records: r });
  assert.equal(oct.actual, 10); assert.equal(nov.actual, 7);
  assert.equal(oct.weeks[oct.weeks.length - 1].actual, 10); assert.equal(nov.weeks[0].actual, 7);
  assert.equal(oct.weeks[oct.weeks.length - 1].plan + nov.weeks[0].plan, 50 * 7, 'Mon 26 Oct – Sun 1 Nov: 6 + 1 days');
});

test('plan: base = 50 × days; override (0 … base) replaces it; monthly budget = sum of weekly plans', () => {
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: { W2: 300, W3: 0 } });
  assert.equal(m.dailyTarget, 50);
  assert.deepEqual(plain(m.weeks.map(w => w.basePlan)), [200, 350, 350, 350, 300]);
  assert.deepEqual(plain(m.weeks.map(w => w.plan)), [200, 300, 0, 350, 300]);
  assert.equal(m.budget, 1150); assert.equal(m.baseBudget, 1550);
  assert.deepEqual(plain(m.weeks.map(w => [w.days, w.dayList.length])), [[4, 4], [7, 7], [7, 7], [7, 7], [6, 6]], 'days = count, dayList = the days');
  for (const ym of ['2026-02', '2028-02', '2026-11', '2026-10']) {
    const x = P.buildMonth({ ym, asOf: ym + '-01', records: [] });
    assert.equal(x.budget, 50 * x.daysInMonth, ym);
  }
});

test('an override above 50/day, negative, fractional or not a number is not applied (warning)', () => {
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: { W1: 201, W2: -5, W3: 10.5, W4: 'abc', W5: null } });
  assert.deepEqual(plain(m.weeks.map(w => w.plan)), [200, 350, 350, 350, 300]);
  assert.deepEqual(plain(m.warnings), ['override-invalid:W1', 'override-invalid:W2', 'override-invalid:W3', 'override-invalid:W4']);
  assert.equal(P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: { W1: 200 } }).weeks[0].plan, 200);
});

test('actual / remaining / used / plan to date; scope = Door A/B/C × DAY/NIGHT only', () => {
  const r = [rec('2026-10-05', 'A', 'DAY', 20), rec('2026-10-05', 'B', 'NIGHT', 15), rec('2026-10-06', 'C', 'DAY', 10),
    rec('2026-10-06', 'DID', 'DAY', 99), rec('2026-10-06', 'A', 'เช้า', 99), rec('2026-10-06', 'A', 'DAY', 0), rec('2026-10-20', 'A', 'DAY', 5)];
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-07', records: r });
  const w2 = m.weeks[1];
  assert.equal(w2.elapsedDays, 3); assert.equal(w2.actual, 45); assert.equal(w2.plan, 350);
  assert.equal(w2.planToDate, 150); assert.equal(w2.remaining, 305); assert.equal(Math.round(w2.used * 1000), 129);
  assert.equal(m.actual, 45, 'days after as-of are not counted'); assert.equal(m.elapsedDays, 7);
  assert.equal(m.planToDate, 200 + 150); assert.equal(m.remaining, m.budget - 45);
  assert.deepEqual(plain(m.weeks.slice(2).map(w => w.status)), ['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED']);
});

test('Line × Shift detail always adds up to the Door A+B+C total', () => {
  const r = [rec('2026-10-05', 'A', 'DAY', 3), rec('2026-10-05', 'A', 'NIGHT', 4), rec('2026-10-06', 'B', 'DAY', 5), rec('2026-10-07', 'C', 'NIGHT', 6), rec('2026-10-12', 'C', 'DAY', 1)];
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: r });
  const w = m.weeks[1].lineShift;
  assert.deepEqual(plain(w.A), { DAY: 3, NIGHT: 4, total: 7 }); assert.deepEqual(plain(w.total), { DAY: 8, NIGHT: 10, total: 18 });
  assert.equal(m.weeks[1].actual, w.total.total);
  assert.equal(m.lineShift.total.total, m.actual);
  for (const x of [m.lineShift, ...m.weeks.map(k => k.lineShift)]) assert.equal(['A', 'B', 'C'].reduce((s, l) => s + x[l].total, 0), x.total.total);
});

test('no data is never 0: a day without any log is NO_DATA (qty unknown), the week is NOT_FINAL', () => {
  const r = [rec('2026-10-05', 'A', 'DAY', 10)];
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-06', records: r });
  const d5 = m.days.find(d => d.date === '2026-10-05'), d6 = m.days.find(d => d.date === '2026-10-06');
  assert.equal(d5.state, 'LOGGED'); assert.equal(d5.qty, 10); assert.equal(d5.final, false);
  assert.equal(d6.state, 'NO_DATA'); assert.equal(d6.qty, null);
  assert.equal(m.weeks[1].status, 'NOT_FINAL'); assert.equal(m.weeks[1].soFar, true);
  assert.equal(m.weeks[0].noLog, true, '1–4 Oct: no log at all'); assert.equal(m.weeks[1].noLog, false); assert.equal(m.noLog, false);
  assert.equal(m.counts.noData, 5, '1–4 and 6 Oct have no log'); assert.equal(m.projection, null, 'no projection with unknown days');
  assert.equal(m.closeInUse, false);
});

test('scrap read failure: no number at all (READ_ERROR), never 0', () => {
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-06', records: [rec('2026-10-05', 'A', 'DAY', 10)], scrapReadFailed: true });
  assert.equal(m.actual, null); assert.equal(m.remaining, null); assert.equal(m.status, 'READ_ERROR');
  assert.ok(m.weeks.slice(0, 2).every(w => w.actual === null && w.status === 'READ_ERROR'));
  assert.ok(m.days.filter(d => d.elapsed).every(d => d.state === 'READ_ERROR' && d.qty === null));
});

test('Shift Close decides finality: all 6 closed → FINAL, ON_TRACK; pending / changed / conflict → not final', () => {
  const dates = ['2026-11-02', '2026-11-03', '2026-11-04'];
  const r = [rec(dates[0], 'A', 'DAY', 20), rec(dates[1], 'B', 'DAY', 5), rec(dates[2], 'C', 'NIGHT', 4)];
  const allClosed = closeUnits(dates, r);
  const m = P.buildMonth({ ym: '2026-11', asOf: dates[2], records: r, closeFrom: '2026-11-02', closeUnits: allClosed });
  assert.deepEqual(plain(m.days.slice(1, 4).map(d => d.state)), ['FINAL', 'FINAL', 'FINAL']);
  assert.equal(m.weeks[1].status, 'ON_TRACK'); assert.equal(m.weeks[1].soFar, true, 'week not over yet');
  assert.equal(m.days[0].state, 'NO_DATA', '1 Nov is before the close date and has no log');
  const pend = closeUnits(dates, r, { [dates[1]]: { B_DAY: null } });
  const m2 = P.buildMonth({ ym: '2026-11', asOf: dates[2], records: r, closeFrom: '2026-11-02', closeUnits: pend });
  assert.equal(m2.days.find(d => d.date === dates[1]).state, 'PENDING'); assert.equal(m2.weeks[1].status, 'NOT_FINAL');
  assert.equal(m2.days.find(d => d.date === dates[1]).closeText, '5/6');
  // a log written after the close (CHANGED) → not final, qty still shown so far
  const later = r.concat([rec(dates[2], 'C', 'NIGHT', 1)]);
  const units3 = closeUnits(dates, r);   // all 6 closed on the original logs …
  const changed = TE.evaluate({ dates: [dates[2]], activeShiftCodes: ['DAY', 'NIGHT'], production: [], scrap: later, scrapReadFailed: false, productionErrors: [], shiftTargets: { histories: {}, failedShifts: [] },
    closeContext: { from: dates[0], summaries: summariesFor([dates[2]], r), failed: false } });   // … judged against the logs now stored
  units3[2] = changed[0];
  const m3 = P.buildMonth({ ym: '2026-11', asOf: dates[2], records: later, closeFrom: '2026-11-02', closeUnits: units3 });
  const d3 = m3.days.find(d => d.date === dates[2]);
  assert.equal(d3.final, false); assert.ok(['PENDING', 'CONFLICT'].includes(d3.state), d3.state); assert.equal(d3.qty, 5);
  // close summary read failure → READ_ERROR, not final
  const m4 = P.buildMonth({ ym: '2026-11', asOf: dates[2], records: r, closeFrom: '2026-11-02', closeUnits: allClosed, closeReadFailed: true });
  assert.equal(m4.weeks[1].status, 'READ_ERROR');
});

test('OVER is certain even when days are not final; over the daily 50 is flagged per day', () => {
  const r = [rec('2026-10-05', 'A', 'DAY', 120), rec('2026-10-06', 'A', 'DAY', 51)];
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-06', records: r });
  assert.equal(m.weeks[1].status, 'OVER', '171 > 100 plan to date');
  assert.deepEqual(plain(m.days.filter(d => d.qty !== null).map(d => [d.date, d.overDaily])), [['2026-10-05', true], ['2026-10-06', true]]);
  assert.equal(m.counts.overDaily, 2);
  const at50 = P.buildMonth({ ym: '2026-10', asOf: '2026-10-05', records: [rec('2026-10-05', 'A', 'DAY', 50)] });
  assert.equal(at50.days[4].overDaily, false);
});

test('reduction goal: −50 % of the previous month, CONFIRMED only when every previous day is final', () => {
  const oct = [rec('2026-10-10', 'A', 'DAY', 300), rec('2026-10-20', 'B', 'NIGHT', 101)];
  const prev = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: oct });
  const cur = P.buildMonth({ ym: '2026-11', asOf: '2026-11-10', records: [rec('2026-11-02', 'A', 'DAY', 30)] });
  const g = P.reductionGoal({ prev, current: cur, goal: 0.5 });
  assert.equal(g.status, 'PROVISIONAL', 'Shift Close not in use: never shown as confirmed');
  assert.equal(g.baseline, 401); assert.equal(g.goalPcs, 200); assert.equal(g.goalToDate, 200 * 10 / 30);
  assert.equal(g.currentActual, 30); assert.equal(g.onPace, true);
  assert.equal(P.reductionGoal({ prev: P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: oct, scrapReadFailed: true }), current: cur, goal: 0.5 }).status, 'READ_ERROR');
  assert.equal(P.reductionGoal({ prev: P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [] }), current: cur, goal: 0.5 }).status, 'NO_DATA');
  const days = P.util.datesBetween('2026-10-01', '2026-10-31');
  const closed = closeUnits(days, oct);
  assert.equal(P.reductionGoal({ prev: P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: oct, closeFrom: '2026-10-01', closeUnits: closed }), current: cur, goal: 0.5 }).status, 'CONFIRMED');
  // one day of the previous month still pending → provisional
  const oneOpen = closeUnits(days, oct, { '2026-10-20': { B_NIGHT: null } });
  assert.equal(P.reductionGoal({ prev: P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: oct, closeFrom: '2026-10-01', closeUnits: oneOpen }), current: cur, goal: 0.5 }).status, 'PROVISIONAL');
  // before the daily rule (Sep 2026) Shift Close never applies: a close date there changes nothing
  const sep = P.buildMonth({ ym: '2026-09', asOf: '2026-09-30', records: [rec('2026-09-10', 'A', 'DAY', 3)], closeFrom: '2026-09-01', closeUnits: [] });
  assert.equal(sep.days[9].state, 'LOGGED'); assert.equal(sep.closeInUse, false);
  assert.equal(K('QD_MONTHLY_REDUCTION_GOAL'), 0.5);
});

test('Improve: Top 5 by defect only (all lines in one row), qty per Door A/B/C and sub-causes inside', () => {
  const r = [
    rec('2026-10-05', 'A', 'DAY', 4, { defectType: 'Dent', rootCause: 'Jig' }), rec('2026-10-06', 'C', 'NIGHT', 6, { defectType: 'Dent', rootCause: 'Handling', model: 'M2' }),
    rec('2026-10-07', 'B', 'DAY', 2, { defectType: 'Dent', rootCause: 'Jig' }), rec('2026-10-05', 'B', 'DAY', 9, { defectType: 'Scratch' }),
    rec('2026-10-05', 'DID', 'DAY', 50, { defectType: 'Dent' }),
    ...['Gap', 'Burr', 'Dirt', 'Clip'].map((d, i) => rec('2026-10-08', 'A', 'DAY', 1 + i, { defectType: d }))
  ];
  const t = P.topDefects(r, '2026-10-01', '2026-10-31', { topN: 5, threshold: 3 });
  assert.equal(t.rows.length, 5); assert.equal(t.defects, 6); assert.equal(t.total, 12 + 9 + 10);
  const dent = t.rows[0];
  assert.equal(dent.defectType, 'Dent'); assert.equal(dent.qty, 12); assert.equal(t.rows.filter(x => x.defectType === 'Dent').length, 1, 'one row per defect, not per line');
  assert.deepEqual(plain(dent.byLine), { A: 4, B: 2, C: 6 }); assert.deepEqual(plain(dent.lines), ['A', 'B', 'C']);
  assert.equal(dent.days, 3); assert.equal(dent.recurring, true);
  assert.deepEqual(plain(dent.causes.map(c => [c.cause, c.qty, c.byLine.A, c.byLine.B, c.byLine.C])), [['Handling', 6, 0, 0, 6], ['Jig', 6, 4, 2, 0]]);
  assert.equal(t.rows[1].defectType, 'Scratch'); assert.equal(t.rows[1].recurring, false);
  assert.equal(t.rows[1].causes[0].cause, '(cause not recorded)');
});

test('card window: as of the Dashboard To date, never after today; month of that date', () => {
  assert.deepEqual(plain(P.cardWindow('2026-10-31', '2026-11-03')), { ym: '2026-10', asOf: '2026-10-31', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(plain(P.cardWindow('2026-12-05', '2026-11-03')), { ym: '2026-11', asOf: '2026-11-03', from: '2026-11-01', to: '2026-11-03' });
});

test('config: weekly plan constants', () => {
  assert.equal(K('QD_WEEKLY_PLAN_COLLECTION'), 'scrapWeeklyPlans');
  assert.equal(K('QD_WEEKLY_PLAN_HISTORY'), 'history');
  assert.equal(K('QD_WEEKLY_REVIEW_COLLECTION'), 'scrapWeeklyReviews');
  assert.equal(K('QD_IMPROVE_TOP_N'), 5);
  assert.equal(K('QD_VIEW_CACHE_MINUTES'), 5, 're-used data is at most 5 minutes old');
  assert.equal(K('DAILY_TARGET_PCS'), 50);
  assert.equal(K('QD_AUTH_MODE'), 'off');
  assert.equal(K('QD_CLOSE_REQUIRED_FROM'), null);
});

test('plan source: no document = DEFAULT (not set), Admin default = ADMIN_DEFAULT, override, unreadable = UNAVAILABLE — a default is never "confirmed"', () => {
  const m = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: { W2: 300, W4: null } });
  assert.deepEqual(plain(m.weeks.map(w => [w.key, w.planSource, w.planConfirmed])), [['W1', 'DEFAULT', false], ['W2', 'OVERRIDE', true], ['W3', 'DEFAULT', false], ['W4', 'ADMIN_DEFAULT', true], ['W5', 'DEFAULT', false]]);
  assert.equal(m.budgetSource, 'DEFAULT'); assert.deepEqual(plain(m.planSources), { OVERRIDE: 1, ADMIN_DEFAULT: 1, DEFAULT: 3, UNAVAILABLE: 0 });
  const all = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: { W1: null, W2: 300, W3: null, W4: null, W5: 250 } });
  assert.equal(all.budgetSource, 'CONFIRMED');
  // the read failed: same default numbers, but UNAVAILABLE everywhere (even where a plan may exist)
  const failed = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: {}, plansReadFailed: true });
  assert.equal(failed.budgetSource, 'UNAVAILABLE'); assert.ok(failed.weeks.every(w => w.planSource === 'UNAVAILABLE' && !w.planConfirmed));
  assert.equal(failed.budget, 1550); assert.deepEqual(plain(failed.warnings), ['plans-read-failed']);
  // an invalid override is not applied and the week counts as not set
  const bad = P.buildMonth({ ym: '2026-10', asOf: '2026-10-31', records: [], overrides: { W1: 999 } });
  assert.equal(bad.weeks[0].planSource, 'DEFAULT'); assert.equal(bad.weeks[0].plan, 200);
});
