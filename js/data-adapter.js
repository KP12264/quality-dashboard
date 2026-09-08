/**
 * data-adapter.js
 * ------------------------------------------------------------------
 * READ-ONLY adapter for Production V2's Firestore collections
 * (project daily-production-report-46b60):
 *   - prodV2_actualLogs : actual production quantity
 *   - prodV2_dailyPlans : the shift's planned Model/Door roster
 *
 * This is the ONLY file in the dashboard that reads production data
 * from Firestore. Every call here is `.get()` — there is no
 * .set()/.update()/.add()/.delete() anywhere in this file or this
 * project touching either of these collections. Do not add any.
 *
 * This file replaced an earlier version that read the legacy
 * `productionLogs` collection (prod_{date}_{line}_{shift} documents
 * with a JSON-string payload). That collection is no longer read here
 * at all — Production V2 is now the sole production data source, per
 * an explicit decision to fully replace it rather than run both in
 * parallel. See PRODUCTION_COLLECTION in config.js for the (now
 * unused) legacy reference.
 *
 * Document shapes (confirmed against the real Production V2 source,
 * not guessed):
 *
 *   prodV2_actualLogs / actual_{date}_{LINE}_{SHIFT}
 *     { actualByCell: { "{blockIndex}|||{model}|||{door}": qty, ... } }
 *   There is no single "total for the shift" field — it's the sum of
 *   every value in actualByCell.
 *
 *   prodV2_dailyPlans / plan_{date}_{LINE}_{SHIFT}
 *     { blocks: [ { start, end, cells: [ {model, door, plan, originalPlan}, ... ],
 *                   total, originalTotal }, ... ],
 *       masterSnapshot: { palletChangeLosses: [...] } }
 *   This is what the Scrap Entry Model dropdown reads (see
 *   getModelListForDayLine below) — it's set before the shift starts,
 *   so it's available even before any actual data has been logged.
 *
 * Every other part of this dashboard still works with the same clean,
 * normalized JS objects as before ({date, line, shift, model,
 * productionQty, ...}) and never needs to know any of the above.
 *
 * Exposed as window.ProductionDataAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  // ---- Document ID helpers -------------------------------------------------

  // Matches: actual_2026-08-28_A_DAY  |  actual_2026-08-28_C_NIGHT
  const ACTUAL_DOC_ID_PATTERN = /^actual_(\d{4}-\d{2}-\d{2})_([ABC])_(DAY|NIGHT)$/;
  // Matches: plan_2026-08-28_A_DAY  |  plan_2026-08-28_C_NIGHT
  const PLAN_DOC_ID_PATTERN = /^plan_(\d{4}-\d{2}-\d{2})_([ABC])_(DAY|NIGHT)$/;

  function buildActualDocId(dateStr, lineCode, shiftCode) {
    return `actual_${dateStr}_${lineCode}_${shiftCode}`;
  }
  function buildPlanDocId(dateStr, lineCode, shiftCode) {
    return `plan_${dateStr}_${lineCode}_${shiftCode}`;
  }
  // Kept for API-compatibility with any external caller that still
  // asks for "the doc id" generically — maps to the actual-log doc.
  function buildDocId(dateStr, lineCode, shiftCode) {
    return buildActualDocId(dateStr, lineCode, shiftCode);
  }

  function toDateStr(d) {
    // Local-date (not UTC) YYYY-MM-DD, matching the format used by the
    // <input type="date"> values across this dashboard.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }

  function dateRange(endDateStr, numDays) {
    // Returns numDays date strings ending at (and including) endDateStr,
    // oldest first.
    const out = [];
    for (let i = numDays - 1; i >= 0; i--) {
      out.push(addDays(endDateStr, -i));
    }
    return out;
  }

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  // Combine Model + Door into one display/matching string. Production V2
  // tracks these as two separate dimensions, but Scrap (and the rest of
  // this dashboard) only has a single "model" field to match against —
  // this is the one place that combination happens, so it's applied
  // identically everywhere a model name is produced from V2 data.
  function combineModelDoor(model, door) {
    const m = (model || "").trim();
    const d = (door || "").trim();
    if (!m) return "";
    return d ? `${m} (${d})` : m;
  }

  // ---- Parsing ---------------------------------------------------------

  /**
   * parseActualDocument(docId, rawFirestoreData)
   * -> { docId, date, line, shift, actualByCell: {cellKey: qty} } | null
   */
  function parseActualDocument(docId, rawFirestoreData) {
    const idMatch = ACTUAL_DOC_ID_PATTERN.exec(docId);
    if (!idMatch) return null;
    if (!rawFirestoreData) return null;
    const [, date, line, shift] = idMatch;
    const actualByCell = (rawFirestoreData.actualByCell && typeof rawFirestoreData.actualByCell === "object")
      ? rawFirestoreData.actualByCell
      : {};
    return { docId, date, line, shift, actualByCell };
  }

  /**
   * parsePlanDocument(docId, rawFirestoreData)
   * -> { docId, date, line, shift, blocks: [{start,end,cells:[{model,door,plan}]}] } | null
   */
  function parsePlanDocument(docId, rawFirestoreData) {
    const idMatch = PLAN_DOC_ID_PATTERN.exec(docId);
    if (!idMatch) return null;
    if (!rawFirestoreData) return null;
    const [, date, line, shift] = idMatch;
    const blocks = Array.isArray(rawFirestoreData.blocks) ? rawFirestoreData.blocks : [];
    return {
      docId, date, line, shift,
      blocks: blocks.map(b => ({
        start: b.start || b.startTime || "",
        end: b.end || b.endTime || "",
        cells: Array.isArray(b.cells) ? b.cells.map(c => ({
          model: c.model || "",
          door: c.door || "",
          plan: num(c.plan),
          originalPlan: num(c.originalPlan)
        })) : []
      }))
    };
  }

  /**
   * normalizeProductionRecord(parsedActualDoc)
   * Collapses one parsed actual-log document into the same normalized
   * shape the rest of the dashboard has always consumed:
   *   { date, shift, line, model, productionQty, planQty, downtimeMin, hasData }
   *
   * `model` is null at this level (day/line/shift TOTAL, not per-model —
   * see normalizeProductionByModel for that). `planQty`/`downtimeMin`
   * are not populated from Production V2 (Plan lives in a separate
   * collection, and V2 doesn't expose a per-shift downtime total the
   * way legacy productionLogs did) — nothing in this dashboard's UI
   * currently reads either field, so they're kept as 0 for shape
   * compatibility rather than fetched with extra reads that would go
   * unused.
   */
  function normalizeProductionRecord(parsedActualDoc) {
    if (!parsedActualDoc) return null;
    const cellValues = Object.values(parsedActualDoc.actualByCell);
    const productionQty = cellValues.reduce((s, v) => s + num(v), 0);
    return {
      date: parsedActualDoc.date,
      line: parsedActualDoc.line,
      shift: parsedActualDoc.shift,
      model: null,
      productionQty,
      planQty: 0,
      downtimeMin: 0,
      hasData: cellValues.length > 0
    };
  }

  /**
   * normalizeProductionByModel(parsedActualDoc)
   * Produces one normalized record PER MODEL(+DOOR) for a given
   * date+line+shift: { date, shift, line, model, productionQty }
   *
   * Sums every actualByCell entry for a given Model+Door combination
   * across all time blocks (the cell key's blockIndex segment is not
   * distinguished here — only Model+Door matters for this breakdown).
   */
  function normalizeProductionByModel(parsedActualDoc) {
    if (!parsedActualDoc) return [];
    const totals = new Map(); // combinedModelName -> qty
    for (const [cellKey, qty] of Object.entries(parsedActualDoc.actualByCell)) {
      const parts = cellKey.split("|||");
      if (parts.length < 3) continue; // malformed key, skip defensively
      const model = combineModelDoor(parts[1], parts[2]);
      if (!model) continue;
      totals.set(model, (totals.get(model) || 0) + num(qty));
    }
    return Array.from(totals.entries()).map(([model, productionQty]) => ({
      date: parsedActualDoc.date,
      line: parsedActualDoc.line,
      shift: parsedActualDoc.shift,
      model,
      productionQty
    }));
  }

  // ---- Fetching (READ ONLY) ---------------------------------------------

  /**
   * fetchOne(db, dateStr, lineCode, shiftCode)
   * Fetches exactly one actual-log document by its known ID.
   * Returns one of:
   *   { status: 'found',     record: <normalized>, parsed }
   *   { status: 'not-found', record: null, parsed: null }   // valid empty shift — NOT an error
   *   { status: 'error',     record: null, parsed: null, error }
   */
  async function fetchOne(db, dateStr, lineCode, shiftCode) {
    const docId = buildActualDocId(dateStr, lineCode, shiftCode);
    try {
      const snap = await db.collection(PROD_V2_ACTUAL_COLLECTION).doc(docId).get();
      if (!snap.exists) {
        return { status: "not-found", record: null, parsed: null };
      }
      const parsed = parseActualDocument(docId, snap.data());
      const normalized = normalizeProductionRecord(parsed);
      return { status: "found", record: normalized, parsed };
    } catch (e) {
      console.error("Quality Dashboard: Firestore read failed for", docId, e);
      return { status: "error", record: null, parsed: null, error: e };
    }
  }

  /**
   * fetchPlanDoc(db, dateStr, lineCode, shiftCode)
   * Fetches exactly one prodV2_dailyPlans document. Same
   * found/not-found/error contract as fetchOne, but for the Plan doc.
   */
  async function fetchPlanDoc(db, dateStr, lineCode, shiftCode) {
    const docId = buildPlanDocId(dateStr, lineCode, shiftCode);
    try {
      const snap = await db.collection(PROD_V2_PLAN_COLLECTION).doc(docId).get();
      if (!snap.exists) {
        return { status: "not-found", parsed: null };
      }
      const parsed = parsePlanDocument(docId, snap.data());
      return { status: "found", parsed };
    } catch (e) {
      console.error("Quality Dashboard: Firestore read failed for", docId, e);
      return { status: "error", parsed: null, error: e };
    }
  }

  /**
   * getProductionData(db, { dates, lines, shifts })
   * Fetches every (date x line x shift) combination requested, in
   * parallel, entirely via read-only .get() calls against
   * prodV2_actualLogs.
   *
   * Returns:
   *   {
   *     records: [normalized, ...],   // only combinations that had data
   *     missing: [{date,line,shift}], // combinations with no document yet (valid, not an error)
   *     errors:  [{date,line,shift,error}] // combinations that failed to read (connection problem)
   *   }
   */
  async function getProductionData(db, { dates, lines, shifts }) {
    if (!db) {
      throw new Error("No Firestore connection available (db is null).");
    }
    const combos = [];
    for (const date of dates) {
      for (const line of lines) {
        for (const shift of shifts) {
          combos.push({ date, line, shift });
        }
      }
    }

    const results = await Promise.all(
      combos.map(c => fetchOne(db, c.date, c.line, c.shift).then(r => ({ ...c, ...r })))
    );

    const records = [];
    const missing = [];
    const errors = [];
    for (const r of results) {
      if (r.status === "found") records.push(r.record);
      else if (r.status === "not-found") missing.push({ date: r.date, line: r.line, shift: r.shift });
      else errors.push({ date: r.date, line: r.line, shift: r.shift, error: r.error });
    }
    return { records, missing, errors };
  }

  /**
   * getProductionDataByModel(db, { dates, lines, shifts })
   * Same idea as getProductionData(), but returns per-model records:
   *   { date, shift, line, model, productionQty }
   * sourced from each (date, line, shift)'s actual-log document.
   *
   * Returns:
   *   {
   *     records: [{date,shift,line,model,productionQty}, ...],
   *     errors:  [{date,line,shift,error}]   // failed reads (connection problem)
   *   }
   * A (date,line,shift) with no actual-log document yet simply
   * contributes no records — that is valid ("nothing logged yet"), not
   * an error, and must not be treated as zero production.
   */
  async function getProductionDataByModel(db, { dates, lines, shifts }) {
    if (!db) {
      throw new Error("No Firestore connection available (db is null).");
    }
    const combos = [];
    for (const date of dates) {
      for (const line of lines) {
        for (const shift of shifts) {
          combos.push({ date, line, shift });
        }
      }
    }

    const results = await Promise.all(combos.map(async (c) => {
      const r = await fetchOne(db, c.date, c.line, c.shift);
      if (r.status === "error") {
        return { records: [], errors: [{ date: c.date, line: c.line, shift: c.shift, error: r.error }] };
      }
      if (r.status === "not-found" || !r.parsed) {
        return { records: [], errors: [] };
      }
      return { records: normalizeProductionByModel(r.parsed), errors: [] };
    }));

    const records = [];
    const errors = [];
    for (const r of results) {
      records.push(...r.records);
      errors.push(...r.errors);
    }
    return { records, errors };
  }

  /**
   * getModelListForDayLine(db, dateStr, lineCode, shiftCode)
   * Convenience read used by the Scrap Entry form (and the Scrap
   * Detail Edit modal) so a Leader picks a Model from the SAME roster
   * already planned for that date+line+shift in Production V2, instead
   * of free-typing a name that might not match (which would silently
   * break the Date+Shift+Line+Model join in js/quality-adapter.js).
   *
   * Reads from prodV2_dailyPlans rather than prodV2_actualLogs — the
   * Plan is set before the shift starts, so the Model dropdown is
   * populated even if no Actual data exists yet (e.g. a Leader
   * recording scrap early in the shift). Returns [] if no plan exists
   * yet for that date/line/shift (valid — not an error).
   *
   * NOTE: this function's signature gained a required `shiftCode`
   * parameter when the data source moved from legacy productionLogs
   * (whose model roster was shared across both shifts of a day) to
   * Production V2 (whose Plan — and therefore Model roster — is
   * per-shift). Both call sites (Scrap Entry, Scrap Detail Edit) were
   * updated to pass it.
   *
   * Returns { names: string[], error? }.
   */
  async function getModelListForDayLine(db, dateStr, lineCode, shiftCode) {
    const r = await fetchPlanDoc(db, dateStr, lineCode, shiftCode);
    if (r.status === "error") return { names: [], error: r.error };
    if (!r.parsed) return { names: [] };
    const names = new Set();
    for (const block of r.parsed.blocks) {
      for (const cell of block.cells) {
        const combined = combineModelDoor(cell.model, cell.door);
        if (combined) names.add(combined);
      }
    }
    return { names: Array.from(names) };
  }

  // ---- Public surface -----------------------------------------------------

  window.ProductionDataAdapter = {
    buildDocId,
    buildActualDocId,
    buildPlanDocId,
    toDateStr,
    addDays,
    dateRange,
    parseActualDocument,
    parsePlanDocument,
    normalizeProductionRecord,
    normalizeProductionByModel,
    getProductionData,
    getProductionDataByModel,
    getModelListForDayLine
  };

})();
