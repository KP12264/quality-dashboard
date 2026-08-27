/**
 * target-adapter.js
 * ------------------------------------------------------------------
 * Reads (and lets a Leader/Admin write) the Scrap Target for a given
 * shift, honoring effective-dating: a target set with effectiveDate
 * "2026-09-01" applies to that date and every later date, until a
 * newer target record with a later effectiveDate supersedes it.
 * Historical dates keep using whatever target was effective back then.
 *
 * The Target is a TOTAL across all 3 lines combined for that shift —
 * never per line. This file is the single place that business rule is
 * encoded; nothing else in the dashboard should multiply a target by
 * line count.
 *
 * This is a NEW collection (targetMaster) belonging to THIS website —
 * it is not part of the existing production system, so normal reads
 * AND writes are fine here (unlike productionLogs).
 *
 * Exposed as window.TargetAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * normalizeTargetRecord(id, raw)
   * -> { id, shift, targetQty, effectiveDate, note }
   */
  function normalizeTargetRecord(id, raw) {
    if (!raw) return null;
    return {
      id,
      shift: raw.shift || "",
      targetQty: num(raw.targetQty),
      effectiveDate: raw.effectiveDate || "",
      note: raw.note || ""
    };
  }

  /**
   * getTargetHistory(db, shiftCode)
   * Fetches every targetMaster record for one shift. A single equality
   * filter (no orderBy on a different field) so this never needs a
   * Firestore composite index — sorting by effectiveDate happens here
   * in JS instead.
   */
  async function getTargetHistory(db, shiftCode) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    const snap = await db.collection(TARGET_MASTER_COLLECTION)
      .where("shift", "==", shiftCode)
      .get();
    const records = [];
    snap.forEach(doc => {
      const r = normalizeTargetRecord(doc.id, doc.data());
      if (r) records.push(r);
    });
    records.sort((a, b) => a.effectiveDate < b.effectiveDate ? 1 : -1); // newest first
    return records;
  }

  /**
   * getTargetForShift(db, shiftCode, dateStr)
   * Returns { targetQty, source, effectiveDate } where source is
   * 'targetMaster' (a real record applied) or 'default' (fell back to
   * config's DEFAULT_TARGET_PER_SHIFT_PCS because no targetMaster
   * record's effectiveDate is <= dateStr yet).
   */
  async function getTargetForShift(db, shiftCode, dateStr) {
    let history = [];
    try {
      history = await getTargetHistory(db, shiftCode);
    } catch (e) {
      console.error("Quality Dashboard: failed to read targetMaster for shift", shiftCode, e);
      // Connection problem — fall back to default rather than blocking
      // the whole dashboard on a non-core collection.
      return {
        targetQty: DEFAULT_TARGET_PER_SHIFT_PCS[shiftCode] || 0,
        source: "default",
        effectiveDate: null,
        error: e
      };
    }
    const applicable = history.find(r => r.effectiveDate && r.effectiveDate <= dateStr);
    if (applicable) {
      return { targetQty: applicable.targetQty, source: "targetMaster", effectiveDate: applicable.effectiveDate };
    }
    return {
      targetQty: DEFAULT_TARGET_PER_SHIFT_PCS[shiftCode] || 0,
      source: "default",
      effectiveDate: null
    };
  }

  /**
   * setTarget(db, { shift, targetQty, effectiveDate, note })
   * Adds a new effective-dated target record. Writes only ever go to
   * targetMaster (this website's own collection) — never to
   * productionLogs.
   */
  async function setTarget(db, { shift, targetQty, effectiveDate, note }) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    if (!shift || !effectiveDate || !Number.isFinite(num(targetQty))) {
      throw new Error("setTarget requires shift, targetQty, and effectiveDate.");
    }
    return db.collection(TARGET_MASTER_COLLECTION).add({
      shift,
      targetQty: num(targetQty),
      effectiveDate,
      note: note || "",
      createdAt: Date.now()
    });
  }

  window.TargetAdapter = {
    normalizeTargetRecord,
    getTargetHistory,
    getTargetForShift,
    setTarget
  };

})();
