/**
 * scrap-plan-calc.js
 * ------------------------------------------------------------------
 * Pure calculations behind Plan & Tracking and Weekly Review. No
 * Firestore, no DOM — takes already-loaded scrap records and returns
 * plain objects, so the numbers can be checked against the Excel
 * workbook ("Scrap Plan & Tracking" / "Weekly Scrap Review") offline.
 *
 * Scope rule (same as the daily target rule in config.js):
 *   only records whose `line` is one of LINES (A/B/C) count; Day and
 *   Night are combined; the production `date` field decides the day.
 *
 * Weeks run Monday–Sunday and are clipped to the month, exactly like
 * the workbook (Oct 2026: W1 = 1–4, W2 = 5–11, ... W5 = 26–31).
 *
 * Exposed as window.ScrapPlanCalc (and module.exports under Node).
 * ------------------------------------------------------------------
 */

(function (root) {

  // ---- date helpers (UTC, "YYYY-MM-DD" strings) -------------------------
  function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function fmt(dt) { return dt.toISOString().slice(0, 10); }
  function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); } // b - a
  function monthStart(ym) { return ym + '-01'; }
  function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function monthEnd(ym) { return ym + '-' + String(daysInMonth(ym)).padStart(2, '0'); }
  function prevMonth(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return fmt(d).slice(0, 7); }
  function weekday(s) { return (parse(s).getUTCDay() + 6) % 7; } // Mon=0 ... Sun=6

  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(s) { const d = parse(s); return String(d.getUTCDate()).padStart(2, '0') + ' ' + SHORT_MONTHS[d.getUTCMonth()]; }
  function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return SHORT_MONTHS[m - 1] + ' ' + y; }

  // ---- scope + aggregation ---------------------------------------------
  function scopeLines() {
    return (typeof LINES !== 'undefined' ? LINES : [{ code: 'A' }, { code: 'B' }, { code: 'C' }]).map(l => l.code);
  }
  function inScope(records) {
    const lines = new Set(scopeLines());
    return records.filter(r => lines.has(r.line) && r.date && Number(r.scrapQty) > 0);
  }
  function sumRange(records, from, to) {
    let t = 0;
    records.forEach(r => { if (r.date >= from && r.date <= to) t += Number(r.scrapQty); });
    return t;
  }
  function sumByLine(records, from, to) {
    const out = {}; scopeLines().forEach(l => { out[l] = 0; });
    records.forEach(r => { if (r.date >= from && r.date <= to) out[r.line] += Number(r.scrapQty); });
    return out;
  }
  function dailyTotals(records, from, to) {
    const map = {};
    for (let d = from; d <= to; d = addDays(d, 1)) map[d] = 0;
    records.forEach(r => { if (r.date >= from && r.date <= to) map[r.date] += Number(r.scrapQty); });
    return map;
  }

  // ---- weeks -----------------------------------------------------------
  function buildWeeks(ym) {
    const weeks = []; const end = monthEnd(ym);
    let cur = null;
    for (let d = monthStart(ym); d <= end; d = addDays(d, 1)) {
      if (!cur || weekday(d) === 0) {
        cur = { index: weeks.length + 1, key: 'W' + (weeks.length + 1), start: d, end: d };
        weeks.push(cur);
      }
      cur.end = d;
    }
    weeks.forEach(w => {
      w.days = daysBetween(w.start, w.end) + 1;
      w.label = shortDate(w.start) + ' – ' + shortDate(w.end);
    });
    return weeks;
  }

  /**
   * latestDataDate(records, ym) -> the last date in the month that has any
   * in-scope scrap, or null. Used as the default "Data as of".
   */
  function latestDataDate(records, ym) {
    let best = null; const from = monthStart(ym), to = monthEnd(ym);
    inScope(records).forEach(r => { if (r.date >= from && r.date <= to && (!best || r.date > best)) best = r.date; });
    return best;
  }

  /**
   * buildPlan({ records, ym, asOf, dailyTarget, reductionGoal, overrides })
   *   records : scrap records covering at least prev month start → month end
   *   asOf    : "YYYY-MM-DD" inside the month; days after it are "not yet"
   *   overrides : { W1: 180, ... } optional weekly plan overrides (pcs)
   */
  function buildPlan({ records, ym, asOf, dailyTarget, reductionGoal, overrides }) {
    const recs = inScope(records);
    const mStart = monthStart(ym), mEnd = monthEnd(ym), nDays = daysInMonth(ym);
    if (asOf < mStart) asOf = addDays(mStart, -1);
    if (asOf > mEnd) asOf = mEnd;
    const elapsed = Math.max(0, daysBetween(mStart, asOf) + 1);

    const pm = prevMonth(ym);
    const baseline = sumRange(recs, monthStart(pm), monthEnd(pm));
    const prevSameTo = monthStart(pm).slice(0, 8) + String(Math.min(elapsed, daysInMonth(pm))).padStart(2, '0');
    const prevSamePeriod = elapsed > 0 ? sumRange(recs, monthStart(pm), prevSameTo) : 0;

    const weeks = buildWeeks(ym).map(w => {
      const baselinePlan = dailyTarget * w.days;
      const ov = overrides && Number.isFinite(overrides[w.key]) ? overrides[w.key] : null;
      const plan = ov != null ? ov : baselinePlan;
      const started = w.start <= asOf;
      const elapsedInWeek = started ? Math.min(w.days, daysBetween(w.start, asOf) + 1) : 0;
      const to = asOf < w.end ? asOf : w.end;
      const actual = started ? sumRange(recs, w.start, to) : null;
      const planToDate = plan * elapsedInWeek / w.days;
      const byLine = started ? sumByLine(recs, w.start, to) : null;
      let status = 'NOT_STARTED';
      if (started) status = actual > planToDate ? 'OVER' : 'ON_TARGET';
      return Object.assign({}, w, {
        baselinePlan, override: ov, plan, started, elapsedInWeek, actual, planToDate,
        gap: started ? actual - planToDate : null, byLine, status,
        complete: started && elapsedInWeek === w.days
      });
    });

    const mtd = elapsed > 0 ? sumRange(recs, mStart, asOf) : 0;
    const planToDate = weeks.reduce((s, w) => s + w.planToDate, 0);
    const monthlyPlan = weeks.reduce((s, w) => s + w.plan, 0);

    return {
      ym, monthLabel: monthLabel(ym), asOf, daysInMonth: nDays, daysElapsed: elapsed,
      dailyTarget, monthlyTarget: dailyTarget * nDays, monthlyPlan,
      prevMonthLabel: monthLabel(pm), baseline,
      reductionGoal, goalPcs: baseline * (1 - reductionGoal),
      mtd, planToDate, gap: mtd - planToDate,
      // Same convention as the workbook (H17/H18): previous month prorated
      // to the elapsed days (baseline x elapsed / days in prev month).
      prevProrated: baseline * elapsed / daysInMonth(pm),
      reductionPct: baseline > 0 && elapsed > 0 ? 1 - mtd / (baseline * elapsed / daysInMonth(pm)) : null,
      // Actual previous-month total over the same calendar days (1..elapsed),
      // shown alongside because seasonality inside a month can differ a lot.
      prevSamePeriod, prevSameTo,
      reductionPctActualDays: prevSamePeriod > 0 ? 1 - mtd / prevSamePeriod : null,
      projection: elapsed > 0 ? mtd / elapsed * nDays : null,
      mtdByLine: elapsed > 0 ? sumByLine(recs, mStart, asOf) : sumByLine([], mStart, mStart),
      daily: dailyTotals(recs, mStart, mEnd),
      weeks,
      status: elapsed === 0 ? 'NOT_STARTED' : (mtd > planToDate ? 'OVER' : 'ON_TARGET')
    };
  }

  /**
   * buildWeekReview({ records, plan, weekKey, topN })
   * Detail for one week of a buildPlan() result: comparison with the 7
   * days right before the week, and a Problem x Line Pareto.
   * Week-over-week change uses pcs/day so a short week (e.g. W1 = 4 days,
   * or the current week part-way through) compares fairly.
   */
  function buildWeekReview({ records, plan, weekKey, topN }) {
    const recs = inScope(records);
    const idx = plan.weeks.findIndex(w => w.key === weekKey);
    const week = plan.weeks[idx];
    if (!week) return null;
    const to = plan.asOf < week.end ? plan.asOf : week.end;
    const days = week.elapsedInWeek;
    const prevFrom = addDays(week.start, -7), prevTo = addDays(week.start, -1);
    const prevActual = sumRange(recs, prevFrom, prevTo);
    const perDay = days > 0 ? week.actual / days : null;
    const prevPerDay = prevActual / 7;

    // Problem x Line pareto for the selected week
    const groups = new Map();
    const prevGroups = new Map();
    recs.forEach(r => {
      const k = r.defectType + '|' + r.line;
      if (days > 0 && r.date >= week.start && r.date <= to) {
        if (!groups.has(k)) groups.set(k, { defectType: r.defectType, line: r.line, qty: 0, models: {}, causes: {} });
        const g = groups.get(k); const q = Number(r.scrapQty);
        g.qty += q;
        if (r.model) g.models[r.model] = (g.models[r.model] || 0) + q;
        if (r.rootCause) g.causes[r.rootCause] = (g.causes[r.rootCause] || 0) + q;
      }
      if (r.date >= prevFrom && r.date <= prevTo) prevGroups.set(k, (prevGroups.get(k) || 0) + Number(r.scrapQty));
    });
    const top = obj => { let best = null; Object.keys(obj).forEach(k => { if (!best || obj[k] > obj[best]) best = k; }); return best ? { name: best, qty: obj[best] } : null; };
    const total = week.actual || 0;
    let cum = 0;
    const pareto = [...groups.values()].sort((a, b) => b.qty - a.qty).slice(0, topN || 10).map((g, i) => {
      cum += g.qty;
      const prevQty = prevGroups.get(g.defectType + '|' + g.line) || 0;
      return {
        rank: i + 1, defectType: g.defectType, line: g.line, qty: g.qty,
        share: total > 0 ? g.qty / total : 0, cumShare: total > 0 ? cum / total : 0,
        prevQty, deltaPerDay: days > 0 ? g.qty / days - prevQty / 7 : null,
        topModel: top(g.models), topCause: top(g.causes)
      };
    });

    return {
      week, days, prevFrom, prevTo, prevActual, perDay, prevPerDay,
      changePct: perDay != null && prevPerDay > 0 ? (perDay - prevPerDay) / prevPerDay : null,
      pareto
    };
  }

  /** Per-day-average change of every week vs the week before it (W1 vs the 7 days before the month). */
  function weekOverWeek(records, plan) {
    const recs = inScope(records);
    return plan.weeks.map(w => {
      if (!w.started || w.elapsedInWeek === 0) return null;
      const prev = sumRange(recs, addDays(w.start, -7), addDays(w.start, -1));
      const perDay = w.actual / w.elapsedInWeek, prevPerDay = prev / 7;
      return { prevActual: prev, changePct: prevPerDay > 0 ? (perDay - prevPerDay) / prevPerDay : null };
    });
  }

  const api = {
    buildPlan, buildWeekReview, weekOverWeek, buildWeeks, latestDataDate,
    util: { addDays, monthStart, monthEnd, prevMonth, daysInMonth, shortDate, monthLabel, inScope }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScrapPlanCalc = api;

})(typeof window !== 'undefined' ? window : globalThis);
