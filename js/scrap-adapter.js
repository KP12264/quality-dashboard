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

  // Optional metadata/enrichment fields a scrapLogs document MAY carry,
  // beyond the 7 core fields every record has always had. Manual entries
  // (js/scrap-entry-page.js, via addScrapEntries/addScrapEntry) never set
  // these — only the Excel import path (addScrapEntryBatch) does, and
  // only for whichever fields the source file actually provided. Dashboard/
  // Scrap Detail/Pareto do not depend on any of these (per design) — they
  // exist for future use (Stage 5) and for audit/dedupe (Stage 3/4).
  const OPTIONAL_SCRAP_FIELDS = [
    'rootCause', 'actionPlan',           // Cause / Solution (Stage 2)
    'scrapCost', 'unitPrice',            // Amt / Price (Stage 2) — never derived, always taken as-is
    'sourceMaterial', 'sourceMaterialName', 'sourceLocation', 'sourceDateText', // raw Excel text, for audit + Stage 3 model mapping key
    'entrySource', 'sourceFileName', 'sourceSheet', 'sourceRow',
    'importBatchId', 'importedAt', 'importFingerprint'   // Stage 3/4 use
  ];
  const OPTIONAL_NUMERIC_OR_NULL_FIELDS = new Set(['scrapCost', 'unitPrice', 'sourceRow', 'importedAt']);

  /**
   * normalizeScrapRecord(id, raw)
   * -> { id, date, shift, line, model, defectType, scrapQty, remark, createdAt, ...optional fields }
   * The optional fields (see OPTIONAL_SCRAP_FIELDS) default to null (for
   * numeric-ish ones) or "" (for text ones) when the document doesn't
   * have them — which is always true for records created before this
   * field set existed, and for ordinary manual entries.
   */
  function normalizeScrapRecord(id, raw) {
    if (!raw) return null;
    const base = {
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
    OPTIONAL_SCRAP_FIELDS.forEach(f => {
      if (OPTIONAL_NUMERIC_OR_NULL_FIELDS.has(f)) {
        base[f] = raw[f] !== undefined && raw[f] !== null ? raw[f] : null;
      } else {
        base[f] = raw[f] || "";
      }
    });
    return base;
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
   * Appropriate for a SMALL number of rows (a Leader's manual entry —
   * a handful of rows). For large bulk imports (hundreds/thousands of
   * rows), use addScrapEntryBatch instead — see its comment for why.
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

  function validateEntryFields(e) {
    const missing = [];
    if (!e.date) missing.push("date");
    if (!e.shift) missing.push("shift");
    if (!e.line) missing.push("line");
    if (!e.model) missing.push("model");
    if (!e.defectType) missing.push("defectType");
    if (!(num(e.scrapQty) > 0)) missing.push("scrapQty (must be > 0)");
    return missing;
  }

  /**
   * addScrapEntryBatch(db, entries)
   * Commits ONE Firestore batched write for up to ~500 entries (a
   * Firestore WriteBatch's hard limit) in a SINGLE network round trip,
   * instead of one round trip per document. This is the function the
   * bulk file-import feature (Scrap Entry → "Import from File") uses —
   * importing thousands of rows via individual .add() calls (even 25
   * at a time in parallel) means hundreds of sequential round trips,
   * which is exactly what caused a large import to appear to hang
   * indefinitely with the progress counter stuck at 0. Batched writes
   * cut that from ~250+ round trips down to a dozen or so.
   *
   * Trade-off: a Firestore batch is atomic — if the commit fails, NONE
   * of the entries in this call were written (not a partial success).
   * Callers doing a large import should keep each call modestly sized
   * (a few hundred entries, not the full multi-thousand-row file) so a
   * single failure doesn't discard a large chunk of work — see
   * js/scrap-import.js, which calls this in batches of 200.
   *
   * Every field is still validated exactly like addScrapEntry — an
   * invalid entry is never included in the batch at all (reported back
   * as `failed` immediately, without even attempting a write).
   *
   * Returns { succeeded: [{entry, id}], failed: [{entry, error}] }.
   */
  async function addScrapEntryBatch(db, entries) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    if (!entries || entries.length === 0) return { succeeded: [], failed: [] };
    if (entries.length > 500) {
      throw new Error(`addScrapEntryBatch received ${entries.length} entries — Firestore's WriteBatch limit is 500. Split into smaller calls.`);
    }

    const failed = [];
    const valid = [];
    entries.forEach(e => {
      const missing = validateEntryFields(e);
      if (missing.length) failed.push({ entry: e, error: new Error("Invalid: " + missing.join(", ")) });
      else valid.push(e);
    });
    if (valid.length === 0) return { succeeded: [], failed };

    const batch = db.batch();
    const refs = valid.map(e => {
      const ref = db.collection(SCRAP_COLLECTION).doc();
      const doc = {
        date: e.date, shift: e.shift, line: e.line, model: e.model, defectType: e.defectType,
        scrapQty: num(e.scrapQty), remark: e.remark || "", createdAt: Date.now()
      };
      // Carry through whichever optional fields this entry actually has
      // (see OPTIONAL_SCRAP_FIELDS above) — never write `undefined`
      // (Firestore rejects it); everything else is simply omitted from
      // the document rather than written as a placeholder.
      OPTIONAL_SCRAP_FIELDS.forEach(f => {
        if (e[f] !== undefined) doc[f] = e[f];
      });
      batch.set(ref, doc);
      return ref;
    });

    try {
      await batch.commit();
      const succeeded = refs.map((ref, i) => ({ entry: valid[i], id: ref.id }));
      return { succeeded, failed };
    } catch (err) {
      // Atomic: the whole batch failed together, so every valid entry
      // in it counts as failed (none were actually written).
      valid.forEach(e => failed.push({ entry: e, error: err }));
      return { succeeded: [], failed };
    }
  }

  window.ScrapDataAdapter = {
    normalizeScrapRecord,
    getScrapData,
    addScrapEntry,
    addScrapEntries,
    addScrapEntryBatch,
    updateScrapEntry,
    deleteScrapEntry
  };

})();
