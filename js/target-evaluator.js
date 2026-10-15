/**
 * target-evaluator.js
 * ------------------------------------------------------------------
 * THE ONE place that judges scrap against a target. Both the Dashboard and
 * the Executive Report call this module with the data they have already
 * loaded, so they can never disagree. Pure logic apart from
 * loadShiftTargetContext(), whose only Firestore access is READING
 * targetMaster (never written, never changed).
 *
 * TWO RULES, chosen per production date (see config.js):
 *
 *   date <  TARGET_DAILY_RULE_EFFECTIVE_DATE  -> rule 'SHIFT'
 *       one unit per active shift, <= targetMaster per-shift target
 *       (default 30), Door A+B+C combined. Behaviour is exactly the
 *       previous one (same targetMaster effective-date lookup, same
 *       NO DATA / WITHIN / OVER results) — except that a read failure can
 *       no longer turn into WITHIN (see below).
 *
 *   date >= TARGET_DAILY_RULE_EFFECTIVE_DATE  -> rule 'DAY'
 *       ONE unit per production date: Day + Night scrap of Door A+B+C
 *       summed and compared with DAILY_TARGET_PCS (50). targetMaster is not
 *       read for these dates. A Shift filter never changes this: the caller
 *       must load BOTH shifts for these dates (productionFetchPlan()).
 *
 * STATUS VOCABULARY
 *   OVER TARGET     scrap is above the target. Certain even if some data is
 *                   still missing (scrap can only grow).
 *   WITHIN TARGET   at or below target AND the data needed to say so is there.
 *   INCOMPLETE      at or below target so far, but it cannot be confirmed:
 *                   a shift's production is missing, a read failed, or no
 *                   scrap log exists at all for the date. Never shown as
 *                   WITHIN, never treated as "scrap = 0".
 *   NO DATA         nothing at all for that unit (no production, no scrap
 *                   log, no read error).
 *
 * A missing scrap log is NOT proof of zero scrap (scrapLogs has no "zero
 * scrap" record), so a DAY-rule date with production but no scrap log is
 * INCOMPLETE ('no-scrap-log'). Door In Door is not included: only lines
 * A/B/C and shifts DAY/NIGHT are counted.
 *
 * Exposed as window.TargetEvaluator.
 * ------------------------------------------------------------------
 */
