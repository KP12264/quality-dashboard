/**
 * dashboard.js
 * ------------------------------------------------------------------
 * Dashboard UI. This file never talks to Firestore directly.
 *
 *   Production (existing system, READ ONLY) -> window.ProductionDataAdapter
 *   Scrap      (this app owns it)           -> window.ScrapDataAdapter
 *   Target     (this app owns it)           -> window.TargetAdapter
 *   Join/business rules (pure functions)    -> window.QualityAdapter
 *
 * Design decision (documented, not hidden in code comments only):
 * Production / Scrap / Scrap Rate in the top KPI row follow the Line
 * filter (All = Door A+B+C combined, or a single line's own numbers).
 * Target is ALWAYS ≤30 pcs PER SHIFT (combined across Door A+B+C) —
 * never per line, and never summed across shifts (Day + Night is never
 * "60"). Each shift is evaluated independently against its own target;
 * when more than one shift is in view, the combined Status pill shows
 * OVER TARGET if ANY shift went over its own target, and a per-shift
 * breakdown line spells out which one. Target Status also always uses
 * the combined A+B+C scrap for each shift, even when a single Line is
 * selected — the UI shows notes explaining both of these so neither is
 * a silent mismatch with the numbers shown elsewhere on the page.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const fmtPct = n => Number.isFinite(n) ? n.toFixed(2) + '%' : 'N/A';
  const ALL_LINE_CODES = LINES.map(l => l.code);
  const ALL_SHIFT_CODES = SHIFTS.map(s => s.code);

  const state = {
    date: ProductionDataAdapter.toDateStr(new Date()),
    shift: 'all',   // 'all' | 'เช้า' | 'ดึก'
    line: 'all',    // 'all' | 'A' | 'B' | 'C'
    trendRangeDays: 7
  };

  let trendChart = null;
  let scrapTrendChart = null;
  let paretoChart = null;

  function activeLines() {
    return state.line === 'all' ? ALL_LINE_CODES.slice() : [state.line];
  }
  function activeShifts() {
    return state.shift === 'all' ? ALL_SHIFT_CODES.slice() : [state.shift];
  }

  // ---- Connection banner --------------------------------------------------

  function showBanner(kind, message) {
    const el = $('connectionBanner');
    el.className = 'qd-banner ' + kind;
    el.textContent = message;
    el.style.display = 'flex';
  }
  function hideBanner() { $('connectionBanner').style.display = 'none'; }

  // ---- Target lookup: ALWAYS per-shift (30 pcs/shift), NEVER summed across shifts ----

  /**
   * getShiftEvaluations(dateStr, shiftCodes, allLinesProduction, allLinesScrap)
   * Evaluates EACH shift independently against its OWN target (default
   * 30 pcs, or whatever TargetAdapter/targetMaster says for that date).
   * A 30 pcs/shift target must never become "60 pcs" just because two
   * shifts are in view — each shift is judged only against its own 30.
   */
  async function getShiftEvaluations(dateStr, shiftCodes, allLinesProduction, allLinesScrap) {
    const evals = await Promise.all(shiftCodes.map(async (shiftCode) => {
      const shiftProduction = allLinesProduction.filter(r => r.shift === shiftCode);
      const shiftScrap = allLinesScrap.filter(r => r.shift === shiftCode);
      const targetResult = await TargetAdapter.getTargetForShift(window.qdDb, shiftCode, dateStr);
      const summary = QualityAdapter.buildOverallSummary(shiftProduction, shiftScrap, targetResult.targetQty);
      return { shiftCode, label: shiftLabel(shiftCode), hasData: shiftProduction.length > 0, ...summary };
    }));
    return evals;
  }

  function shiftLabel(code) {
    const s = SHIFTS.find(x => x.code === code);
    return s ? s.label : code;
  }

  // ---- Main render ----------------------------------------------------

  async function render() {
    $('dateFilter').value = state.date;

    if (window.qdFirebaseError) {
      showBanner('error', '⚠ ' + window.qdFirebaseError + ' — data cannot be shown until this is resolved.');
      renderEmpty();
      return;
    }

    // Always fetch Production + Scrap for ALL lines (Target Status needs
    // the combined A+B+C total PER SHIFT, and Shift Performance needs
    // all lines too); the Line filter is applied client-side afterwards
    // for the displayed KPI numbers and the by-Line/by-Model/trend panels.
    let productionResult, scrapResult;
    try {
      [productionResult, scrapResult] = await Promise.all([
        ProductionDataAdapter.getProductionData(window.qdDb, {
          dates: [state.date], lines: ALL_LINE_CODES, shifts: activeShifts()
        }),
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate: state.date, endDate: state.date })
      ]);
    } catch (e) {
      console.error('Quality Dashboard: failed to load dashboard data:', e);
      showBanner('error', '⚠ Could not read data from Firestore. Nothing is shown to avoid displaying incorrect numbers. Try refreshing.');
      renderEmpty();
      return;
    }

    if (productionResult.errors.length > 0) {
      showBanner('warn', `⚠ ${productionResult.errors.length} production read${productionResult.errors.length > 1 ? 's' : ''} failed for this date — figures below may be incomplete. Try refreshing.`);
    } else if (scrapResult.error) {
      showBanner('warn', '⚠ Could not read scrap data for this date — scrap figures may be incomplete. Try refreshing.');
    } else {
      hideBanner();
    }

    const scrapInScope = scrapResult.records.filter(r => activeShifts().includes(r.shift));

    // Evaluate each active shift against its OWN target (never summed).
    const shiftEvals = await getShiftEvaluations(state.date, activeShifts(), productionResult.records, scrapInScope);

    // ---- Top KPI row: Production/Scrap/Rate follow the Line filter,
    // Target Status is the worst-case across the per-shift evaluations
    // (each shift judged against its own 30 pcs, never a summed 60).
    const linesInScope = activeLines();
    const lineFilteredProduction = productionResult.records.filter(r => linesInScope.includes(r.line));
    const lineFilteredScrap = scrapInScope.filter(r => linesInScope.includes(r.line));
    renderKpis(lineFilteredProduction, lineFilteredScrap, shiftEvals);

    // ---- Shift Performance: all lines, split by shift ----
    renderShiftPerformance(shiftEvals);

    // ---- Line Performance: respects the Line filter ----
    renderLinePerformance(lineFilteredProduction, lineFilteredScrap);

    // ---- By Model: respects the Line filter, needs per-model production ----
    await renderByModel(linesInScope, lineFilteredScrap);

    // ---- Pareto: respects Line filter ----
    renderPareto(lineFilteredScrap);

    // ---- Trends: respect Line filter ----
    await renderTrends();

    $('lastUpdated').textContent =
      'Production source: productionLogs (read-only) · Scrap source: scrapLogs · Last refreshed ' + new Date().toLocaleTimeString('en-US');
  }

  function renderEmpty() {
    renderKpis(null, [], []);
    $('shiftPerformance').innerHTML = '';
    $('linePerformance').innerHTML = '';
    $('modelTableBody').innerHTML = '';
    renderTrend([]);
    renderScrapTrend([]);
    renderPareto([]);
  }

  // ---- KPI cards --------------------------------------------------------

  function setKpiStatus(kpiEl, level) {
    const color = level === 'good' ? 'var(--green)' : level === 'warn' ? 'var(--amber)' : level === 'bad' ? 'var(--red)' : 'var(--slate)';
    kpiEl.style.setProperty('--kpi-status', color);
  }

  // Target display text: "≤30 pcs / Shift" when every active shift shares
  // the same target; otherwise spells out each shift's own target rather
  // than ever adding them together.
  function formatTargetLabel(shiftEvals) {
    const targets = shiftEvals.map(e => e.target).filter(t => Number.isFinite(t) && t > 0);
    if (targets.length === 0) return '–';
    const unique = Array.from(new Set(targets));
    if (unique.length === 1) return `≤${fmt(unique[0])}`;
    return shiftEvals.map(e => `${e.label} ≤${fmt(e.target)}`).join(' · ');
  }

  function renderKpis(displayProductionRecords, displayScrapRecords, shiftEvals) {
    const productionEl = $('kpiProduction');
    const targetEl = $('kpiTarget');
    const scrapEl = $('kpiScrap');
    const scrapRateEl = $('kpiScrapRate');
    const statusEl = $('kpiStatus');
    const noteEl = $('kpiStatusNote');
    const breakdownEl = $('kpiShiftBreakdown');

    if (!displayProductionRecords) {
      productionEl.textContent = '–';
      scrapEl.textContent = '–';
      scrapRateEl.textContent = '–';
      targetEl.textContent = '–';
      statusEl.textContent = '–';
      statusEl.className = 'qd-status-pill neutral';
      noteEl.textContent = '';
      breakdownEl.textContent = '';
      ['production', 'scrap', 'scrapRate', 'target', 'status'].forEach(k =>
        setKpiStatus($(`kpiSection`).querySelector(`[data-kpi="${k}"]`), 'neutral'));
      return;
    }

    // Displayed Production/Scrap/Rate respect the Line filter (target arg
    // is irrelevant here — we don't use this summary's .status).
    const displaySummary = QualityAdapter.buildOverallSummary(displayProductionRecords, displayScrapRecords, NaN);
    // Target Status: worst-case across each shift judged against ITS OWN
    // target (never a summed target across shifts) — see business rule.
    const combinedStatus = QualityAdapter.combineShiftStatuses(shiftEvals);

    productionEl.textContent = fmt(displaySummary.totalProduction);
    scrapEl.textContent = fmt(displaySummary.totalScrap);
    scrapEl.classList.remove('na');
    scrapRateEl.textContent = fmtPct(displaySummary.scrapRatePct);
    scrapRateEl.classList.remove('na');
    targetEl.textContent = formatTargetLabel(shiftEvals);

    statusEl.textContent = combinedStatus;
    statusEl.className = 'qd-status-pill ' + (combinedStatus === 'WITHIN TARGET' ? 'good' : combinedStatus === 'OVER TARGET' ? 'bad' : 'neutral');

    if (state.line === 'all') {
      noteEl.textContent = '';
    } else {
      const combinedScrap = shiftEvals.reduce((s, e) => s + e.totalScrap, 0);
      const lineLabel = (LINES.find(l => l.code === state.line) || {}).label || state.line;
      noteEl.textContent = `Target Status uses combined Scrap (Door A+B+C) = ${fmt(combinedScrap)} pcs — not just ${lineLabel}'s ${fmt(displaySummary.totalScrap)} pcs shown above.`;
    }

    // Per-shift breakdown, so "one shift went over" is never hidden inside
    // a combined number when Shift = All (or in general, whenever more
    // than one shift is being evaluated at once).
    if (shiftEvals.length > 1) {
      breakdownEl.textContent = shiftEvals.map(e => {
        if (!e.hasData) return `${e.label} Shift: no data`;
        const diff = e.totalScrap - e.target;
        const tag = e.status === 'OVER TARGET' ? `+${fmt(diff)} OVER` : e.status === 'WITHIN TARGET' ? 'WITHIN' : 'NO DATA';
        return `${e.label} Shift: ${fmt(e.totalScrap)}/${fmt(e.target)} pcs (${tag})`;
      }).join('  ·  ');
    } else {
      breakdownEl.textContent = '';
    }

    setKpiStatus($('kpiSection').querySelector('[data-kpi="production"]'), 'neutral');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="scrap"]'), combinedStatus === 'OVER TARGET' ? 'bad' : 'good');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="scrapRate"]'), 'neutral');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="target"]'), 'neutral');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="status"]'), combinedStatus === 'WITHIN TARGET' ? 'good' : combinedStatus === 'OVER TARGET' ? 'bad' : 'neutral');
  }

  // ---- Shift performance --------------------------------------------------

  function renderShiftPerformance(shiftEvals) {
    const container = $('shiftPerformance');
    container.innerHTML = '';

    shiftEvals.forEach(e => {
      const card = document.createElement('div');
      card.className = 'qd-shift-card';
      card.innerHTML = `
        <div class="qd-shift-name">${e.label} Shift</div>
        <div class="qd-shift-stats">
          <div class="qd-stat">
            <div class="qd-stat-label">Production</div>
            <div class="qd-stat-value">${e.hasData ? fmt(e.totalProduction) : '–'}</div>
          </div>
          <div class="qd-stat">
            <div class="qd-stat-label">Scrap</div>
            <div class="qd-stat-value">${fmt(e.totalScrap)}</div>
          </div>
          <div class="qd-stat">
            <div class="qd-stat-label">Target</div>
            <div class="qd-stat-value">${fmt(e.target)}</div>
          </div>
        </div>`;
      container.appendChild(card);
    });
  }

  // ---- Line performance --------------------------------------------------

  function renderLinePerformance(productionRecords, scrapRecords) {
    const container = $('linePerformance');
    container.innerHTML = '';

    activeLines().forEach(lineCode => {
      const line = LINES.find(l => l.code === lineCode);
      const lineProduction = productionRecords.filter(r => r.line === lineCode);
      const lineScrap = scrapRecords.filter(r => r.line === lineCode);
      const production = lineProduction.reduce((s, r) => s + r.productionQty, 0);
      const scrap = lineScrap.reduce((s, r) => s + r.scrapQty, 0);
      const rate = QualityAdapter.pct(scrap, production);
      const hasAnyDoc = lineProduction.length > 0;

      const card = document.createElement('div');
      card.className = 'qd-line-card';
      card.innerHTML = `
        <div class="qd-line-badge line-${line.code}">${line.code}</div>
        <div class="qd-line-info">
          <div class="qd-line-name">${line.label}</div>
          <div class="qd-line-rate">${rate === null ? 'Scrap rate N/A' : 'Scrap rate ' + fmtPct(rate)}</div>
        </div>
        <div class="qd-line-qty">${hasAnyDoc ? fmt(production) : '–'}<span class="unit">pcs</span></div>
        <div class="qd-line-scrap">
          <div class="qd-stat-label">Scrap</div>
          <div class="qd-line-scrap-value${scrap === 0 ? ' zero' : ''}">${fmt(scrap)}</div>
        </div>`;
      container.appendChild(card);
    });
  }

  // ---- By Model -----------------------------------------------------------

  async function renderByModel(lineCodes, scrapRecordsInScope) {
    const tbody = $('modelTableBody');
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading…</td></tr>';

    let byModelResult;
    try {
      byModelResult = await ProductionDataAdapter.getProductionDataByModel(window.qdDb, {
        dates: [state.date], lines: lineCodes, shifts: activeShifts()
      });
    } catch (e) {
      console.error('Quality Dashboard: by-model fetch failed:', e);
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Could not load model breakdown.</td></tr>';
      return;
    }

    const rows = QualityAdapter.buildByModel(byModelResult.records, scrapRecordsInScope);
    if (rows.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No per-model production or scrap data recorded for this scope yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => `
      <tr class="${r.unmatchedProduction ? 'unmatched' : ''}">
        <td>${escapeHtml(r.model)}${r.unmatchedProduction ? '<span class="unmatched-tag">⚠ no matching production record</span>' : ''}</td>
        <td>${fmt(r.production)}</td>
        <td>${fmt(r.scrap)}</td>
        <td>${fmtPct(r.scrapRatePct)}</td>
      </tr>`).join('');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- Pareto defect --------------------------------------------------

  function renderPareto(scrapRecords) {
    if (typeof Chart === 'undefined') return;
    const data = QualityAdapter.buildParetoDefects(scrapRecords);
    const labels = data.map(d => d.defectType);
    const qty = data.map(d => d.qty);
    const cumulative = data.map(d => d.cumulativePct);
    const eightyLine = labels.map(() => 80); // flat 80% Pareto reference line, right axis, independent of Qty scale

    const chartData = {
      labels,
      datasets: [
        { type: 'bar', label: 'Qty', data: qty, backgroundColor: '#2563EB', borderRadius: 4, order: 3, yAxisID: 'y' },
        { type: 'line', label: 'Cumulative %', data: cumulative, borderColor: '#F59E0B', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#F59E0B', fill: false, order: 2, yAxisID: 'y1' },
        { type: 'line', label: '80%', data: eightyLine, borderColor: '#94A3B8', borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, fill: false, order: 1, yAxisID: 'y1' }
      ]
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 10, usePointStyle: true, font: { family: "'Inter', sans-serif", size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: "'Inter', sans-serif", size: 10 }, maxRotation: 20 } },
        y: { beginAtZero: true, position: 'left', grid: { color: 'rgba(15,39,71,0.08)' }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y1: { beginAtZero: true, min: 0, max: 100, position: 'right', grid: { display: false }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => v + '%' } }
      }
    };

    if (data.length === 0) {
      if (paretoChart) { paretoChart.destroy(); paretoChart = null; }
      return;
    }
    if (paretoChart) { paretoChart.data = chartData; paretoChart.options = options; paretoChart.update(); }
    else paretoChart = new Chart($('paretoChart'), { type: 'bar', data: chartData, options });
  }

  // ---- Trends ---------------------------------------------------------

  async function renderTrends() {
    if (window.qdFirebaseError) { renderTrend([]); renderScrapTrend([]); return; }

    const dates = ProductionDataAdapter.dateRange(state.date, state.trendRangeDays);
    const lineCodes = activeLines();
    let productionResult, scrapResult;
    try {
      [productionResult, scrapResult] = await Promise.all([
        ProductionDataAdapter.getProductionData(window.qdDb, { dates, lines: lineCodes, shifts: activeShifts() }),
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate: dates[0], endDate: dates[dates.length - 1] })
      ]);
    } catch (e) {
      console.error('Quality Dashboard: trend fetch failed:', e);
      renderTrend([]); renderScrapTrend([]);
      return;
    }

    const scrapInScope = scrapResult.records.filter(r => activeShifts().includes(r.shift) && lineCodes.includes(r.line));
    const trend = QualityAdapter.buildDailyTrend(dates, productionResult.records, scrapInScope);

    renderTrend(trend.map(t => ({ date: t.date, production: t.production })));
    renderScrapTrend(trend);
  }

  function renderTrend(points) {
    if (typeof Chart === 'undefined') return;
    const labels = points.map(p => p.date.slice(5));
    const data = points.map(p => p.production);

    const chartData = {
      labels,
      datasets: [{
        label: 'Production (pcs)', data,
        borderColor: '#2563EB', backgroundColor: 'rgba(37,99,235,0.10)',
        fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#2563EB'
      }]
    };
    const options = baseLineOptions(v => Number(v).toLocaleString('en-US') + ' pcs');

    if (trendChart) { trendChart.data = chartData; trendChart.options = options; trendChart.update(); }
    else trendChart = new Chart($('trendChart'), { type: 'line', data: chartData, options });
  }

  function renderScrapTrend(points) {
    if (typeof Chart === 'undefined') return;
    const labels = points.map(p => p.date.slice(5));
    const scrapQty = points.map(p => p.scrap);
    const rate = points.map(p => p.scrapRatePct);

    const chartData = {
      labels,
      datasets: [
        { type: 'bar', label: 'Scrap (pcs)', data: scrapQty, backgroundColor: '#DC2626', borderRadius: 4, order: 2, yAxisID: 'y' },
        { type: 'line', label: 'Scrap Rate %', data: rate, borderColor: '#F59E0B', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#F59E0B', fill: false, order: 1, yAxisID: 'y1', spanGaps: true }
      ]
    };
    const options = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 10, usePointStyle: true, font: { family: "'Inter', sans-serif", size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y: { beginAtZero: true, position: 'left', grid: { color: 'rgba(15,39,71,0.08)' }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => v + '%' } }
      }
    };

    if (scrapTrendChart) { scrapTrendChart.data = chartData; scrapTrendChart.options = options; scrapTrendChart.update(); }
    else scrapTrendChart = new Chart($('scrapTrendChart'), { type: 'bar', data: chartData, options });
  }

  function baseLineOptions(tooltipFmt) {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0B2540', titleColor: '#fff', bodyColor: '#EAF1FE',
          padding: 10, cornerRadius: 6,
          callbacks: { label: ctx => ' ' + tooltipFmt(ctx.parsed.y) }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748B', font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(15,39,71,0.08)' }, ticks: { color: '#64748B', font: { family: "'JetBrains Mono', monospace", size: 10 } } }
      }
    };
  }

  // ---- Scrap entry form -------------------------------------------------
  // (Removed — the entry form now lives on its own page, scrap-entry.html.
  // See js/scrap-entry-page.js.)

  // ---- Improvement Status + Recurring Problems (Dashboard widgets) --------

  async function renderImprovementStatus() {
    const container = $('improvementStatusBreakdown');
    if (typeof ImprovementAdapter === 'undefined' || window.qdFirebaseError) {
      container.innerHTML = '<div class="qd-placeholder">Improvement data unavailable.</div>';
      return;
    }
    try {
      const { records, error } = await ImprovementAdapter.getImprovements(window.qdDb, { limit: 200 });
      if (error) { container.innerHTML = '<div class="qd-placeholder">Could not load improvement records.</div>'; return; }
      if (records.length === 0) {
        container.innerHTML = '<div class="qd-placeholder"><strong>No improvement records yet</strong>Create one from the Improvement page once a recurring or high-impact defect needs root-cause action.</div>';
        return;
      }
      const counts = {};
      IMPROVEMENT_STATUSES.forEach(s => { counts[s] = 0; });
      records.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
      container.innerHTML = IMPROVEMENT_STATUSES.map(s => `
        <div class="qd-status-chip">
          <div class="count">${counts[s] || 0}</div>
          <div class="label">${escapeHtml(s)}</div>
        </div>`).join('');
    } catch (e) {
      console.error('Quality Dashboard: failed to load improvement status:', e);
      container.innerHTML = '<div class="qd-placeholder">Could not load improvement records.</div>';
    }
  }

  async function renderRecurringProblems() {
    const tbody = $('recurringTableBody');
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading…</td></tr>';
    if (window.qdFirebaseError) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Data unavailable.</td></tr>'; return; }
    try {
      const lookbackDates = ProductionDataAdapter.dateRange(state.date, 30);
      const scrapResult = await ScrapDataAdapter.getScrapData(window.qdDb, { startDate: lookbackDates[0], endDate: lookbackDates[lookbackDates.length - 1] });
      if (scrapResult.error) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Could not load scrap data.</td></tr>'; return; }
      const groups = QualityAdapter.buildRecurringProblems(scrapResult.records, RECURRING_THRESHOLD_DISTINCT_DATES)
        .filter(g => g.recurring)
        .slice(0, 8);
      if (groups.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No recurring problems in the last 30 days.</td></tr>';
        return;
      }
      tbody.innerHTML = groups.map(g => `
        <tr>
          <td>${escapeHtml(g.line)}</td>
          <td>${escapeHtml(g.model)}</td>
          <td>${escapeHtml(g.defectType)} <span class="qd-badge recurring">RECURRING</span></td>
          <td class="num">${g.distinctDates}</td>
          <td class="num">${fmt(g.totalQty)}</td>
        </tr>`).join('');
    } catch (e) {
      console.error('Quality Dashboard: failed to load recurring problems:', e);
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Could not load recurring problems.</td></tr>';
    }
  }

  // ---- Event wiring (top filters) ---------------------------------------------------

  $('dateFilter').addEventListener('change', () => { state.date = $('dateFilter').value; render(); });

  $('shiftFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.shift = btn.dataset.shift;
    $('shiftFilter').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });

  $('lineFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.line = btn.dataset.line;
    $('lineFilter').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });

  $('trendRange').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.trendRangeDays = parseInt(btn.dataset.range, 10);
    $('trendRange').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderTrends();
  });

  // ---- Boot ---------------------------------------------------------------

  render();
  renderImprovementStatus();
  renderRecurringProblems();
})();
