/**
 * weekly-plan-page.js — Weekly Plan V5 (weekly-plan.html).
 * ------------------------------------------------------------------
 * Reads for one month: scrapLogs (ONE range query: month start … as-of), the public close summary
 * (only for close-required dates, one query at most), scrapWeeklyPlans (one query, <= 6 docs) and,
 * signed in, scrapWeeklyReviews (one query). No production documents. The previous month (for the
 * 50 % reduction goal) is read only when that section is opened.
 * All numbers come from WeeklyPlanCalc — the same module the Dashboard card uses.
 * ------------------------------------------------------------------
 */
(function () {
  const $ = id => document.getElementById(id);
  const C = () => window.WeeklyPlanCalc, U = () => window.WeeklyPlanCalc.util;
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const pct = n => Number.isFinite(n) ? (n * 100).toFixed(0) + '%' : '–';
  // Remaining below zero is shown as "N over" (never as a negative budget).
  const remain = n => !Number.isFinite(n) ? '–' : (n < 0 ? `<span class="wp-over">${Math.round(-n).toLocaleString('en-US')} over</span>` : Math.round(n).toLocaleString('en-US'));
  // ON_TRACK on a week / month that is complete and final reads "Within plan".
  const statusKey = p => (p.status === 'ON_TRACK' && p.final ? 'WITHIN_PLAN' : p.status);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LINE_LABEL = code => { const l = LINES.find(x => x.code === code); return l ? l.label : code; };

  const STATUS = {
    ON_TRACK: ['On track', 'good'], WITHIN_PLAN: ['Within plan', 'good'], OVER: ['Over plan', 'bad'], NOT_FINAL: ['Not final', 'warn'],
    NOT_STARTED: ['Not started', 'neutral'], READ_ERROR: ['Read error', 'bad']
  };
  const DAY_STATE = {
    FINAL: ['Final', 'good'], LOGGED: ['Logged · not closed', 'warn'], PENDING: ['Pending close', 'warn'],
    CONFLICT: ['Conflict', 'bad'], NO_DATA: ['No data (not 0)', 'neutral'], READ_ERROR: ['Read error', 'bad'], FUTURE: ['—', 'neutral']
  };
  // Plan source (never shows a default as an approved plan)
  const PLAN_SOURCE = {
    OVERRIDE: ['Set by Admin', 'good', 'An Admin set this plan (history in the editor)'],
    ADMIN_DEFAULT: ['Default · confirmed', 'good', 'An Admin confirmed the default plan (50 × days)'],
    DEFAULT: ['Default · not set', 'neutral', 'No plan has been set for this week: the default 50 × days is shown, not an approved plan'],
    UNAVAILABLE: ['Default · unconfirmed', 'warn', 'Weekly plans could not be read: the default 50 × days is shown and is NOT a confirmed plan']
  };
  const planTag = src => { const [t, c, title] = PLAN_SOURCE[src]; return `<span class="wp-chip ${c} wp-src" data-source="${src}" title="${esc(title)}">${esc(t)}</span>`; };
  const FINAL_TEXT = { 'WITHIN TARGET': 'Final', 'OVER TARGET': 'Final · over 50', 'NO PRODUCTION': 'Final · no production' };
  function dayChip(d) {
    if (d.state === 'FINAL') return `<span class="wp-chip ${d.evaluatorStatus === 'OVER TARGET' ? 'bad' : 'good'}" data-status="FINAL">${esc(FINAL_TEXT[d.evaluatorStatus] || 'Final')}</span>`;
    return chip(DAY_STATE, d.state);
  }
  function plansProblem() {
    const e = state.data && state.data.plans && state.data.plans.error;
    if (!e) return null;
    return /permission/i.test(e.code || e.message || '') ? 'denied' : 'error';
  }
  const chip = (map, k) => { const [t, c] = map[k] || [k, 'neutral']; return `<span class="wp-chip ${c}" data-status="${esc(k)}">${esc(t)}</span>`; };

  // cache: per month, what was read (scrap, plans, closes, goal) — going back to a month within
  // QD_VIEW_CACHE_MINUTES reads nothing again; older data, Reload and reopening the page read fresh.
  const state = { ym: null, week: null, asOf: null, data: null, month: null, improveScope: 'week', reviews: null, goal: null, loadSeq: 0, cache: new Map(), goals: new Map() };
  window.__qdWeeklyPlan = state;   // read by the tests

  function todayBkk() { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
  function asOfFor(ym) {
    const t = todayBkk();
    if (ym < t.slice(0, 7)) return U().monthEnd(ym);
    if (ym > t.slice(0, 7)) return U().addDays(U().monthStart(ym), -1);
    return t;
  }
  function writeUrl() {
    const u = new URL(location.href); u.searchParams.set('ym', state.ym);
    if (state.week) u.searchParams.set('week', state.week); else u.searchParams.delete('week');
    history.replaceState(null, '', u);
  }
  function banner(kind, text) {
    const b = $('connectionBanner');
    if (!text) { b.style.display = 'none'; return; }
    b.className = 'qd-banner ' + kind; b.textContent = text; b.style.display = 'flex';
  }
  const signedIn = () => window.QDAuth && QDAuth.getState().enabled && !!QDAuth.getState().profile && QDAuth.getState().profile.active === true;
  const canEdit = () => signedIn() && QDAuth.can('weeklyPlan.write', {});

  // ---- load ------------------------------------------------------------------------------
  async function load(force) {
    const seq = ++state.loadSeq;
    const ym = state.ym, asOf = asOfFor(ym), db = window.qdDb;
    if (force) { state.cache.delete(ym); state.goals.delete(ym); }
    state.asOf = asOf; state.goal = state.goals.get(ym) || null;   // (age checked when the goal is opened)
    $('wpGoalBody').innerHTML = ''; if ($('wpGoal').open) $('wpGoal').open = false;   // reopening shows the kept goal
    $('wpMonth').innerHTML = '<div class="wp-loading">Loading…</div>';
    if (window.qdFirebaseError || !db) { banner('error', '⚠ ' + (window.qdFirebaseError || 'Not connected to Firestore.')); return; }
    const hit = state.cache.get(ym);
    const maxAge = (typeof QD_VIEW_CACHE_MINUTES === 'number' ? QD_VIEW_CACHE_MINUTES : 5) * 60000;
    if (hit && hit.asOf === asOf && Date.now() - hit.at < maxAge) { state.data = hit.data; finishLoad(seq); return; }
    const from = U().monthStart(ym);
    const elapsed = asOf >= from;
    const [scrap, plans] = await Promise.all([
      elapsed ? ScrapDataAdapter.getScrapData(db, { startDate: from, endDate: asOf }) : Promise.resolve({ records: [] }),
      WeeklyPlanData.loadPlans(db, ym)
    ]);
    if (seq !== state.loadSeq) return;
    const dates = elapsed ? U().datesBetween(from, asOf) : [];
    const close = await WeeklyPlanData.closeStatus(db, dates, scrap.records, !!scrap.error, null);
    if (seq !== state.loadSeq) return;
    state.data = { scrap, plans, close };
    state.readAt = Date.now();
    if (!scrap.error && !close.failed && !plans.error) state.cache.set(ym, { asOf, at: Date.now(), data: state.data });   // never keep a failed read
    finishLoad(seq);
  }
  function loadedAtText() {
    const hit = state.cache.get(state.ym), at = hit ? hit.at : state.readAt;
    if (!at) return '';
    const maxAge = (typeof QD_VIEW_CACHE_MINUTES === 'number' ? QD_VIEW_CACHE_MINUTES : 5) * 60000;
    const t = new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
    return Date.now() - at >= maxAge ? `Loaded ${t} (TH) · older than ${maxAge / 60000} min — press Reload` : `Loaded ${t} (TH)`;
  }
  function showLoadedAt() { const el = $('wpLoadedAt'); if (el) { el.textContent = loadedAtText(); el.classList.toggle('stale', /older/.test(el.textContent)); } }
  function finishLoad(seq) {
    showLoadedAt();
    const { scrap, plans, close } = state.data;
    const msgs = [];
    if (scrap.error) msgs.push('Scrap data could not be read — no figures are shown (never shown as 0).');
    if (close.failed) msgs.push('Shift close status could not be read — affected days show Read error.');
    if (plans.error) msgs.push(/permission/i.test(plans.error.code || plans.error.message || '')
      ? 'Weekly plans are not readable here (access denied by the Firestore rules) — the default plan (50 × days) is shown and is NOT a confirmed plan.'
      : 'Weekly plans could not be read (read error) — the default plan (50 × days) is shown and is NOT a confirmed plan. Try Reload.');
    banner(scrap.error ? 'error' : 'warn', msgs.length ? '⚠ ' + msgs.join(' ') : '');
    compute();
    render();
    loadReviews(seq);
  }
  function compute() {
    const d = state.data;
    state.month = C().buildMonth({
      ym: state.ym, asOf: state.asOf, records: d.scrap.records, scrapReadFailed: !!d.scrap.error,
      closeFrom: d.close.from, closeUnits: d.close.units, closeReadFailed: d.close.failed,
      overrides: d.plans.overrides, plansReadFailed: !!d.plans.error, dailyTarget: DAILY_TARGET_PCS
    });
    const weeks = state.month.weeks;
    if (!state.week || !weeks.some(w => w.key === state.week)) {
      const cur = weeks.find(w => state.asOf >= w.start && state.asOf <= w.end);
      state.week = (cur || (state.asOf < state.month.monthStart ? weeks[0] : weeks[weeks.length - 1])).key;
    }
  }
  async function loadReviews(seq) {
    state.reviews = null;
    if (!signedIn()) { renderReview(); return; }
    const r = await WeeklyPlanData.loadReviews(window.qdDb, state.ym);
    if (seq !== state.loadSeq) return;
    state.reviews = r; renderReview();
  }

  // ---- render ----------------------------------------------------------------------------
  function render() { renderMonth(); renderWeeks(); renderWeek(); renderImprove(); renderReview(); writeUrl(); }

  function dataLine(c, m) {
    const parts = [`${fmt(c.final)} of ${fmt(c.elapsed)} day${c.elapsed === 1 ? '' : 's'} final`];
    if (c.logged) parts.push(`${fmt(c.logged)} logged, not closed`);
    if (c.pending) parts.push(`${fmt(c.pending)} pending close`);
    if (c.conflict) parts.push(`${fmt(c.conflict)} conflict`);
    if (c.noData) parts.push(`${fmt(c.noData)} without any scrap log (not counted as 0)`);
    if (c.readError) parts.push(`${fmt(c.readError)} read error`);
    if (m && !m.closeInUse) parts.push('Shift Close not in use yet, so no day can be final');
    return parts.join(' · ');
  }
  const soFar = p => (p.soFar && p.actual !== null && p.elapsedDays > 0 ? '<sup class="wp-sofar" title="So far — includes days that are not final">so far</sup>' : '');

  function budgetSourceText(m) {
    if (m.budgetSource === 'UNAVAILABLE') return plansProblem() === 'denied' ? 'plans not readable (access denied): default, unconfirmed' : 'plans could not be read: default, unconfirmed';
    const set = m.planSources.OVERRIDE + m.planSources.ADMIN_DEFAULT;
    return set === m.weeks.length ? 'all weeks set by an Admin' : `${set} of ${m.weeks.length} weeks set by an Admin, ${m.planSources.DEFAULT} default (not set)`;
  }
  function renderMonth() {
    const m = state.month;
    const tile = (k, label, value, sub, extra = '') => `<div class="wp-tile" data-k="${k}"${extra}><div class="wp-tile-label">${label}</div><div class="wp-tile-value">${value}</div><div class="wp-tile-sub">${sub}</div></div>`;
    const remainSub = m.actual === null ? '' : (m.remaining < 0 ? 'over the budget' : (m.soFar ? 'at most, while days are not final' : 'left in the budget'));
    $('wpMonth').innerHTML = `
      <div class="wp-month-head"><h2>${esc(m.monthLabel)}</h2>${chip(STATUS, statusKey(m))}<span class="wp-asof">as of ${esc(m.elapsedDays ? U().shortDate(m.asOf) : '—')}</span></div>
      <div class="wp-tiles">
        ${tile('budget', m.budgetSource === 'CONFIRMED' ? 'Monthly budget' : 'Monthly budget · default', fmt(m.budget) + ' <small>pcs</small>' + (m.budgetSource === 'CONFIRMED' ? '' : ' ' + planTag(m.budgetSource === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'DEFAULT')),
          `= sum of ${m.weeks.length} weekly plans · ${budgetSourceText(m)} · base ${fmt(m.dailyTarget)} × ${m.daysInMonth} days = ${fmt(m.baseBudget)}`)}
        ${tile('actual', 'Actual', (m.actual === null ? '–' : fmt(m.actual)) + ' <small>pcs</small>' + soFar(m), `plan to date ${fmt(m.planToDate)} pcs`)}
        ${tile('remaining', 'Remaining', m.actual === null ? '–' : remain(m.remaining) + (m.remaining < 0 ? '' : ' <small>pcs</small>'), remainSub)}
        ${tile('used', '% Used', pct(m.used), m.projection === null ? 'projection: needs a log every day' : `projection ${fmt(m.projection)} pcs`)}
      </div>
      <div class="wp-bar" aria-hidden="true"><i style="width:${Math.min(100, (m.used || 0) * 100).toFixed(1)}%" class="${m.status === 'OVER' ? 'bad' : ''}"></i><b style="left:${m.budget ? Math.min(100, m.planToDate / m.budget * 100).toFixed(1) : 0}%" title="plan to date"></b></div>
      <div class="wp-data" id="wpMonthData">Data: ${esc(dataLine(m.counts, m))}</div>
      ${m.warnings.filter(w => w.startsWith('override-invalid')).map(w => `<div class="wp-warn">Override for ${esc(w.split(':')[1])} is above ${fmt(m.dailyTarget)}/day and was not applied (default plan used).</div>`).join('')}`;
  }

  function renderWeeks() {
    const m = state.month, edit = canEdit();
    const rows = m.weeks.map(w => `
      <tr data-week="${w.key}" class="${w.key === state.week ? 'selected' : ''}" tabindex="0">
        <th scope="row">${w.key}</th>
        <td>${esc(w.label)}</td><td class="n">${w.days}</td>
        <td class="n"><span class="wp-plan">${fmt(w.plan)}</span>${w.override !== null ? ` <span class="wp-ov" title="Admin override (base ${fmt(w.basePlan)})">base ${fmt(w.basePlan)}</span>` : ''}</td>
        <td>${planTag(w.planSource)}</td>
        <td class="n">${w.elapsedDays ? fmt(w.planToDate) : '–'}</td>
        <td class="n">${w.elapsedDays ? (w.actual === null ? '–' : (w.noLog ? '<span class="wp-unknown" title="No scrap log on any day yet — not counted as 0">No log</span>' : fmt(w.actual) + soFar(w))) : '–'}</td>
        <td class="n">${w.elapsedDays && w.actual !== null && !w.noLog ? remain(w.remaining) : '–'}</td>
        <td class="n">${w.elapsedDays && !w.noLog ? pct(w.used) : '–'}</td>
        <td>${chip(STATUS, statusKey(w))}</td>
        <td>${w.elapsedDays ? `${w.counts.final}/${w.elapsedDays} final` : '—'}${w.counts.overDaily ? ` <span class="wp-chip bad" title="Days over the daily limit">${w.counts.overDaily} day${w.counts.overDaily === 1 ? '' : 's'} &gt;${fmt(m.dailyTarget)}</span>` : ''}</td>
        ${edit ? `<td><button type="button" class="sc-btn wp-edit" data-edit="${w.key}">Edit plan</button></td>` : ''}
      </tr>`).join('');
    $('wpWeeks').innerHTML = `
      <div class="wp-scroll"><table class="wp-table" id="wpWeeksTable">
        <thead><tr><th>Week</th><th>Dates</th><th class="n">Days</th><th class="n">Plan</th><th>Plan source</th><th class="n">Plan to date</th><th class="n">Actual</th><th class="n">Remaining</th><th class="n">Used</th><th>Status</th><th>Data</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Month</th><td></td><td class="n">${m.daysInMonth}</td><td class="n">${fmt(m.budget)}</td><td>${m.budgetSource === 'CONFIRMED' ? '' : planTag(m.budgetSource === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'DEFAULT')}</td><td class="n">${m.elapsedDays ? fmt(m.planToDate) : '–'}</td><td class="n">${m.actual === null ? '–' : fmt(m.actual)}</td><td class="n">${m.actual === null ? '–' : remain(m.remaining)}</td><td class="n">${pct(m.used)}</td><td>${chip(STATUS, statusKey(m))}</td><td>${m.elapsedDays ? `${m.counts.final}/${m.elapsedDays} final` : '—'}</td>${edit ? '<td></td>' : ''}</tr></tfoot>
      </table></div>
      <p class="wp-note">Weeks run Monday–Sunday inside the month, so a day is counted in one week of one month only. Plan = ${fmt(DAILY_TARGET_PCS)} × days unless an Admin sets a lower plan.</p>`;
  }

  function lineShiftTable(ls, caption) {
    const sh = SHIFTS.map(s => s.code);
    const row = (label, o, cls = '') => `<tr class="${cls}"><th scope="row">${esc(label)}</th>${sh.map(s => `<td class="n">${fmt(o[s])}</td>`).join('')}<td class="n"><b>${fmt(o.total)}</b></td></tr>`;
    return `<div class="wp-scroll"><table class="wp-table wp-ls" data-ls="${esc(caption)}"><caption>${esc(caption)}</caption>
      <thead><tr><th>Line</th>${SHIFTS.map(s => `<th class="n">${esc(s.label)}</th>`).join('')}<th class="n">Total</th></tr></thead>
      <tbody>${LINES.map(l => row(l.label, ls[l.code])).join('')}</tbody>
      <tfoot>${row('Door A+B+C', ls.total, 'total')}</tfoot></table></div>`;
  }

  function renderWeek() {
    const m = state.month, w = m.weeks.find(x => x.key === state.week);
    const days = w.dayList.map(d => `
      <tr data-date="${d.date}">
        <th scope="row">${esc(d.label)}</th>
        <td class="n">${d.state === 'FUTURE' ? '—' : (d.qty === null ? '<span class="wp-unknown" title="No scrap log — not counted as 0">—</span>' : fmt(d.qty))}</td>
        <td>${d.qty === null ? '' : (d.overDaily ? `<span class="wp-chip bad">&gt;${fmt(m.dailyTarget)}</span>` : `<span class="wp-chip good">≤${fmt(m.dailyTarget)}</span>`)}</td>
        <td>${dayChip(d)}</td>
        <td>${d.closeRequired && d.state !== 'FUTURE' ? `<a href="daily-confirmation.html?date=${d.date}${window.qdEmulator ? '&qdEmulator=1' : ''}">${esc(d.closeText || '0/6')} closed</a>` : (d.state === 'FUTURE' ? '' : 'close not required')}</td>
        ${LINES.map(l => `<td class="n">${d.state === 'FUTURE' || d.qty === null ? '—' : fmt(d.lineShift[l.code].total)}</td>`).join('')}
      </tr>`).join('');
    $('wpWeekDetail').innerHTML = `
      <div class="wp-section-head"><h2>${w.key} · ${esc(w.label)}</h2>${chip(STATUS, statusKey(w))}</div>
      <p class="wp-data" id="wpWeekData">Plan ${fmt(w.plan)} pcs${w.override !== null ? ` (Admin override, base ${fmt(w.basePlan)})` : ` (${fmt(DAILY_TARGET_PCS)} × ${w.days} days)`} ${planTag(w.planSource)} · Actual ${w.actual === null ? '–' : (w.noLog ? 'no scrap log yet' : fmt(w.actual) + (w.soFar && w.elapsedDays ? ' so far' : ''))} · Remaining ${w.actual === null || !w.elapsedDays || w.noLog ? '–' : remain(w.remaining)} · Data: ${esc(w.elapsedDays ? dataLine(w.counts, m) : 'not started')}</p>
      <div class="wp-grid2">
        <div><div class="wp-scroll"><table class="wp-table" id="wpDaysTable"><caption>Days · daily limit ≤${fmt(m.dailyTarget)} pcs (Door A+B+C, Day + Night)</caption>
          <thead><tr><th>Date</th><th class="n">Scrap</th><th>≤${fmt(m.dailyTarget)}</th><th>Data</th><th>Shift Close</th>${LINES.map(l => `<th class="n">${esc(l.label)}</th>`).join('')}</tr></thead>
          <tbody>${days}</tbody></table></div></div>
        <div>${lineShiftTable(w.lineShift, `${w.key} by Line × Shift`)}${lineShiftTable(m.lineShift, `${m.monthLabel} to date by Line × Shift`)}</div>
      </div>`;
  }

  function renderImprove() {
    const m = state.month, w = m.weeks.find(x => x.key === state.week);
    const scope = state.improveScope;
    const [from, to] = scope === 'week' ? [w.start, w.end < m.asOf ? w.end : m.asOf] : [m.monthStart, m.asOf];
    const t = state.data.scrap.error ? null : C().topDefects(state.data.scrap.records, from, to, { topN: typeof QD_IMPROVE_TOP_N === 'number' ? QD_IMPROVE_TOP_N : 5, threshold: RECURRING_THRESHOLD_DISTINCT_DATES });
    const head = `<div class="wp-section-head"><h2>Improve · Top ${typeof QD_IMPROVE_TOP_N === 'number' ? QD_IMPROVE_TOP_N : 5} defects (all lines)</h2>
      <div class="qd-segmented" role="group" aria-label="Improve period"><button type="button" data-scope="week" class="${scope === 'week' ? 'active' : ''}">${w.key}</button><button type="button" data-scope="month" class="${scope === 'month' ? 'active' : ''}">Month to date</button></div></div>`;
    if (!t) { $('wpImprove').innerHTML = head + '<p class="wp-note">Scrap data could not be read.</p>'; return; }
    if (!t.rows.length) { $('wpImprove').innerHTML = head + '<p class="wp-note">No scrap logged in this period (days without a log are unknown, not 0).</p>'; return; }
    const rows = t.rows.map(r => `
      <li class="wp-defect" data-defect="${esc(r.defectType)}">
        <div class="wp-defect-main">
          <span class="wp-rank">${r.rank}</span>
          <span class="wp-defect-name"><b>${esc(r.defectType)}</b>${r.recurring ? ` <span class="wp-chip warn" title="Seen on ${r.days} different days">Recurring · ${r.days} days</span>` : ` <small>${r.days} day${r.days === 1 ? '' : 's'}</small>`}</span>
          <span class="wp-defect-qty">${fmt(r.qty)} <small>pcs · ${(r.share * 100).toFixed(1)}%</small></span>
        </div>
        <div class="wp-defect-lines">${LINES.map(l => `<span class="wp-line${r.byLine[l.code] ? '' : ' zero'}" data-line="${l.code}">${esc(l.label)} <b>${fmt(r.byLine[l.code])}</b></span>`).join('')}</div>
        <details class="wp-causes"><summary>Sub-causes (${r.causes.length})</summary>
          <table class="wp-table"><thead><tr><th>Cause</th><th class="n">Total</th>${LINES.map(l => `<th class="n">${esc(l.label)}</th>`).join('')}</tr></thead>
          <tbody>${r.causes.map(c => `<tr><td>${esc(c.cause)}</td><td class="n">${fmt(c.qty)}</td>${LINES.map(l => `<td class="n">${fmt(c.byLine[l.code])}</td>`).join('')}</tr>`).join('')}</tbody></table>
        </details>
      </li>`).join('');
    $('wpImprove').innerHTML = head + `<ol class="wp-defects" id="wpDefects">${rows}</ol>
      <p class="wp-note">One row per defect, all lines together (never repeated per line). ${fmt(t.defects)} defect type${t.defects === 1 ? '' : 's'} · ${fmt(t.total)} pcs in the period. <a href="improvement.html${window.qdEmulator ? '?qdEmulator=1' : ''}">Open Improvement →</a></p>`;
  }

  function renderReview() {
    const box = $('wpReview');
    if (!window.QDAuth || !QDAuth.getState().enabled) { box.hidden = true; return; }
    box.hidden = false;
    if (!signedIn()) { box.innerHTML = '<h2>Review note</h2><p class="wp-note">Sign in to read the weekly review notes.</p>'; return; }
    if (!state.reviews) { box.innerHTML = '<h2>Review note</h2><p class="wp-note">Loading…</p>'; return; }
    if (state.reviews.error) { box.innerHTML = '<h2>Review note</h2><p class="wp-note">Review notes could not be read.</p>'; return; }
    const note = (state.reviews.notes[state.week] || {}).reviewNote || '';
    box.innerHTML = `<h2>Review note · ${esc(state.week)}</h2>` + (canEdit()
      ? `<textarea id="wpReviewText" maxlength="2000" rows="4" aria-label="Review note">${esc(note)}</textarea>
         <div class="wp-actions"><button type="button" class="sc-btn primary" id="wpReviewSave">Save note</button><span id="wpReviewMsg" class="wp-note" role="status"></span></div>`
      : `<p id="wpReviewText" class="wp-review-text">${note ? esc(note) : '<span class="wp-note">No note for this week.</span>'}</p>`);
    const save = $('wpReviewSave');
    if (save) save.addEventListener('click', async () => {
      const msg = $('wpReviewMsg'); msg.textContent = 'Saving…';
      try { await WeeklyPlanData.saveReview(window.qdDb, { ym: state.ym, week: state.week, reviewNote: $('wpReviewText').value }); msg.textContent = 'Saved.'; state.reviews.notes[state.week] = { reviewNote: $('wpReviewText').value }; }
      catch (e) { msg.textContent = 'Not saved: ' + (e && e.message || e); }
    });
  }

  // ---- reduction goal (previous month, loaded on demand) ---------------------------------
  async function loadGoal() {
    const maxAge = (typeof QD_VIEW_CACHE_MINUTES === 'number' ? QD_VIEW_CACHE_MINUTES : 5) * 60000;
    if (state.goal && state.goal.forYm === state.ym && Date.now() - state.goal.at < maxAge) { renderGoal(); return; }
    if (!state.month) return;
    const seq = state.loadSeq, db = window.qdDb, pym = U().prevMonth(state.ym);
    $('wpGoalBody').innerHTML = '<div class="wp-loading">Loading the previous month…</div>';
    const from = U().monthStart(pym), to = U().monthEnd(pym);
    const scrap = await ScrapDataAdapter.getScrapData(db, { startDate: from, endDate: to });
    const close = await WeeklyPlanData.closeStatus(db, U().datesBetween(from, to), scrap.records, !!scrap.error, null);
    if (seq !== state.loadSeq) return;
    const prev = C().buildMonth({ ym: pym, asOf: to, records: scrap.records, scrapReadFailed: !!scrap.error, closeFrom: close.from, closeUnits: close.units, closeReadFailed: close.failed, overrides: {}, dailyTarget: DAILY_TARGET_PCS });
    state.goal = Object.assign(C().reductionGoal({ prev, current: state.month, goal: QD_MONTHLY_REDUCTION_GOAL }), { forYm: state.ym, at: Date.now() });
    if (!scrap.error && !close.failed) state.goals.set(state.ym, state.goal);
    renderGoal();
  }
  function renderGoal() {
    const g = state.goal, m = state.month;
    if (g.status === 'READ_ERROR') { $('wpGoalBody').innerHTML = '<p class="wp-note">The previous month could not be read — no goal is shown.</p>'; return; }
    const pctGoal = Math.round(g.goal * 100);
    const label = { CONFIRMED: ['Confirmed', 'good'], PROVISIONAL: ['Provisional — previous month not confirmed', 'warn'], NO_DATA: ['No data for the previous month', 'neutral'] }[g.status];
    $('wpGoalBody').innerHTML = `
      <div class="wp-section-head"><span class="wp-chip ${label[1]}" id="wpGoalStatus" data-status="${g.status}">${esc(label[0])}</span></div>
      <dl class="wp-goal">
        <div><dt>Basis</dt><dd>${esc(g.prevLabel)} scrap ${fmt(g.baseline)} pcs (Door A+B+C, Day + Night)</dd></div>
        <div><dt>Goal (−${pctGoal}%)</dt><dd id="wpGoalPcs">${g.status === 'NO_DATA' ? '–' : '≤' + fmt(g.goalPcs) + ' pcs in ' + esc(m.monthLabel)}${g.status === 'PROVISIONAL' ? ' <small>(provisional)</small>' : ''}</dd></div>
        <div><dt>${esc(m.monthLabel)} so far</dt><dd>${g.currentActual === null ? '–' : fmt(g.currentActual) + ' pcs'}${g.goalToDate !== null && g.status !== 'NO_DATA' ? ` vs ${fmt(g.goalToDate)} pro-rated` : ''}</dd></div>
        <div><dt>Previous-month data</dt><dd>${esc(dataLine(g.prevCounts))}</dd></div>
      </dl>
      <p class="wp-note">This reduction goal is separate from the daily operational limit (≤${fmt(DAILY_TARGET_PCS)} pcs/day) and from the weekly budget. It is confirmed only when every day of the previous month is final through Shift Close.</p>`;
  }

  // ---- plan editing (Admin, sign-in) ------------------------------------------------------
  async function openEditor(weekKey) {
    const w = state.month.weeks.find(x => x.key === weekKey), dlg = $('wpEditDialog');
    $('wpEditTitle').textContent = `Weekly plan · ${state.month.monthLabel} ${w.key} (${w.label})`;
    $('wpEditBase').textContent = `${fmt(w.basePlan)} pcs (${fmt(DAILY_TARGET_PCS)} × ${w.days} days)`;
    $('wpEditInput').value = w.override === null ? '' : String(w.override);
    $('wpEditInput').max = String(w.basePlan);
    $('wpEditReason').value = ''; $('wpEditMsg').textContent = '';
    dlg.dataset.week = w.key; dlg.dataset.base = String(w.basePlan);
    $('wpEditHistory').innerHTML = '<li class="wp-note">Loading history…</li>';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    try {
      const h = await WeeklyPlanData.loadHistory(window.qdDb, state.ym, w.key);
      $('wpEditHistory').innerHTML = h.length ? h.map(x => `<li>#${x.rev} · ${x.from === null || x.from === undefined ? 'default' : fmt(x.from)} → ${x.to === null ? 'default' : fmt(x.to)} · ${esc(x.reason)} · ${esc(x.by || '')}${x.at ? ' · ' + esc(x.at.toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) + ' (TH)' : ''}</li>`).join('') : '<li class="wp-note">No changes yet.</li>';
    } catch (e) { $('wpEditHistory').innerHTML = '<li class="wp-note">History could not be read.</li>'; }
  }
  async function saveEditor(clear) {
    const dlg = $('wpEditDialog'), week = dlg.dataset.week, base = Number(dlg.dataset.base), msg = $('wpEditMsg');
    const raw = $('wpEditInput').value.trim();
    const value = clear || raw === '' ? null : Number(raw);
    if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= base)) { msg.textContent = `Enter a whole number from 0 to ${fmt(base)} (≤${fmt(DAILY_TARGET_PCS)}/day), or leave blank for the default.`; return; }
    if ($('wpEditReason').value.trim().length < 3) { msg.textContent = 'A reason is required (at least 3 characters).'; return; }
    msg.textContent = 'Saving…';
    try {
      await WeeklyPlanData.savePlan(window.qdDb, { ym: state.ym, week, planOverride: value, reason: $('wpEditReason').value, basePlan: base });
      const plans = await WeeklyPlanData.loadPlans(window.qdDb, state.ym);
      state.data.plans = plans; compute(); render();
      if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    } catch (e) { msg.textContent = 'Not saved: ' + (/permission/i.test(e && (e.code || e.message)) ? 'not allowed (Admin only)' : (e && e.message || e)); }
  }

  // ---- wiring ------------------------------------------------------------------------------
  function init() {
    const sidebar = $('dashboardSidebar'), toggle = $('dashboardMobileToggle'), overlay = $('dashboardSidebarOverlay');
    const set = open => { sidebar.classList.toggle('open', open); overlay.classList.toggle('open', open); toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    toggle.addEventListener('click', () => set(!sidebar.classList.contains('open')));
    overlay.addEventListener('click', () => set(false));
    $('wpRule').innerHTML = `Daily operational limit <b>≤${fmt(DAILY_TARGET_PCS)} pcs/day</b> · Door A+B+C · Day + Night · Weekly plan = ${fmt(DAILY_TARGET_PCS)} × days (Admin may set lower) · Monthly budget = sum of the weekly plans`;

    const qs = new URLSearchParams(location.search);
    state.ym = /^\d{4}-\d{2}$/.test(qs.get('ym') || '') ? qs.get('ym') : todayBkk().slice(0, 7);
    state.week = /^W[1-6]$/.test(qs.get('week') || '') ? qs.get('week') : null;
    $('wpMonthInput').value = state.ym;
    const go = ym => { state.ym = ym; state.week = null; $('wpMonthInput').value = ym; load(); };
    $('wpMonthInput').addEventListener('change', () => { if (/^\d{4}-\d{2}$/.test($('wpMonthInput').value)) go($('wpMonthInput').value); });
    $('wpPrev').addEventListener('click', () => go(U().prevMonth(state.ym)));
    $('wpNext').addEventListener('click', () => go(U().nextMonth(state.ym)));
    $('wpReload').addEventListener('click', () => load(true));
    $('wpWeeks').addEventListener('click', e => {
      const ed = e.target.closest('[data-edit]'); if (ed) { openEditor(ed.dataset.edit); return; }
      const tr = e.target.closest('tr[data-week]'); if (tr) { state.week = tr.dataset.week; renderWeeks(); renderWeek(); renderImprove(); renderReview(); writeUrl(); }
    });
    $('wpWeeks').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-week]')) { e.preventDefault(); e.target.click(); } });
    $('wpImprove').addEventListener('click', e => { const b = e.target.closest('[data-scope]'); if (b) { state.improveScope = b.dataset.scope; renderImprove(); } });
    $('wpGoal').addEventListener('toggle', () => { if ($('wpGoal').open) loadGoal(); });
    $('wpEditSave').addEventListener('click', () => saveEditor(false));
    $('wpEditClear').addEventListener('click', () => saveEditor(true));
    $('wpEditCancel').addEventListener('click', () => { const d = $('wpEditDialog'); if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); });
    if (window.QDAuth) QDAuth.onChange(() => { if (state.month) { renderWeeks(); loadReviews(state.loadSeq); } });
    window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });   // back/forward cache: never old data
    document.addEventListener('visibilitychange', () => { if (!document.hidden) showLoadedAt(); });
    window.addEventListener('focus', showLoadedAt);
    setInterval(showLoadedAt, 30000);   // clock only, no reads
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
