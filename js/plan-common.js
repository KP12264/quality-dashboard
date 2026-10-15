/**
 * plan-common.js
 * ------------------------------------------------------------------
 * Small shared helpers for Plan & Tracking (plan-tracking.html) and
 * Weekly Review (weekly-review.html): formatting, the month/as-of
 * controls, and loading one month of scrap + weekly-plan data.
 *
 * Reads scrapLogs through ScrapDataAdapter (no new query shapes) and
 * scrapWeeklyPlans through ScrapPlanAdapter. Never touches Production V2.
 *
 * Exposed as window.PlanCommon = { ... }
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const U = () => ScrapPlanCalc.util;

  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const fmtSigned = n => !Number.isFinite(n) ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const fmtPct = (n, digits = 1) => !Number.isFinite(n) ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n * 100).toFixed(digits) + '%';
  const fmtShare = n => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '–';
  const lineLabel = code => { const l = (typeof LINES !== 'undefined' ? LINES : []).find(x => x.code === code); return l ? l.label : code; };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showBanner(kind, message) {
    const el = $('connectionBanner');
    if (!el) return;
    if (!message) { el.style.display = 'none'; return; }
    el.className = 'qd-banner ' + kind;
    el.textContent = message;
    el.style.display = 'flex';
  }

  const STATUS_TEXT = { OVER: 'Over plan', ON_TARGET: 'On plan', NOT_STARTED: 'Not started' };
  const STATUS_CLASS = { OVER: 'bad', ON_TARGET: 'good', NOT_STARTED: 'neutral' };
  function statusChip(status) {
    return `<span class="pr-chip ${STATUS_CLASS[status] || 'neutral'}">${STATUS_TEXT[status] || status}</span>`;
  }

  // Today in the plant's time zone (Asia/Bangkok), as YYYY-MM-DD.
  function todayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  /** Reads ?ym=YYYY-MM&asOf=YYYY-MM-DD&week=W2 from the URL. */
  function readParams() {
    const p = new URLSearchParams(location.search);
    const ym = /^\d{4}-\d{2}$/.test(p.get('ym') || '') ? p.get('ym') : todayStr().slice(0, 7);
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(p.get('asOf') || '') ? p.get('asOf') : null;
    return { ym, asOf, week: p.get('week') || null };
  }
  function writeParams(obj) {
    const p = new URLSearchParams(location.search);
    Object.keys(obj).forEach(k => { if (obj[k]) p.set(k, obj[k]); else p.delete(k); });
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  }

  /**
   * loadMonth(ym) -> { records, entries, scrapError, planError }
   * Fetches scrapLogs from the start of the previous month (baseline +
   * the 7 days before W1) to the end of the selected month.
   */
  async function loadMonth(ym) {
    const db = window.qdDb;
    const from = U().monthStart(U().prevMonth(ym));
    const to = U().monthEnd(ym);
    const [scrap, plans] = await Promise.all([
      ScrapDataAdapter.getScrapData(db, { startDate: from, endDate: to }),
      ScrapPlanAdapter.getMonth(db, ym)
    ]);
    return { records: scrap.records, entries: plans.entries, scrapError: scrap.error, planError: plans.error };
  }

  /**
   * resolveAsOf(records, ym, requested)
   * Default "Data as of" = the latest day in the month with scrap data,
   * but never later than today. An explicit choice is kept as-is.
   */
  function resolveAsOf(records, ym, requested) {
    if (requested && requested.slice(0, 7) === ym) return { asOf: requested, auto: false };
    const today = todayStr();
    const latest = ScrapPlanCalc.latestDataDate(records, ym);
    if (ym < today.slice(0, 7)) return { asOf: U().monthEnd(ym), auto: true };
    if (ym > today.slice(0, 7)) return { asOf: U().addDays(U().monthStart(ym), -1), auto: true };
    return { asOf: latest && latest <= today ? latest : today, auto: true };
  }

  function overridesFrom(entries) {
    const o = {};
    Object.keys(entries || {}).forEach(k => { if (Number.isFinite(entries[k].planOverride)) o[k] = entries[k].planOverride; });
    return o;
  }

  function dailyTarget() { return typeof DAILY_TARGET_PCS !== 'undefined' ? DAILY_TARGET_PCS : 50; }
  function reductionGoal() { return typeof MONTHLY_REDUCTION_GOAL !== 'undefined' ? MONTHLY_REDUCTION_GOAL : 0.5; }

  function connectionProblem() {
    if (window.qdFirebaseError) return window.qdFirebaseError;
    if (!window.qdDb) return 'Not connected to Firestore.';
    return null;
  }

  window.PlanCommon = {
    $, fmt, fmtSigned, fmtPct, fmtShare, lineLabel, escapeHtml, showBanner, statusChip,
    todayStr, readParams, writeParams, loadMonth, resolveAsOf, overridesFrom,
    dailyTarget, reductionGoal, connectionProblem, STATUS_TEXT
  };
})();
