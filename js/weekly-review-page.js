/**
 * weekly-review-page.js
 * ------------------------------------------------------------------
 * Page: Weekly Scrap Review (weekly-review.html). Web version of the
 * "Weekly Scrap Review" sheet: selected-week result vs plan, change vs
 * the previous 7 days, Problem x Line top 10, and a week-by-week table
 * with a review note per week (saved to scrapWeeklyPlans).
 *
 * Numbers come from ScrapPlanCalc (buildPlan / buildWeekReview /
 * weekOverWeek) — this file only renders and saves notes.
 * ------------------------------------------------------------------
 */

(function () {
  const P = window.PlanCommon;
  const { $, fmt, fmtSigned, fmtPct, fmtShare, escapeHtml } = P;
  const lineCodes = () => (typeof LINES !== 'undefined' ? LINES : []).map(l => l.code);

  const state = { ym: null, asOfRequested: null, week: null, data: null, plan: null, chart: null };

  async function load() {
    const problem = P.connectionProblem();
    if (problem) { P.showBanner('error', problem); return; }
    state.data = await P.loadMonth(state.ym);
    const msgs = [];
    if (state.data.scrapError) msgs.push('Could not read scrap data — numbers below are incomplete (' + (state.data.scrapError.message || state.data.scrapError) + ').');
    if (state.data.planError) msgs.push('Weekly plans and review notes could not be read. Check that scrapWeeklyPlans is allowed in Firestore rules.');
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
    const p = state.plan;
    $('fAsOf').min = ScrapPlanCalc.util.monthStart(state.ym);
    $('fAsOf').max = ScrapPlanCalc.util.monthEnd(state.ym);
    $('fAsOf').value = p.asOf >= ScrapPlanCalc.util.monthStart(state.ym) ? p.asOf : '';
    $('asOfHint').textContent = auto ? 'Latest day with scrap data' : 'Set manually';

    // default week = the week containing "as of" (or the last started week)
    if (!state.week || !p.weeks.some(w => w.key === state.week)) {
      const cur = p.weeks.find(w => w.start <= p.asOf && p.asOf <= w.end) || [...p.weeks].reverse().find(w => w.started) || p.weeks[0];
      state.week = cur.key;
    }
    $('fWeek').innerHTML = p.weeks.map(w => `<option value="${w.key}"${w.key === state.week ? ' selected' : ''}>${w.key} · ${escapeHtml(w.label)}</option>`).join('');
    render();
  }

  function setKpi(id, cls) {
    const el = $(id);
    el.classList.remove('is-bad', 'is-good', 'is-neutral', 'is-info');
    el.classList.add(cls);
  }

  function render() {
    const p = state.plan;
    const rv = ScrapPlanCalc.buildWeekReview({ records: state.data.records, plan: p, weekKey: state.week, topN: 10 });
    const w = rv.week;
    $('hdrSub').textContent = `${w.key} · ${w.label} ${p.monthLabel.slice(-4)} · Door A + B + C, Day and Night combined.`;

    if (!w.started) {
      ['kpiActVal', 'kpiPtdVal', 'kpiGapVal', 'kpiChgVal'].forEach(id => { $(id).textContent = '–'; });
      ['kpiActNote', 'kpiGapNote', 'kpiChgNote'].forEach(id => { $(id).textContent = ''; });
      $('kpiPtdNote').textContent = `Weekly plan ${fmt(w.plan)} pcs`;
      $('kpiStatusVal').innerHTML = P.statusChip('NOT_STARTED');
      $('kpiStatusNote').textContent = `Starts ${w.label.split(' – ')[0]}`;
      ['kpiAct', 'kpiGap', 'kpiChg', 'kpiStatus'].forEach(id => setKpi(id, 'is-neutral'));
    } else {
      const over = w.status === 'OVER';
      $('kpiActVal').textContent = fmt(w.actual);
      $('kpiActVal').className = 'qd-kpi-value ' + (over ? 'pr-kpi-value-bad' : 'pr-kpi-value-good');
      $('kpiActUnit').textContent = `pcs · ${fmt(rv.perDay)} per day`;
      $('kpiActNote').textContent = lineCodes().map(c => `${c} ${fmt(w.byLine[c])}`).join('  |  ');
      setKpi('kpiAct', over ? 'is-bad' : 'is-good');

      $('kpiPtdVal').textContent = fmt(w.planToDate);
      $('kpiPtdNote').textContent = w.complete ? `Full week plan (${w.days} days)` : `${fmt(w.plan)} for the week, pro-rated to ${w.elapsedInWeek} of ${w.days} days`;

      $('kpiGapVal').textContent = fmtSigned(w.gap);
      $('kpiGapNote').textContent = w.gap > 0 ? 'Above plan' : 'Within plan';
      setKpi('kpiGap', w.gap > 0 ? 'is-bad' : 'is-good');

      $('kpiChgVal').textContent = fmtPct(rv.changePct);
      $('kpiChgNote').textContent = `${fmt(rv.perDay)}/day now vs ${fmt(rv.prevPerDay)}/day (${fmt(rv.prevActual)} pcs, ${ScrapPlanCalc.util.shortDate(rv.prevFrom)} – ${ScrapPlanCalc.util.shortDate(rv.prevTo)})`;
      setKpi('kpiChg', !Number.isFinite(rv.changePct) ? 'is-neutral' : rv.changePct > 0 ? 'is-bad' : 'is-good');

      $('kpiStatusVal').innerHTML = P.statusChip(w.status);
      $('kpiStatusNote').textContent = `${w.elapsedInWeek} of ${w.days} days elapsed`;
      setKpi('kpiStatus', over ? 'is-bad' : 'is-good');
    }

    renderLines(w);
    renderPareto(rv);
    renderWeeks(p);
  }

  function renderLines(w) {
    if (!w.started) { $('linesTable').innerHTML = ''; $('linesNote').textContent = 'No data yet for this week.'; return; }
    const codes = lineCodes();
    const max = Math.max(1, ...codes.map(c => w.byLine[c]));
    $('linesNote').textContent = `${w.elapsedInWeek} day${w.elapsedInWeek > 1 ? 's' : ''} of data`;
    $('linesTable').innerHTML = codes.map(c => `
      <tr>
        <td style="width:70px"><b>${escapeHtml(P.lineLabel(c))}</b></td>
        <td><div class="bar" style="width:${(w.byLine[c] / max * 100).toFixed(1)}%"></div></td>
        <td class="num" style="width:60px">${fmt(w.byLine[c])}</td>
        <td class="num pr-muted" style="width:56px">${w.actual > 0 ? (w.byLine[c] / w.actual * 100).toFixed(0) + '%' : '–'}</td>
      </tr>`).join('') + `<tr><td><b>Total</b></td><td></td><td class="num"><b>${fmt(w.actual)}</b></td><td></td></tr>`;
  }

  function renderPareto(rv) {
    const rows = rv.pareto;
    $('paretoNote').textContent = rows.length
      ? `Top ${rows.length} Problem × Line make up ${fmtShare(rows[rows.length - 1].cumShare)} of this week's scrap.`
      : 'No scrap recorded for this week yet.';

    const tbody = $('paretoTable').querySelector('tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No scrap recorded for this week yet.</td></tr>';
    } else {
      tbody.innerHTML = rows.map(r => {
        const d = r.deltaPerDay;
        const impHref = `improvement.html?new=1&problem=${encodeURIComponent(r.defectType + ' — ' + P.lineLabel(r.line))}&defectType=${encodeURIComponent(r.defectType)}&line=${encodeURIComponent(r.line)}${r.topModel ? '&model=' + encodeURIComponent(r.topModel.name) : ''}`;
        return `<tr>
          <td class="num">${r.rank}</td>
          <td><b>${escapeHtml(r.defectType)}</b></td>
          <td>${escapeHtml(P.lineLabel(r.line))}</td>
          <td class="num">${fmt(r.qty)}</td>
          <td class="num"><span class="pr-share"><span class="bar" style="width:${Math.max(2, r.share * 60).toFixed(0)}px"></span>${fmtShare(r.share)}</span></td>
          <td class="num pr-muted">${fmtShare(r.cumShare)}</td>
          <td class="num">${fmt(r.prevQty)}</td>
          <td class="num ${d > 0 ? 'pr-up' : d < 0 ? 'pr-down' : ''}">${Number.isFinite(d) ? (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1) : '–'}</td>
          <td>${r.topModel ? escapeHtml(r.topModel.name) + ` <span class="pr-muted">(${fmt(r.topModel.qty)})</span>` : '<span class="pr-muted">–</span>'}</td>
          <td class="pr-cause">${r.topCause ? escapeHtml(r.topCause.name) + ` (${fmt(r.topCause.qty)})` : '<span class="pr-muted">–</span>'}</td>
          <td><a class="qd-link-btn" href="${impHref}">+ Improvement</a></td>
        </tr>`;
      }).join('');
    }

    if (typeof Chart === 'undefined') return;
    const css = getComputedStyle(document.documentElement);
    const navy = css.getPropertyValue('--navy-2').trim() || '#123258';
    const amber = css.getPropertyValue('--amber').trim() || '#F59E0B';
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('paretoChart'), {
      data: {
        labels: rows.map(r => `${r.defectType} (${r.line})`),
        datasets: [
          { type: 'bar', label: 'Scrap (pcs)', data: rows.map(r => r.qty), backgroundColor: navy, borderRadius: 4, yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Cumulative %', data: rows.map(r => +(r.cumShare * 100).toFixed(1)), borderColor: amber, backgroundColor: amber, pointRadius: 3, borderWidth: 2, yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10.5 }, maxRotation: 50, minRotation: 30 } },
          y: { beginAtZero: true, title: { display: true, text: 'pcs' } },
          y1: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { callback: v => v + '%' } }
        }
      }
    });
  }

  function renderWeeks(p) {
    const wow = ScrapPlanCalc.weekOverWeek(state.data.records, p);
    const codes = lineCodes();
    const rows = p.weeks.map((w, i) => {
      const note = (state.data.entries[w.key] && state.data.entries[w.key].reviewNote) || '';
      const c = wow[i];
      return `<tr class="${w.key === state.week ? 'pr-selected' : ''}">
        <td><a class="pr-week-link" href="#" data-pick="${w.key}">${w.key}</a></td>
        <td>${escapeHtml(w.label)}</td>
        <td class="num">${fmt(w.plan)}</td>
        <td class="num">${w.started ? fmt(w.actual) : '–'}</td>
        <td class="num">${w.started ? fmt(w.planToDate) : '–'}</td>
        <td class="num ${w.started && w.gap > 0 ? 'pr-up' : w.started ? 'pr-down' : ''}">${w.started ? fmtSigned(w.gap) : '–'}</td>
        <td class="num ${c && c.changePct > 0 ? 'pr-up' : c && c.changePct < 0 ? 'pr-down' : ''}">${c ? fmtPct(c.changePct) : '–'}</td>
        ${codes.map(code => `<td class="num">${w.started ? fmt(w.byLine[code]) : '–'}</td>`).join('')}
        <td>${P.statusChip(w.status)}</td>
        <td>
          <textarea class="pr-note" data-week="${w.key}" rows="1" aria-label="Review note for ${w.key}" placeholder="Decision / next action">${escapeHtml(note)}</textarea>
          <span class="pr-save-state" id="note_${w.key}"></span>
        </td>
      </tr>`;
    }).join('');
    const total = `<tr class="pr-total">
      <td>Month</td><td>${escapeHtml(p.monthLabel)}</td><td class="num">${fmt(p.monthlyPlan)}</td>
      <td class="num">${p.daysElapsed ? fmt(p.mtd) : '–'}</td><td class="num">${fmt(p.planToDate)}</td>
      <td class="num ${p.gap > 0 ? 'pr-up' : 'pr-down'}">${p.daysElapsed ? fmtSigned(p.gap) : '–'}</td><td></td>
      ${codes.map(code => `<td class="num">${fmt(p.mtdByLine[code])}</td>`).join('')}
      <td>${P.statusChip(p.status)}</td><td></td></tr>`;
    const tbody = $('weeksTable').querySelector('tbody');
    tbody.innerHTML = rows + total;
    tbody.querySelectorAll('[data-pick]').forEach(a => a.addEventListener('click', ev => {
      ev.preventDefault(); selectWeek(a.dataset.pick); window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    tbody.querySelectorAll('.pr-note').forEach(t => {
      t.dataset.saved = t.value;
      t.addEventListener('blur', onNoteBlur);
    });
  }

  async function onNoteBlur(ev) {
    const t = ev.target, week = t.dataset.week, msg = $('note_' + week);
    if (t.value === t.dataset.saved) return;
    msg.className = 'pr-save-state'; msg.textContent = 'Saving…';
    try {
      await ScrapPlanAdapter.saveWeek(window.qdDb, state.ym, week, { reviewNote: t.value });
      t.dataset.saved = t.value;
      state.data.entries[week] = Object.assign({}, state.data.entries[week], { reviewNote: t.value });
      msg.className = 'pr-save-state ok'; msg.textContent = 'Saved';
    } catch (e) {
      console.error(e);
      msg.className = 'pr-save-state err';
      msg.textContent = /permission/i.test(e && e.message) ? 'Not saved: Firestore rules block scrapWeeklyPlans' : 'Not saved: ' + (e.message || e);
    }
  }

  function selectWeek(key) {
    state.week = key; $('fWeek').value = key;
    P.writeParams({ week: key }); render();
  }

  function init() {
    const prm = P.readParams();
    state.ym = prm.ym; state.asOfRequested = prm.asOf; state.week = prm.week;
    $('fMonth').value = state.ym;
    $('fMonth').addEventListener('change', () => {
      if (!/^\d{4}-\d{2}$/.test($('fMonth').value)) return;
      state.ym = $('fMonth').value; state.asOfRequested = null; state.week = null;
      P.writeParams({ ym: state.ym, asOf: null, week: null }); load();
    });
    $('fWeek').addEventListener('change', () => selectWeek($('fWeek').value));
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