(function () {

  const OVER = 'OVER TARGET';
  const WITHIN = 'WITHIN TARGET';
  const INCOMPLETE = 'INCOMPLETE';
  const NO_DATA = 'NO DATA';

  const LINE_CODES = LINES.map(l => l.code);
  const SHIFT_CODES = SHIFTS.map(s => s.code);

  function shiftLabel(code) { const s = SHIFTS.find(x => x.code === code); return s ? s.label : code; }

  // ---- which rule applies -------------------------------------------------
  function ruleFor(dateStr) { return dateStr >= TARGET_DAILY_RULE_EFFECTIVE_DATE ? 'DAY' : 'SHIFT'; }

  function formatCutoverDate() {
    const m = TARGET_DAILY_RULE_EFFECTIVE_DATE.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return m ? `${m[3]} ${mon[parseInt(m[2], 10) - 1]} ${m[1]}` : TARGET_DAILY_RULE_EFFECTIVE_DATE;
  }

  /**
   * productionFetchPlan(dates, activeShiftCodes)
   * Which shifts must be READ for which dates. DAY-rule dates always need
   * both shifts (the daily total is Day + Night, whatever the Shift filter
   * says); SHIFT-rule dates only need the active shifts (as before).
   * -> [{ dates, shifts }, ...]  (one group when both lists coincide)
   */
  function productionFetchPlan(dates, activeShiftCodes) {
    const daily = dates.filter(d => ruleFor(d) === 'DAY');
    const legacy = dates.filter(d => ruleFor(d) === 'SHIFT');
    const sameShifts = activeShiftCodes.length === SHIFT_CODES.length;
    if (sameShifts || legacy.length === 0 || daily.length === 0) {
      const shifts = daily.length > 0 ? SHIFT_CODES.slice() : activeShiftCodes.slice();
      return [{ dates: dates.slice(), shifts }];
    }
    return [
      { dates: legacy, shifts: activeShiftCodes.slice() },
      { dates: daily, shifts: SHIFT_CODES.slice() }
    ];
  }

  /**
   * loadShiftTargetContext(db, dates, shiftCodes)
   * Reads targetMaster history ONCE per shift — and only when the range
   * contains at least one SHIFT-rule (pre-cutover) date. Ranges that start on
   * or after the cutover do not touch targetMaster at all.
   * -> { histories: { DAY: [...]|null, NIGHT: [...]|null }, failedShifts: [..], queries: n }
   *    (null = that read failed)
   */
  async function loadShiftTargetContext(db, dates, shiftCodes) {
    const ctx = { histories: {}, failedShifts: [], queries: 0 };
    if (!dates.some(d => ruleFor(d) === 'SHIFT')) return ctx;
    await Promise.all(shiftCodes.map(async (shiftCode) => {
      ctx.queries++;
      try {
        ctx.histories[shiftCode] = await TargetAdapter.getTargetHistory(db, shiftCode);
      } catch (e) {
        console.error('Quality Dashboard: failed to read targetMaster for shift', shiftCode, e);
        ctx.histories[shiftCode] = null;
        ctx.failedShifts.push(shiftCode);
      }
    }));
    return ctx;
  }

  // Same lookup TargetAdapter.getTargetForShift uses: newest record whose
  // effectiveDate <= date, otherwise the documented per-shift default.
  function legacyShiftTarget(ctx, shiftCode, dateStr) {
    const history = ctx && ctx.histories ? ctx.histories[shiftCode] : null;
    const applicable = history && history.find(r => r.effectiveDate && r.effectiveDate <= dateStr);
    return applicable ? applicable.targetQty : (DEFAULT_TARGET_PER_SHIFT_PCS[shiftCode] || 0);
  }

  /**
   * evaluate({ dates, activeShiftCodes, production, scrap, scrapReadFailed,
   *            productionErrors, shiftTargets })
   * production / scrap: ALL loaded records (every line/shift); this function
   * itself keeps only Door A/B/C and Day/Night. Returns one unit per
   * production date (rule DAY) or per date+active shift (rule SHIFT), in date
   * order. Every unit has: date, rule, unit ('DAY'|'SHIFT'), label, target,
   * totalScrap (null when scrap could not be read), scrapKnown (false when there is
   * no scrap log for a daily-rule date, so the 0 must not be displayed as a fact), gap,
   * status, reasons[], hasData, totalProduction.
   */
  function evaluate({ dates, activeShiftCodes, production, scrap, scrapReadFailed, productionErrors, shiftTargets }) {
    const prodCount = new Map(), prodQty = new Map(), scrapSum = new Map(), scrapN = new Map();
    const scrapDateN = new Map(), errByDate = new Map(), errByDateShift = new Map();
    let excludedScrapRecords = 0;

    (production || []).forEach(r => {
      if (!LINE_CODES.includes(r.line) || !SHIFT_CODES.includes(r.shift)) return;
      const k = `${r.date}|${r.shift}`;
      prodCount.set(k, (prodCount.get(k) || 0) + 1);
      prodQty.set(k, (prodQty.get(k) || 0) + (Number(r.productionQty) || 0));
    });
    (scrap || []).forEach(r => {
      if (!LINE_CODES.includes(r.line) || !SHIFT_CODES.includes(r.shift)) { excludedScrapRecords++; return; }
      const k = `${r.date}|${r.shift}`;
      scrapSum.set(k, (scrapSum.get(k) || 0) + (Number(r.scrapQty) || 0));
      scrapN.set(k, (scrapN.get(k) || 0) + 1);
      scrapDateN.set(r.date, (scrapDateN.get(r.date) || 0) + 1);
    });
    (productionErrors || []).forEach(e => {
      if (!LINE_CODES.includes(e.line)) return;
      errByDate.set(e.date, (errByDate.get(e.date) || 0) + 1);
      const k = `${e.date}|${e.shift}`;
      errByDateShift.set(k, (errByDateShift.get(k) || 0) + 1);
    });

    const units = [];
    dates.forEach(date => {
      if (ruleFor(date) === 'DAY') {
        const hasDay = (prodCount.get(`${date}|DAY`) || 0) > 0;
        const hasNight = (prodCount.get(`${date}|NIGHT`) || 0) > 0;
        const dayScrap = scrapSum.get(`${date}|DAY`) || 0, nightScrap = scrapSum.get(`${date}|NIGHT`) || 0;
        const logCount = scrapDateN.get(date) || 0;
        const readErrors = errByDate.get(date) || 0;
        const totalScrap = scrapReadFailed ? null : dayScrap + nightScrap;
        // With NO scrap log at all the total is UNKNOWN, not zero: display code must show it as unknown.
        const scrapKnown = !scrapReadFailed && logCount > 0;
        const reasons = [];
        let status;
        if (scrapReadFailed) {
          status = INCOMPLETE; reasons.push('scrap-read-failed');
        } else {
          if (!hasDay) reasons.push('day-production-missing');
          if (!hasNight) reasons.push('night-production-missing');
          if (readErrors > 0) reasons.push('production-read-error');
          if (logCount === 0) reasons.push('no-scrap-log');
          if (totalScrap > DAILY_TARGET_PCS) status = OVER;                       // certain even if data is partial
          else if (reasons.length === 0) status = WITHIN;
          else if (!hasDay && !hasNight && logCount === 0 && readErrors === 0) { status = NO_DATA; reasons.length = 0; }
          else status = INCOMPLETE;
        }
        units.push({
          date, rule: 'DAY', unit: 'DAY', shiftCode: null, label: 'Day + Night',
          target: DAILY_TARGET_PCS, totalScrap, shiftScrap: { DAY: dayScrap, NIGHT: nightScrap },
          totalProduction: (prodQty.get(`${date}|DAY`) || 0) + (prodQty.get(`${date}|NIGHT`) || 0),
          hasData: hasDay || hasNight, hasShiftProduction: { DAY: hasDay, NIGHT: hasNight }, scrapLogCount: logCount,
          scrapKnown, gap: scrapKnown ? totalScrap - DAILY_TARGET_PCS : null, status, reasons
        });
      } else {
        activeShiftCodes.forEach(shiftCode => {
          const k = `${date}|${shiftCode}`;
          const hasData = (prodCount.get(k) || 0) > 0;
          const target = legacyShiftTarget(shiftTargets, shiftCode, date);
          const targetUnavailable = !!(shiftTargets && shiftTargets.failedShifts && shiftTargets.failedShifts.includes(shiftCode));
          const sScrap = scrapSum.get(k) || 0;
          const totalScrap = scrapReadFailed ? null : sScrap;
          const reasons = [];
          // Previous behaviour, unchanged: no production for the shift = NO DATA; otherwise scrap vs target.
          let status = hasData ? (QualityAdapter.buildOverallSummary(
            [{ productionQty: prodQty.get(k) || 0 }], [{ scrapQty: sScrap }], target).status) : NO_DATA;
          // New: a failed read must never become "scrap = 0" / WITHIN.
          if (scrapReadFailed) { status = INCOMPLETE; reasons.push('scrap-read-failed'); }
          else if (targetUnavailable) { status = INCOMPLETE; reasons.push('target-unavailable'); }
          else if ((errByDateShift.get(k) || 0) > 0 && status !== OVER) { status = INCOMPLETE; reasons.push('production-read-error'); }
          units.push({
            date, rule: 'SHIFT', unit: 'SHIFT', shiftCode, label: shiftLabel(shiftCode),
            target, totalScrap, shiftScrap: null, totalProduction: prodQty.get(k) || 0,
            hasData, hasShiftProduction: null, scrapLogCount: scrapN.get(k) || 0, scrapKnown: totalScrap !== null,
            gap: totalScrap === null ? null : totalScrap - target, status, reasons
          });
        });
      }
    });
    units.excludedScrapRecords = excludedScrapRecords;
    return units;
  }

  // Priority across units: OVER > INCOMPLETE > WITHIN > NO DATA.
  // (Per-unit results are never summed and no target is ever added together.)
  function combineStatuses(units) {
    if (!units || units.length === 0) return NO_DATA;
    if (units.some(u => u.status === OVER)) return OVER;
    if (units.some(u => u.status === INCOMPLETE)) return INCOMPLETE;
    if (units.some(u => u.status === WITHIN)) return WITHIN;
    return NO_DATA;
  }

  // Counts per status, kept SEPARATE for days (DAY rule) and shifts (SHIFT
  // rule) so a range that spans the rule change is never reduced to one
  // unexplained percentage.
  function summarize(units) {
    const blank = () => ({ total: 0, within: 0, over: 0, incomplete: 0, noData: 0 });
    const out = { days: blank(), shifts: blank(), mixed: false, hasDays: false, hasShifts: false };
    units.forEach(u => {
      const b = u.unit === 'DAY' ? out.days : out.shifts;
      b.total++;
      if (u.status === WITHIN) b.within++; else if (u.status === OVER) b.over++;
      else if (u.status === INCOMPLETE) b.incomplete++; else b.noData++;
    });
    out.hasDays = out.days.total > 0; out.hasShifts = out.shifts.total > 0; out.mixed = out.hasDays && out.hasShifts;
    return out;
  }

  /**
   * describeTarget(units, fmt)
   * -> { mode:'DAY'|'SHIFT'|'MIXED'|'NONE', label, unitText, unitCode, ruleText }
   * unitCode is what the CSV reports as "Target Unit": DAY, SHIFT or SHIFT+DAY.
   */
  function describeTarget(units, fmt) {
    const f = fmt || (n => String(n));
    const daily = units.some(u => u.unit === 'DAY'), shift = units.filter(u => u.unit === 'SHIFT');
    const shiftLabelText = () => {
      const seen = new Set(), parts = [];
      shift.forEach(u => { const k = `${u.label}|${u.target}`; if (!seen.has(k)) { seen.add(k); parts.push(u); } });
      const uniqueTargets = Array.from(new Set(parts.map(u => u.target).filter(t => Number.isFinite(t) && t > 0)));
      if (uniqueTargets.length === 0) return '–';
      if (uniqueTargets.length === 1) return `≤${f(uniqueTargets[0])}`;
      return parts.map(u => `${u.label} ≤${f(u.target)}`).join(' · ');
    };
    const cutover = formatCutoverDate();
    if (daily && shift.length) {
      return { mode: 'MIXED', label: `${shiftLabelText()}/shift · ≤${f(DAILY_TARGET_PCS)}/day`, unitText: 'pcs scrap · rule changes ' + cutover, unitCode: 'SHIFT+DAY',
        ruleText: `<strong>&le;${f(DAILY_TARGET_PCS)} pcs/day</strong> from ${cutover} &middot; before that &le;30 pcs/shift (Day/Night separate) &middot; A+B+C combined` };
    }
    if (daily) {
      return { mode: 'DAY', label: `≤${f(DAILY_TARGET_PCS)}`, unitText: 'pcs scrap / day', unitCode: 'DAY',
        ruleText: `<strong>&le;${f(DAILY_TARGET_PCS)} pcs/day</strong> &middot; A+B+C combined &middot; Day + Night combined` };
    }
    if (shift.length) {
      return { mode: 'SHIFT', label: shiftLabelText(), unitText: 'pcs scrap / shift', unitCode: 'SHIFT',
        ruleText: '<strong>&le;30 pcs/shift</strong> &middot; A+B+C combined &middot; Day/Night separate' };
    }
    return { mode: 'NONE', label: '–', unitText: 'pcs scrap', unitCode: '', ruleText: '' };
  }

  // Human wording for the reason codes (used by both pages).
  const REASON_TEXT = {
    'day-production-missing': 'Day production missing',
    'night-production-missing': 'Night production missing',
    'production-read-error': 'Production read error',
    'no-scrap-log': 'No scrap log recorded',
    'scrap-read-failed': 'Scrap data could not be read',
    'target-unavailable': 'Target could not be read'
  };
  function reasonText(code) { return REASON_TEXT[code] || code; }

  window.TargetEvaluator = {
    STATUS: { OVER, WITHIN, INCOMPLETE, NO_DATA },
    ruleFor, formatCutoverDate, productionFetchPlan, loadShiftTargetContext,
    evaluate, combineStatuses, summarize, describeTarget, reasonText
  };

})();
