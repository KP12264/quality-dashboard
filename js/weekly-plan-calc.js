/**
 * weekly-plan-calc.js — Weekly Plan V5 numbers (pure: no Firestore, no DOM).
 * ------------------------------------------------------------------
 * Used by the Dashboard "Scrap Budget" card AND weekly-plan.html, so both always show the same
 * numbers from the same records.
 *
 * Scope = the Target Evaluator scope: Door A/B/C and shifts DAY/NIGHT only (other lines and old
 * shift codes are not counted). Day + Night combined; the production `date` decides the day.
 *
 * Weeks run Monday–Sunday and are clipped to the month, so a day is never counted in two months
 * (a week that crosses a month end is two weeks: the last of one month, the first of the next).
 *
 *   base weekly plan  = DAILY_TARGET_PCS x days of the week in the month
 *   weekly plan       = Admin override (whole pcs, 0 … base) or the base plan.
 *                       An override above the base would allow more than 50/day: it is ignored
 *                       (warning) so the plan always stays within the daily limit.
 *   monthly budget    = sum of the weekly plans of the month (no separate monthly override)
 *   plan to date      = plan x elapsed days / days
 *   actual            = scrap of the elapsed days ("so far" while any of them is not final)
 *   remaining         = plan - actual (negative = over budget)
 *   used              = actual / plan
 *
 * A day is FINAL only through Shift Close (the existing close status, judged by
 * TargetEvaluator for dates on/after QD_CLOSE_REQUIRED_FROM): all 6 shifts closed and the day is
 * WITHIN / OVER / NO PRODUCTION. Before that date (or while it is not in use) a day with scrap
 * logs is LOGGED (not final) and a day without any log is NO_DATA — unknown, never 0.
 *
 * Status of a week / the month (same principle as the daily status: OVER is certain because
 * scrap can only grow):
 *   NOT_STARTED  no elapsed day
 *   READ_ERROR   scrap could not be read (no number is shown), or a close status could not be read
 *   OVER         actual > plan to date
 *   ON_TRACK     actual <= plan to date and every elapsed day is final
 *   NOT_FINAL    actual <= plan to date so far, but some elapsed day is not final
 * noLog = no elapsed day has any scrap log: the page shows "No log", never an actual of 0.
 *
 * Exposed as window.WeeklyPlanCalc (module.exports under Node).
 * ------------------------------------------------------------------
 */
