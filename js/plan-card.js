/**
 * plan-card.js — Dashboard V5 "Scrap Budget" card (Weekly Plan V5 summary).
 * ------------------------------------------------------------------
 * This week + this month of the Dashboard's To date (as of To, never after today), Door A+B+C,
 * Day + Night — whatever the Line / Shift filters are (the budget is for the whole door line).
 * Scrap logs: the records the Dashboard has ALREADY loaded:
 *   - one date  → the Attention Required look-back query (its window starts at the month start
 *                 at the latest, so it always covers the month to date);
 *   - a range   → the range query; when the range starts after the 1st of the month, only the
 *                 missing days (1st … From − 1) are read, in one query.
 * Shift Close: the close context the Dashboard loaded (only missing close-required dates are read).
 * Plans: one query (<= 6 documents). Details live on weekly-plan.html.
 * Exposed as window.PlanCard.
 * ------------------------------------------------------------------
 */
(function () {
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const pct = n => Number.isFinite(n) ? (n * 100).toFixed(0) + '%' : '–';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { ON_TRACK: ['On track', 'good'], OVER: ['Over plan', 'bad'], NOT_FINAL: ['Not final', 'warn'], NOT_STARTED: ['Not started', 'neutral'], READ_ERROR: ['Read error', 'bad'] };
  const chip = k => { const [t, c] = STATUS[k] || [k, 'neutral']; return `<span class="wp-chip ${c}" data-status="${k}">${t}</span>`; };
  const todayBkk = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

  /**
   * Scrap records covering [win.from, win.to]: reuse `sources` ({ from, to, result }) that the
   * page already has; read only what none of them covers. -> { records, error, extraQuery }
   */
  async function monthRecords(db, win, sources) {
    const ok = sources.filter(s => s && s.result && !s.result.error && s.from <= win.to && s.to >= win.to);
    if (sources.some(s => s && s.result && s.result.error && s.from <= win.to && s.to >= win.to)) return { records: [], error: true, extraQuery: null };
    const best = ok.sort((a, b) => a.from < b.from ? -1 : 1)[0];
    if (best && best.from <= win.from) return { records: best.result.records, error: false, extraQuery: null };
    const U = WeeklyPlanCalc.util;
    const gapTo = best ? U.addDays(best.from, -1) : win.to;
    const extra = await ScrapDataAdapter.getScrapData(db, { startDate: win.from, endDate: gapTo });
    if (extra.error) return { records: [], error: true, extraQuery: [win.from, gapTo] };
    return { records: extra.records.concat(best ? best.result.records : []), error: false, extraQuery: [win.from, gapTo] };
  }

  function half(title, p, extraLine) {
    if (p.status === 'NOT_STARTED') return `<div class="v5-budget-half"><h3>${title} ${chip(p.status)}</h3><div class="v5-budget-nums">Plan <b>${fmt(p.plan)}</b> pcs</div></div>`;
    const actual = p.actual === null ? '–' : (p.noLog ? 'No log' : fmt(p.actual));
    const c = p.counts;
    const data = c.final === c.elapsed ? `${c.final}/${c.elapsed} days final`
      : `${c.final}/${c.elapsed} days final${c.noData ? ` · ${c.noData} without scrap log (not counted as 0)` : ''}`;
    return `<div class="v5-budget-half" data-k="${title.toLowerCase().startsWith('this week') ? 'week' : 'month'}">
      <h3>${title} ${chip(p.status)}</h3>
      <div class="v5-budget-nums">
        <span>Actual <b data-v="actual">${actual}</b>${p.soFar && p.actual !== null && !p.noLog ? ' <span class="wp-sofar">so far</span>' : ''} of <span data-v="plan">${fmt(p.plan)}</span> pcs</span>
        <span>Remaining <b data-v="remaining">${p.actual === null ? '–' : fmt(p.remaining)}</b></span>
        <span>Used <b data-v="used">${p.noLog ? '–' : pct(p.used)}</b></span>
      </div>
      <div class="wp-bar" aria-hidden="true"><i style="width:${Math.min(100, (p.used || 0) * 100).toFixed(1)}%" class="${p.status === 'OVER' ? 'bad' : ''}"></i><b style="left:${p.plan ? Math.min(100, p.planToDate / p.plan * 100).toFixed(1) : 0}%"></b></div>
      <div class="v5-budget-data">${esc(data)}${extraLine ? ' · ' + extraLine : ''}</div>
    </div>`;
  }

  /**
   * render(container, ctx)
   *   ctx: { db, dateFrom, dateTo, isCurrent(), range: { from, to, result }, lookback: Promise<{ from, to, result }>|null,
   *          rangeDates, closeContext }
   */
  async function render(container, ctx) {
    if (!container) return;
    const win = WeeklyPlanCalc.cardWindow(ctx.dateTo, todayBkk());
    const stats = { ym: win.ym, asOf: win.asOf, extraScrapQuery: null, planQueries: 1, closeQueries: 0 };
    window.__qdPlanCard = stats;
    container.innerHTML = '<div class="wp-loading">Loading scrap budget…</div>';
    if (window.qdFirebaseError || !ctx.db) { container.innerHTML = ''; return; }
    try {
      const sources = [ctx.range];
      if (ctx.lookback) sources.push(await ctx.lookback);
      if (!ctx.isCurrent()) return;
      const [scrap, plans] = await Promise.all([monthRecords(ctx.db, win, sources), WeeklyPlanData.loadPlans(ctx.db, win.ym)]);
      if (!ctx.isCurrent()) return;
      stats.extraScrapQuery = scrap.extraQuery;
      const dates = WeeklyPlanCalc.util.datesBetween(win.from, win.asOf);
      const close = await WeeklyPlanData.closeStatus(ctx.db, dates, scrap.records, scrap.error, { dates: ctx.rangeDates || [], ctx: ctx.closeContext });
      if (!ctx.isCurrent()) return;
      stats.closeQueries = close.queries;
      const m = WeeklyPlanCalc.buildMonth({ ym: win.ym, asOf: win.asOf, records: scrap.records, scrapReadFailed: scrap.error,
        closeFrom: close.from, closeUnits: close.units, closeReadFailed: close.failed, overrides: plans.overrides, plansReadFailed: !!plans.error, dailyTarget: DAILY_TARGET_PCS });
      const w = m.weeks.find(x => win.asOf >= x.start && win.asOf <= x.end);
      const day = m.days.find(d => d.date === win.asOf);
      stats.month = { budget: m.budget, actual: m.actual, remaining: m.remaining, used: m.used, status: m.status, final: m.counts.final, elapsed: m.counts.elapsed };
      stats.week = { key: w.key, plan: w.plan, actual: w.actual, remaining: w.remaining, used: w.used, status: w.status };
      const link = `weekly-plan.html?ym=${win.ym}&week=${w.key}${window.qdEmulator ? '&qdEmulator=1' : ''}`;
      const dayLine = day && day.qty !== null ? `${esc(day.label)}: ${fmt(day.qty)} pcs ${day.overDaily ? `&gt; ${fmt(m.dailyTarget)}` : `≤ ${fmt(m.dailyTarget)}`}` : `${esc(day ? day.label : '')}: no scrap log yet`;
      const notes = [];
      if (plans.error) notes.push('Weekly plans could not be read — default plan (50 × days) shown.');
      if (!m.closeInUse) notes.push('Shift Close is not in use yet: figures are “so far”, days are not final.');
      container.innerHTML = `
        <div class="v5-budget-head"><h2>Scrap Budget · ${esc(m.monthLabel)}</h2><span class="wp-note">Door A+B+C · Day + Night · daily limit ≤${fmt(m.dailyTarget)} pcs · as of ${esc(WeeklyPlanCalc.util.shortDate(win.asOf))}</span>
          <a class="v5-budget-link" href="${link}">Weekly Plan →</a></div>
        <div class="v5-budget-grid">
          ${half(`This week · ${w.key} (${w.label})`, w, dayLine)}
          ${half('This month', Object.assign({}, m, { plan: m.budget }), m.counts.overDaily ? `${m.counts.overDaily} day${m.counts.overDaily === 1 ? '' : 's'} over ${fmt(m.dailyTarget)}` : `no day over ${fmt(m.dailyTarget)} so far`)}
        </div>
        ${notes.length ? `<p class="wp-note">${notes.map(esc).join(' ')}</p>` : ''}`;
    } catch (e) {
      console.error('Quality Dashboard: scrap budget card failed', e);
      if (ctx.isCurrent()) container.innerHTML = '<p class="wp-note">Scrap budget could not be loaded.</p>';
    }
  }

  window.PlanCard = { render, monthRecords };
})();
