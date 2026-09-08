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
   * -> { id, date, shift, line, model, defectType, scrapQty, remark, createdAt }
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
      remark: raw.remark || "",
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
   * addScrapEntry(db, { date, shift, line, model, defectType, scrapQty, remark })
   * Writes ONE new scrap entry to scrapLogs. Never writes to
   * productionLogs. Validates the required fields (all of them, since
   * matching against production depends on date+shift+line+model being
   * correct and consistent). `remark` is optional — always stored as a
   * string, "" when not provided.
   */
  async function addScrapEntry(db, { date, shift, line, model, defectType, scrapQty, remark }) {
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
      remark: remark || "",
      createdAt: Date.now()
    });
  }

  /**
   * updateScrapEntry(db, id, { date, shift, line, model, defectType, scrapQty, remark })
   * Updates an EXISTING scrapLogs document in place (no duplicate is
   * created). Only ever touches SCRAP_COLLECTION — never productionLogs.
   * Same field validation as addScrapEntry, since Edit can change any
   * of the matching keys (date/shift/line/model) or the defect/qty.
   */
  async function updateScrapEntry(db, id, { date, shift, line, model, defectType, scrapQty, remark }) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    if (!id) throw new Error("updateScrapEntry requires an id.");
    const missing = [];
    if (!date) missing.push("date");
    if (!shift) missing.push("shift");
    if (!line) missing.push("line");
    if (!model) missing.push("model");
    if (!defectType) missing.push("defectType");
    if (!(num(scrapQty) > 0)) missing.push("scrapQty (must be > 0)");
    if (missing.length) {
      throw new Error("updateScrapEntry is missing/invalid: " + missing.join(", "));
    }
    return db.collection(SCRAP_COLLECTION).doc(id).update({
      date, shift, line, model, defectType,
      scrapQty: num(scrapQty),
      remark: remark || "",
      updatedAt: Date.now()
    });
  }

  /**
   * deleteScrapEntry(db, id)
   * Deletes ONE scrapLogs document. Only ever touches SCRAP_COLLECTION —
   * never productionLogs. Callers (Scrap Detail page) are responsible
   * for showing a confirmation dialog before calling this — this
   * function itself performs the delete unconditionally once called.
   */
  async function deleteScrapEntry(db, id) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    if (!id) throw new Error("deleteScrapEntry requires an id.");
    return db.collection(SCRAP_COLLECTION).doc(id).delete();
  }

  /**
   * addScrapEntries(db, entries)
   * Batch version of addScrapEntry for the multi-row Scrap Entry page —
   * saves each row independently (Promise.allSettled) so one bad row
   * never silently drops the others, and the caller can report exactly
   * which rows succeeded/failed rather than an all-or-nothing result.
   * Returns { succeeded: [{entry, id}], failed: [{entry, error}] }.
   */
  async function addScrapEntries(db, entries) {
    const results = await Promise.allSettled(entries.map(e => addScrapEntry(db, e)));
    const succeeded = [];
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push({ entry: entries[i], id: r.value.id });
      else failed.push({ entry: entries[i], error: r.reason });
    });
    return { succeeded, failed };
  }

  window.ScrapDataAdapter = {
    normalizeScrapRecord,
    getScrapData,
    addScrapEntry,
    addScrapEntries,
    updateScrapEntry,
    deleteScrapEntry
  };

})();