(function (root) {
  // ---- dates ("YYYY-MM-DD", UTC arithmetic) ---------------------------------------------
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = dt => dt.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const monthStart = ym => ym + '-01';
  const monthEnd = ym => ym + '-' + String(daysInMonth(ym)).padStart(2, '0');
  const prevMonth = ym => { const [y, m] = ym.split('-').map(Number); return iso(new Date(Date.UTC(y, m - 2, 1))).slice(0, 7); };
  const nextMonth = ym => { const [y, m] = ym.split('-').map(Number); return iso(new Date(Date.UTC(y, m, 1))).slice(0, 7); };
  const weekday = s => (parse(s).getUTCDay() + 6) % 7;   // Mon = 0 … Sun = 6
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = s => { const d = parse(s); return String(d.getUTCDate()).padStart(2, '0') + ' ' + MON[d.getUTCMonth()]; };
  const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return MON[m - 1] + ' ' + y; };
  function datesBetween(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

  const LINE_CODES = () => (typeof LINES !== 'undefined' ? LINES : [{ code: 'A' }, { code: 'B' }, { code: 'C' }]).map(l => l.code);
  const SHIFT_CODES = () => (typeof SHIFTS !== 'undefined' ? SHIFTS : [{ code: 'DAY' }, { code: 'NIGHT' }]).map(s => s.code);
  const dailyTargetDefault = () => (typeof DAILY_TARGET_PCS !== 'undefined' ? DAILY_TARGET_PCS : 50);

  /** Same scope as TargetEvaluator: Door A/B/C x DAY/NIGHT, a date and a positive quantity. */
  function inScope(records) {
    const lines = new Set(LINE_CODES()), shifts = new Set(SHIFT_CODES());
    return (records || []).filter(r => r && lines.has(r.line) && shifts.has(r.shift) && r.date && Number(r.scrapQty) > 0);
  }

  /** Weeks of a month: Monday–Sunday, clipped to the month. W1 … W4–W6. */
  function buildWeeks(ym) {
    const weeks = []; let cur = null;
    datesBetween(monthStart(ym), monthEnd(ym)).forEach(d => {
      if (!cur || weekday(d) === 0) { cur = { index: weeks.length + 1, key: 'W' + (weeks.length + 1), start: d, end: d }; weeks.push(cur); }
      cur.end = d;
    });
    weeks.forEach(w => { w.days = daysBetween(w.start, w.end) + 1; w.label = shortDate(w.start) + (w.days > 1 ? ' – ' + shortDate(w.end) : ''); });
    return weeks;
  }
  function weekOf(ym, date) { return buildWeeks(ym).find(w => date >= w.start && date <= w.end) || null; }

  /** The override to use, or null. An override above the base plan (> 50/day) is not applied. */
  function resolveOverride(raw, basePlan) {
    if (raw === null || raw === undefined || raw === '') return { value: null, invalid: false };
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > basePlan) return { value: null, invalid: true };
    return { value: v, invalid: false };
  }

  const blankLineShift = () => { const o = {}; LINE_CODES().forEach(l => { o[l] = { DAY: 0, NIGHT: 0, total: 0 }; }); o.total = { DAY: 0, NIGHT: 0, total: 0 }; return o; };
  function addLineShift(acc, r) {
    const q = Number(r.scrapQty);
    acc[r.line][r.shift] += q; acc[r.line].total += q; acc.total[r.shift] += q; acc.total.total += q;
  }

  const FINAL_STATUSES = ['WITHIN TARGET', 'OVER TARGET', 'NO PRODUCTION'];

  /**
   * One day's data state.
   *   unit: the TargetEvaluator unit of a close-required day (closeRule), or undefined.
   * -> { state, final, known, closeText }
   *   state: FUTURE | READ_ERROR | FINAL | CONFLICT | PENDING | LOGGED | NO_DATA
   */
  function dayState({ elapsed, logs, scrapReadFailed, closeRequired, unit, closeReadFailed }) {
    if (!elapsed) return { state: 'FUTURE', final: false, known: false };
    if (scrapReadFailed) return { state: 'READ_ERROR', final: false, known: false };
    if (closeRequired) {
      if (closeReadFailed || !unit) return { state: 'READ_ERROR', final: false, known: logs > 0 };
      const st = unit.status, c = unit.close || { closed: 0, total: 6 };
      const closeText = c.closed + '/' + c.total;
      if (st === 'READ ERROR') return { state: 'READ_ERROR', final: false, known: logs > 0, closeText, evaluatorStatus: st };
      if (c.closed === c.total && FINAL_STATUSES.includes(st)) return { state: 'FINAL', final: true, known: true, closeText, evaluatorStatus: st };
      if (st === 'CONFLICT' || (c.conflict && c.conflict.length)) return { state: 'CONFLICT', final: false, known: logs > 0, closeText, evaluatorStatus: st };
      if (logs === 0 && c.closed === 0) return { state: 'NO_DATA', final: false, known: false, closeText, evaluatorStatus: st };
      return { state: 'PENDING', final: false, known: true, closeText, evaluatorStatus: st };
    }
    return logs > 0 ? { state: 'LOGGED', final: false, known: true } : { state: 'NO_DATA', final: false, known: false };
  }

  function periodStatus({ elapsedDays, actual, planToDate, anyReadError, allFinal }) {
    if (elapsedDays === 0) return 'NOT_STARTED';
    if (actual === null) return 'READ_ERROR';
    if (actual > planToDate + 1e-9) return 'OVER';
    if (anyReadError) return 'READ_ERROR';
    return allFinal ? 'ON_TRACK' : 'NOT_FINAL';
  }

  function countStates(days) {
    const c = { elapsed: 0, final: 0, notFinal: 0, noData: 0, logged: 0, pending: 0, conflict: 0, readError: 0, overDaily: 0 };
    days.forEach(d => {
      if (d.state === 'FUTURE') return;
      c.elapsed++;
      if (d.final) c.final++; else c.notFinal++;
      if (d.state === 'NO_DATA') c.noData++;
      if (d.state === 'LOGGED') c.logged++;
      if (d.state === 'PENDING') c.pending++;
      if (d.state === 'CONFLICT') c.conflict++;
      if (d.state === 'READ_ERROR') c.readError++;
      if (d.overDaily) c.overDaily++;
    });
    return c;
  }

  /**
   * buildMonth({ ym, asOf, records, scrapReadFailed, closeFrom, closeUnits, closeReadFailed,
   *              overrides, plansReadFailed, dailyTarget })
   *   asOf        last elapsed date; clamped to the month (before the month = nothing elapsed)
   *   records     scrap records (any range — only the month and the scope are used)
   *   closeFrom   QD_CLOSE_REQUIRED_FROM in force (null = Shift Close does not decide)
   *   closeUnits  TargetEvaluator units (closeRule) for the close-required dates
   *   overrides   { W1: 300, … } (raw values from scrapWeeklyPlans)
   */
  function buildMonth(o) {
    const ym = o.ym, target = Number.isFinite(o.dailyTarget) ? o.dailyTarget : dailyTargetDefault();
    const mStart = monthStart(ym), mEnd = monthEnd(ym), nDays = daysInMonth(ym);
    let asOf = o.asOf || mEnd;
    if (asOf > mEnd) asOf = mEnd;
    const scrapReadFailed = !!o.scrapReadFailed;
    const closeFrom = o.closeFrom || null;
    // Same rule as TargetEvaluator.closeRequired: from the close date AND on the daily (<=50/day) rule.
    const dailyFrom = typeof TARGET_DAILY_RULE_EFFECTIVE_DATE === 'string' ? TARGET_DAILY_RULE_EFFECTIVE_DATE : '0000-00-00';
    const isCloseDay = d => !!closeFrom && d >= closeFrom && d >= dailyFrom;
    const unitByDate = new Map((o.closeUnits || []).filter(u => u && u.closeRule).map(u => [u.date, u]));

    const recs = scrapReadFailed ? [] : inScope(o.records).filter(r => r.date >= mStart && r.date <= mEnd && r.date <= asOf);
    const byDate = new Map();
    recs.forEach(r => {
      if (!byDate.has(r.date)) byDate.set(r.date, { qty: 0, logs: 0, ls: blankLineShift() });
      const b = byDate.get(r.date); b.qty += Number(r.scrapQty); b.logs++; addLineShift(b.ls, r);
    });

    const weeksDef = buildWeeks(ym);
    const days = datesBetween(mStart, mEnd).map(date => {
      const elapsed = date <= asOf, b = byDate.get(date) || { qty: 0, logs: 0, ls: blankLineShift() };
      const s = dayState({ elapsed, logs: b.logs, scrapReadFailed, closeRequired: isCloseDay(date), unit: unitByDate.get(date), closeReadFailed: !!o.closeReadFailed });
      const qty = s.known ? b.qty : null;
      return Object.assign({ date, label: shortDate(date), week: weeksDef.find(w => date >= w.start && date <= w.end).key, elapsed, logs: b.logs,
        qty, overDaily: qty !== null && qty > target, closeRequired: isCloseDay(date), lineShift: b.ls }, s);
    });

    const warnings = [];
    if (o.plansReadFailed) warnings.push('plans-read-failed');
    const weeks = weeksDef.map(w => {
      const wDays = days.filter(d => d.week === w.key);
      const basePlan = target * w.days;
      const raw = o.overrides ? o.overrides[w.key] : null;
      const ov = resolveOverride(raw, basePlan);
      if (ov.invalid) warnings.push('override-invalid:' + w.key);
      const plan = ov.value !== null ? ov.value : basePlan;
      const elapsedDays = wDays.filter(d => d.elapsed).length;
      const planToDate = plan * elapsedDays / w.days;
      const actual = scrapReadFailed ? null : wDays.reduce((s, d) => s + (d.elapsed ? (byDate.get(d.date) || { qty: 0 }).qty : 0), 0);
      const counts = countStates(wDays);
      const allFinal = elapsedDays > 0 && counts.final === elapsedDays;
      const ls = blankLineShift();
      if (!scrapReadFailed) recs.filter(r => r.date >= w.start && r.date <= w.end).forEach(r => addLineShift(ls, r));
      return Object.assign({}, w, {
        basePlan, override: ov.value, overrideRaw: raw === undefined ? null : raw, overrideInvalid: ov.invalid, plan,
        elapsedDays, planToDate, actual, remaining: actual === null ? null : plan - actual,
        used: actual === null || plan <= 0 ? null : actual / plan,
        budgetExceeded: actual !== null && actual > plan,
        noLog: elapsedDays > 0 && counts.noData === elapsedDays,
        final: allFinal && elapsedDays === w.days, soFar: !(allFinal && elapsedDays === w.days),
        counts, status: periodStatus({ elapsedDays, actual, planToDate, anyReadError: counts.readError > 0, allFinal }),
        lineShift: ls, dayList: wDays
      });
    });

    const elapsedDays = days.filter(d => d.elapsed).length;
    const budget = weeks.reduce((s, w) => s + w.plan, 0);
    const planToDate = weeks.reduce((s, w) => s + w.planToDate, 0);
    const actual = scrapReadFailed ? null : weeks.reduce((s, w) => s + w.actual, 0);
    const counts = countStates(days);
    const allFinal = elapsedDays > 0 && counts.final === elapsedDays;
    const ls = blankLineShift(); recs.forEach(r => addLineShift(ls, r));
    return {
      ym, monthLabel: monthLabel(ym), asOf, monthStart: mStart, monthEnd: mEnd, daysInMonth: nDays, elapsedDays,
      dailyTarget: target, baseBudget: target * nDays, budget, planToDate, actual,
      remaining: actual === null ? null : budget - actual,
      used: actual === null || budget <= 0 ? null : actual / budget,
      budgetExceeded: actual !== null && actual > budget,
      noLog: elapsedDays > 0 && counts.noData === elapsedDays,
      projection: actual !== null && elapsedDays > 0 && counts.noData === 0 ? actual / elapsedDays * nDays : null,
      final: allFinal && elapsedDays === nDays, soFar: !(allFinal && elapsedDays === nDays),
      counts, status: periodStatus({ elapsedDays, actual, planToDate, anyReadError: counts.readError > 0, allFinal }),
      closeFrom, closeInUse: !!closeFrom && closeFrom <= asOf && asOf >= dailyFrom,
      lineShift: ls, weeks, days, warnings
    };
  }

  /**
   * Previous-month reduction goal (QD_MONTHLY_REDUCTION_GOAL, 50 %), kept SEPARATE from the
   * daily operational limit. prev = buildMonth() of the previous month (asOf = its end).
   * The goal is CONFIRMED only when every day of the previous month is final; otherwise it is
   * PROVISIONAL (never shown as a confirmed goal). READ_ERROR when the month could not be read.
   */
  function reductionGoal({ prev, current, goal }) {
    const g = Number.isFinite(goal) ? goal : (typeof QD_MONTHLY_REDUCTION_GOAL !== 'undefined' ? QD_MONTHLY_REDUCTION_GOAL : 0.5);
    if (!prev || prev.actual === null) return { status: 'READ_ERROR', goal: g, prevYm: prev && prev.ym };
    const confirmed = prev.final && prev.counts.readError === 0;
    const baseline = prev.actual;
    const goalPcs = Math.floor(baseline * (1 - g));
    const goalToDate = current ? goalPcs * current.elapsedDays / current.daysInMonth : null;
    const cur = current && current.actual !== null ? current.actual : null;
    return {
      status: prev.elapsedDays === 0 || (prev.counts.noData === prev.elapsedDays) ? 'NO_DATA' : (confirmed ? 'CONFIRMED' : 'PROVISIONAL'),
      goal: g, prevYm: prev.ym, prevLabel: prev.monthLabel, baseline, goalPcs, goalToDate,
      prevCounts: prev.counts, prevDays: prev.daysInMonth,
      currentActual: cur, onPace: cur === null || goalToDate === null ? null : cur <= goalToDate
    };
  }

  /**
   * Improve: Top N defects for [from, to], grouped by DEFECT ONLY (all lines together, one row per
   * defect — never repeated per line). Inside each row: qty per Door A/B/C and the sub-causes
   * (rootCause) with their qty per line. recurring = seen on >= threshold different dates.
   */
  function topDefects(records, from, to, opts) {
    const topN = (opts && opts.topN) || 5;
    const threshold = (opts && opts.threshold) || (typeof RECURRING_THRESHOLD_DISTINCT_DATES !== 'undefined' ? RECURRING_THRESHOLD_DISTINCT_DATES : 3);
    const lines = LINE_CODES();
    const groups = new Map(); let total = 0;
    inScope(records).filter(r => r.date >= from && r.date <= to).forEach(r => {
      const key = String(r.defectType || '').trim() || '(no defect type)';
      if (!groups.has(key)) { const byLine = {}; lines.forEach(l => { byLine[l] = 0; }); groups.set(key, { defectType: key, qty: 0, dates: new Set(), byLine, causes: new Map() }); }
      const g = groups.get(key), q = Number(r.scrapQty);
      g.qty += q; total += q; g.dates.add(r.date); g.byLine[r.line] += q;
      const cause = String(r.rootCause || '').trim() || '(cause not recorded)';
      if (!g.causes.has(cause)) { const bl = {}; lines.forEach(l => { bl[l] = 0; }); g.causes.set(cause, { cause, qty: 0, byLine: bl }); }
      const c = g.causes.get(cause); c.qty += q; c.byLine[r.line] += q;
    });
    const rows = [...groups.values()].sort((a, b) => b.qty - a.qty || a.defectType.localeCompare(b.defectType));
    return {
      total, defects: rows.length,
      rows: rows.slice(0, topN).map((g, i) => ({
        rank: i + 1, defectType: g.defectType, qty: g.qty, share: total > 0 ? g.qty / total : 0,
        days: g.dates.size, recurring: g.dates.size >= threshold, lastSeen: [...g.dates].sort().pop(),
        byLine: g.byLine, lines: lines.filter(l => g.byLine[l] > 0),
        causes: [...g.causes.values()].sort((a, b) => b.qty - a.qty || a.cause.localeCompare(b.cause))
      }))
    };
  }

  /**
   * Date window helper for the Dashboard: the month-to-date the card needs, given what the page
   * has already loaded. -> { ym, asOf, from, to } (from..to = month start .. asOf)
   */
  function cardWindow(dateTo, today) {
    const asOf = today && dateTo > today ? today : dateTo;
    const ym = asOf.slice(0, 7);
    return { ym, asOf, from: monthStart(ym), to: asOf };
  }

  const api = {
    buildMonth, buildWeeks, weekOf, reductionGoal, topDefects, inScope, resolveOverride, dayState, cardWindow,
    util: { addDays, daysBetween, daysInMonth, monthStart, monthEnd, prevMonth, nextMonth, shortDate, monthLabel, datesBetween }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WeeklyPlanCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
