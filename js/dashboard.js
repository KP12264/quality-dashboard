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

  // Date Range (inclusive). Both default to today, so first load behaves
  // exactly like the old single-date Dashboard — a range is only loaded
  // when the user explicitly widens it.
  const MAX_RANGE_DAYS = 366;   // safety net against an accidental multi-year range, not a "short" limit
  const todayStr = ProductionDataAdapter.toDateStr(new Date());
  const state = {
    dateFrom: todayStr,
    dateTo: todayStr,
    shift: 'all',   // 'all' | 'DAY' | 'NIGHT'
    line: 'all'     // 'all' | 'A' | 'B' | 'C'
  };
  let renderSeq = 0;   // lets a newer render() discard the results of an older, slower one

  let trendChart = null;
  let scrapTrendChart = null;
  let paretoChart = null;

  function activeLines() {
    return state.line === 'all' ? ALL_LINE_CODES.slice() : [state.line];
  }
  function activeShifts() {
    return state.shift === 'all' ? ALL_SHIFT_CODES.slice() : [state.shift];
  }

  // ---- Date Range helpers (pure string/UTC arithmetic) -------------------
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isMultiDay() { return state.dateFrom !== state.dateTo; }
  function daysInclusive(from, to) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
  }
  // An invalid range is never fetched and never rendered, and dates are
  // never silently swapped — the user sees exactly what is wrong.
  function validateRange() {
    if (!DATE_RE.test(state.dateFrom || '') || !DATE_RE.test(state.dateTo || '')) {
      return { ok: false, message: 'Select both a From date and a To date.' };
    }
    if (state.dateFrom > state.dateTo) {
      return { ok: false, message: 'From date must be on or before To date. Nothing is loaded until the range is valid.' };
    }
    const days = daysInclusive(state.dateFrom, state.dateTo);
    if (days > MAX_RANGE_DAYS) {
      return { ok: false, message: `Date range is too long (${days} days). Maximum is ${MAX_RANGE_DAYS} days.` };
    }
    return { ok: true, days };
  }
  function showRangeValidation(check) {
    const el = $('rangeError');
    el.hidden = check.ok;
    el.textContent = check.ok ? '' : '⚠ ' + check.message;
    ['dateFrom', 'dateTo'].forEach(id => $(id).classList.toggle('invalid', !check.ok));
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
   * getRangeShiftEvaluations(dates, shiftCodes, allLinesProduction, allLinesScrap)
   * Evaluates EVERY Date + Shift as its own independent unit, each against
   * its OWN per-shift target (default 30 pcs, or whatever targetMaster says
   * is effective on THAT date), using the combined Door A+B+C scrap for that
   * Date + Shift. There is deliberately NO range-wide target: 7 days is
   * never "7 x 30 = 210" and Day + Night is never "60" — a range just
   * produces more independent Date + Shift results, which are then counted
   * (and combined by OVER > WITHIN > NO DATA priority) elsewhere.
   *
   * A single date is simply a range of one, so the old Day/Night result is
   * produced by the same code path.
   *
   * Targets are effective-dated, so each shift's targetMaster history is
   * read ONCE (TargetAdapter.getTargetHistory, 1 query per shift for the
   * whole range) and the per-date target is resolved here with the exact
   * rule TargetAdapter.getTargetForShift uses: the newest record whose
   * effectiveDate <= that date, else DEFAULT_TARGET_PER_SHIFT_PCS.
   */
  async function getRangeShiftEvaluations(dates, shiftCodes, allLinesProduction, allLinesScrap) {
    const histories = {};
    await Promise.all(shiftCodes.map(async (shiftCode) => {
      try {
        histories[shiftCode] = await TargetAdapter.getTargetHistory(window.qdDb, shiftCode);
      } catch (e) {
        console.error('Quality Dashboard: failed to read targetMaster for shift', shiftCode, e);
        histories[shiftCode] = null;   // same fallback TargetAdapter uses: the default target
      }
    }));
    const targetFor = (shiftCode, dateStr) => {
      const history = histories[shiftCode];
      const applicable = history && history.find(r => r.effectiveDate && r.effectiveDate <= dateStr);
      return applicable ? applicable.targetQty : (DEFAULT_TARGET_PER_SHIFT_PCS[shiftCode] || 0);
    };
    const bucket = (records) => {
      const m = new Map();
      records.forEach(r => {
        const k = `${r.date}|${r.shift}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      });
      return m;
    };
    const productionBy = bucket(allLinesProduction);
    const scrapBy = bucket(allLinesScrap);

    const evals = [];
    dates.forEach(dateStr => {
      shiftCodes.forEach(shiftCode => {
        const key = `${dateStr}|${shiftCode}`;
        const shiftProduction = productionBy.get(key) || [];
        const shiftScrap = scrapBy.get(key) || [];
        const summary = QualityAdapter.buildOverallSummary(shiftProduction, shiftScrap, targetFor(shiftCode, dateStr));
        const hasData = shiftProduction.length > 0;
        // QualityAdapter.buildOverallSummary() only checks that a target
        // number exists, never that this shift has production data — so
        // "no production, no scrap" and "production exists, scrap=0" both
        // came back WITHIN TARGET. Corrected here (QualityAdapter itself
        // untouched): no production for this Date + Shift is NO DATA,
        // regardless of the raw scrap-vs-target comparison.
        const status = hasData ? summary.status : 'NO DATA';
        evals.push({ date: dateStr, shiftCode, label: shiftLabel(shiftCode), hasData, ...summary, status });
      });
    });
    return evals;
  }

  function shiftLabel(code) {
    const s = SHIFTS.find(x => x.code === code);
    return s ? s.label : code;
  }

  // ---- Main render ----------------------------------------------------

  async function render() {
    const seq = ++renderSeq;
    $('dateFrom').value = state.dateFrom;
    $('dateTo').value = state.dateTo;

    // Validate BEFORE touching Firestore: an invalid range is neither
    // fetched nor rendered (and bumping renderSeq above also discards any
    // slower render still in flight for the previous, valid range).
    const check = validateRange();
    showRangeValidation(check);
    if (!check.ok) {
      renderEmpty();
      // Attention Required is fetched/rendered separately, so clear it too
      // — nothing from the previous (valid) range should linger on screen.
      $('attentionSummary').innerHTML = '<div class="qd-placeholder">Select a valid date range to see recurring problems.</div>';
      return;
    }
    const scopeWord = isMultiDay() ? 'date range' : 'date';

    if (window.qdFirebaseError) {
      showBanner('error', '⚠ ' + window.qdFirebaseError + ' — data cannot be shown until this is resolved.');
      renderEmpty();
      return;
    }

    // ONE load for the whole range, then everything below is derived from
    // it in memory (KPIs, target evaluation, Door Line, Pareto, Trend,
    // Recurring Problems): Production = one document read per date/line/
    // shift (the same reads the old 30-day trend did), Scrap = ONE range
    // query. All lines are loaded (Target Status needs combined A+B+C per
    // Date + Shift); the Line filter is applied client-side afterwards.
    const dates = ProductionDataAdapter.dateRange(state.dateTo, check.days);
    let productionResult, scrapResult;
    try {
      [productionResult, scrapResult] = await Promise.all([
        ProductionDataAdapter.getProductionData(window.qdDb, {
          dates, lines: ALL_LINE_CODES, shifts: activeShifts()
        }),
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate: state.dateFrom, endDate: state.dateTo })
      ]);
    } catch (e) {
      console.error('Quality Dashboard: failed to load dashboard data:', e);
      if (seq !== renderSeq) return;
      showBanner('error', '⚠ Could not read data from Firestore. Nothing is shown to avoid displaying incorrect numbers. Try refreshing.');
      renderEmpty();
      return;
    }
    if (seq !== renderSeq) return;

    if (productionResult.errors.length > 0) {
      showBanner('warn', `⚠ ${productionResult.errors.length} production read${productionResult.errors.length > 1 ? 's' : ''} failed for this ${scopeWord} — figures below may be incomplete. Try refreshing.`);
    } else if (scrapResult.error) {
      showBanner('warn', `⚠ Could not read scrap data for this ${scopeWord} — scrap figures may be incomplete. Try refreshing.`);
    } else {
      hideBanner();
    }

    const scrapInScope = scrapResult.records.filter(r => activeShifts().includes(r.shift));

    // Evaluate each Date + Shift on its own against its OWN target
    // (never summed across shifts, never across days).
    const shiftEvals = await getRangeShiftEvaluations(dates, activeShifts(), productionResult.records, scrapInScope);
    if (seq !== renderSeq) return;

    // ---- Top KPI row: Production/Scrap/Rate follow the Line filter,
    // Target Status is the worst-case across every Date + Shift
    // evaluation (OVER > WITHIN > NO DATA).
    const linesInScope = activeLines();
    const lineFilteredProduction = productionResult.records.filter(r => linesInScope.includes(r.line));
    const lineFilteredScrap = scrapInScope.filter(r => linesInScope.includes(r.line));
    renderKpis(lineFilteredProduction, lineFilteredScrap, shiftEvals);

    // ---- Scrap Target & Performance: Day/Night table for one date,
    // range summary + drill-down for several ----
    renderTargetPerformance(shiftEvals, dates);

    // ---- Door Line Comparison: ALWAYS all 3 lines, aggregated over the
    // range; never subject to the per-shift target individually. ----
    renderDoorLineComparison(productionResult.records, scrapInScope);

    // ---- Pareto + Top Defects: respect Line filter, same range ----
    renderPareto(lineFilteredScrap);
    renderTopDefectsList(lineFilteredScrap);

    // ---- Scrap Trend: one daily point per date in the range (no extra fetch) ----
    renderScrapTrend(QualityAdapter.buildDailyTrend(dates, lineFilteredProduction, lineFilteredScrap));

    // ---- Attention Required: re-runs on every render() so it follows the range ----
    renderAttentionRequired(scrapResult);

    $('lastUpdated').textContent =
      'Production V2 (read-only) · Scrap: scrapLogs · Last refreshed ' + new Date().toLocaleTimeString('en-US');
  }

  function renderEmpty() {
    renderKpis(null, [], []);
    $('targetPerfSingle').hidden = false;
    $('targetPerfRange').hidden = true;
    $('targetPerfTableBody').innerHTML = '<tr class="empty-row"><td colspan="5">No data.</td></tr>';
    $('doorLineComparison').innerHTML = '';
    renderScrapTrend([]);
    renderPareto([]);
    renderTopDefectsList([]);
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
    // (a range has one eval per Date + Shift — list each distinct shift/target pair once)
    const seen = new Set();
    return shiftEvals
      .filter(e => { const k = `${e.label}|${e.target}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(e => `${e.label} ≤${fmt(e.target)}`).join(' · ');
  }

  // Short Target rule shown in the Scrap Target & Performance header.
  // Same rule in both modes; the range wording just makes clear that every
  // Date + Shift is judged on its own (never against a range-wide target).
  function targetRuleHtml() {
    const base = '<strong>&le;30 pcs/shift</strong> &middot; A+B+C combined &middot; ';
    if (state.line === 'all') return base + (isMultiDay() ? 'each Date + Shift separate' : 'Day/Night separate');
    return base + (isMultiDay() ? 'each Date + Shift separate &middot; ' : '') + 'Status still uses all lines';
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
      $('targetStripText').innerHTML = targetRuleHtml();
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
      noteEl.textContent = `Target Status uses combined Scrap (Door A+B+C) = ${fmt(combinedScrap)} pcs — not just ${lineLabel}'s ${fmt(displaySummary.totalScrap)} pcs shown above.`
        + (isMultiDay() ? ' Each Date + Shift is judged against its own target.' : '');
    }

    // Short Target strip text — presentation only, same underlying rule
    // as the long version it replaced, just two compact sentences
    // depending on whether a single Line is selected.
    $('targetStripText').innerHTML = targetRuleHtml();

    // Per-shift breakdown, so "one shift went over" is never hidden inside
    // a combined number when Shift = All (or in general, whenever more
    // than one shift is being evaluated at once).
    if (shiftEvals.length > 1 && !isMultiDay()) {
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

  // ---- Scrap Target & Performance -----------------------------------------
  // Pure presentation of shiftEvals, already computed by getRangeShiftEvaluations
  // above (same per-shift target evaluation used everywhere else on this
  // page) — no new target calculation here, just a clearer table view:
  // Shift | Actual Scrap | Target | Gap | Status.

  function renderShiftTargetTable(shiftEvals) {
    const tbody = $('targetPerfTableBody');
    if (!shiftEvals || shiftEvals.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No data.</td></tr>';
      return;
    }
    tbody.innerHTML = shiftEvals.map(e => {
      const statusClass = e.status === 'WITHIN TARGET' ? 'good' : e.status === 'OVER TARGET' ? 'bad' : 'neutral';
      const statusPill = `<span class="qd-status-pill ${statusClass} qd-status-pill-sm">${escapeHtml(e.status)}</span>`;
      if (!e.hasData) {
        return `<tr><td>${escapeHtml(e.label)}</td><td class="num">–</td><td class="num">≤${fmt(e.target)}</td><td class="num">–</td><td>${statusPill}</td></tr>`;
      }
      const gap = e.totalScrap - e.target;
      const gapText = (gap > 0 ? '+' : '') + fmt(gap);
      const gapColor = gap > 0 ? 'var(--red)' : 'var(--green)';
      return `<tr>
        <td>${escapeHtml(e.label)}</td>
        <td class="num">${fmt(e.totalScrap)}</td>
        <td class="num">≤${fmt(e.target)}</td>
        <td class="num" style="color:${gapColor};font-weight:700;">${gapText}</td>
        <td>${statusPill}</td>
      </tr>`;
    }).join('');
  }

  // Multi-day: replace the 2-row Day/Night table with a COUNT of the
  // independent Date + Shift results, plus a drill-down listing each one.
  // Nothing here is a range target — every row keeps its own ≤30 target.
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function renderTargetPerformance(shiftEvals, dates) {
    const single = $('targetPerfSingle');
    const range = $('targetPerfRange');
    if (!isMultiDay()) {
      single.hidden = false;
      range.hidden = true;
      renderShiftTargetTable(shiftEvals);
      return;
    }
    single.hidden = true;
    range.hidden = false;

    const count = status => shiftEvals.filter(e => e.status === status).length;
    const within = count('WITHIN TARGET');
    const over = count('OVER TARGET');
    const noData = count('NO DATA');
    const evaluated = within + over;   // valid shifts = those with production data

    $('targetPerfRangeSummary').innerHTML = `
      <div class="qd-dashboard-range-stat good"><div class="num">${fmt(within)}</div><div class="lbl">Shifts Within</div></div>
      <div class="qd-dashboard-range-stat bad"><div class="num">${fmt(over)}</div><div class="lbl">Shifts Over</div></div>
      <div class="qd-dashboard-range-stat neutral"><div class="num">${fmt(noData)}</div><div class="lbl">No Data</div></div>
      <div class="qd-dashboard-range-stat total"><div class="num">${fmt(evaluated)}</div><div class="lbl">Total Evaluated</div></div>`;

    const spansYears = dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4);
    const fmtDay = d => `${d.slice(8)} ${MONTH_ABBR[parseInt(d.slice(5, 7), 10) - 1]}${spansYears ? ' ' + d.slice(0, 4) : ''}`;
    $('targetPerfDetailBody').innerHTML = shiftEvals.map(e => {
      const statusClass = e.status === 'WITHIN TARGET' ? 'good' : e.status === 'OVER TARGET' ? 'bad' : 'neutral';
      const pill = `<span class="qd-status-pill ${statusClass} qd-status-pill-sm">${escapeHtml(e.status)}</span>`;
      if (!e.hasData) {
        return `<tr><td>${fmtDay(e.date)}</td><td>${escapeHtml(e.label)}</td><td class="num">—</td><td class="num">≤${fmt(e.target)}</td><td class="num">—</td><td>${pill}</td></tr>`;
      }
      const gap = e.totalScrap - e.target;
      return `<tr><td>${fmtDay(e.date)}</td><td>${escapeHtml(e.label)}</td><td class="num">${fmt(e.totalScrap)}</td><td class="num">≤${fmt(e.target)}</td><td class="num" style="color:${gap > 0 ? 'var(--red)' : 'var(--green)'};font-weight:700;">${(gap > 0 ? '+' : '') + fmt(gap)}</td><td>${pill}</td></tr>`;
    }).join('');
  }

  // ---- Door Line Comparison -------------------------------------------
  // Informational only — always compares all 3 lines regardless of the
  // top Line filter (comparison is meaningless with only one line shown).
  // The ≤30pcs/shift target is NEVER applied per-line here, only the
  // combined A+B+C total (enforced elsewhere, in getRangeShiftEvaluations /
  // renderKpis / renderShiftTargetTable) — this section adds Scrap Rate
  // and % contribution to total scrap on top of the same Production/
  // Scrap numbers the old Line Performance cards already showed.

  function renderDoorLineComparison(productionRecords, scrapRecords) {
    const container = $('doorLineComparison');
    container.innerHTML = '';

    const perLine = ALL_LINE_CODES.map(lineCode => {
      const line = LINES.find(l => l.code === lineCode);
      const lineProduction = productionRecords.filter(r => r.line === lineCode);
      const lineScrap = scrapRecords.filter(r => r.line === lineCode);
      const production = lineProduction.reduce((s, r) => s + r.productionQty, 0);
      const scrap = lineScrap.reduce((s, r) => s + r.scrapQty, 0);
      const rate = QualityAdapter.pct(scrap, production);
      return { line, production, scrap, rate, hasAnyDoc: lineProduction.length > 0 };
    });

    const totalScrapAllLines = perLine.reduce((s, p) => s + p.scrap, 0);
    const maxScrap = Math.max(...perLine.map(p => p.scrap));

    perLine.forEach(p => {
      const contribution = totalScrapAllLines > 0 ? (p.scrap / totalScrapAllLines) * 100 : null;
      const isHighest = p.scrap > 0 && p.scrap === maxScrap;

      const card = document.createElement('div');
      card.className = 'qd-dashboard-doorline-card' + (isHighest ? ' qd-dashboard-doorline-card-highest' : '');
      card.innerHTML = `
        <div class="qd-dashboard-doorline-head">
          <div class="qd-line-badge line-${p.line.code}">${p.line.code}</div>
          <div class="qd-dashboard-doorline-name">${p.line.label}</div>
        </div>
        <div class="qd-dashboard-doorline-prod"><span class="num">${p.hasAnyDoc ? fmt(p.production) : '–'}</span><span class="unit">pcs</span></div>
        <div class="qd-dashboard-doorline-prodlabel">Production</div>
        <div class="qd-dashboard-doorline-metrics">
          <div><span class="k">Scrap</span><span class="v${p.scrap === 0 ? ' zero' : ' bad'}">${fmt(p.scrap)}</span></div>
          <div><span class="k">Rate</span><span class="v">${p.rate === null ? 'N/A' : fmtPct(p.rate)}</span></div>
          <div><span class="k">Share</span><span class="v">${contribution === null ? '–' : contribution.toFixed(0) + '%'}</span></div>
        </div>`;
      container.appendChild(card);
    });
  }

  // ---- By Model -----------------------------------------------------------
  // NOTE: no longer called from render() above — the "Production & Scrap
  // by Model" table was removed from the executive Dashboard layout per
  // the redesign (detailed Model-level data belongs on Scrap Detail /
  // later review pages). Kept here, unmodified and unused, since the
  // function and QualityAdapter.buildByModel() may still be useful
  // elsewhere.

  async function renderByModel(lineCodes, scrapRecordsInScope) {
    const tbody = $('modelTableBody');
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Loading…</td></tr>';

    let byModelResult;
    try {
      byModelResult = await ProductionDataAdapter.getProductionDataByModel(window.qdDb, {
        dates: [state.dateTo], lines: lineCodes, shifts: activeShifts()
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

  // Compact Top 3–5 defect list alongside the Pareto chart — reuses the
  // SAME pure QualityAdapter.buildParetoDefects() computation the chart
  // above already uses (no new Firestore read; this just also derives
  // each defect's individual % of total scrap from the same result).
  // Owns the shared empty-state for the whole Top Defects / Pareto layout
  // (table + chart together) — a single clean "No defects recorded in
  // this scope." panel instead of a tall blank table next to a tall
  // blank chart. Uses the Dashboard-specific .qd-dashboard-top-defect-row
  // class (never Scrap Detail's .qd-top-defect-row).
  function renderTopDefectsList(scrapRecords) {
    const list = $('topDefectsList');
    const tableWrap = $('topDefectsTableWrap');
    const chartHolder = $('paretoChartHolder');
    const layout = $('paretoLayout');
    const data = QualityAdapter.buildParetoDefects(scrapRecords);

    const existingEmpty = layout.querySelector('.qd-dashboard-pareto-empty');
    if (existingEmpty) existingEmpty.remove();

    if (data.length === 0) {
      tableWrap.style.display = 'none';
      chartHolder.style.display = 'none';
      list.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'qd-dashboard-pareto-empty';
      empty.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <span>No defects recorded in this scope.</span>`;
      layout.appendChild(empty);
      return;
    }

    tableWrap.style.display = '';
    chartHolder.style.display = '';
    const totalQty = data.reduce((s, d) => s + d.qty, 0);
    const top = data.slice(0, 5);
    list.innerHTML = top.map((d, i) => `
      <div class="qd-dashboard-top-defect-row">
        <span>${i + 1}</span>
        <span>${escapeHtml(d.defectType)}</span>
        <span>${fmt(d.qty)} pcs</span>
        <span>${totalQty > 0 ? ((d.qty / totalQty) * 100).toFixed(0) + '%' : '–'}</span>
      </div>`).join('');
  }

  // ---- Trends ---------------------------------------------------------

  // Scrap Trend has no range buttons of its own any more: renderScrapTrend()
  // is fed one daily point per date of the selected Date Range, built in
  // render() from the data already loaded for the whole page (no extra
  // fetch), with the same Line + Shift filtering as the KPIs.

  // NOTE: no longer called from anywhere — the standalone
  // Production Trend panel was removed from the executive Dashboard
  // layout per the redesign. Kept here, unmodified, since the function
  // (and the trendChart variable below) may still be useful elsewhere.
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

  // Hides the Chart.js canvas and shows a compact message (same visual
  // language as the Top Defects empty state — .qd-dashboard-pareto-empty
  // is reused as-is) when NOTHING across the whole trend range has any
  // production or scrap — a day with production>0/scrap=0, or
  // production=0/scrap>0, still counts as meaningful and shows the real
  // chart. Does not touch the underlying daily-trend calculation at all.
  function renderScrapTrend(points) {
    const holder = $('scrapTrendChartHolder');
    const existingEmpty = holder.parentElement.querySelector('.qd-dashboard-pareto-empty');
    if (existingEmpty) existingEmpty.remove();

    const hasMeaningfulData = points.some(p => p.production > 0 || p.scrap > 0);
    if (!hasMeaningfulData) {
      if (scrapTrendChart) { scrapTrendChart.destroy(); scrapTrendChart = null; }
      holder.style.display = 'none';
      const empty = document.createElement('div');
      empty.className = 'qd-dashboard-pareto-empty';
      empty.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>
        <span>No production or scrap data in this period.</span>`;
      holder.insertAdjacentElement('afterend', empty);
      return;
    }
    holder.style.display = '';

    if (typeof Chart === 'undefined') return;
    // Every daily point is kept and labelled with its FULL date, so the
    // tooltip title is always the exact date. Only the x-axis TICK text is
    // shortened: 'MM-DD' for short ranges (<= 7 points, as before), the
    // bare day number when a longer range stays inside one month, 'MM-DD'
    // when it crosses months — and, for long ranges, labels (never data
    // points) are auto-skipped so they cannot overlap.
    const longRange = points.length > 7;
    const sameMonth = points.every(p => p.date.slice(0, 7) === points[0].date.slice(0, 7));
    const labels = points.map(p => p.date);
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
        x: { grid: { display: false }, ticks: Object.assign({
          font: { family: "'JetBrains Mono', monospace", size: 10 },
          callback: function (value) {
            const d = String(this.getLabelForValue(value));
            return (longRange && sameMonth) ? d.slice(-2).replace(/^0/, '') : d.slice(5);
          }
        }, longRange ? { autoSkip: true, maxRotation: 0, autoSkipPadding: 8 } : {}) },
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

  // ---- Attention Required (merges the old separate Improvement Status
  // and Recurring Problems panels into one compact section) --------------
  // Both halves below call the EXACT SAME adapter functions the old two
  // panels used (ImprovementAdapter.getImprovements, QualityAdapter.
  // buildRecurringProblems, ScrapDataAdapter.getScrapData) — only the
  // presentation is merged/condensed; no new data source, no invented
  // statuses beyond IMPROVEMENT_STATUSES, which already exists.

  async function fetchImprovementStatusCounts() {
    if (typeof ImprovementAdapter === 'undefined' || window.qdFirebaseError) return { error: true };
    try {
      const { records, error } = await ImprovementAdapter.getImprovements(window.qdDb, { limit: 200 });
      if (error) return { error: true };
      const counts = {};
      IMPROVEMENT_STATUSES.forEach(s => { counts[s] = 0; });
      records.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
      return { error: false, counts, total: records.length };
    } catch (e) {
      console.error('Quality Dashboard: failed to load improvement status:', e);
      return { error: true };
    }
  }

  // Single date (From = To): unchanged — the existing 30-day lookback ending
  // at that date. Several dates: the selected range itself, using the scrap
  // render() already loaded for the whole page (no extra query); a problem
  // still has to occur on RECURRING_THRESHOLD_DISTINCT_DATES different days
  // inside that range to count as recurring.
  async function fetchRecurringProblems(rangeScrapResult) {
    if (window.qdFirebaseError) return { error: true };
    try {
      if (isMultiDay()) {
        if (!rangeScrapResult || rangeScrapResult.error) return { error: true };
        const groups = QualityAdapter.buildRecurringProblems(rangeScrapResult.records, RECURRING_THRESHOLD_DISTINCT_DATES).filter(g => g.recurring);
        return { error: false, groups, scope: 'range' };
      }
      const lookbackDates = ProductionDataAdapter.dateRange(state.dateTo, 30);
      const scrapResult = await ScrapDataAdapter.getScrapData(window.qdDb, { startDate: lookbackDates[0], endDate: lookbackDates[lookbackDates.length - 1] });
      if (scrapResult.error) return { error: true };
      const groups = QualityAdapter.buildRecurringProblems(scrapResult.records, RECURRING_THRESHOLD_DISTINCT_DATES).filter(g => g.recurring);
      return { error: false, groups, scope: '30d' };
    } catch (e) {
      console.error('Quality Dashboard: failed to load recurring problems:', e);
      return { error: true };
    }
  }

  // "Last Seen" is a real derived value — the most recent entry in
  // buildRecurringProblems()'s own `dates` array (sorted ascending), not
  // an invented field — expressed relative to the Dashboard's currently
  // selected range's To date (state.dateTo), same reference point the
  // rest of the page uses.
  function daysAgoLabel(dateStr) {
    const target = new Date(dateStr + 'T00:00:00');
    const ref = new Date(state.dateTo + 'T00:00:00');
    const diffDays = Math.round((ref - target) / 86400000);
    if (diffDays <= 0) return 'today';
    if (diffDays === 1) return '1d ago';
    return diffDays + 'd ago';
  }

  async function renderAttentionRequired(rangeScrapResult) {
    const seq = renderSeq;
    const container = $('attentionSummary');
    container.innerHTML = '<div class="qd-placeholder">Loading…</div>';

    const [impResult, recResult] = await Promise.all([fetchImprovementStatusCounts(), fetchRecurringProblems(rangeScrapResult)]);
    if (seq !== renderSeq) return;   // a newer render() owns this panel now
    const parts = [];

    parts.push(`
      <div class="qd-dashboard-attention-block">
        <div class="qd-dashboard-attention-head">
          <div class="qd-dashboard-attention-title">
            <span class="qd-dashboard-attention-dot blue"></span>
            Recurring Problems${recResult.error ? '' : ` <span class="qd-dashboard-attention-count">${recResult.groups.length}</span>`}
          </div>
          <a class="qd-link-btn" href="scrap-detail.html">View in Scrap Detail →</a>
        </div>
        ${recResult.error
          ? '<div class="qd-placeholder">Could not load recurring problems.</div>'
          : recResult.groups.length === 0
            ? `<div class="qd-placeholder">${
                recResult.scope === 'range'
                  ? (daysInclusive(state.dateFrom, state.dateTo) < RECURRING_THRESHOLD_DISTINCT_DATES
                      ? `Range is shorter than ${RECURRING_THRESHOLD_DISTINCT_DATES} days — a recurring problem needs ${RECURRING_THRESHOLD_DISTINCT_DATES}+ different days.`
                      : 'No recurring problems in this date range.')
                  : 'No recurring problems in the last 30 days.'}</div>`
            : `<div class="qd-table-scroll"><table class="qd-datatable qd-dashboard-table">
                <thead><tr><th>#</th><th>Defect / Issue</th><th>Last Seen</th><th>Qty</th></tr></thead>
                <tbody>${recResult.groups.slice(0, 5).map((g, i) => `
                  <tr>
                    <td class="num">${i + 1}</td>
                    <td>${escapeHtml(g.line)} &middot; ${escapeHtml(g.model)} &middot; ${escapeHtml(g.defectType)}</td>
                    <td>${escapeHtml(daysAgoLabel(g.dates[g.dates.length - 1]))}</td>
                    <td class="num">${fmt(g.totalQty)}</td>
                  </tr>`).join('')}</tbody>
              </table></div>`}
      </div>`);

    parts.push(`
      <div class="qd-dashboard-attention-block">
        <div class="qd-dashboard-attention-head">
          <div class="qd-dashboard-attention-title">
            <span class="qd-dashboard-attention-dot blue"></span>
            Improvement Records${!impResult.error ? ` <span class="qd-dashboard-attention-count">${impResult.total}</span>` : ''}
          </div>
          <a class="qd-link-btn" href="improvement.html">View in Improvement →</a>
        </div>
        ${impResult.error
          ? '<div class="qd-placeholder">Could not load improvement records.</div>'
          : impResult.total === 0
            ? '<div class="qd-placeholder">No improvement records yet.</div>'
            : `<div class="qd-dashboard-improvement-stats">${IMPROVEMENT_STATUSES.map(s => `
                <div class="qd-dashboard-improvement-stat ${statusAccentClass(s)}"><div class="count">${impResult.counts[s] || 0}</div><div class="label">${escapeHtml(s)}</div></div>`).join('')}</div>`}
      </div>`);

    container.innerHTML = parts.join('');
  }

  // Purely a visual accent choice (not new business logic) matching the
  // mockup's per-status coloring; the status VALUES themselves are still
  // only ever IMPROVEMENT_STATUSES, nothing invented.
  function statusAccentClass(status) {
    if (status === 'Controlled') return 'green';
    if (status === 'Not Effective') return 'amber';
    if (status === 'Recurring') return 'red';
    return 'blue'; // Monitoring
  }

  // ---- Event wiring (top filters) ---------------------------------------------------

  // Either date changing re-runs render(); an invalid combination is
  // reported by render() itself and never fetched.
  function onDateRangeChange() {
    state.dateFrom = $('dateFrom').value;
    state.dateTo = $('dateTo').value;
    render();
  }
  $('dateFrom').addEventListener('change', onDateRangeChange);
  $('dateTo').addEventListener('change', onDateRangeChange);

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

  // Refresh button: just re-runs the existing render() pipeline on
  // demand — no new fetch, no new adapter call, purely a convenience
  // trigger for the same data flow the filters already use.
  $('refreshBtn').addEventListener('click', () => { render(); });

  // ---- Mobile sidebar drawer (UI-only — no data/business logic) ---------
  // Dashboard-only; the sidebar itself replaces the shared top nav on
  // this page only (see index.html comment) — this wiring never touches
  // nav.js or any other page.
  (function wireMobileSidebar() {
    const sidebar = $('dashboardSidebar');
    const toggle = $('dashboardMobileToggle');
    const overlay = $('dashboardSidebarOverlay');
    if (!sidebar || !toggle || !overlay) return;
    const open = () => { sidebar.classList.add('open'); overlay.classList.add('open'); };
    const close = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };
    toggle.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open());
    overlay.addEventListener('click', close);
  })();

  // ---- Boot ---------------------------------------------------------------
  // renderAttentionRequired() is called from inside render() itself now
  // (see above) — not separately here — so it refreshes on every Date/
  // Shift/Line filter change, not just once at boot, and isn't called
  // twice on first load.

  render();
})();
