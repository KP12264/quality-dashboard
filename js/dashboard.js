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
 * Target and Target Status are the one exception: the business rule
 * defines the 30 pcs/shift target as a COMBINED total for Door A+B+C,
 * never per line — so Target Status is always computed from the
 * combined A+B+C scrap for the selected shift(s), even when a single
 * Line is selected. The UI shows a note explaining this whenever a
 * single Line is selected, so it isn't a silent mismatch.
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

  // ---- Target lookup (sums across the shifts currently in scope, ALWAYS all-lines) ----

  async function getActiveTargetTotal(dateStr, shiftCodes) {
    const results = await Promise.all(
      shiftCodes.map(s => TargetAdapter.getTargetForShift(window.qdDb, s, dateStr))
    );
    return results.reduce((sum, r) => sum + (Number.isFinite(r.targetQty) ? r.targetQty : 0), 0);
  }

  // ---- Main render ----------------------------------------------------

  async function render() {
    $('dateFilter').value = state.date;

    if (window.qdFirebaseError) {
      showBanner('error', '⚠ ' + window.qdFirebaseError + ' — data cannot be shown until this is resolved.');
      renderEmpty();
      return;
    }

    // Always fetch Production + Scrap for ALL lines (needed for the
    // combined-A+B+C Target Status, and for Shift Performance); the Line
    // filter is applied client-side afterwards for the displayed KPI
    // numbers and the by-Line/by-Model/trend panels.
    let productionResult, scrapResult, target;
    try {
      [productionResult, scrapResult, target] = await Promise.all([
        ProductionDataAdapter.getProductionData(window.qdDb, {
          dates: [state.date], lines: ALL_LINE_CODES, shifts: activeShifts()
        }),
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate: state.date, endDate: state.date }),
        getActiveTargetTotal(state.date, activeShifts())
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

    // ---- Top KPI row: Production/Scrap/Rate follow the Line filter,
    // but Target Status is ALWAYS derived from the combined A+B+C total
    // for the selected shift(s) — see business rule in the header comment.
    const linesInScope = activeLines();
    const lineFilteredProduction = productionResult.records.filter(r => linesInScope.includes(r.line));
    const lineFilteredScrap = scrapInScope.filter(r => linesInScope.includes(r.line));
    renderKpis(lineFilteredProduction, lineFilteredScrap, productionResult.records, scrapInScope, target);

    // ---- Shift Performance: all lines, split by shift ----
    await renderShiftPerformance(productionResult.records, scrapInScope);

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
    renderKpis(null, [], [], [], 0);
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

  function renderKpis(displayProductionRecords, displayScrapRecords, allLinesProductionRecords, allLinesScrapRecords, target) {
    const productionEl = $('kpiProduction');
    const targetEl = $('kpiTarget');
    const scrapEl = $('kpiScrap');
    const scrapRateEl = $('kpiScrapRate');
    const statusEl = $('kpiStatus');
    const noteEl = $('kpiStatusNote');

    if (!displayProductionRecords) {
      productionEl.textContent = '–';
      scrapEl.textContent = '–';
      scrapRateEl.textContent = '–';
      targetEl.textContent = '–';
      statusEl.textContent = '–';
      statusEl.className = 'qd-status-pill neutral';
      noteEl.textContent = '';
      ['production', 'scrap', 'scrapRate', 'target', 'status'].forEach(k =>
        setKpiStatus($(`kpiSection`).querySelector(`[data-kpi="${k}"]`), 'neutral'));
      return;
    }

    // Displayed numbers respect the Line filter.
    const displaySummary = QualityAdapter.buildOverallSummary(displayProductionRecords, displayScrapRecords, target);
    // Target Status ALWAYS comes from the combined Door A+B+C total,
    // regardless of the Line filter — per business rule.
    const combinedSummary = QualityAdapter.buildOverallSummary(allLinesProductionRecords, allLinesScrapRecords, target);

    productionEl.textContent = fmt(displaySummary.totalProduction);
    scrapEl.textContent = fmt(displaySummary.totalScrap);
    scrapEl.classList.remove('na');
    scrapRateEl.textContent = fmtPct(displaySummary.scrapRatePct);
    scrapRateEl.classList.remove('na');
    targetEl.textContent = fmt(combinedSummary.target);

    statusEl.textContent = combinedSummary.status;
    statusEl.className = 'qd-status-pill ' + (combinedSummary.status === 'WITHIN TARGET' ? 'good' : combinedSummary.status === 'OVER TARGET' ? 'bad' : 'neutral');

    if (state.line === 'all') {
      noteEl.textContent = '';
    } else {
      const lineLabel = (LINES.find(l => l.code === state.line) || {}).label || state.line;
      noteEl.textContent = `Target Status uses combined Scrap (Door A+B+C) = ${fmt(combinedSummary.totalScrap)} pcs vs Target ${fmt(combinedSummary.target)} pcs — not just ${lineLabel}'s ${fmt(displaySummary.totalScrap)} pcs shown above.`;
    }

    setKpiStatus($('kpiSection').querySelector('[data-kpi="production"]'), 'neutral');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="scrap"]'), combinedSummary.status === 'OVER TARGET' ? 'bad' : 'good');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="scrapRate"]'), 'neutral');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="target"]'), 'neutral');
    setKpiStatus($('kpiSection').querySelector('[data-kpi="status"]'), combinedSummary.status === 'WITHIN TARGET' ? 'good' : combinedSummary.status === 'OVER TARGET' ? 'bad' : 'neutral');
  }

  // ---- Shift performance --------------------------------------------------

  async function renderShiftPerformance(productionRecords, scrapRecords) {
    const container = $('shiftPerformance');
    container.innerHTML = '';

    for (const shift of SHIFTS) {
      const shiftProduction = productionRecords.filter(r => r.shift === shift.code);
      const shiftScrap = scrapRecords.filter(r => r.shift === shift.code);
      const target = await TargetAdapter.getTargetForShift(window.qdDb, shift.code, state.date);
      const summary = QualityAdapter.buildOverallSummary(shiftProduction, shiftScrap, target.targetQty);
      const hasAnyDoc = shiftProduction.length > 0;

      const card = document.createElement('div');
      card.className = 'qd-shift-card';
      card.innerHTML = `
        <div class="qd-shift-name">${shift.label} Shift</div>
        <div class="qd-shift-stats">
          <div class="qd-stat">
            <div class="qd-stat-label">Production</div>
            <div class="qd-stat-value">${hasAnyDoc ? fmt(summary.totalProduction) : '–'}</div>
          </div>
          <div class="qd-stat">
            <div class="qd-stat-label">Scrap</div>
            <div class="qd-stat-value">${fmt(summary.totalScrap)}</div>
          </div>
          <div class="qd-stat">
            <div class="qd-stat-label">Target</div>
            <div class="qd-stat-value">${fmt(summary.target)}</div>
          </div>
        </div>`;
      container.appendChild(card);
    }
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

    const chartData = {
      labels,
      datasets: [
        { type: 'bar', label: 'Qty', data: qty, backgroundColor: '#2563EB', borderRadius: 4, order: 2, yAxisID: 'y' },
        { type: 'line', label: 'Cumulative %', data: cumulative, borderColor: '#F59E0B', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#F59E0B', fill: false, order: 1, yAxisID: 'y1' }
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
        y1: { beginAtZero: true, max: 100, position: 'right', grid: { display: false }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => v + '%' } }
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

  async function refreshFormModelOptions() {
    const modelSelect = $('formModel');
    const date = $('formDate').value;
    const line = $('formLine').value;
    modelSelect.innerHTML = '<option value="">Loading models…</option>';
    if (window.qdFirebaseError) { modelSelect.innerHTML = '<option value="">Firebase unavailable</option>'; return; }
    try {
      const { names, error } = await ProductionDataAdapter.getModelListForDayLine(window.qdDb, date, line);
      if (error) { modelSelect.innerHTML = '<option value="">Could not load models</option>'; return; }
      if (names.length === 0) {
        modelSelect.innerHTML = '<option value="">No models recorded for this day/line yet</option>';
        return;
      }
      modelSelect.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    } catch (e) {
      console.error('Quality Dashboard: failed to load model list for form:', e);
      modelSelect.innerHTML = '<option value="">Could not load models</option>';
    }
  }

  function initForm() {
    $('formDate').value = state.date;
    $('formLine').value = state.line !== 'all' ? state.line : 'A';
    $('formShift').value = state.shift !== 'all' ? state.shift : 'เช้า';
    $('formDefect').innerHTML = DEFECT_TYPES.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    refreshFormModelOptions();

    $('formDate').addEventListener('change', refreshFormModelOptions);
    $('formLine').addEventListener('change', refreshFormModelOptions);

    $('scrapForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = $('formSubmit');
      const msgEl = $('formMessage');
      msgEl.style.display = 'none';

      const payload = {
        date: $('formDate').value,
        shift: $('formShift').value,
        line: $('formLine').value,
        model: $('formModel').value,
        defectType: $('formDefect').value,
        scrapQty: $('formQty').value
      };

      if (!payload.model) {
        msgEl.className = 'qd-form-message error';
        msgEl.textContent = 'Select a Model before submitting (none available for this Date/Line means Production hasn\'t recorded a model breakdown yet).';
        msgEl.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        await ScrapDataAdapter.addScrapEntry(window.qdDb, payload);
        msgEl.className = 'qd-form-message success';
        msgEl.textContent = `Saved: ${payload.scrapQty} pcs · ${payload.defectType} · ${payload.model} · Line ${payload.line} · ${payload.date}`;
        msgEl.style.display = 'block';
        $('formQty').value = '';
        // Refresh the dashboard so the new entry is reflected immediately.
        if (payload.date === state.date) render();
      } catch (err) {
        console.error('Quality Dashboard: addScrapEntry failed:', err);
        msgEl.className = 'qd-form-message error';
        msgEl.textContent = '⚠ Could not save this entry: ' + (err && err.message ? err.message : String(err));
        msgEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '+ Add Scrap Entry';
      }
    });
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

  initForm();
  render();
})();
