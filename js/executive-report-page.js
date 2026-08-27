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

    if (productionResult.errors.length > 0 || scrapResult.error) {
      showBanner('warn', '⚠ Some reads failed — figures below may be incomplete.');
    } else {
      hideBanner();
    }

    const production = productionResult.records;
    const scrap = scrapResult.records;

    // Overall summary (target left out of this sum — see per-shift status below)
    const totalProduction = production.reduce((s, r) => s + r.productionQty, 0);
    const totalScrap = scrap.reduce((s, r) => s + r.scrapQty, 0);
    const scrapRate = QualityAdapter.pct(totalScrap, totalProduction);

    // Per-shift target display: today's (endDate's) own targets, never summed across shifts/days.
    const targets = await Promise.all(ALL_SHIFT_CODES.map(s => TargetAdapter.getTargetForShift(window.qdDb, s, endDate)));
    const uniqueTargets = Array.from(new Set(targets.map(t => t.targetQty)));
    const targetLabel = uniqueTargets.length === 1 ? `≤${fmt(uniqueTargets[0])}` :
      ALL_SHIFT_CODES.map((s, i) => `${shiftLabel(s)} ≤${fmt(targets[i].targetQty)}`).join(' · ');

    // Shift performance: for each shift, evaluate EVERY date in range against
    // that date's own target (never summed across days), then report how
    // many day-instances went over — same "never sum a per-shift target"
    // principle as the Dashboard, extended across a date range.
    const shiftPerf = await buildShiftPerformance(dates, production, scrap);

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

    lastReportData = { period, startDate, endDate, totalProduction, totalScrap, scrapRate, targetLabel, shiftPerf, linePerf, pareto, paretoTotal, statusCounts, recurring };
    render(lastReportData);
  }

  async function buildShiftPerformance(dates, production, scrap) {
    const results = [];
    for (const shiftCode of ALL_SHIFT_CODES) {
      let over = 0, within = 0, noData = 0;
      let shiftProduction = 0, shiftScrap = 0;
      for (const date of dates) {
        const dayProd = production.filter(r => r.date === date && r.shift === shiftCode);
        const dayScrap = scrap.filter(r => r.date === date && r.shift === shiftCode);
        shiftProduction += dayProd.reduce((s, r) => s + r.productionQty, 0);
        shiftScrap += dayScrap.reduce((s, r) => s + r.scrapQty, 0);
        if (dayProd.length === 0 && dayScrap.length === 0) { noData++; continue; }
        const targetResult = await TargetAdapter.getTargetForShift(window.qdDb, shiftCode, date);
        const daySummary = QualityAdapter.buildOverallSummary(dayProd, dayScrap, targetResult.targetQty);
        if (daySummary.status === 'OVER TARGET') over++; else if (daySummary.status === 'WITHIN TARGET') within++;
      }
      results.push({ shiftCode, label: shiftLabel(shiftCode), production: shiftProduction, scrap: shiftScrap, daysOver: over, daysWithin: within, daysNoData: noData });
    }
    return results;
  }

  // ---- Render ---------------------------------------------------------

  function render(data) {
    $('rProduction').textContent = fmt(data.totalProduction);
    $('rScrap').textContent = fmt(data.totalScrap);
    $('rScrapRate').textContent = fmtPct(data.scrapRate);
    $('rTarget').textContent = data.targetLabel;

    $('rLineTableBody').innerHTML = data.linePerf.map(l => `
      <tr><td>${escapeHtml(lineLabel(l.line))}</td><td class="num">${fmt(l.production)}</td><td class="num">${fmt(l.scrap)}</td><td class="num">${fmtPct(l.scrapRatePct)}</td></tr>
    `).join('') || '<tr class="empty-row"><td colspan="4">No data</td></tr>';

    $('rShiftTableBody').innerHTML = data.shiftPerf.map(s => {
      const statusText = s.daysOver > 0 ? `${s.daysOver}/${s.daysOver + s.daysWithin} day(s) OVER` : (s.daysWithin > 0 ? 'All days within target' : 'No data');
      return `<tr><td>${escapeHtml(s.label)}</td><td class="num">${fmt(s.production)}</td><td class="num">${fmt(s.scrap)}</td><td class="num">≤30/day</td><td>${statusText}</td></tr>`;
    }).join('') || '<tr class="empty-row"><td colspan="5">No data</td></tr>';

    $('rDefectTableBody').innerHTML = data.pareto.length ? data.pareto.map(d => `
      <tr><td>${escapeHtml(d.defectType)}</td><td class="num">${fmt(d.qty)}</td><td class="num">${data.paretoTotal > 0 ? (d.qty / data.paretoTotal * 100).toFixed(1) + '%' : '–'}</td></tr>
    `).join('') : '<tr class="empty-row"><td colspan="3">No scrap in this period</td></tr>';

    $('rImprovementBreakdown').innerHTML = IMPROVEMENT_STATUSES.map(s => `
      <div class="qd-status-chip"><div class="count">${data.statusCounts[s] || 0}</div><div class="label">${escapeHtml(s)}</div></div>
    `).join('');

    $('rRecurringTableBody').innerHTML = data.recurring.length ? data.recurring.slice(0, 10).map(g => `
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
    lines.push(toCsvRow(['Scrap', d.totalScrap]));
    lines.push(toCsvRow(['Scrap Rate', Number.isFinite(d.scrapRate) ? d.scrapRate.toFixed(2) + '%' : 'N/A']));
    lines.push(toCsvRow(['Target', d.targetLabel]));
    lines.push('');
    lines.push(toCsvRow(['Line', 'Production', 'Scrap', 'Scrap Rate %']));
    d.linePerf.forEach(l => lines.push(toCsvRow([lineLabel(l.line), l.production, l.scrap, Number.isFinite(l.scrapRatePct) ? l.scrapRatePct.toFixed(2) : ''])));
    lines.push('');
    lines.push(toCsvRow(['Shift', 'Production', 'Scrap', 'Days Over Target', 'Days Within Target']));
    d.shiftPerf.forEach(s => lines.push(toCsvRow([s.label, s.production, s.scrap, s.daysOver, s.daysWithin])));
    lines.push('');
    lines.push(toCsvRow(['Defect', 'Qty', '% of Total']));
    d.pareto.forEach(p => lines.push(toCsvRow([p.defectType, p.qty, d.paretoTotal > 0 ? (p.qty / d.paretoTotal * 100).toFixed(1) + '%' : ''])));
    lines.push('');
    lines.push(toCsvRow(['Recurring Problem: Line', 'Model', 'Defect', 'Distinct Days']));
    d.recurring.forEach(g => lines.push(toCsvRow([lineLabel(g.line), g.model, g.defectType, g.distinctDates])));

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
