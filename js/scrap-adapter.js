/**
 * scrap-adapter.js
 * ------------------------------------------------------------------
 * Adapter for the NEW `scrapLogs` Firestore collection — this is data
 * this website owns. Unlike js/data-adapter.js (which is READ ONLY
 * against the existing `productionLogs`), this file both reads AND
 * writes, because scrapLogs belongs to this app, not the original
 * production system.
 *
 * This file never touches PRODUCTION_COLLECTION ("productionLogs") —
 * only SCRAP_COLLECTION ("scrapLogs"). If you need to cross-reference
 * production data, use js/data-adapter.js and join in
 * js/quality-adapter.js instead of reaching into productionLogs here.
 *
 * Per the business rule, a scrap entry deliberately has NO defect-time
 * field — the Leader records a total per Date + Shift + Line + Model +
 * Defect, without knowing exactly when in the shift it happened.
 *
 * Exposed as window.ScrapDataAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * normalizeScrapRecord(id, raw)
   * -> { id, date, shift, line, model, defectType, scrapQty, createdAt }
   */
  function normalizeScrapRecord(id, raw) {
    if (!raw) return null;
    return {
      id,
      date: raw.date || "",
      shift: raw.shift || "",
      line: raw.line || "",
      model: raw.model || "",
      defectType: raw.defectType || "",
      scrapQty: num(raw.scrapQty),
      createdAt: raw.createdAt || null
    };
  }

  /**
   * getScrapData(db, { startDate, endDate })
   * Reads every scrap entry with date in [startDate, endDate] (inclusive).
   * A single range filter on `date` needs no composite index. Line /
   * shift / model filtering happens in JS after the fetch, which is
   * cheap at this data volume (a factory records a handful of scrap
   * entries per shift, not thousands).
   *
   * Returns { records: [...normalized], error? }
   * On a read failure, records is [] and `error` is set — callers must
   * treat that as "could not load scrap data" and say so, not as
   * "zero scrap".
   */
  async function getScrapData(db, { startDate, endDate }) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    try {
      const snap = await db.collection(SCRAP_COLLECTION)
        .where("date", ">=", startDate)
        .where("date", "<=", endDate)
        .get();
      const records = [];
      snap.forEach(doc => {
        const r = normalizeScrapRecord(doc.id, doc.data());
        if (r) records.push(r);
      });
      return { records };
    } catch (e) {
      console.error("Quality Dashboard: failed to read scrapLogs", e);
      return { records: [], error: e };
    }
  }

  /**
   * addScrapEntry(db, { date, shift, line, model, defectType, scrapQty })
   * Writes ONE new scrap entry to scrapLogs. Never writes to
   * productionLogs. Validates the required fields (all of them, since
   * matching against production depends on date+shift+line+model being
   * correct and consistent).
   */
  async function addScrapEntry(db, { date, shift, line, model, defectType, scrapQty }) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    const missing = [];
    if (!date) missing.push("date");
    if (!shift) missing.push("shift");
    if (!line) missing.push("line");
    if (!model) missing.push("model");
    if (!defectType) missing.push("defectType");
    if (!(num(scrapQty) > 0)) missing.push("scrapQty (must be > 0)");
    if (missing.length) {
      throw new Error("addScrapEntry is missing/invalid: " + missing.join(", "));
    }
    return db.collection(SCRAP_COLLECTION).add({
      date, shift, line, model, defectType,
      scrapQty: num(scrapQty),
      createdAt: Date.now()
    });
  }

  window.ScrapDataAdapter = {
    normalizeScrapRecord,
    getScrapData,
    addScrapEntry
  };

})();
