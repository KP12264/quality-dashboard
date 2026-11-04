/**
 * weekly-plan-data.js — Firestore access for Weekly Plan V5 (Dashboard card + weekly-plan.html).
 * ------------------------------------------------------------------
 *   scrapWeeklyPlans/{ym}_{W#}            PUBLIC numbers only: { ym, week, planOverride, historyRev, updatedAt }
 *   scrapWeeklyPlans/{id}/history/{rev}   signed-in only, immutable: { from, to, reason, at, by }
 *   scrapWeeklyReviews/{ym}_{W#}          signed-in only: { ym, week, reviewNote, updatedAt, updatedBy }
 *
 * Scrap logs are NOT read here: callers pass the records they already loaded (the Dashboard's own
 * queries). Shift Close status comes from the existing public close summary through
 * TargetEvaluator (the same evaluation the Dashboard uses).
 * A plan change and its history entry are ONE transaction; the rules refuse a plan change
 * without its history entry. Writes only in sign-in mode, Admin only (weeklyPlan.write).
 *
 * Exposed as window.WeeklyPlanData.
 * ------------------------------------------------------------------
 */
(function () {
  const PLAN = () => (typeof QD_WEEKLY_PLAN_COLLECTION === 'string' ? QD_WEEKLY_PLAN_COLLECTION : 'scrapWeeklyPlans');
  const HIST = () => (typeof QD_WEEKLY_PLAN_HISTORY === 'string' ? QD_WEEKLY_PLAN_HISTORY : 'history');
  const REVIEW = () => (typeof QD_WEEKLY_REVIEW_COLLECTION === 'string' ? QD_WEEKLY_REVIEW_COLLECTION : 'scrapWeeklyReviews');
  const docId = (ym, week) => `${ym}_${week}`;

  /** -> { overrides: { W1: n|null }, error, queries, docs } — one query (<= 6 documents). */
  async function loadPlans(db, ym) {
    const out = { overrides: {}, error: null, queries: 1, docs: 0 };
    try {
      const snap = await db.collection(PLAN()).where('ym', '==', ym).get();
      snap.forEach(d => {
        const v = d.data() || {};
        if (!/^W[1-6]$/.test(v.week || '')) return;
        out.docs++;
        out.overrides[v.week] = v.planOverride === undefined ? null : v.planOverride;
      });
    } catch (e) {
      console.error('Quality Dashboard: failed to read weekly plans', e);
      out.error = e;
    }
    return out;
  }

  /** Review notes (signed-in only). -> { notes: { W1: { reviewNote } }, error } */
  async function loadReviews(db, ym) {
    const out = { notes: {}, error: null };
    try {
      const snap = await db.collection(REVIEW()).where('ym', '==', ym).get();
      snap.forEach(d => { const k = d.id.slice(8); out.notes[k] = { reviewNote: String((d.data() || {}).reviewNote || '') }; });
    } catch (e) {
      console.error('Quality Dashboard: failed to read weekly reviews', e);
      out.error = e;
    }
    return out;
  }

  /** Override history of one week (signed-in only), newest first. */
  async function loadHistory(db, ym, week) {
    const snap = await db.collection(PLAN()).doc(docId(ym, week)).collection(HIST()).get();
    const rows = [];
    snap.forEach(d => { const v = d.data() || {}; rows.push({ rev: Number(d.id), from: v.from, to: v.to, reason: v.reason, at: v.at && v.at.toDate ? v.at.toDate() : null, by: v.by }); });
    return rows.sort((a, b) => b.rev - a.rev);
  }

  /**
   * Shift Close status for the close-required dates in `dates`, judged by TargetEvaluator from
   * the public close summary and the scrap logs the caller already has.
   * reuse = { dates: [...], ctx } — a close context the page already loaded: only dates it does
   * not cover are read (one query at most). cache(key, fn) (optional) keeps that read for the session.
   * -> { from, units, failed, queries, docs }
   */
  async function closeStatus(db, dates, records, scrapReadFailed, reuse, cache) {
    const TE = window.TargetEvaluator;
    const from = TE.closeRequiredFrom();
    const need = dates.filter(d => TE.closeRequired(d, from));
    if (need.length === 0) return { from, units: [], failed: false, queries: 0, docs: 0 };
    const covered = reuse && reuse.ctx ? new Set(reuse.dates) : new Set();
    const missing = need.filter(d => !covered.has(d));
    const summaries = new Map(reuse && reuse.ctx ? reuse.ctx.summaries : []);
    let failed = !!(reuse && reuse.ctx && reuse.ctx.failed && need.some(d => covered.has(d)));
    let queries = 0, docs = 0;
    if (missing.length) {
      const load = () => TE.loadCloseContext(db, missing);
      const ctx = await (cache ? cache(`close|${missing.join(',')}`, load) : load());   // cache: optional, the card's session cache
      queries = ctx.queries; docs = ctx.docs;
      ctx.summaries.forEach((v, k) => summaries.set(k, v));
      failed = failed || ctx.failed;
    }
    const units = TE.evaluate({
      dates: need, activeShiftCodes: SHIFTS.map(s => s.code), production: [], scrap: records,
      scrapReadFailed: !!scrapReadFailed, productionErrors: [], shiftTargets: { histories: {}, failedShifts: [] },
      closeContext: { from, summaries, failed }
    });
    return { from, units, failed, queries, docs };
  }

  function requireAdmin() {
    if (!window.QDAuth || !QDAuth.getState().enabled) throw new Error('Plan editing needs sign-in (not in use on this site yet).');
    QDAuth.assertCan('weeklyPlan.write', {});
    return QDAuth.getState().email;
  }

  /**
   * Admin: set (or clear with null) the override of one week, with a reason. One transaction:
   * plan document (historyRev + 1) + history/{historyRev} { from, to, reason, at, by }.
   */
  async function savePlan(db, { ym, week, planOverride, reason, basePlan }) {
    const email = requireAdmin();
    const r = String(reason || '').trim();
    if (r.length < 3 || r.length > 200) throw new Error('Reason must be 3–200 characters.');
    if (planOverride !== null && !(Number.isInteger(planOverride) && planOverride >= 0 && planOverride <= basePlan)) {
      throw new Error(`Plan must be a whole number from 0 to ${basePlan} pcs (≤${DAILY_TARGET_PCS}/day), or blank for the default.`);
    }
    const FV = firebase.firestore.FieldValue;
    const ref = db.collection(PLAN()).doc(docId(ym, week));
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const old = snap.exists ? snap.data() : null;
      const rev = (old && Number.isInteger(old.historyRev) ? old.historyRev : 0) + 1;
      const fromVal = old && old.planOverride !== undefined ? old.planOverride : null;
      tx.set(ref, { ym, week, planOverride, historyRev: rev, updatedAt: FV.serverTimestamp() });
      tx.set(ref.collection(HIST()).doc(String(rev)), { from: fromVal, to: planOverride, reason: r, at: FV.serverTimestamp(), by: email });
      return rev;
    });
  }

  /** Admin: review note of one week (signed-in readers only). */
  async function saveReview(db, { ym, week, reviewNote }) {
    const email = requireAdmin();
    const note = String(reviewNote || '');
    if (note.length > 2000) throw new Error('Review note: at most 2000 characters.');
    return db.collection(REVIEW()).doc(docId(ym, week)).set({ ym, week, reviewNote: note, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: email });
  }

  window.WeeklyPlanData = { loadPlans, loadReviews, loadHistory, closeStatus, savePlan, saveReview, docId };
})();
