/**
 * overview-page.js
 * ------------------------------------------------------------------
 * Page: Overview (index.html). One month of Door Line scrap at a
 * glance: a plain-language verdict, the day-by-day strip against the
 * daily target, scrap rate by line (production from Production V2,
 * read-only), top problems with their recorded causes, and the weekly
 * plan.
 *
 * Month/plan numbers come from ScrapPlanCalc.buildPlan, so they always
 * match Plan & Tracking and Weekly Review. Scope: LINES A/B/C, Day +
 * Night combined (same rule as the daily target).
 * ------------------------------------------------------------------
 */

(function () {
  const P = window.PlanCommon;
  const { $, fmt, fmtSigned, fmtPct, escapeHtml } = P;
  const U = () => ScrapPlanCalc.util;
  const LINE_CODES = (typeof LINES !== 'undefined' ? LINES : [{ code: 'A' }, { code: 'B' }, { code: 'C' }]).map(l => l.code);
  const SHIFT_CODES = (typeof SHIFTS !== 'undefined' ? SHIFTS : [{ code: 'DAY' }, { code: 'NIGHT' }]).map(s => s.code);
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const state = { ym: null, asOfRequested: null, data: null, prod: null, prodKey: null };

  // ---- data -------------------------------------------------------------

  async function load() {
    const problem = P.connectionProblem();
    if (problem) { P.showBanner('error', problem); $('ovVerdict').textContent = 'Not connected.'; return; }
    $('ovVerdict').textContent = 'Loading…';
    state.data = await P.loadMonth(state.ym);
    state.prod = null; state.prodKey = null;
    await compute();
  }

  /** Production for every day/line/shift from the 1st to asOf. Cached per month+asOf. */
  async function loadProduction(asOf) {
    const key = state.ym + '|' + asOf;
    if (state.prodKey === key) return state.prod;
    const dates = [];
    for (let d = U().monthStart(state.ym); d <= asOf; d = U().addDays(d, 1)) dates.push(d);
    let res = { records: [], missing: [], errors: [] };
    if (dates.length) {
      try {
        res = await ProductionDataAdapter.getProductionData(window.qdDb, { dates, lines: LINE_CODES, shifts: SHIFT_CODES });
      } catch (e) {
        res = { records: [], missing: [], errors: [{ error: e }] };
      }
    }
    const byLine = {}, byDay = {};
    LINE_CODES.forEach(l => { byLine[l] = 0; });
    res.records.forEach(r => {
      byLine[r.line] = (byLine[r.line] || 0) + r.productionQty;
      byDay[r.date] = (byDay[r.date] || 0) + r.productionQty;
    });
    state.prod = { byLine, byDay, total: Object.values(byLine).reduce((s, v) => s + v, 0), errors: res.errors.length, missing: res.missing.length };
    state.prodKey = key;
    return state.prod;
  }

  async function compute() {
    const { asOf } = P.resolveAsOf(state.data.records, state.ym, state.asOfRequested);
    const plan = ScrapPlanCalc.buildPlan({
      records: state.data.records, ym: state.ym, asOf,
      dailyTarget: P.dailyTarget(), reductionGoal: P.reductionGoal(),
      overrides: P.overridesFrom(state.data.entries)
    });
    $('fAsOf').min = U().monthStart(state.ym);
    $('fAsOf').max = U().monthEnd(state.ym);
    $('fAsOf').value = plan.asOf >= U().monthStart(state.ym) ? plan.asOf : '';

    const prod = plan.daysElapsed > 0 ? await loadProduction(plan.asOf) : { byLine: {}, byDay: {}, total: 0, errors: 0, missing: 0 };

    const msgs = [];
    if (state.data.scrapError) msgs.push('Could not read scrap data, so the numbers below are incomplete.');
    if (prod.errors) msgs.push(`Production could not be read for ${prod.errors} line-shift(s); scrap rate is left out where it would be wrong.`);
    if (state.data.planError) msgs.push('Weekly plan overrides could not be read; default plans are shown.');
    P.showBanner(state.data.scrapError || prod.errors ? 'error' : 'warn', msgs.join(' '));

    const monthRecs = U().inScope(state.data.records).filter(r => r.date >= U().monthStart(state.ym) && r.date <= plan.asOf);
    render(plan, prod, monthRecs);
  }

  // ---- render -----------------------------------------------------------

  function render(p, prod, recs) {
    const T = p.dailyTarget;
    document.querySelectorAll('.jsTarget').forEach(el => { el.textContent = T; });
    const [y, m] = state.ym.split('-').map(Number);
    const monthName = MONTH_NAMES[m - 1];
    $('ovTitle').textContent = `Door Line scrap, ${monthName} ${y}`;
    $('ovMeta').textContent = p.daysElapsed > 0
      ? `Door A + B + C · Day + Night · 1–${Number(p.asOf.slice(8))} ${monthName.slice(0, 3)}`
      : 'Door A + B + C · Day + Night · no data yet';
    $('lnkWeekly').href = `weekly-review.html?ym=${state.ym}`;

    // day classification
    const days = [];
    for (let d = U().monthStart(state.ym); d <= U().monthEnd(state.ym); d = U().addDays(d, 1)) {
      const q = p.daily[d] || 0;
      const produced = (prod.byDay[d] || 0) > 0;
      let kind = 'future';
      if (d <= p.asOf) kind = (q === 0 && !produced) ? 'none' : (q > 2 * T ? 'hot' : q > T ? 'over' : 'ok');
      days.push({ d, q, kind });
    }
    const counted = days.filter(x => x.kind !== 'future' && x.kind !== 'none');
    const overDays = counted.filter(x => x.kind === 'over' || x.kind === 'hot').length;

    renderVerdict(p, counted.length, overDays, monthName);
    renderDays(days, p);
    renderStats(p, prod, recs);
    renderChart(days, recs, T);
    renderLines(p, prod);
    renderProblems(recs, p.mtd);
    renderWeeks(p);
  }

  function renderVerdict(p, prodDays, overDays, monthName) {
    if (p.daysElapsed === 0) {
      $('ovVerdict').textContent = `${monthName} has not started yet.`;
      $('ovVerdict2').textContent = `Target is ${fmt(p.monthlyTarget)} pcs for the month (${p.dailyTarget} × ${p.daysInMonth} days).`;
      return;
    }
    const n = p.daysElapsed;
    $('ovVerdict').textContent = p.mtd > p.planToDate
      ? `${fmt(p.mtd)} pcs scrapped in ${n} day${n > 1 ? 's' : ''}, against a plan of ${fmt(p.planToDate)}.`
      : `${fmt(p.mtd)} pcs scrapped in ${n} day${n > 1 ? 's' : ''}, within the plan of ${fmt(p.planToDate)}.`;
    const ratio = p.projection / p.monthlyTarget;
    const pace = !Number.isFinite(ratio) ? '' : ratio > 1.05
      ? ` At this pace ${monthName} closes near <b class="qs-n">${fmt(p.projection)}</b> pcs, ${ratio >= 1.95 ? Math.round(ratio * 10) / 10 + '×' : Math.round((ratio - 1) * 100) + '% over'} the <b class="qs-n">${fmt(p.monthlyTarget)}</b> target.`
      : ` At this pace ${monthName} closes near <b class="qs-n">${fmt(p.projection)}</b> pcs, within the <b class="qs-n">${fmt(p.monthlyTarget)}</b> target.`;
    $('ovVerdict2').innerHTML = `${overDays} of the ${prodDays} production day${prodDays === 1 ? '' : 's'} ${overDays === 1 ? 'was' : 'were'} over ${p.dailyTarget} pcs.${pace}`;
  }

  function renderDays(days, p) {
    $('ovDays').innerHTML = days.map(x => {
      const day = Number(x.d.slice(8));
      const cls = x.kind + (x.d === p.asOf ? ' asof' : '');
      const val = x.kind === 'future' ? '' : x.kind === 'none' ? 'no record' : fmt(x.q);
      const label = x.kind === 'future' ? `${day}: not yet` : x.kind === 'none' ? `${day}: no scrap or production recorded` : `${day}: ${fmt(x.q)} pcs`;
      return `<div class="ov-day ${cls}" role="listitem" title="${label}" aria-label="${label}"><span class="d">${day}</span><span class="q">${val}</span></div>`;
    }).join('');
  }

  function renderStats(p, prod, recs) {
    if (prod.total > 0 && !prod.errors) {
      $('stRate').textContent = (p.mtd / prod.total * 100).toFixed(2) + '%';
      $('stRateSub').textContent = `${fmt(p.mtd)} of ${fmt(prod.total)} produced`
        + (prod.missing ? ` · no production log for ${prod.missing} line-shift(s), rate may read high` : '');
    } else {
      $('stRate').textContent = '–';
      $('stRateSub').textContent = prod.errors ? 'production could not be read' : 'no production recorded yet';
    }
    $('stGap').textContent = p.daysElapsed ? fmtSigned(p.gap) : '–';
    $('stGap').className = 'v ' + (p.gap > 0 ? 'qs-red' : 'qs-green');
    $('stGapSub').textContent = `plan to date ${fmt(p.planToDate)}`;

    const prevName = p.prevMonthLabel.split(' ')[0];
    $('stPrevLabel').textContent = `vs ${prevName} pace`;
    if (Number.isFinite(p.reductionPct)) {
      $('stPrev').textContent = fmtPct(-p.reductionPct, 0);
      $('stPrev').className = 'v ' + (p.reductionPct >= p.reductionGoal ? 'qs-green' : 'qs-red');
      $('stPrevSub').textContent = `goal −${Math.round(p.reductionGoal * 100)}% (${prevName} ${fmt(p.baseline)} pcs)`;
    } else {
      $('stPrev').textContent = '–'; $('stPrev').className = 'v';
      $('stPrevSub').textContent = `no ${prevName} data`;
    }

    const withCost = recs.filter(r => Number.isFinite(r.scrapCost) && r.scrapCost > 0);
    if (withCost.length) {
      const sum = withCost.reduce((s, r) => s + r.scrapCost, 0);
      $('stCost').textContent = sum >= 1e6 ? '฿' + (sum / 1e6).toFixed(2) + 'M' : '฿' + fmt(sum);
      $('stCostSub').textContent = withCost.length === recs.length ? 'sum of Amt. on scrap records' : `${fmt(withCost.length)} of ${fmt(recs.length)} records have a value`;
    } else {
      $('stCost').textContent = '–';
      $('stCostSub').textContent = 'only imported records carry a value';
    }
  }

  function renderChart(days, recs, T) {
    const shown = days.filter(x => x.kind !== 'future');
    if (!shown.length) { $('ovChart').innerHTML = '<div class="ov-empty">No days yet.</div>'; return; }
    const byDayLine = {};
    recs.forEach(r => {
      const k = r.date; byDayLine[k] = byDayLine[k] || {};
      byDayLine[k][r.line] = (byDayLine[k][r.line] || 0) + Number(r.scrapQty);
    });
    const max = Math.max(T * 1.2, ...shown.map(x => x.q));
    const k = 170 / max; // px per pc; leaves room for the total label
    const cls = { A: 'qs-la', B: 'qs-lb', C: 'qs-lc' };
    const cols = [], xs = [];
    shown.forEach(x => {
      const day = Number(x.d.slice(8));
      xs.push(`<span class="x">${day}</span>`);
      if (x.kind === 'none') { cols.push(`<div class="ov-col"><span class="gap" title="${day}: no record">—</span></div>`); return; }
      const parts = LINE_CODES.slice().reverse().map(l => {
        const v = (byDayLine[x.d] || {})[l] || 0;
        return v ? `<div class="${cls[l] || 'qs-lb'}" style="height:${Math.max(1, v * k).toFixed(1)}px"></div>` : '';
      }).join('');
      const tip = `${day}: ` + LINE_CODES.map(l => `${l} ${(byDayLine[x.d] || {})[l] || 0}`).join(', ');
      cols.push(`<div class="ov-col" title="${tip}"><span class="t">${fmt(x.q)}</span>${parts}</div>`);
    });
    $('ovChart').innerHTML = `<div class="ov-plot" role="img" aria-label="Daily scrap by line">
        <div class="ov-target" style="bottom:${(T * k).toFixed(1)}px" aria-hidden="true"></div>${cols.join('')}</div>
      <div class="ov-xrow" aria-hidden="true">${xs.join('')}</div>`;
  }

  function renderLines(p, prod) {
    const total = p.mtd;
    const rows = LINE_CODES.map(l => {
      const s = p.mtdByLine[l] || 0, pr = prod.byLine[l] || 0;
      return { l, s, pr, rate: pr > 0 && !prod.errors ? s / pr : null, share: total > 0 ? s / total : null };
    });
    const rated = rows.filter(r => r.rate != null);
    const worst = rated.length ? rated.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
    const most = rows.reduce((a, b) => (b.s > a.s ? b : a));
    const cls = { A: 'qs-la', B: 'qs-lb', C: 'qs-lc' };
    $('ovLines').querySelector('tbody').innerHTML = rows.map(r => `
      <tr><td><span class="qs-key ${cls[r.l] || ''}"></span>${escapeHtml(P.lineLabel(r.l))}</td>
      <td class="r qs-n">${r === most && total > 0 ? '<b>' + fmt(r.s) + '</b>' : fmt(r.s)}</td>
      <td class="r qs-n">${r.pr ? fmt(r.pr) : '–'}</td>
      <td class="r qs-n${r === worst ? ' qs-red' : ''}">${r.rate != null ? (r === worst ? '<b>' : '') + (r.rate * 100).toFixed(2) + '%' + (r === worst ? '</b>' : '') : '–'}</td>
      <td class="r qs-n">${r.share != null ? Math.round(r.share * 100) + '%' : '–'}</td></tr>`).join('') + `
      <tr class="tot"><td>Total</td><td class="r qs-n">${fmt(total)}</td><td class="r qs-n">${prod.total ? fmt(prod.total) : '–'}</td>
      <td class="r qs-n">${prod.total && !prod.errors ? (total / prod.total * 100).toFixed(2) + '%' : '–'}</td><td></td></tr>`;
    $('ovLinesNote').textContent = total === 0 ? '' :
      worst && worst !== most
        ? `${P.lineLabel(worst.l)} has the worst rate; ${P.lineLabel(most.l)} has the most pieces.`
        : `${P.lineLabel(most.l)} has both the most pieces and ${worst ? 'the worst rate' : 'the largest share'}.`;
  }

  function renderProblems(recs, mtd) {
    const g = new Map();
    recs.forEach(r => {
      const k = r.defectType || '(blank)';
      if (!g.has(k)) g.set(k, { name: k, qty: 0, lines: {}, causes: {} });
      const x = g.get(k), q = Number(r.scrapQty);
      x.qty += q;
      x.lines[r.line] = (x.lines[r.line] || 0) + q;
      if (r.rootCause) x.causes[r.rootCause] = (x.causes[r.rootCause] || 0) + q;
    });
    const top = [...g.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    const tbody = $('ovProblems').querySelector('tbody');
    if (!top.length) { tbody.innerHTML = '<tr class="empty"><td colspan="4">No scrap recorded yet.</td></tr>'; return; }
    const max = top[0].qty;
    tbody.innerHTML = top.map(x => {
      const line = Object.entries(x.lines).sort((a, b) => b[1] - a[1])[0];
      const causes = Object.entries(x.causes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, q]) => `${escapeHtml(c)} ${fmt(q)}`).join(' · ');
      return `<tr>
        <td><b>${escapeHtml(x.name)}</b><div class="qs-mute" style="font-size:12px">${causes || 'no cause recorded'}</div></td>
        <td>${escapeHtml(P.lineLabel(line[0]))} <span class="qs-mute qs-n">${fmt(line[1])}</span></td>
        <td class="r"><span class="qs-n">${fmt(x.qty)}</span><div class="qs-bar" style="margin:6px 0 0 auto;width:110px"><i style="width:${(x.qty / max * 100).toFixed(0)}%"></i></div></td>
        <td class="r qs-n qs-mute">${mtd > 0 ? Math.round(x.qty / mtd * 100) + '%' : '–'}</td></tr>`;
    }).join('');
  }

  function renderWeeks(p) {
    const chip = s => `<span class="qs-chip ${s === 'OVER' ? 'over' : s === 'ON_TARGET' ? 'ok' : 'idle'}">${P.STATUS_TEXT[s]}</span>`;
    const rows = p.weeks.map(w => {
      const partial = w.started && !w.complete ? ` <span class="qs-mute" style="font-size:12px">(${w.elapsedInWeek} of ${w.days} days)</span>` : '';
      const label = `<a href="weekly-review.html?ym=${state.ym}&week=${w.key}"><b>${w.key}</b></a> <span class="qs-mute">${escapeHtml(w.label)}</span>${partial}`;
      if (!w.started) return `<tr><td>${label}</td><td class="r qs-n">${fmt(w.plan)}</td><td class="r qs-n qs-mute">–</td><td class="r qs-n qs-mute">–</td><td>${chip(w.status)}</td></tr>`;
      return `<tr><td>${label}</td><td class="r qs-n">${fmt(w.plan)}</td><td class="r qs-n">${fmt(w.actual)}</td>
        <td class="r qs-n ${w.gap > 0 ? 'qs-red' : 'qs-green'}">${fmtSigned(w.gap)}</td><td>${chip(w.status)}</td></tr>`;
    }).join('');
    $('ovWeeks').querySelector('tbody').innerHTML = rows + `
      <tr class="tot"><td>${escapeHtml(p.monthLabel)}</td><td class="r qs-n">${fmt(p.monthlyPlan)}</td>
      <td class="r qs-n">${p.daysElapsed ? fmt(p.mtd) : '–'}</td>
      <td class="r qs-n ${p.gap > 0 ? 'qs-red' : 'qs-green'}">${p.daysElapsed ? fmtSigned(p.gap) : '–'}</td><td>${chip(p.status)}</td></tr>`;
  }

  // ---- controls -----------------------------------------------------------

  function init() {
    const prm = P.readParams();
    state.ym = prm.ym; state.asOfRequested = prm.asOf;
    $('fMonth').value = state.ym;
    $('fMonth').addEventListener('change', () => {
      if (!/^\d{4}-\d{2}$/.test($('fMonth').value)) return;
      state.ym = $('fMonth').value; state.asOfRequested = null;
      P.writeParams({ ym: state.ym, asOf: null }); load();
    });
    $('fAsOf').addEventListener('change', () => {
      const v = $('fAsOf').value;
      if (!v || v.slice(0, 7) !== state.ym) return;
      state.asOfRequested = v; P.writeParams({ asOf: v }); compute();
    });
    $('btnLatest').addEventListener('click', () => { state.asOfRequested = null; P.writeParams({ asOf: null }); if (state.data) compute(); });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
