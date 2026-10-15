/**
 * executive-report-page.js
 * ------------------------------------------------------------------
 * Page 5 — Executive Report. Reads Production (read-only,
 * productionLogs), Scrap (scrapLogs) and Improvements. Aggregates
 * client-side with js/quality-adapter.js's pure functions — no writes
 * anywhere on this page.
 *
 * EXPORT SCOPE NOTE: "Export CSV" is real (builds an actual .csv file
 * client-side and downloads it) and "Print / Save as PDF" is real
 * (uses the browser's native print dialog with print-specific CSS in
 * styles.css — that's how a person saves this page as a PDF without
 * adding a PDF-generation library). A true binary .xlsx export would
 * need an extra library (e.g. SheetJS) that isn't included yet, per
 * "don't add unnecessary dependencies" — CSV opens in Excel directly,
 * so that gap is covered for now without adding a new dependency.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const fmtPct = n => Number.isFinite(n) ? n.toFixed(2) + '%' : 'N/A';

  const ALL_LINE_CODES = LINES.map(l => l.code);
  const ALL_SHIFT_CODES = SHIFTS.map(s => s.code);

  let period = 'daily'; // 'daily' | 'weekly' | 'monthly'
  let lastReportData = null; // cached for CSV export

  function shiftLabel(code) { return (SHIFTS.find(s => s.code === code) || {}).label || code; }
  function lineLabel(code) { return (LINES.find(l => l.code === code) || {}).label || code; }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showBanner(kind, message) {
    const el = $('connectionBanner');
    el.className = 'qd-banner ' + kind;
    el.textContent = message;
    el.style.display = 'flex';
  }
  function hideBanner() { $('connectionBanner').style.display = 'none'; }

  function periodDays() {
    return period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
  }

  // ---- Load + aggregate ---------------------------------------------------

  async function load() {
    if (window.qdFirebaseError) { showBanner('error', '⚠ ' + window.qdFirebaseError); return; }
    const endDate = $('rEndDate').value;
    if (!endDate) return;

    const dates = ProductionDataAdapter.dateRange(endDate, periodDays());
    const startDate = dates[0];

    let productionResult, scrapResult, improvementsResult;
    try {
      [productionResult, scrapResult, improvementsResult] = await Promise.all([
        ProductionDataAdapter.getProductionData(window.qdDb, { dates, lines: ALL_LINE_CODES, shifts: ALL_SHIFT_CODES }),
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate, endDate }),
        (typeof ImprovementAdapter !== 'undefined') ? ImprovementAdapter.getImprovements(window.qdDb, {}) : Promise.resolve({ records: [] })
      ]);
    } catch (e) {
      console.error('Quality Dashboard: executive report load failed:', e);
      showBanner('error', '⚠ Could not read report data from Firestore.');
      return;
    }

    // A failed scrap read must never look like "scrap = 0" or WITHIN TARGET.
    const scrapFailed = !!scrapResult.error;
    if (scrapFailed) {
      showBanner('warn', '⚠ Scrap data could not be read — scrap figures are not shown and target status cannot be confirmed.');
    } else if (productionResult.errors.length > 0) {
      showBanner('warn', '⚠ Some production reads failed — figures below may be incomplete.');
    } else {
      hideBanner();
    }

    const production = productionResult.records;
    // Door A/B/C only and the DAY/NIGHT shift codes the system defines — exactly the records the
    // Dashboard and the target evaluator count (old records with other shift codes are not counted anywhere).
    const scrap = scrapResult.records.filter(r => ALL_LINE_CODES.includes(r.line) && ALL_SHIFT_CODES.includes(r.shift));

    const totalProduction = production.reduce((s, r) => s + r.productionQty, 0);
    const totalScrap = scrapFailed ? null : scrap.reduce((s, r) => s + r.scrapQty, 0);
    const scrapRate = scrapFailed ? NaN : QualityAdapter.pct(totalScrap, totalProduction);

    // Target judgement: the SAME shared evaluator the Dashboard uses, with the same inputs
    // (both shifts for every date), so the two pages cannot disagree. targetMaster is read
    // at most once per shift, and only when the period contains pre-cutover dates.
    const shiftTargets = await TargetEvaluator.loadShiftTargetContext(window.qdDb, dates, ALL_SHIFT_CODES);
    const units = TargetEvaluator.evaluate({
      dates, activeShiftCodes: ALL_SHIFT_CODES,
      production, scrap: scrapResult.records,
      scrapReadFailed: scrapFailed, productionErrors: productionResult.errors, shiftTargets
    });
    const targetDesc = TargetEvaluator.describeTarget(units, fmt);
    const targetPerf = buildTargetPerformance(units);

    // Shift table: Production / Scrap per shift for information only (the target is no longer per shift).
    const shiftInfo = ALL_SHIFT_CODES.map(code => ({
      shiftCode: code, label: shiftLabel(code),
      production: production.filter(r => r.shift === code).reduce((s, r) => s + r.productionQty, 0),
      scrap: scrapFailed ? null : scrap.filter(r => r.shift === code).reduce((s, r) => s + r.scrapQty, 0)
    }));

    // Line performance (whole period totals)
    const linePerf = QualityAdapter.buildByLine(production, scrap, ALL_LINE_CODES);

    // Top defect
    const pareto = QualityAdapter.buildParetoDefects(scrap);
    const paretoTotal = pareto.reduce((s, d) => s + d.qty, 0);

    // Improvement performance: records created within this period
    const startMs = new Date(startDate + 'T00:00:00').getTime();
    const endMs = new Date(endDate + 'T23:59:59').getTime();
    const improvementsInPeriod = (improvementsResult.records || []).filter(r => r.createdAt >= startMs && r.createdAt <= endMs);
    const statusCounts = {};
    IMPROVEMENT_STATUSES.forEach(s => { statusCounts[s] = 0; });
    improvementsInPeriod.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });

    // Recurring problems within period
    const recurring = QualityAdapter.buildRecurringProblems(scrap, RECURRING_THRESHOLD_DISTINCT_DATES).filter(g => g.recurring);

    lastReportData = { period, startDate, endDate, totalProduction, totalScrap, scrapRate, scrapFailed, targetDesc, units, targetPerf, shiftInfo, linePerf, pareto, paretoTotal, statusCounts, recurring };
    render(lastReportData);
  }

  // One row per RULE (never one blended percentage): the daily rule counts DAYS, the
  // legacy rule counts SHIFTS (separately for Day and Night).
  function buildTargetPerformance(units) {
    const cutover = TargetEvaluator.formatCutoverDate();
    const rows = [];
    const count = list => ({
      evaluated: list.length,
      within: list.filter(u => u.status === 'WITHIN TARGET').length,
      over: list.filter(u => u.status === 'OVER TARGET').length,
      incomplete: list.filter(u => u.status === 'INCOMPLETE').length,
      noData: list.filter(u => u.status === 'NO DATA').length
    });
    const days = units.filter(u => u.unit === 'DAY');
    if (days.length) {
      rows.push({ rule: 'PER_DAY', ruleText: `Per day · Day + Night combined (from ${cutover})`, unitCode: 'DAY', unitWord: 'days', targetText: `≤${fmt(DAILY_TARGET_PCS)} pcs/day`, targetPcs: DAILY_TARGET_PCS, ...count(days) });
    }
    ALL_SHIFT_CODES.forEach(code => {
      const list = units.filter(u => u.unit === 'SHIFT' && u.shiftCode === code);
      if (!list.length) return;
      const targets = Array.from(new Set(list.map(u => u.target)));
      rows.push({ rule: 'PER_SHIFT', ruleText: `Per shift · ${shiftLabel(code)} (before ${cutover})`, unitCode: 'SHIFT', unitWord: 'shifts',
        targetText: targets.map(t => `≤${fmt(t)} pcs/shift`).join(' / '), targetPcs: targets.join(' / '), ...count(list) });
    });
    return rows;
  }

  // ---- Render ---------------------------------------------------------

  function targetCellText(u) { return `≤${fmt(u.target)}/${u.unit === 'DAY' ? 'day' : 'shift'}`; }
  function isJudged(u) { return u.totalScrap !== null && u.scrapKnown !== false && u.status !== 'NO DATA' && (u.unit === 'DAY' || u.hasData); }

  function render(data) {
    $('rProduction').textContent = fmt(data.totalProduction);
    $('rScrap').textContent = data.scrapFailed ? 'N/A' : fmt(data.totalScrap);
    $('rScrapRate').textContent = data.scrapFailed ? 'N/A' : fmtPct(data.scrapRate);
    $('rTarget').textContent = data.targetDesc.label;
    $('rTargetUnit').textContent = data.targetDesc.unitText;

    const NA = data.scrapFailed;
    $('rLineTableBody').innerHTML = data.linePerf.map(l => `
      <tr><td>${escapeHtml(lineLabel(l.line))}</td><td class="num">${fmt(l.production)}</td><td class="num">${NA ? '–' : fmt(l.scrap)}</td><td class="num">${NA ? 'N/A' : fmtPct(l.scrapRatePct)}</td></tr>
    `).join('') || '<tr class="empty-row"><td colspan="4">No data</td></tr>';

    $('rShiftTableBody').innerHTML = data.shiftInfo.map(s =>
      `<tr><td>${escapeHtml(s.label)}</td><td class="num">${fmt(s.production)}</td><td class="num">${NA ? '–' : fmt(s.scrap)}</td></tr>`
    ).join('') || '<tr class="empty-row"><td colspan="3">No data</td></tr>';

    // Target Performance: counts per rule, never blended into one percentage.
    $('rTargetTableBody').innerHTML = data.targetPerf.map(r => `
      <tr><td>${escapeHtml(r.ruleText)}</td><td>${escapeHtml(r.targetText)}</td><td>${r.unitCode}</td>
        <td class="num">${fmt(r.evaluated)} ${r.unitWord}</td><td class="num">${fmt(r.within)}</td><td class="num">${fmt(r.over)}</td><td class="num">${fmt(r.incomplete)}</td><td class="num">${fmt(r.noData)}</td></tr>
    `).join('') || '<tr class="empty-row"><td colspan="8">No data</td></tr>';
    const notes = [];
    if (data.targetPerf.length > 1 && data.targetPerf.some(r => r.rule === 'PER_DAY') && data.targetPerf.some(r => r.rule === 'PER_SHIFT')) {
      notes.push(`This period spans the rule change on ${TargetEvaluator.formatCutoverDate()}: days and shifts are counted separately and are not combined into one percentage.`);
    }
    if (data.units.some(u => u.status === 'INCOMPLETE')) notes.push('INCOMPLETE = at or below target so far, but it cannot be confirmed (missing shift production, failed read, or no scrap log). It is never counted as within target.');
    $('rTargetNote').textContent = notes.join(' ');

    $('rDailyTableBody').innerHTML = data.units.map(u => {
      const judged = isJudged(u);
      const split = (judged && u.unit === 'DAY') ? ` <span class="qd-sub">Day ${fmt(u.shiftScrap.DAY)} · Night ${fmt(u.shiftScrap.NIGHT)}</span>` : '';
      const reasons = u.reasons.map(c => TargetEvaluator.reasonText(c)).join(' · ');
      return `<tr><td>${u.date}</td><td>${escapeHtml(u.label)}</td><td class="num">${judged ? fmt(u.totalScrap) + split : '—'}</td><td class="num">${targetCellText(u)}</td><td class="num">${judged ? (u.gap > 0 ? '+' : '') + fmt(u.gap) : '—'}</td><td>${escapeHtml(u.status)}</td><td>${escapeHtml(reasons)}</td></tr>`;
    }).join('') || '<tr class="empty-row"><td colspan="7">No data</td></tr>';

    $('rDefectTableBody').innerHTML = data.scrapFailed
      ? '<tr class="empty-row"><td colspan="3">Scrap data could not be read</td></tr>'
      : data.pareto.length ? data.pareto.map(d => `
      <tr><td>${escapeHtml(d.defectType)}</td><td class="num">${fmt(d.qty)}</td><td class="num">${data.paretoTotal > 0 ? (d.qty / data.paretoTotal * 100).toFixed(1) + '%' : '–'}</td></tr>
    `).join('') : '<tr class="empty-row"><td colspan="3">No scrap in this period</td></tr>';

    $('rImprovementBreakdown').innerHTML = IMPROVEMENT_STATUSES.map(s => `
      <div class="qd-status-chip"><div class="count">${data.statusCounts[s] || 0}</div><div class="label">${escapeHtml(s)}</div></div>
    `).join('');

    $('rRecurringTableBody').innerHTML = data.scrapFailed
      ? '<tr class="empty-row"><td colspan="4">Scrap data could not be read</td></tr>'
      : data.recurring.length ? data.recurring.slice(0, 10).map(g => `
      <tr><td>${escapeHtml(lineLabel(g.line))}</td><td>${escapeHtml(g.model)}</td><td>${escapeHtml(g.defectType)} <span class="qd-badge recurring">RECURRING</span></td><td class="num">${g.distinctDates}</td></tr>
    `).join('') : '<tr class="empty-row"><td colspan="4">None in this period</td></tr>';
  }

  // ---- CSV export -----------------------------------------------------

  function toCsvRow(cells) {
    return cells.map(c => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }

  function exportCsv() {
    if (!lastReportData) return;
    const d = lastReportData;
    const lines = [];
    lines.push(toCsvRow(['Executive Report', d.period, d.startDate + ' to ' + d.endDate]));
    lines.push('');
    lines.push(toCsvRow(['Production', d.totalProduction]));
    lines.push(toCsvRow(['Scrap', d.scrapFailed ? 'UNAVAILABLE (scrap read failed)' : d.totalScrap]));
    lines.push(toCsvRow(['Scrap Rate', d.scrapFailed ? 'UNAVAILABLE' : (Number.isFinite(d.scrapRate) ? d.scrapRate.toFixed(2) + '%' : 'N/A')]));
    // Target Unit says what the target is measured per, so a number is never misread:
    // DAY = per production day (Day + Night), SHIFT = per shift, SHIFT+DAY = period spans both rules.
    lines.push(toCsvRow(['Target', d.targetDesc.label, 'Target Unit', d.targetDesc.unitCode]));
    lines.push('');
    lines.push(toCsvRow(['Line', 'Production', 'Scrap', 'Scrap Rate %']));
    d.linePerf.forEach(l => lines.push(toCsvRow([lineLabel(l.line), l.production, d.scrapFailed ? 'UNAVAILABLE' : l.scrap, d.scrapFailed ? '' : (Number.isFinite(l.scrapRatePct) ? l.scrapRatePct.toFixed(2) : '')])));
    lines.push('');
    lines.push(toCsvRow(['Shift', 'Production', 'Scrap']));
    d.shiftInfo.forEach(s => lines.push(toCsvRow([s.label, s.production, d.scrapFailed ? 'UNAVAILABLE' : s.scrap])));
    lines.push('');
    lines.push(toCsvRow(['Target Performance (counted per rule, never blended)']));
    lines.push(toCsvRow(['Rule', 'Target Unit', 'Target (pcs)', 'Units Evaluated', 'Within', 'Over', 'Incomplete', 'No Data']));
    d.targetPerf.forEach(r => lines.push(toCsvRow([r.rule, r.unitCode, r.targetPcs, `${r.evaluated} ${r.unitWord}`, r.within, r.over, r.incomplete, r.noData])));
    lines.push('');
    lines.push(toCsvRow(['Daily Target Evaluation']));
    lines.push(toCsvRow(['Date', 'Rule', 'Target Unit', 'Scope', 'Scrap', 'Target (pcs)', 'Gap', 'Status', 'Notes']));
    d.units.forEach(u => {
      const judged = isJudged(u);
      lines.push(toCsvRow([u.date, u.rule === 'DAY' ? 'PER_DAY' : 'PER_SHIFT', u.unit, u.label, judged ? u.totalScrap : '', u.target, judged ? u.gap : '', u.status, u.reasons.map(c => TargetEvaluator.reasonText(c)).join(' | ')]));
    });
    lines.push('');
    lines.push(toCsvRow(['Defect', 'Qty', '% of Total']));
    if (d.scrapFailed) lines.push(toCsvRow(['UNAVAILABLE (scrap read failed)', '', '']));
    else d.pareto.forEach(p => lines.push(toCsvRow([p.defectType, p.qty, d.paretoTotal > 0 ? (p.qty / d.paretoTotal * 100).toFixed(1) + '%' : ''])));
    lines.push('');
    lines.push(toCsvRow(['Recurring Problem: Line', 'Model', 'Defect', 'Distinct Days']));
    if (!d.scrapFailed) d.recurring.forEach(g => lines.push(toCsvRow([lineLabel(g.line), g.model, g.defectType, g.distinctDates])));

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `executive-report_${d.period}_${d.endDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- Init ---------------------------------------------------------------

  function init() {
    $('rEndDate').value = ProductionDataAdapter.toDateStr(new Date());

    $('periodTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      period = btn.dataset.period;
      $('periodTabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      load();
    });

    $('refreshReport').addEventListener('click', load);
    $('exportCsv').addEventListener('click', exportCsv);
    $('printReport').addEventListener('click', () => window.print());

    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
