/**
 * scrap-plan-adapter.js
 * ------------------------------------------------------------------
 * Reads/writes the `scrapWeeklyPlans` collection (owned by this app,
 * never touches Production V2). One document per month + week:
 *   id: "2026-10_W3"
 *   { ym, week, planOverride: number|null, reviewNote: string, updatedAt }
 *
 * The weekly plan itself is DAILY_TARGET_PCS x days unless planOverride
 * is set — same as the "Plan Override" column in the workbook.
 *
 * NOTE: add `scrapWeeklyPlans` to Firestore Security Rules (same pattern
 * as scrapLogs / improvements). Until then reads may still work but
 * saves will fail with "permission-denied"; the pages say so.
 *
 * Exposed as window.ScrapPlanAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  function docId(ym, week) { return `${ym}_${week}`; }

  /** -> { entries: { W1: { planOverride, reviewNote }, ... }, error? } */
  async function getMonth(db, ym) {
    if (!db) return { entries: {}, error: new Error('No Firestore connection.') };
    try {
      const snap = await db.collection(SCRAP_WEEKLY_PLAN_COLLECTION).where('ym', '==', ym).get();
      const entries = {};
      snap.forEach(doc => {
        const d = doc.data() || {};
        if (!d.week) return;
        const ov = d.planOverride;
        entries[d.week] = {
          planOverride: (ov === null || ov === undefined || ov === '') ? null : Number(ov),
          reviewNote: d.reviewNote || ''
        };
      });
      return { entries };
    } catch (e) {
      console.error('Quality Dashboard: failed to read scrapWeeklyPlans', e);
      return { entries: {}, error: e };
    }
  }

  /** Merge-writes one week. Pass only the fields that changed. */
  async function saveWeek(db, ym, week, patch) {
    if (!db) throw new Error('No Firestore connection.');
    const data = { ym, week, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if ('planOverride' in patch) {
      const v = patch.planOverride;
      if (v !== null && !(Number.isFinite(v) && v >= 0)) throw new Error('Plan must be a number ≥ 0, or blank to use the default.');
      data.planOverride = v;
    }
    if ('reviewNote' in patch) data.reviewNote = String(patch.reviewNote || '');
    return db.collection(SCRAP_WEEKLY_PLAN_COLLECTION).doc(docId(ym, week)).set(data, { merge: true });
  }

  window.ScrapPlanAdapter = { getMonth, saveWeek, docId };
})();
