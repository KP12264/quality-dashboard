/**
 * quality-adapter.js
 * ------------------------------------------------------------------
 * Pure aggregation/matching logic that combines normalized Production
 * records (from js/data-adapter.js) with normalized Scrap records
 * (from js/scrap-adapter.js) into the Quality figures the dashboard
 * shows. Nothing in this file talks to Firestore — it only works with
 * plain arrays already fetched by the two adapters. That keeps the
 * matching/business-rule logic (scrap rate formula, target-total-not-
 * per-line, Pareto grouping) in one place, testable without a database.
 *
 * Matching key: Date + Shift + Line (+ Model, for the by-Model views).
 *
 * Exposed as window.QualityAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  function key(date, shift, line) { return `${date}|${shift}|${line}`; }
  function keyM(date, shift, line, model) { return `${date}|${shift}|${line}|${model}`; }

  function pct(numerator, denominator) {
    if (!(denominator > 0)) return null; // N/A, not 0 — avoid implying a real 0% rate off a 0 base
    return (numerator / denominator) * 100;
  }

  // ---- Overall summary (Total Production / Total Scrap / Rate / Target / Status) ----

  /**
   * buildOverallSummary(productionRecords, scrapRecords, targetQty)
   * productionRecords: normalized records from getProductionData() (model:null level is fine — this only needs totals)
   * scrapRecords: normalized records from getScrapData() (already date/shift/line filtered by caller)
   * targetQty: TOTAL target across all lines for the shift(s)/scope in view (from TargetAdapter, summed by caller if scope spans multiple shifts)
   */
  function buildOverallSummary(productionRecords, scrapRecords, targetQty) {
    const totalProduction = productionRecords.reduce((s, r) => s + r.productionQty, 0);
    const totalScrap = scrapRecords.reduce((s, r) => s + r.scrapQty, 0);
    const scrapRatePct = pct(totalScrap, totalProduction);
    let status = "NO DATA";
    if (Number.isFinite(targetQty) && targetQty > 0) {
      status = totalScrap <= targetQty ? "WITHIN TARGET" : "OVER TARGET";
    }
    return { totalProduction, totalScrap, scrapRatePct, target: targetQty, status };
  }

  // ---- By Line ----------------------------------------------------------

  /**
   * buildByLine(productionRecords, scrapRecords, lines)
   * lines: array of line codes to include, e.g. ['A','B','C']
   * -> [{ line, production, scrap, scrapRatePct }, ...] in the given order
   */
  function buildByLine(productionRecords, scrapRecords, lines) {
    return lines.map(line => {
      const production = productionRecords.filter(r => r.line === line).reduce((s, r) => s + r.productionQty, 0);
      const scrap = scrapRecords.filter(r => r.line === line).reduce((s, r) => s + r.scrapQty, 0);
      return { line, production, scrap, scrapRatePct: pct(scrap, production) };
    });
  }

  // ---- By Model -----------------------------------------------------------

  /**
   * buildByModel(productionByModelRecords, scrapRecords)
   * productionByModelRecords: from getProductionDataByModel() — {date,shift,line,model,productionQty}
   * scrapRecords: normalized scrap records — {date,shift,line,model,scrapQty,...}
   *
   * Matches by model NAME (scrap entries should always be recorded
   * against a model name taken from that day/line's production model
   * list, via the entry form, to guarantee this matches). Aggregates
   * across whatever date/shift/line scope the caller already filtered
   * both input arrays to.
   *
   * -> [{ model, production, scrap, scrapRatePct }, ...] sorted by
   *    production desc. Models that only appear in scrap (e.g. a typo,
   *    or scrap logged against a model with no recorded production
   *    breakdown that day) are still included with production: 0, so
   *    nothing is silently dropped — the UI can flag those as
   *    unmatched instead of hiding them.
   */
  function buildByModel(productionByModelRecords, scrapRecords) {
    const byModel = new Map();
    productionByModelRecords.forEach(r => {
      if (!byModel.has(r.model)) byModel.set(r.model, { model: r.model, production: 0, scrap: 0 });
      byModel.get(r.model).production += r.productionQty;
    });
    scrapRecords.forEach(r => {
      if (!byModel.has(r.model)) byModel.set(r.model, { model: r.model, production: 0, scrap: 0 });
      byModel.get(r.model).scrap += r.scrapQty;
    });
    return Array.from(byModel.values())
      .map(m => ({ ...m, scrapRatePct: pct(m.scrap, m.production), unmatchedProduction: m.production === 0 && m.scrap > 0 }))
      .sort((a, b) => b.production - a.production);
  }

  // ---- Pareto defect --------------------------------------------------

  /**
   * buildParetoDefects(scrapRecords)
   * -> [{ defectType, qty, cumulativePct }, ...] sorted by qty desc,
   *    with a running cumulative-percent-of-total-scrap for the classic
   *    Pareto line overlay.
   */
  function buildParetoDefects(scrapRecords) {
    const byDefect = new Map();
    let total = 0;
    scrapRecords.forEach(r => {
      byDefect.set(r.defectType, (byDefect.get(r.defectType) || 0) + r.scrapQty);
      total += r.scrapQty;
    });
    const sorted = Array.from(byDefect.entries())
      .map(([defectType, qty]) => ({ defectType, qty }))
      .sort((a, b) => b.qty - a.qty);
    let running = 0;
    return sorted.map(d => {
      running += d.qty;
      return { ...d, cumulativePct: total > 0 ? (running / total) * 100 : 0 };
    });
  }

  // ---- Daily trend ------------------------------------------------------

  /**
   * buildDailyTrend(dates, productionRecords, scrapRecords)
   * dates: ordered array of date strings to plot (oldest first)
   * -> [{ date, production, scrap, scrapRatePct }, ...] one entry per date
   */
  function buildDailyTrend(dates, productionRecords, scrapRecords) {
    return dates.map(date => {
      const production = productionRecords.filter(r => r.date === date).reduce((s, r) => s + r.productionQty, 0);
      const scrap = scrapRecords.filter(r => r.date === date).reduce((s, r) => s + r.scrapQty, 0);
      return { date, production, scrap, scrapRatePct: pct(scrap, production) };
    });
  }

  window.QualityAdapter = {
    key,
    keyM,
    pct,
    buildOverallSummary,
    buildByLine,
    buildByModel,
    buildParetoDefects,
    buildDailyTrend
  };

})();
