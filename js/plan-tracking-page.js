/**
 * plan-tracking-page.js
 * ------------------------------------------------------------------
 * Page: Scrap Plan & Tracking (plan-tracking.html). Web version of the
 * "Scrap Plan & Tracking" sheet: month target, MTD vs plan, a daily
 * calendar, cumulative chart, line split and the weekly control table
 * with per-week plan overrides (saved to scrapWeeklyPlans).
 *
 * All numbers come from ScrapPlanCalc.buildPlan — this file only renders.
 * ------------------------------------------------------------------
 */

(function () {
  const P = window.PlanCommon;
  const { $, fmt, fmtSigned, fmtPct, escapeHtml } = P;

  const state = { ym: null, asOfRequested: null, data: null, plan: null, chart: null };

  // ---- load + compute ---------------------------------------------------

  async function load() {
    const problem = P.connectionProblem();
    if (problem) { P.showBanner('error', problem); return; }
    $('targetStrip').textContent = 'Loading…';
    state.data = await P.loadMonth(state.ym);
    const msgs = [];
    if (state.data.scrapError) msgs.push('Could not read scrap data — numbers below are incomplete (' + (state.data.scrapError.message || state.data.scrapError) + ').');
    if (state.data.planError) msgs.push('Weekly plan overrides could not be read, so default plans are shown. Check that scrapWeeklyPlans is allowed in Firestore rules.');
    P.showBanner(state.data.scrapError ? 'error' : 'warn', msgs.join(' '));
    compute();
  }

  function compute() {
    const { asOf, auto } = P.resolveAsOf(state.data.records, state.ym, state.asOfRequested);
    state.plan = ScrapPlanCalc.buildPlan({
      records: state.data.records, ym: state.ym, asOf,
      dailyTarget: P.dailyTarget(), reductionGoal: P.reductionGoal(),
      overrides: P.overridesFrom(state.data.entries)
    });
    $('fAsOf').min = ScrapPlanCalc.util.monthStart(state.ym);
    $('fAsOf').max = ScrapPlanCalc.util.monthEnd(state.ym);
    $('fAsOf').value = state.plan.asOf >= ScrapPlanCalc.util.monthStart(state.ym) ? state.plan.asOf : '';
    $('asOfHint').textContent = auto ? 'Latest day with scrap data' : 'Set manually';
    render();
  }

  // ---- render -----------------------------------------------------------

  function setKpi(id, cls) {
    const el = $(id);
    el.classList.remove('is-bad', 'is-good', 'is-neutral', 'is-info');
    el.classList.add(cls);
  }

  function render() {
    const p = state.plan;
    $('hdrDailyTarget').textContent = p.dailyTarget;

    $('targetStrip').innerHTML = [
      `${escapeHtml(p.prevMonthLabel)} scrap <b>${fmt(p.baseline)}</b> pcs`,
      `Reduction goal <b>${Math.round(p.reductionGoal * 100)}%</b> (≈ <b>${fmt(p.goalPcs)}</b> pcs)`,
      `Daily target <b>≤ ${fmt(p.dailyTarget)}</b>`,
      `${escapeHtml(p.monthLabel)} target <b>${fmt(p.monthlyTarget)}</b> pcs (${p.dailyTarget} × ${p.daysInMonth} days)`,
      p.monthlyPlan !== p.monthlyTarget ? `Weekly plans add up to <b>${fmt(p.monthlyPlan)}</b>` : '',
      `Day <b>${p.daysElapsed}</b> of ${p.daysInMonth}`
    ].filter(Boolean).map(s => `<span>${s}</span>`).join('');

    const started = p.daysElapsed > 0;
    const over = p.status === 'OVER';

    $('kpiMtdVal').textContent = started ? fmt(p.mtd) : '–';
    $('kpiMtdVal').className = 'qd-kpi-value' + (started ? (over ? ' pr-kpi-value-bad' : ' pr-kpi-value-good') : '');
    $('kpiMtdNote').innerHTML = started ? P.statusChip(p.status) : 'No days elapsed yet';
    setKpi('kpiMtd', started ? (over ? 'is-bad' : 'is-good') : 'is-neutral');

    $('kpiPlanVal').textContent = fmt(p.planToDate);
    $('kpiPlanNote').textContent = `of ${fmt(p.monthlyPlan)} for the month`;

    $('kpiGapVal').textContent = started ? fmtSigned(p.gap) : '–';
    $('kpiGapNote').textContent = started ? (p.gap > 0 ? 'Above plan to date' : 'Below plan to date') : '';
    setKpi('kpiGap', started ? (p.gap > 0 ? 'is-bad' : 'is-good') : 'is-neutral');

    const red = p.reductionPct;
    // Shown as the change in scrap: −42% means 42% less scrap than last month.
    $('kpiRedVal').textContent = Number.isFinite(red) ? fmtPct(-red) : '–';
    $('kpiRedUnit').textContent = `scrap change · goal −${Math.round(p.reductionGoal * 100)}%`;
    $('kpiRedNote').textContent = Number.isFinite(red)
      ? `vs ${p.prevMonthLabel} pro-rated ${fmt(p.prevProrated)} pcs · same days actual ${fmt(p.prevSamePeriod)} (${fmtPct(-p.reductionPctActualDays)})`
      : 'No previous-month data';
    setKpi('kpiRed', !Number.isFinite(red) ? 'is-neutral' : red >= p.reductionGoal ? 'is-good' : 'is-bad');

    $('kpiProjVal').textContent = Number.isFinite(p.projection) ? fmt(p.projection) : '–';
    $('kpiProjNote').textContent = Number.isFinite(p.projection) ? `at the current pace · target ${fmt(p.monthlyTarget)}` : '';
    setKpi('kpiProj', !Number.isFinite(p.projection) ? 'is-neutral' : p.projection > p.monthlyTarget ? 'is-bad' : 'is-good');

    renderCalendar(p);
    renderChart(p);
    renderLines(p);
    renderWeeks(p);
  }

  function renderCalendar(p) {
    const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="pr-cal-head">${d}</div>`).join('')
      + '<div class="pr-cal-head week">Week</div>';
    let html = heads;
    const T = p.dailyTarget;
    p.weeks.forEach(w => {
      // leading blanks for a week that starts mid-week (W1)
      const firstDow = (new Date(w.start + 'T00:00:00Z').getUTCDay() + 6) % 7;
      for (let i = 0; i < firstDow; i++) html += '<div class="pr-day out"></div>';
      for (let i = 0; i < w.days; i++) {
        const d = ScrapPlanCalc.util.addDays(w.start, i);
        const day = Number(d.slice(8));
        const q = p.daily[d] || 0;
        let cls = 'future', val = '·';
        if (d <= p.asOf) { cls = q > 2 * T ? 'hot' : q > T ? 'over' : 'ok'; val = fmt(q); }
        if (d === p.asOf) cls += ' asof';
        html += `<div class="pr-day ${cls}" title="${d}: ${d <= p.asOf ? fmt(q) + ' pcs' : 'not yet'}"><span class="d">${day}</span><span class="q">${val}</span></div>`;
      }
      const trailing = 7 - firstDow - w.days;
      for (let i = 0; i < trailing; i++) html += '<div class="pr-day out"></div>';
      const wcls = w.status === 'OVER' ? 'bad' : w.status === 'ON_TARGET' ? 'good' : 'neutral';
      const href = `weekly-review.html?ym=${state.ym}&week=${w.key}${state.asOfRequested ? '&asOf=' + state.asOfRequested : ''}`;
      html += `<a class="pr-week ${wcls}" href="${href}" style="text-decoration:none">
        <span class="k">${w.key} · ${P.STATUS_TEXT[w.status]}</span>
        <span class="v">${w.started ? fmt(w.actual) : '–'} <small>/ ${fmt(w.started ? w.planToDate : w.plan)}</small></span>
      </a>`;
    });
    $('calendar').innerHTML = html;
  }

  function renderChart(p) {
    if (typeof Chart === 'undefined') return;
    const labels = [], actual = [], plan = [];
    let runA = 0, runP = 0;
    p.weeks.forEach(w => {
      for (let i = 0; i < w.days; i++) {
        const d = ScrapPlanCalc.util.addDays(w.start, i);
        labels.push(Number(d.slice(8)));
        runP += w.plan / w.days;
        plan.push(Math.round(runP));
        if (d <= p.asOf) { runA += p.daily[d] || 0; actual.push(runA); } else actual.push(null);
      }
    });
    const css = getComputedStyle(document.documentElement);
    const red = css.getPropertyValue('--red').trim() || '#DC2626';
    const navy = css.getPropertyValue('--navy').trim() || '#0B2540';
    const muted = css.getPropertyValue('--muted').trim() || '#64748B';
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('cumChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Actual (cumulative)', data: actual, borderColor: p.status === 'OVER' ? red : navy, backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 0, tension: 0.15 },
          { label: 'Plan (cumulative)', data: plan, borderColor: muted, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } } },
        scales: {
          x: { title: { display: true, text: 'Day of month' }, grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: 'pcs' } }
        }
      }
    });
  }

  function renderLines(p) {
    const entries = Object.keys(p.mtdByLine).map(code => ({ code, qty: p.mtdByLine[code] }));
    const total = entries.reduce((s, e) => s + e.qty, 0);
    const max = Math.max(1, ...entries.map(e => e.qty));
    $('linesNote').textContent = p.daysElapsed > 0 ? `${p.daysElapsed} days · avg ${fmt(total / p.daysElapsed)} pcs/day across all lines` : '';
    $('linesTable').innerHTML = entries.map(e => `
      <tr>
        <td style="width:70px"><b>${escapeHtml(P.lineLabel(e.code))}</b></td>
        <td><div class="bar" style="width:${(e.qty / max * 100).toFixed(1)}%"></div></td>
        <td class="num" style="width:60px">${fmt(e.qty)}</td>
        <td class="num pr-muted" style="width:56px">${total > 0 ? (e.qty / total * 100).toFixed(0) + '%' : '–'}</td>
      </tr>`).join('') + `
      <tr><td><b>Total</b></td><td></td><td class="num"><b>${fmt(total)}</b></td><td></td></tr>`;
  }

  function renderWeeks(p) {
    const rows = p.weeks.map(w => `
      <tr>
        <td><a class="pr-week-link" href="weekly-review.html?ym=${state.ym}&week=${w.key}">${w.key}</a></td>
        <td>${escapeHtml(w.label)}</td>
        <td class="num">${w.days}</td>
        <td class="num">${fmt(w.baselinePlan)}</td>
        <td class="num">
          <input class="pr-plan-input" type="number" min="0" step="1" inputmode="numeric"
                 data-week="${w.key}" value="${w.override != null ? w.override : ''}" placeholder="${w.baselinePlan}"
                 aria-label="Plan for ${w.key}">
          <span class="pr-save-state" id="save_${w.key}"></span>
        </td>
        <td class="num"><b>${fmt(w.plan)}</b></td>
        <td class="num">${w.started ? fmt(w.actual) : '–'}</td>
        <td class="num">${w.started ? fmt(w.planToDate) : '–'}</td>
        <td class="num ${w.started && w.gap > 0 ? 'pr-up' : w.started ? 'pr-down' : ''}">${w.started ? fmtSigned(w.gap) : '–'}</td>
        <td>${P.statusChip(w.status)}${w.started && !w.complete ? ` <span class="pr-muted" style="font-size:11px">${w.elapsedInWeek}/${w.days} days</span>` : ''}</td>
      </tr>`).join('');
    const total = `
      <tr class="pr-total">
        <td>Month</td><td>${escapeHtml(p.monthLabel)}</td><td class="num">${p.daysInMonth}</td>
        <td class="num">${fmt(p.monthlyTarget)}</td><td></td><td class="num">${fmt(p.monthlyPlan)}</td>
        <td class="num">${p.daysElapsed > 0 ? fmt(p.mtd) : '–'}</td><td class="num">${fmt(p.planToDate)}</td>
        <td class="num ${p.gap > 0 ? 'pr-up' : 'pr-down'}">${p.daysElapsed > 0 ? fmtSigned(p.gap) : '–'}</td>
        <td>${P.statusChip(p.status)}</td>
      </tr>`;
    $('weeksTable').querySelector('tbody').innerHTML = rows + total;
    $('weeksTable').querySelectorAll('.pr-plan-input').forEach(inp => inp.addEventListener('change', onPlanChange));
  }

  async function onPlanChange(ev) {
    const inp = ev.target, week = inp.dataset.week, msg = $('save_' + week);
    const raw = inp.value.trim();
    const value = raw === '' ? null : Number(raw);
    if (value !== null && !(Number.isFinite(value) && value >= 0)) { msg.className = 'pr-save-state err'; msg.textContent = 'Enter 0 or more'; return; }
    msg.className = 'pr-save-state'; msg.textContent = 'Saving…';
    try {
      await ScrapPlanAdapter.saveWeek(window.qdDb, state.ym, week, { planOverride: value });
      state.data.entries[week] = Object.assign({}, state.data.entries[week], { planOverride: value });
      compute();
      const m = $('save_' + week); if (m) { m.className = 'pr-save-state ok'; m.textContent = value === null ? 'Using default' : 'Saved'; }
    } catch (e) {
      console.error(e);
      msg.className = 'pr-save-state err';
      msg.textContent = /permission/i.test(e && e.message) ? 'Not saved: Firestore rules block scrapWeeklyPlans' : 'Not saved: ' + (e.message || e);
    }
  }

  // ---- controls -------------------------------------------------------------

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
      if (!v || v.slice(0, 7) !== state.ym) { $('fAsOf').value = state.plan ? state.plan.asOf : ''; return; }
      state.asOfRequested = v; P.writeParams({ asOf: v }); compute();
    });
    $('btnLatest').addEventListener('click', () => { state.asOfRequested = null; P.writeParams({ asOf: null }); if (state.data) compute(); });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
