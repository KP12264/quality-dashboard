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
 * TARGET has TWO rules, chosen per production date (config.js
 * TARGET_DAILY_RULE_EFFECTIVE_DATE = 2026-10-01) and judged ONLY by
 * js/target-evaluator.js, which the Executive Report uses too:
 *   before 2026-10-01: ≤30 pcs PER SHIFT (Door A+B+C combined), Day and
 *                      Night judged separately, per-shift target from targetMaster.
 *   from   2026-10-01: ≤50 pcs PER DAY (Door A+B+C AND Day+Night combined),
 *                      one judgement per production date.
 * Each date is judged on its own (a Date Range is never one big total), and
 * the daily judgement ignores the Shift filter: both shifts are always
 * loaded for those dates. Production / Scrap / Scrap Rate in the KPI row
 * still follow the Line and Shift filters. Status is OVER if any unit is
 * over, INCOMPLETE if nothing is over but something cannot be confirmed
 * (missing shift, failed read, no scrap log), else WITHIN. A failed read is
 * never shown as "scrap = 0" or WITHIN. The UI notes explain all of this.
 * ------------------------------------------------------------------
 */

(function () {
  // V5: charts use the page font (IBM Plex Sans Thai Looped), never a monospace face.
  const V5_CHART_FONT = "'IBM Plex Sans Thai Looped','IBM Plex Sans Thai','Noto Sans Thai','Leelawadee UI','Tahoma',sans-serif";

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
  let scrapLoadFailed = false;   // a failed scrap read must never look like "scrap = 0" or WITHIN

  let trendChart = null;
  let scrapTrendChart = null;

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
  function rangeLabelText() {
    const f = d => `${d.slice(8)} ${MONTH_ABBR[parseInt(d.slice(5, 7), 10) - 1]} ${d.slice(0, 4)}`;
    return state.dateFrom === state.dateTo ? f(state.dateFrom) : `${f(state.dateFrom)} – ${f(state.dateTo)}`;
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

  // ---- Target evaluation lives in js/target-evaluator.js (shared with the Executive Report) ----

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
    $('scrapTrendRangeLabel').textContent = check.ok ? rangeLabelText() : '';
    $('topDefectsRangeLabel').textContent = check.ok ? rangeLabelText() : '';
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
    // Dates on the daily (≤50/day) rule need BOTH shifts whatever the Shift
    // filter says, so a single-shift filter reads more production documents
    // for those dates (documented); legacy dates read only the active shifts.
    const fetchPlan = TargetEvaluator.productionFetchPlan(dates, activeShifts());
    let productionResult, scrapResult;
    try {
      const results = await Promise.all([
        ...fetchPlan.map(g => ProductionDataAdapter.getProductionData(window.qdDb, { dates: g.dates, lines: ALL_LINE_CODES, shifts: g.shifts })),
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate: state.dateFrom, endDate: state.dateTo })
      ]);
      scrapResult = results[results.length - 1];
      const groups = results.slice(0, -1);
      productionResult = {
        records: groups.flatMap(g => g.records),
        missing: groups.flatMap(g => g.missing),
        errors: groups.flatMap(g => g.errors)
      };
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
      showBanner('warn', `⚠ Could not read scrap data for this ${scopeWord} — scrap figures are not shown and Status cannot be confirmed. Try refreshing.`);
    } else {
      hideBanner();
    }

    scrapLoadFailed = !!scrapResult.error;
    // Display scope: the Shift filter applies to what is SHOWN (Production/Scrap/Rate, Door Line,
    // Pareto, Trend). The target judgement below always gets every loaded record.
    const productionInScope = productionResult.records.filter(r => activeShifts().includes(r.shift));
    const scrapInScope = scrapResult.records.filter(r => activeShifts().includes(r.shift));

    // Judge every date (daily rule) / date+shift (legacy rule) on its own, using ONLY Door A/B/C.
    const shiftTargets = await TargetEvaluator.loadShiftTargetContext(window.qdDb, dates, activeShifts());
    if (seq !== renderSeq) return;
    const shiftEvals = TargetEvaluator.evaluate({
      dates, activeShiftCodes: activeShifts(),
      production: productionResult.records, scrap: scrapResult.records,
      scrapReadFailed: scrapLoadFailed, productionErrors: productionResult.errors, shiftTargets
    });

    // ---- Top KPI row: Production/Scrap/Rate follow the Line filter,
    // Target Status is the worst-case across every Date + Shift
    // evaluation (OVER > WITHIN > NO DATA).
    const linesInScope = activeLines();
    const lineFilteredProduction = productionInScope.filter(r => linesInScope.includes(r.line));
    const lineFilteredScrap = scrapInScope.filter(r => linesInScope.includes(r.line));
    renderKpis(lineFilteredProduction, lineFilteredScrap, shiftEvals);

    // ---- Target Performance detail (opened from the KPI's View Details):
    // range summary + per-date / per-shift table ----
    renderTargetPerformance(shiftEvals, dates);

    // ---- Door Line Comparison: ALWAYS all 3 lines, aggregated over the
    // range; never subject to the per-shift target individually. ----
    renderDoorLineComparison(productionInScope, scrapInScope);

    // ---- Pareto + Top Defects: respect Line filter, same range ----
    renderPareto(lineFilteredScrap);
    renderTopDefectsList(lineFilteredScrap);

    // ---- Scrap Trend: one daily point per date in the range (no extra fetch) ----
    let trendPoints = QualityAdapter.buildDailyTrend(dates, lineFilteredProduction, lineFilteredScrap);
    // A failed scrap read must not draw zero-height "no scrap" bars.
    if (scrapLoadFailed) trendPoints = trendPoints.map(p => ({ ...p, scrap: null, scrapRatePct: null }));
    renderScrapTrend(trendPoints, trendTargetLine(dates), shiftEvals);

    // ---- Attention Required: re-runs on every render() so it follows the range ----
    renderAttentionRequired(scrapResult);

    // Same moment as before (new Date()); only the layout changed: time on line 1, date on line 2.
    // The data-source note that used to share this chip stays in the page footer.
    const refreshedAt = new Date();
    $('lastUpdated').textContent = 'Last refreshed ' + refreshedAt.toLocaleTimeString('en-US') + '\n'
      + `${String(refreshedAt.getDate()).padStart(2, '0')} ${MONTH_ABBR[refreshedAt.getMonth()]} ${refreshedAt.getFullYear()}`;
  }

  // Target ≤50/day reference for the Scrap Trend. Valid ONLY for All Lines + All Shifts
  // (the target is for Door A+B+C, Day+Night) and ONLY on dates under the daily rule, so it is
  // drawn from the first daily-rule date on and never presented as one target for a whole
  // range that also contains pre-cutover (per-shift) dates.
  function trendTargetLine(dates) {
    if (state.shift !== 'all' || state.line !== 'all') return null;
    const idx = dates.map((d, i) => TargetEvaluator.ruleFor(d) === 'DAY' ? i : -1).filter(i => i >= 0);
    if (idx.length === 0) return null;
    const partial = idx.length < dates.length;
    return {
      value: DAILY_TARGET_PCS, startIndex: idx[0], endIndex: idx[idx.length - 1],
      label: partial ? `Target ≤${fmt(DAILY_TARGET_PCS)}/day (from ${TargetEvaluator.formatCutoverDate()})` : `Target ≤${fmt(DAILY_TARGET_PCS)}/day`
    };
  }

  function renderEmpty() {
    renderKpis(null, [], []);
    $('targetPerfSingle').hidden = true;
    $('targetPerfRange').hidden = false;
    $('targetPerfRangeSummary').innerHTML = ['Within', 'Over', 'Incomplete', 'No Data', 'Total Evaluated'].map((l, i) =>
      `<div class="qd-dashboard-range-stat ${['good', 'bad', 'warn', 'neutral', 'total'][i]}"><div class="num">–</div><div class="lbl">${l}</div></div>`).join('');
    $('targetPerfDetailBody').innerHTML = '';
    $('doorLineComparison').innerHTML = '';
    renderScrapTrend([], null, []);
    renderPareto([]);
    renderTopDefectsList([]);
  }

  // ---- KPI cards --------------------------------------------------------

  // V5: the level is a data attribute the scoped CSS reads (red only for 'bad').
  // Null-safe so a missing card can never break render().
  function setKpiStatus(kpiEl, level) {
    if (!kpiEl) return;
    kpiEl.dataset.level = level || 'neutral';
  }
  const kpiCard = key => { const sec = $('kpiSection'); return sec ? sec.querySelector(`[data-kpi="${key}"]`) : null; };

  // ---- Target wording (all of it comes from the shared evaluator's description) ----

  // Which rule(s) the SELECTED range uses, even before any data is loaded.
  function rangeRuleUnits() {
    const mk = d => TargetEvaluator.ruleFor(d) === 'DAY' ? { unit: 'DAY' } : { unit: 'SHIFT', label: 'Day', target: 30 };
    return [mk(state.dateFrom), mk(state.dateTo)];
  }

  // Short Target rule shown in the Target tooltip and the Target Performance detail header.
  function targetRuleHtml() {
    const base = TargetEvaluator.describeTarget(rangeRuleUnits(), fmt).ruleText;
    return base + (isMultiDay() ? ' &middot; each date judged separately' : '')
      + (state.line === 'all' ? '' : ' &middot; Status still uses all lines');
  }

  function setTargetRuleText() {
    const html = targetRuleHtml();
    $('targetStripText').innerHTML = html;
    $('targetDetailRule').innerHTML = html;
  }

  // Status pill / tile colour class for a status string.
  function statusClassOf(status) {
    return status === 'WITHIN TARGET' ? 'good' : status === 'OVER TARGET' ? 'bad' : status === 'INCOMPLETE' ? 'warn' : 'neutral';
  }

  // Helper under the Status pill: counts of the SAME evaluations that drive the status,
  // kept separate for days and shifts.
  function statusHelperText(units) {
    const sum = TargetEvaluator.summarize(units);
    const unitWord = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const overParts = [];
    if (sum.days.over) overParts.push(unitWord(sum.days.over, 'day'));
    if (sum.shifts.over) overParts.push(unitWord(sum.shifts.over, 'shift'));
    if (overParts.length) return `${overParts.join(' · ')} over target`;
    const incParts = [];
    if (sum.days.incomplete) incParts.push(unitWord(sum.days.incomplete, 'day'));
    if (sum.shifts.incomplete) incParts.push(unitWord(sum.shifts.incomplete, 'shift'));
    if (incParts.length) return `${incParts.join(' · ')} incomplete — cannot confirm`;
    const what = sum.mixed ? 'days/shifts' : (sum.hasDays ? 'days' : 'shifts');
    return (sum.days.within + sum.shifts.within) > 0 ? `All evaluated ${what} within target` : `No evaluated ${what}`;
  }

  // Scrap Cost: only the cost stored on each scrap record (Amt. from the Excel
  // import). Never estimated. If some records in scope have no cost, the sum is
  // shown as incomplete; if none have one, N/A.
  function scrapCostSummary(records) {
    let total = 0, withCost = 0;
    records.forEach(r => {
      const c = r.scrapCost === null || r.scrapCost === undefined || r.scrapCost === '' ? NaN : Number(r.scrapCost);
      if (Number.isFinite(c)) { total += c; withCost++; }
    });
    return { total, withCost, count: records.length };
  }
  const fmtBaht = n => '฿' + Math.round(n).toLocaleString('en-US');
  // Big totals are shortened on the card (฿1.33M); the exact amount is in the sub line.
  const fmtBahtShort = n => Math.abs(n) >= 1e6 ? '฿' + (n / 1e6).toFixed(2) + 'M' : fmtBaht(n);

  // Counts strip under Target Performance: same units as the status (shared evaluator).
  function targetCountsHtml(units) {
    const sum = TargetEvaluator.summarize(units);
    const W = sum.days.within + sum.shifts.within, O = sum.days.over + sum.shifts.over;
    const I = sum.days.incomplete + sum.shifts.incomplete, N = sum.days.noData + sum.shifts.noData;
    const unit = sum.mixed ? 'days/shifts' : (sum.hasDays ? 'days' : 'shifts');
    const c = (cls, n, label) => `<span class="v5-count ${cls}"><b>${fmt(n)}</b> ${label}</span>`;
    return `<span class="v5-counts-unit">${unit}:</span>` + c('good', W, 'Within') + c('bad', O, 'Over') + c('warn', I, 'Incomplete') + c('neutral', N, 'No Data');
  }

  function renderKpis(displayProductionRecords, displayScrapRecords, shiftEvals) {
    const targetEl = $('kpiTarget');
    const scrapEl = $('kpiScrap');
    const scrapRateEl = $('kpiScrapRate');
    const costEl = $('kpiScrapCost');
    const statusEl = $('kpiStatus');
    const noteEl = $('kpiStatusNote');

    if (!displayProductionRecords) {
      scrapEl.textContent = '–';
      scrapRateEl.textContent = '–';
      costEl.textContent = '–';
      targetEl.textContent = '–';
      $('kpiTargetUnitText').textContent = 'pcs scrap';
      $('kpiTargetCounts').innerHTML = '';
      statusEl.textContent = '–';
      statusEl.className = 'qd-status-pill neutral';
      noteEl.textContent = '';
      setTargetRuleText();
      $('kpiScrapUnit').textContent = '–';
      $('kpiScrapRateUnit').textContent = '–';
      $('kpiScrapCostSub').textContent = '–';
      ['scrap', 'scrapRate', 'cost', 'status'].forEach(k => setKpiStatus(kpiCard(k), 'neutral'));
      return;
    }

    // Displayed Production/Scrap/Rate respect the Line and Shift filters (target arg
    // is irrelevant here — we don't use this summary's .status).
    const displaySummary = QualityAdapter.buildOverallSummary(displayProductionRecords, displayScrapRecords, NaN);
    // Target Status: judged by the shared evaluator, one unit per date (daily rule) or per
    // date+shift (legacy rule); OVER > INCOMPLETE > WITHIN > NO DATA. Never a summed target.
    const combinedStatus = TargetEvaluator.combineStatuses(shiftEvals);
    const targetDesc = TargetEvaluator.describeTarget(shiftEvals, fmt);

    // Card 1 — Scrap Total
    if (scrapLoadFailed) {
      // A failed read must never look like "scrap = 0".
      scrapEl.textContent = 'N/A'; scrapEl.classList.add('na');
      scrapRateEl.textContent = 'N/A'; scrapRateEl.classList.add('na');
    } else {
      scrapEl.textContent = fmt(displaySummary.totalScrap);
      scrapEl.classList.remove('na');
      scrapRateEl.textContent = fmtPct(displaySummary.scrapRatePct);
      scrapRateEl.classList.toggle('na', !Number.isFinite(displaySummary.scrapRatePct));
    }
    $('kpiScrapUnit').textContent = scrapLoadFailed ? 'Scrap data could not be read'
      : displayScrapRecords.length > 0 ? `${fmt(displayScrapRecords.length)} scrap record${displayScrapRecords.length === 1 ? '' : 's'}` : 'No scrap recorded in this scope';

    // Card 2 — Scrap Rate, with Production as the secondary line
    $('kpiScrapRateUnit').innerHTML = scrapLoadFailed ? 'Scrap data could not be read'
      : `Production <b>${fmt(displaySummary.totalProduction)}</b> pcs`
        + (Number.isFinite(displaySummary.scrapRatePct) ? '' : ' · no production in this scope');

    // Card 3 — Scrap Cost (stored values only)
    const cost = scrapCostSummary(displayScrapRecords);
    let costLevel = 'neutral';
    if (scrapLoadFailed) {
      costEl.textContent = 'N/A'; costEl.classList.add('na');
      $('kpiScrapCostSub').textContent = 'Scrap data could not be read';
    } else if (cost.count === 0) {
      costEl.textContent = '–'; costEl.classList.add('na');
      $('kpiScrapCostSub').textContent = 'No scrap recorded in this scope';
    } else if (cost.withCost === 0) {
      costEl.textContent = 'N/A'; costEl.classList.add('na');
      $('kpiScrapCostSub').textContent = 'No cost on these records (manual entries carry no cost)';
    } else {
      costEl.textContent = fmtBahtShort(cost.total); costEl.classList.remove('na');
      costEl.title = fmtBaht(cost.total);
      if (cost.withCost < cost.count) {
        costLevel = 'warn';
        $('kpiScrapCostSub').textContent = `Incomplete: ${fmt(cost.count - cost.withCost)} of ${fmt(cost.count)} records have no cost`;
      } else {
        $('kpiScrapCostSub').textContent = `${fmt(cost.count)} scrap record${cost.count === 1 ? '' : 's'}`;
      }
    }

    // Card 4 — Target Performance
    targetEl.textContent = targetDesc.label;
    $('kpiTargetUnitText').textContent = targetDesc.unitText;
    statusEl.textContent = combinedStatus;
    statusEl.className = 'qd-status-pill ' + statusClassOf(combinedStatus);
    $('kpiTargetCounts').innerHTML = shiftEvals.length ? targetCountsHtml(shiftEvals) : '';

    // Notes under the KPI row: Line filter, Shift filter (the daily judgement
    // ignores it) and the multi-day reminder.
    const notes = [];
    if (state.line !== 'all' && !scrapLoadFailed) {
      const combinedScrap = shiftEvals.reduce((s, e) => s + (e.totalScrap || 0), 0);
      const lineLabel = (LINES.find(l => l.code === state.line) || {}).label || state.line;
      notes.push(`Target Status uses combined Scrap (Door A+B+C) = ${fmt(combinedScrap)} pcs — not just ${lineLabel}'s ${fmt(displaySummary.totalScrap)} pcs shown above.`
        + (isMultiDay() ? (shiftEvals.some(e => e.unit === 'DAY') ? ' Each date is judged against its own target.' : ' Each Date + Shift is judged against its own target.') : ''));
    }
    if (state.shift !== 'all' && shiftEvals.some(e => e.unit === 'DAY')) {
      const shiftName = (SHIFTS.find(x => x.code === state.shift) || {}).label || state.shift;
      notes.push(`From ${TargetEvaluator.formatCutoverDate()}, Status is judged on Day + Night combined (≤${fmt(DAILY_TARGET_PCS)} pcs/day) even though only ${shiftName} is shown above.`);
    }
    if (targetDesc.mode === 'MIXED') {
      notes.push(`This range uses two target rules: ≤30 pcs/shift before ${TargetEvaluator.formatCutoverDate()}, ≤${fmt(DAILY_TARGET_PCS)} pcs/day from then on.`);
    }
    noteEl.textContent = notes.join(' ');

    setTargetRuleText();

    setKpiStatus(kpiCard('scrap'), scrapLoadFailed ? 'neutral' : combinedStatus === 'OVER TARGET' ? 'bad' : 'neutral');
    setKpiStatus(kpiCard('scrapRate'), 'neutral');
    setKpiStatus(kpiCard('cost'), costLevel);
    setKpiStatus(kpiCard('status'), statusClassOf(combinedStatus));
  }

  // ---- Scrap Target & Performance -----------------------------------------
  // Pure presentation of the units produced by js/target-evaluator.js (the same
  // units the Executive Report uses): one unit per date on the daily rule,
  // one per date + shift on the legacy rule. Nothing is re-judged here.

  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "View Details" on the Target Performance KPI shows / hides the detail panel under the KPI row.
  // The panel is filled on every render() whether open or not, so opening it never reads Firestore.
  function setPerfDetailOpen(open) {
    const panel = $('targetDetailPanel'), b = $('targetPerfDetailBtn');
    panel.hidden = !open;
    b.textContent = open ? 'Hide Details' : 'View Details →';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function renderTargetPerformance(units, dates) {
    $('targetPerfSingle').hidden = true;
    $('targetPerfRange').hidden = false;

    // Counts stay SEPARATE for days (≤50/day rule) and shifts (≤30/shift rule). When a range spans
    // the rule change, the tiles show the day/shift split instead of one combined percentage.
    const sum = TargetEvaluator.summarize(units);
    const W = sum.days.within + sum.shifts.within, O = sum.days.over + sum.shifts.over;
    const I = sum.days.incomplete + sum.shifts.incomplete, N = sum.days.noData + sum.shifts.noData;
    const evaluated = W + O;   // judged units: within + over
    const word = sum.mixed ? '' : (sum.hasDays ? 'Days ' : 'Shifts ');
    const unitName = sum.mixed ? 'units' : (sum.hasDays ? 'days' : 'shifts');
    const split = (d, s) => `${fmt(d)} day${d === 1 ? '' : 's'} · ${fmt(s)} shift${s === 1 ? '' : 's'}`;
    const pctOfEval = n => (!sum.mixed && evaluated > 0) ? Math.round(n / evaluated * 100) + '%' : '–';
    const tile = (cls, num, label, sub) => `<div class="qd-dashboard-range-stat ${cls}"><div class="num">${fmt(num)}</div><div class="lbl">${label}</div><div class="sub">${sub}</div></div>`;
    $('targetPerfRangeSummary').innerHTML =
      tile('good', W, `${word}Within`, sum.mixed ? split(sum.days.within, sum.shifts.within) : pctOfEval(W))
      + tile('bad', O, `${word}Over`, sum.mixed ? split(sum.days.over, sum.shifts.over) : pctOfEval(O))
      + tile('warn', I, 'Incomplete', sum.mixed ? split(sum.days.incomplete, sum.shifts.incomplete) : (I > 0 ? 'not confirmed' : '–'))
      + tile('neutral', N, 'No Data', sum.mixed ? split(sum.days.noData, sum.shifts.noData) : '–')
      + tile('total', evaluated, 'Total Evaluated', sum.mixed ? split(sum.days.within + sum.days.over, sum.shifts.within + sum.shifts.over) : `of ${fmt(W + O + I + N)} ${unitName}`);

    const spansYears = dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4);
    const fmtDay = d => `${d.slice(8)} ${MONTH_ABBR[parseInt(d.slice(5, 7), 10) - 1]}${spansYears ? ' ' + d.slice(0, 4) : ''}`;
    $('targetPerfDetailBody').innerHTML = units.map(u => {
      const pill = `<span class="qd-status-pill ${statusClassOf(u.status)} qd-status-pill-sm">${escapeHtml(u.status)}</span>`;
      const reasons = u.reasons.length ? `<span class="qd-reason">${u.reasons.map(c => escapeHtml(TargetEvaluator.reasonText(c))).join(' · ')}</span>` : '';
      const targetText = `≤${fmt(u.target)}/${u.unit === 'DAY' ? 'day' : 'shift'}`;
      const judged = u.totalScrap !== null && u.scrapKnown !== false && u.status !== 'NO DATA' && (u.unit === 'DAY' || u.hasData);
      const split = (judged && u.unit === 'DAY') ? `<span class="qd-sub">Day ${fmt(u.shiftScrap.DAY)} · Night ${fmt(u.shiftScrap.NIGHT)}</span>` : '';
      const scrapCell = judged ? `${fmt(u.totalScrap)}${split}` : '—';
      const gapCell = judged
        ? `<span style="color:${u.gap > 0 ? 'var(--red)' : 'var(--green)'};font-weight:700;">${(u.gap > 0 ? '+' : '') + fmt(u.gap)}</span>` : '—';
      return `<tr><td>${fmtDay(u.date)}</td><td>${escapeHtml(u.label)}</td><td class="num">${scrapCell}</td><td class="num">${targetText}</td><td class="num">${gapCell}</td><td>${pill}${reasons}</td></tr>`;
    }).join('');
  }

  // ---- Door Line Comparison -------------------------------------------
  // Informational only — always compares all 3 lines regardless of the
  // top Line filter (comparison is meaningless with only one line shown).
  // The scrap target (≤30/shift before the cutover, ≤50/day after it) is NEVER
  // applied per-line here, only to the combined A+B+C total (enforced in
  // js/target-evaluator.js) — this section adds Scrap Rate
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

    // Compact comparison table: Line | Production | Scrap | Scrap Rate | Share (+ proportional bar).
    // Same per-line numbers as before; the bar is the Share value drawn to scale.
    // The row with the highest scrap contribution is highlighted — no threshold involved.
    const body = perLine.map(p => {
      const contribution = totalScrapAllLines > 0 ? (p.scrap / totalScrapAllLines) * 100 : null;
      const isHighest = p.scrap > 0 && p.scrap === maxScrap;
      return `
        <tr class="${isHighest ? 'is-highest' : ''}"${isHighest ? ' title="Highest share of total scrap"' : ''}>
          <td><span class="qd-line-badge line-${p.line.code}">${p.line.code}</span><span class="qd-dashboard-doortable-name">${p.line.label}</span></td>
          <td class="num"><b>${p.hasAnyDoc ? fmt(p.production) : '–'}</b><span class="u">pcs</span></td>
          <td class="num scrap${p.scrap === 0 && !scrapLoadFailed ? ' zero' : ''}"><b>${scrapLoadFailed ? '–' : fmt(p.scrap)}</b>${scrapLoadFailed ? '' : '<span class="u">pcs</span>'}</td>
          <td class="num rate"><b>${scrapLoadFailed || p.rate === null ? 'N/A' : fmtPct(p.rate)}</b></td>
          <td><div class="qd-dashboard-doortable-share"><span class="pct">${scrapLoadFailed || contribution === null ? '–' : contribution.toFixed(0) + '%'}</span><span class="bar" title="Share of total scrap"><i style="width:${scrapLoadFailed || contribution === null ? 0 : contribution.toFixed(1)}%"></i></span></div></td>
        </tr>`;
    }).join('');
    container.innerHTML = `
      <table class="qd-datatable qd-dashboard-table qd-dashboard-doortable">
        <thead><tr><th>Line</th><th class="num">Production</th><th class="num">Scrap Qty</th><th class="num">Scrap Rate</th><th>Scrap Share</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
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

  // Compact, readable tooltip for the Scrap Trend chart.
  function compactTooltip(callbacks) {
    return {
      backgroundColor: '#0B2540', titleColor: '#fff', bodyColor: '#EAF1FE',
      padding: 8, cornerRadius: 6, caretSize: 5, bodySpacing: 3, titleMarginBottom: 4,
      titleFont: { family: V5_CHART_FONT, size: 11, weight: '600' },
      bodyFont: { family: V5_CHART_FONT, size: 11 },
      usePointStyle: true, boxWidth: 7, boxHeight: 7, boxPadding: 3,
      callbacks
    };
  }
  // Dashed Target reference (presentation only, opt-in via options.plugins.targetLine).
  const targetLinePlugin = {
    id: 'targetLine',
    afterDatasetsDraw(chart, args, opts) {
      if (!opts) return;
      const y = chart.scales.y, x = chart.scales.x, a = chart.chartArea;
      if (!y || !x) return;
      const py = y.getPixelForValue(opts.value);
      if (py < a.top || py > a.bottom) return;
      const n = chart.data.labels.length, slot = a.width / n;
      const x0 = a.left + opts.startIndex * slot, x1 = a.left + (opts.endIndex + 1) * slot;
      const c = chart.ctx;
      c.save(); c.setLineDash([6, 4]); c.lineWidth = 1.5; c.strokeStyle = '#F59E0B';
      c.beginPath(); c.moveTo(x0, py); c.lineTo(x1, py); c.stroke(); c.setLineDash([]);
      c.fillStyle = '#B45309'; c.font = '600 10px ' + V5_CHART_FONT; c.textAlign = 'right'; c.textBaseline = 'bottom';
      c.fillText(opts.label, x1 - 4, py - 3);
      c.restore();
    }
  };
  const axisTitle = text => ({ display: true, text, color: '#64748B', font: { family: V5_CHART_FONT, size: 10, weight: '500' }, padding: { top: 0, bottom: 2 } });

  // ---- Pareto Analysis (V5 executive) ---------------------------------
  // Vertical bars = Scrap Qty of the Top 10 defects + "O" (Others = every remaining
  // defect summed), blue line = Cumulative %, dashed orange line = 80%. The x-axis
  // uses rank numbers so long Thai names never overlap; the full names are in the
  // tooltip and in the "Defect list" panel. Data: QualityAdapter.buildParetoDefects()
  // over the scrap already loaded for the selected Date Range / Shift / Line (no extra
  // read). Cumulative % is over ALL defects; when the 80% point falls inside Others,
  // the real rank and defect that reach it are named — Others is never one defect.
  const PARETO_TOP_N = 10;
  const PARETO_CUTOFF = 80;
  const PARETO_COL = { TOP: '#155E6E', BAR: '#1F7A8C', OTHERS: '#A7C4CC', LINE: '#1F62D6', REF: '#F08A24' };
  let paretoChart = null;

  // Placement of the "80% at #N" tag: try spots around the highlighted point and keep the
  // first one that touches none of the Cumulative line, its points or the 80% reference
  // (then, if possible, no bar label either). Falls back to the spot with the fewest hits.
  function paretoTagSpot(chart, m, pt, w, h) {
    const area = chart.chartArea, line = chart.getDatasetMeta(m.lineIndex).data;
    const refY = chart.scales.y1.getPixelForValue(m.ref), pad = 3, gap = 9;
    const segs = [];
    for (let i = 1; i < line.length; i++) segs.push([line[i - 1].x, line[i - 1].y, line[i].x, line[i].y]);
    segs.push([area.left, refY, area.right, refY]);
    const labels = chart.getDatasetMeta(m.barIndex).data.map(b => [b.x - 14, b.y - 16, 28, 14]);   // value labels above bars
    const hitSeg = (r, [x1, y1, x2, y2]) => {   // segment vs padded rectangle (sampled; segments are short)
      const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2));
      for (let k = 0; k <= n; k++) { const x = x1 + (x2 - x1) * k / n, y = y1 + (y2 - y1) * k / n;
        if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) return true; }
      return false;
    };
    const hitPt = r => line.some(q => q.x + 7 >= r.x && q.x - 7 <= r.x + r.w && q.y + 7 >= r.y && q.y - 7 <= r.y + r.h);
    const hitBox = (r, [x, y, bw, bh]) => x < r.x + r.w && x + bw > r.x && y < r.y + r.h && y + bh > r.y;
    const spots = [
      [pt.x + gap, pt.y + gap], [pt.x - w - gap, pt.y + gap], [pt.x + gap, pt.y - h - gap], [pt.x - w - gap, pt.y - h - gap],
      [pt.x - w / 2, pt.y + gap + 8], [pt.x - w / 2, pt.y - h - gap - 8], [pt.x + gap, pt.y + 3 * gap], [pt.x - w - gap, pt.y + 3 * gap],
      [pt.x - w / 2, pt.y + 4 * gap]
    ];
    let best = null;
    spots.forEach(([x, y], order) => {
      const r = { x: Math.max(area.left + 2, Math.min(x, area.right - w - 2)), y: Math.max(area.top + 2, Math.min(y, area.bottom - h - 2)), w, h };
      const lineHits = segs.filter(sg => hitSeg(r, sg)).length + (hitPt(r) ? 1 : 0);
      const labelHits = labels.filter(b => hitBox(r, b)).length;
      const score = lineHits * 100 + labelHits * 10 + order;
      if (!best || score < best.score) best = { r, score, lineHits };
    });
    return best;
  }

  // Bar values on top of each bar + the "80% at #N" tag next to the highlighted point.
  const paretoDecorPlugin = {
    id: 'paretoDecor',
    afterDatasetsDraw(chart, args, o) {
      if (!o || !o.meta) return;
      const m = o.meta, c = chart.ctx, area = chart.chartArea;
      c.save();
      c.font = '600 10.5px ' + V5_CHART_FONT; c.fillStyle = '#3E4B5B'; c.textAlign = 'center'; c.textBaseline = 'bottom';
      chart.getDatasetMeta(m.barIndex).data.forEach((bar, i) => c.fillText(fmt(m.qty[i]), bar.x, bar.y - 3));
      if (m.markIndex >= 0) {
        const pt = chart.getDatasetMeta(m.lineIndex).data[m.markIndex];
        if (pt) {
          c.font = '700 10.5px ' + V5_CHART_FONT;
          const w = c.measureText(m.markText).width + 12, h = 18;
          const spot = paretoTagSpot(chart, m, pt, w, h);
          const x = spot.r.x, y = spot.r.y;
          chart.$paretoTag = { x, y, w, h, lineHits: spot.lineHits };   // read by the regression test only
          c.fillStyle = '#FFFFFF'; c.strokeStyle = PARETO_COL.REF; c.lineWidth = 1;
          c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, 9); else c.rect(x, y, w, h); c.fill(); c.stroke();
          c.fillStyle = '#B4540A'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(m.markText, x + 6, y + h / 2 + 0.5);
        }
      }
      c.restore();
    }
  };

  function renderPareto(scrapRecords) {
    const data = QualityAdapter.buildParetoDefects(scrapRecords);
    const label = $('paretoRangeLabel');
    if (label) label.textContent = data.length ? rangeLabelText() : '';
    if (data.length === 0) {   // the empty state itself is drawn by renderTopDefectsList()
      if (paretoChart) { paretoChart.destroy(); paretoChart = null; }
      ['paretoKpiTotal', 'paretoKpiPriority', 'paretoKpiCoverage'].forEach(id => { $(id).textContent = '–'; });
      $('paretoInsight').textContent = ''; $('paretoKeyList').innerHTML = '';
      return;
    }

    const pct1 = n => n.toFixed(1) + '%';
    const total = data.reduce((sum, d) => sum + d.qty, 0);
    const crossIdx = data.findIndex(d => d.cumulativePct >= PARETO_CUTOFF);   // found whenever total > 0 (last = 100%)
    const cross = data[crossIdx];
    const top = data.slice(0, PARETO_TOP_N);
    const rest = data.slice(PARETO_TOP_N);
    const othersQty = rest.reduce((sum, d) => sum + d.qty, 0);
    const insideOthers = crossIdx >= top.length;

    // ---- KPIs + insight (all from the same data) ----
    $('paretoKpiTotal').textContent = fmt(total);
    $('paretoKpiPriority').textContent = fmt(crossIdx + 1);
    $('paretoKpiPriorityUnit').textContent = `of ${fmt(data.length)} type${data.length === 1 ? '' : 's'}`;
    $('paretoKpiCoverage').textContent = pct1(cross.cumulativePct);
    $('paretoInsight').innerHTML =
      `<b>${fmt(crossIdx + 1)} defect type${crossIdx === 0 ? '' : 's'}</b> account${crossIdx === 0 ? 's' : ''} for <b>${pct1(cross.cumulativePct)}</b> of scrap`
      + (insideOthers ? ` — the ${PARETO_CUTOFF}% point is reached at defect #${crossIdx + 1} (${escapeHtml(cross.defectType)}), inside Others.` : '.');

    // ---- chart points: 1..10 (+ O) ----
    const points = top.map((d, i) => ({ key: String(i + 1), name: d.defectType, qty: d.qty, cum: d.cumulativePct }));
    if (rest.length) points.push({ key: 'O', name: `Others (${fmt(rest.length)} defect type${rest.length === 1 ? '' : 's'})`, qty: othersQty, cum: 100, others: true });
    const markIndex = insideOthers ? points.length - 1 : crossIdx;
    const markText = insideOthers ? `${PARETO_CUTOFF}% at #${crossIdx + 1} (in Others)` : `${PARETO_CUTOFF}% at #${crossIdx + 1}`;

    // ---- rank → full name list ----
    $('paretoKeyList').innerHTML = points.map((p, i) => `
      <li class="${p.others ? 'is-others' : ''}${!p.others && i <= crossIdx ? ' is-priority' : ''}">
        <span class="k">${p.key}</span><span class="n">${escapeHtml(p.name)}</span>
        <span class="q">${fmt(p.qty)}</span><span class="p">${pct1(p.qty / total * 100)}</span>
      </li>`).join('')
      + (insideOthers ? `<li class="is-note"><span class="k"></span><span class="n">${PARETO_CUTOFF}% reached at #${crossIdx + 1}: ${escapeHtml(cross.defectType)} (cumulative ${pct1(cross.cumulativePct)})</span></li>` : '');

    if (typeof Chart === 'undefined') return;
    const narrow = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    const pointRadius = points.map((p, i) => i === markIndex ? 6 : 3);
    const datasets = [
      { type: 'bar', label: 'Scrap Qty', data: points.map(p => p.qty), yAxisID: 'y', order: 2,
        backgroundColor: points.map((p, i) => p.others ? PARETO_COL.OTHERS : i === 0 ? PARETO_COL.TOP : PARETO_COL.BAR), borderRadius: 4, maxBarThickness: 44, categoryPercentage: 0.78, barPercentage: 0.9 },
      { type: 'line', label: 'Cumulative %', data: points.map(p => p.cum), yAxisID: 'y1', order: 1,
        borderColor: PARETO_COL.LINE, borderWidth: 2, tension: 0, fill: false, clip: false,   // the 100% point is never cut at the top edge
        pointRadius, pointHoverRadius: pointRadius.map(r => r + 1),
        pointBackgroundColor: points.map((p, i) => i === markIndex ? PARETO_COL.REF : '#FFFFFF'),
        pointBorderColor: points.map((p, i) => i === markIndex ? '#FFFFFF' : PARETO_COL.LINE), pointBorderWidth: points.map((p, i) => i === markIndex ? 2.5 : 1.5) },
      { type: 'line', label: '80% reference', data: points.map(() => PARETO_CUTOFF), yAxisID: 'y1', order: 0,
        borderColor: PARETO_COL.REF, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, fill: false }
    ];
    const tick = { family: V5_CHART_FONT, size: 10 };
    const options = {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 18, right: 4 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        paretoDecor: { meta: { barIndex: 0, lineIndex: 1, ref: PARETO_CUTOFF, qty: points.map(p => p.qty), markIndex, markText } },
        tooltip: Object.assign(compactTooltip({
          title: items => items.length ? `${points[items[0].dataIndex].key === 'O' ? '' : '#' + points[items[0].dataIndex].key + ' '}${points[items[0].dataIndex].name}` : '',
          label: () => '',
          afterBody: items => {
            if (!items.length) return [];
            const p = points[items[0].dataIndex];
            const out = [` Scrap Qty: ${fmt(p.qty)} pcs`, ` % of Total: ${pct1(p.qty / total * 100)}`, ` Cumulative %: ${pct1(p.cum)}`];
            if (p.others && insideOthers) out.push(` ${PARETO_CUTOFF}% reached at #${crossIdx + 1}: ${cross.defectType} (${pct1(cross.cumulativePct)})`);
            else if (!p.others && items[0].dataIndex === crossIdx) out.push(` First point at or above ${PARETO_CUTOFF}%`);
            return out;
          }
        }), { displayColors: false, filter: item => item.datasetIndex === 0 })
      },
      scales: {
        x: { grid: { display: false }, border: { color: '#D5DCE5' }, ticks: { font: { ...tick, size: 11, weight: '600' }, color: '#475569', autoSkip: false, maxRotation: 0 } },
        y: { beginAtZero: true, grace: '12%', position: 'left', title: narrow ? undefined : axisTitle('Scrap Qty (pcs)'),
          grid: { color: 'rgba(15,39,71,0.06)', drawTicks: false }, border: { display: false }, ticks: { precision: 0, font: tick, color: '#64748B', maxTicksLimit: 6, padding: 6 } },
        y1: { min: 0, max: 100, position: 'right', title: narrow ? undefined : axisTitle('Cumulative %'),
          grid: { display: false }, border: { display: false }, ticks: { stepSize: 20, font: tick, color: '#64748B', callback: v => v + '%', padding: 6 } }
      }
    };
    const chartData = { labels: points.map(p => p.key), datasets };
    if (paretoChart) { paretoChart.data = chartData; paretoChart.options = options; paretoChart.update(); }
    else paretoChart = new Chart($('paretoChart'), { type: 'bar', data: chartData, options, plugins: [paretoDecorPlugin] });
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
    const data = QualityAdapter.buildParetoDefects(scrapRecords);

    // Top 5 and Pareto are two separate cards now, each with its own empty state.
    ['topDefectsCard', 'paretoCard'].forEach(id => {
      const old = $(id).querySelector('.qd-dashboard-pareto-empty');
      if (old) old.remove();
    });

    if (data.length === 0) {
      tableWrap.style.display = 'none';
      chartHolder.style.display = 'none';
      list.innerHTML = '';
      const emptyIcon = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
      ['topDefectsCard', 'paretoCard'].forEach(id => {
        const empty = document.createElement('div');
        empty.className = 'qd-dashboard-pareto-empty';
        empty.innerHTML = `${emptyIcon}<span>${scrapLoadFailed ? 'Scrap data could not be read.' : 'No defects recorded in this scope.'}</span>`;
        $(id).appendChild(empty);
      });
      return;
    }

    tableWrap.style.display = '';
    chartHolder.style.display = '';
    const totalQty = data.reduce((s, d) => s + d.qty, 0);
    const top = data.slice(0, 5);
    list.innerHTML = top.map((d, i) => {
      const share = totalQty > 0 ? (d.qty / totalQty) * 100 : null;   // same share the % column shows
      return `
      <div class="qd-dashboard-top-defect-row">
        <span>${i + 1}</span>
        <span class="qd-dashboard-top-defect-name"><span class="t" title="${escapeHtml(d.defectType)}">${escapeHtml(d.defectType)}</span></span>
        <span>${fmt(d.qty)}</span>
        <span>${share === null ? '–' : share.toFixed(0) + '%'}</span>
        <span class="qd-dashboard-top-defect-bar"><i style="width:${share === null ? 0 : share.toFixed(1)}%"></i></span>
      </div>`;
    }).join('');
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
  // ---- Scrap Trend (V5): status-coloured daily bars -----------------------
  // One bar per date = Scrap Qty for the selected Line/Shift scope (points from
  // QualityAdapter.buildDailyTrend, unchanged). Bar COLOUR comes only from the
  // central evaluator (TargetEvaluator.evaluate units already computed in
  // render() — no extra reads): daily-rule dates use their DAY unit; dates before
  // the cutover are judged per shift, so they get a neutral colour and their shift
  // results are listed in the tooltip (never merged into one day status). With a
  // specific Line or Shift selected the colours are neutral, because the target
  // belongs to A+B+C, Day+Night combined.
  const TREND_COL = { WITHIN: '#14A08C', OVER: '#F08A24', SCOPE: '#5B86A8', LEGACY: '#9DB3C7', INCOMPLETE: '#C7CFD8', TARGET: '#F08A24' };
  let trendHatch = null;
  function trendHatchPattern(ctx) {
    if (trendHatch) return trendHatch;
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#E4E9EF'; g.fillRect(0, 0, 8, 8);
    g.strokeStyle = '#A9B4C0'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
    trendHatch = ctx.createPattern(c, 'repeat');
    return trendHatch;
  }

  // Presentation-only plugin: labels on the Top 3 bars, small text-free markers on
  // the baseline where a value would otherwise look like a confirmed 0 (hatched stub =
  // incomplete / no scrap log, hollow dot = no data or not readable, thin line = a
  // recorded 0), the "TARGET 50" tag at the right end of the target line, and the
  // cutover marker. The exact status of each date is in the tooltip.
  const trendDecorPlugin = {
    id: 'trendDecor',
    afterDatasetsDraw(chart, args, o) {
      if (!o || !o.meta) return;
      const m = o.meta, c = chart.ctx, area = chart.chartArea, x = chart.scales.x, y = chart.scales.y;
      c.save();
      // baseline markers for days without a usable value (no text, so they never clutter)
      const slot = m.marker.length > 1 ? Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0)) : area.right - area.left;
      const w = Math.max(4, Math.min(40, slot * 0.6));
      m.marker.forEach((t, i) => {
        if (!t) return;
        const cx = x.getPixelForValue(i);
        if (t === 'No log') {   // incomplete: same hatch as the Incomplete legend, as a short stub
          c.fillStyle = m.hatch; c.strokeStyle = '#A9B4C0'; c.lineWidth = 1;
          c.fillRect(cx - w / 2, area.bottom - 6, w, 6); c.strokeRect(cx - w / 2 + 0.5, area.bottom - 5.5, w - 1, 5);
        } else if (t === '0') {   // a recorded 0: thin line in the bar's own colour
          c.fillStyle = m.zeroColor[i] || '#9DB3C7';
          c.fillRect(cx - w / 2, area.bottom - 2, w, 2);
        } else {   // 'No data' / 'N/A': hollow dot
          c.strokeStyle = '#94A3B8'; c.lineWidth = 1.5; c.fillStyle = '#FFFFFF';
          c.beginPath(); c.arc(cx, area.bottom - 5, 3.5, 0, Math.PI * 2); c.fill(); c.stroke();
        }
      });
      // cutover marker (range crosses 01 Oct)
      if (m.cutoverIndex > 0) {
        const px = (x.getPixelForValue(m.cutoverIndex - 1) + x.getPixelForValue(m.cutoverIndex)) / 2;
        c.strokeStyle = '#94A3B8'; c.setLineDash([3, 3]); c.lineWidth = 1;
        c.beginPath(); c.moveTo(px, area.top); c.lineTo(px, area.bottom); c.stroke(); c.setLineDash([]);
        c.font = '600 10px ' + V5_CHART_FONT; c.fillStyle = '#475569'; c.textAlign = 'left'; c.textBaseline = 'top';
        c.fillText(m.cutoverText, Math.min(px + 4, area.right - c.measureText(m.cutoverText).width), area.top + 2);
      }
      // "TARGET 50" tag
      if (m.target) {
        const ty = y.getPixelForValue(m.target.value);
        const tag = 'TARGET ' + fmt(m.target.value);
        c.font = '700 10px ' + V5_CHART_FONT; c.textAlign = 'right'; c.textBaseline = 'middle';
        const tw = c.measureText(tag).width, tx = area.right - 2, tyy = ty - 10;
        // white pill so the tag stays readable over an orange bar
        c.fillStyle = 'rgba(255,255,255,0.92)'; c.strokeStyle = TREND_COL.TARGET; c.lineWidth = 1;
        c.beginPath(); if (c.roundRect) c.roundRect(tx - tw - 8, tyy - 7, tw + 8, 14, 4); else c.rect(tx - tw - 8, tyy - 7, tw + 8, 14); c.fill(); c.stroke();
        c.fillStyle = TREND_COL.TARGET; c.fillText(tag, tx - 4, tyy + 0.5);
      }
      // Top 3 value labels (kept inside the plot area)
      c.font = '700 11px ' + V5_CHART_FONT; c.fillStyle = '#16212E'; c.textAlign = 'center'; c.textBaseline = 'bottom';
      const bars = chart.getDatasetMeta(0).data;
      m.top3.forEach(i => { const b = bars[i]; if (b) c.fillText(fmt(m.values[i]), b.x, Math.max(area.top + 12, b.y - 4)); });
      c.restore();
    }
  };

  function trendStatusText(s) {
    const S = TargetEvaluator.STATUS;
    return s === S.WITHIN ? 'WITHIN' : s === S.OVER ? 'OVER' : s === S.INCOMPLETE ? 'INCOMPLETE' : s === S.NO_DATA ? 'NO DATA' : '–';
  }

  // Header KPIs of the card — same scope as the bars; Over Target from the evaluator.
  // Each KPI explains itself in a small tooltip (hover, keyboard focus or tap).
  function setTrendTip(id, text) {
    const e = $(id); if (!e) return;
    let tipEl = e.querySelector('.v5-tip');
    if (!tipEl) { tipEl = document.createElement('span'); tipEl.className = 'v5-tip'; tipEl.setAttribute('role', 'tooltip'); tipEl.id = id + 'Tip'; e.appendChild(tipEl); e.setAttribute('aria-describedby', tipEl.id); }
    e.removeAttribute('title');
    tipEl.textContent = text;
  }
  function renderTrendKpis(points, units, meta) {
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
    const scrapOk = points.length > 0 && points.every(p => p.scrap !== null && p.scrap !== undefined);
    const total = scrapOk ? points.reduce((s, p) => s + p.scrap, 0) : null;
    set('trendTotal', total === null ? 'N/A' : fmt(total));
    setTrendTip('trendKpiTotal', total === null ? 'Scrap data could not be read' : `Scrap Qty for ${meta.scopeText}, ${meta.rangeText}`);

    // Over Target: counts straight from the central evaluator's units (TargetEvaluator.summarize).
    // Denominator = evaluated units only (Within + Over); Incomplete / No Data are listed, never counted.
    const sum = TargetEvaluator.summarize(units);
    const d = sum.days, s = sum.shifts;
    const selectedDays = points.length;
    let overText = '–', unit = '', lines = [];
    if (sum.hasDays) {
      overText = fmt(d.over); unit = `over / ${plural(d.within + d.over, 'evaluated day')}`;
      lines = [
        `Selected days: ${fmt(selectedDays)}`,
        `Evaluated days: ${fmt(d.within + d.over)} (${fmt(d.within)} Within, ${fmt(d.over)} Over)`,
        `Incomplete days: ${fmt(d.incomplete)}`,
        `No Data days: ${fmt(d.noData)}`,
        `Target ≤${fmt(DAILY_TARGET_PCS)} pcs/day · Door A+B+C · Day + Night combined.`
      ];
      if (sum.hasShifts) lines.push(`Before ${TargetEvaluator.formatCutoverDate()} (${plural(selectedDays - d.total, 'day')}, judged per shift): ${fmt(s.over)} over / ${plural(s.within + s.over, 'evaluated shift')}, ${fmt(s.incomplete)} incomplete, ${fmt(s.noData)} no data.`);
    } else if (sum.hasShifts) {
      overText = fmt(s.over); unit = `over / ${plural(s.within + s.over, 'evaluated shift')}`;
      lines = [
        `Selected days: ${fmt(selectedDays)}`,
        `Evaluated shifts: ${fmt(s.within + s.over)} (${fmt(s.within)} Within, ${fmt(s.over)} Over)`,
        `Incomplete shifts: ${fmt(s.incomplete)}`,
        `No Data shifts: ${fmt(s.noData)}`,
        `Before ${TargetEvaluator.formatCutoverDate()} each shift is judged on its own target (Door A+B+C).`
      ];
    }
    if (state.line !== 'all' || state.shift !== 'all') lines.push('Judged on Door A+B+C, Day + Night combined — not only the selected line/shift.');
    set('trendOver', overText); set('trendOverUnit', unit);
    setTrendTip('trendKpiOver', lines.length ? lines.join('\n') : 'No evaluated days in this range');
    const overEl = $('trendKpiOver'); if (overEl) overEl.dataset.level = (sum.hasDays ? d.over : s.over) > 0 ? 'bad' : 'neutral';

    // Daily average: total ÷ days with at least one scrap log in scope. A day
    // without any log is unknown, not 0 (see target-evaluator.js), so it is left out.
    const logged = points.filter(p => p.scrap > 0).length;
    set('trendAvg', total === null || logged === 0 ? 'N/A' : fmt(Math.round(total / logged)));
    setTrendTip('trendKpiAvg', total === null ? 'Scrap data could not be read'
      : logged === 0 ? 'No day in this range has recorded scrap'
      : `${fmt(total)} pcs ÷ ${plural(logged, 'day')} with recorded scrap = ${(total / logged).toLocaleString('en-US', { maximumFractionDigits: 1 })} pcs/day\n`
        + `Selected days: ${fmt(selectedDays)}. Days without a scrap record are not counted as 0.`);
  }

  function renderScrapTrend(points, targetLine, units) {
    units = units || [];
    const holder = $('scrapTrendChartHolder');
    const existingEmpty = holder.parentElement.querySelector('.qd-dashboard-pareto-empty');
    if (existingEmpty) existingEmpty.remove();

    const filtered = state.line !== 'all' || state.shift !== 'all';
    const lineName = (LINES.find(l => l.code === state.line) || {}).label;
    const shiftName = (SHIFTS.find(x => x.code === state.shift) || {}).label;
    const scopeText = filtered ? [state.line !== 'all' ? lineName : 'Door A+B+C', state.shift !== 'all' ? shiftName : 'Day+Night'].join(' · ') : 'Door A+B+C · Day+Night';
    renderTrendKpis(points, units, { scopeText, rangeText: rangeLabelText() });

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

    const S = TargetEvaluator.STATUS;
    const dayUnit = new Map(units.filter(u => u.unit === 'DAY').map(u => [u.date, u]));
    const shiftUnits = new Map();
    units.filter(u => u.unit === 'SHIFT').forEach(u => { if (!shiftUnits.has(u.date)) shiftUnits.set(u.date, []); shiftUnits.get(u.date).push(u); });

    const labels = points.map(p => p.date);
    const values = [], colors = [], marker = [], kind = [];
    points.forEach(p => {
      const du = dayUnit.get(p.date);
      const scrapFail = p.scrap === null || p.scrap === undefined;
      const noData = !scrapFail && !(p.production > 0) && !(p.scrap > 0);
      // Daily-rule day with production but no scrap log at all (any line/shift): the total is
      // unknown, not 0 — also when a Line/Shift is selected (its 0 would not be confirmed either).
      const unknown = du && !du.scrapKnown && !scrapFail && !noData;
      if (scrapFail) { values.push(null); marker.push('N/A'); }
      else if (noData) { values.push(null); marker.push('No data'); }
      else if (unknown) { values.push(null); marker.push('No log'); }
      else { values.push(p.scrap); marker.push(p.scrap > 0 ? '' : '0'); }
      let k;
      if (filtered) k = 'SCOPE';
      else if (du) k = du.status === S.OVER ? 'OVER' : du.status === S.WITHIN ? 'WITHIN' : 'INCOMPLETE';
      else k = 'LEGACY';
      kind.push(k);
      colors.push(k === 'INCOMPLETE' ? null : TREND_COL[k]);
    });
    const ctx = $('scrapTrendChart').getContext('2d');
    const hatch = trendHatchPattern(ctx);
    const bg = colors.map(c => c || hatch);
    const zeroColor = bg.map(c => typeof c === 'string' ? c : '#A9B4C0');

    // Top 3 by Scrap Qty (ties: earlier date first)
    const top3 = values.map((v, i) => [v, i]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 3).map(([, i]) => i);
    const target = points.map((p, i) => targetLine && i >= targetLine.startIndex && i <= targetLine.endIndex ? targetLine.value : null);
    const cutoverIndex = targetLine && targetLine.startIndex > 0 ? targetLine.startIndex : -1;

    // Legend (HTML, so it can explain the colours honestly)
    const legend = $('trendLegend');
    if (legend) {
      const item = (cls, text) => `<span class="v5-trend-li"><i class="${cls}"></i>${text}</span>`;
      const parts = [];
      if (filtered) parts.push(item('scope', `Scrap Qty · ${escapeHtml(scopeText)}`));
      else {
        if (kind.includes('WITHIN')) parts.push(item('within', 'Within target'));
        if (kind.includes('OVER')) parts.push(item('over', 'Over target'));
        if (kind.includes('INCOMPLETE') || marker.includes('No log')) parts.push(item('incomplete', 'Incomplete'));
        if (kind.includes('LEGACY')) parts.push(item('legacy', `Before ${TargetEvaluator.formatCutoverDate()} · judged per shift (see tooltip)`));
      }
      if (marker.some(t => t === 'No data' || t === 'N/A')) parts.push(item('nodata', marker.includes('N/A') && !marker.includes('No data') ? 'Not readable' : 'No data'));
      if (filtered && marker.includes('No log')) parts.push(item('incomplete', 'No scrap log'));
      if (targetLine) parts.push(item('target', `Target ≤${fmt(targetLine.value)} pcs/day${cutoverIndex > 0 ? ' (from ' + TargetEvaluator.formatCutoverDate() + ')' : ''}`));
      legend.innerHTML = parts.join('');
    }
    const note = $('trendNote');
    if (note) note.textContent = filtered
      ? `Bars show ${scopeText} only. Target status and the ≤${fmt(DAILY_TARGET_PCS)} pcs/day line apply to Door A+B+C, Day+Night combined, so they are not drawn here; the day's overall status is in the tooltip.`
      : '';

    // at least ~18px per day; when the card is narrower the chart scrolls inside the card, never the page
    holder.style.minWidth = (points.length * 18) + 'px';

    const datasets = [
      { type: 'bar', label: 'Scrap Qty (pcs)', data: values, backgroundColor: bg, borderColor: bg, borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 40, categoryPercentage: 0.82, barPercentage: 0.9, order: 1 }
    ];
    if (targetLine) datasets.push({ type: 'line', label: 'Target', data: target, borderColor: TREND_COL.TARGET, borderWidth: 2, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0, fill: false, order: 2, spanGaps: false });   // drawn over the bars, like the reference

    const fmtDate = d => `${parseInt(d.slice(8), 10)} ${MONTH_ABBR[parseInt(d.slice(5, 7), 10) - 1]} ${d.slice(0, 4)}`;
    const reasonList = u => (u.reasons || []).map(r => TargetEvaluator.reasonText(r)).join(', ');
    const options = {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 18, right: 6 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        trendDecor: { meta: { values, marker, hatch, zeroColor, top3, target: targetLine, cutoverIndex, cutoverText: `Daily rule from ${TargetEvaluator.formatCutoverDate()}` } },
        tooltip: Object.assign(compactTooltip({
          title: items => items.length ? fmtDate(String(items[0].label)) : '',
          label: () => '',
          afterBody: items => {
            if (!items.length) return [];
            const i = items[0].dataIndex, p = points[i], du = dayUnit.get(p.date), out = [];
            const scopeLbl = filtered ? ` (${scopeText})` : '';
            out.push(marker[i] === 'N/A' ? ' Scrap Qty: N/A (scrap data could not be read)'
              : marker[i] === 'No data' ? ` Scrap Qty${scopeLbl}: N/A (no production or scrap recorded)`
              : marker[i] === 'No log' ? ' Scrap Qty: N/A (no scrap log recorded)'
              : ` Scrap Qty${scopeLbl}: ${fmt(p.scrap)} pcs`);
            out.push(p.production > 0 ? ` Production Qty${scopeLbl}: ${fmt(p.production)} pcs` : ` Production Qty${scopeLbl}: N/A (not recorded)`);
            out.push(marker[i] === 'No log' || marker[i] === 'N/A' ? ' Scrap Rate: N/A (scrap not known)'
              : p.scrapRatePct === null || p.scrapRatePct === undefined ? ' Scrap Rate: N/A (no production)' : ` Scrap Rate: ${Number(p.scrapRatePct).toFixed(2)}%`);
            if (du) {
              out.push(` Daily Target: ≤${fmt(du.target)} pcs (A+B+C, Day+Night)`);
              out.push(du.gap === null || du.gap === undefined ? ' Gap to Target: N/A (scrap not known)' : ` Gap to Target: ${du.gap > 0 ? '+' : ''}${fmt(du.gap)} pcs`);
              out.push(` Data Status: ${trendStatusText(du.status)}${filtered ? ' (whole day, A+B+C)' : ''}`);
              if (du.status === S.INCOMPLETE && du.reasons.length) out.push(`   ${reasonList(du)}`);
            } else if (shiftUnits.has(p.date)) {
              out.push(' Target rule: ≤30 pcs/shift (before ' + TargetEvaluator.formatCutoverDate() + ')');
              shiftUnits.get(p.date).forEach(u => out.push(`   ${u.label}: ${trendStatusText(u.status)}${u.totalScrap === null ? '' : ' · ' + fmt(u.totalScrap) + ' pcs'}${u.target ? ' / ≤' + fmt(u.target) : ''}`));
            }
            return out;
          }
        }), { displayColors: false, filter: item => item.datasetIndex === 0 })
      },
      scales: {
        x: { grid: { display: false }, border: { color: '#D5DCE5' }, ticks: {
          font: { family: V5_CHART_FONT, size: 10 }, color: '#475569', maxRotation: 0, autoSkip: true, autoSkipPadding: 6,
          callback: function (value) { const d = String(this.getLabelForValue(value)); return `${parseInt(d.slice(8), 10)} ${MONTH_ABBR[parseInt(d.slice(5, 7), 10) - 1]}`; }
        } },
        y: { beginAtZero: true, grace: '12%', suggestedMax: targetLine ? Math.ceil(targetLine.value * 1.3) : undefined,
          title: axisTitle('Scrap Quantity (pcs)'), grid: { color: 'rgba(15,39,71,0.07)' }, border: { display: false },
          ticks: { precision: 0, font: { family: V5_CHART_FONT, size: 10 }, color: '#475569' } }
      }
    };

    const chartData = { labels, datasets };
    if (scrapTrendChart) { scrapTrendChart.data = chartData; scrapTrendChart.options = options; scrapTrendChart.update(); }
    else scrapTrendChart = new Chart($('scrapTrendChart'), { type: 'bar', data: chartData, options, plugins: [trendDecorPlugin] });
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
        x: { grid: { display: false }, ticks: { color: '#64748B', font: { family: V5_CHART_FONT, size: 10 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(15,39,71,0.08)' }, ticks: { color: '#64748B', font: { family: V5_CHART_FONT, size: 10 } } }
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
  (function wirePerfDetailButton() {
    $('targetPerfDetailBtn').addEventListener('click', () => {
      const open = $('targetDetailPanel').hidden;
      setPerfDetailOpen(open);
      if (open) $('targetDetailPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('targetDetailCloseBtn').addEventListener('click', () => { setPerfDetailOpen(false); $('targetPerfDetailBtn').focus(); });
    setPerfDetailOpen(false);
  })();

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
