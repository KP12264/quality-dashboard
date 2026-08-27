/**
 * data-adapter.js
 * ------------------------------------------------------------------
 * READ-ONLY adapter for the existing `productionLogs` Firestore
 * collection (project daily-production-report-46b60).
 *
 * This is the ONLY file in the dashboard that talks to Firestore.
 * Every call here is `.get()` — there is no .set()/.update()/.add()/
 * .delete() anywhere in this file or this project. Do not add any.
 *
 * Why an adapter at all: the existing documents have no native
 * `date` / `line` / `shift` fields — those are encoded only in the
 * Firestore Document ID (e.g. "prod_2026-08-15_A_เช้า"), and the
 * actual payload is a JSON *string* inside a field called `json`.
 * Every other part of this dashboard works with clean, normalized
 * JS objects and never needs to know any of that.
 *
 * Exposed as window.ProductionDataAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  // ---- Document ID helpers -------------------------------------------------

  // Matches: prod_2026-08-15_A_เช้า  |  prod_2026-08-15_C_ดึก
  const DOC_ID_PATTERN = /^prod_(\d{4}-\d{2}-\d{2})_([ABC])_(เช้า|ดึก)$/;
  // Matches: prod_2026-08-15_A_models  (per-model qty, shared across BOTH shifts of that day/line)
  const MODEL_DOC_ID_PATTERN = /^prod_(\d{4}-\d{2}-\d{2})_([ABC])_models$/;

  function buildDocId(dateStr, lineCode, shiftCode) {
    return `prod_${dateStr}_${lineCode}_${shiftCode}`;
  }

  function buildModelDocId(dateStr, lineCode) {
    return `prod_${dateStr}_${lineCode}_models`;
  }

  function toDateStr(d) {
    // Local-date (not UTC) YYYY-MM-DD, matching the format used by the
    // existing site's <input type="date"> values.
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

  // ---- Parsing ---------------------------------------------------------

  /**
   * parseProductionDocument(docId, rawFirestoreData)
   * Turns one raw Firestore document (id + { json, updatedAt }) into a
   * plain structured object, or null if the document doesn't match the
   * expected production-log shape at all (defensive — should not
   * normally happen for docs matched by our own ID builder).
   */
  function parseProductionDocument(docId, rawFirestoreData) {
    const idMatch = DOC_ID_PATTERN.exec(docId);
    if (!idMatch) return null;
    if (!rawFirestoreData || typeof rawFirestoreData.json !== "string") return null;

    let payload;
    try {
      payload = JSON.parse(rawFirestoreData.json);
    } catch (e) {
      console.error("Quality Dashboard: failed to JSON.parse doc", docId, e);
      return null;
    }

    const [, date, line, shift] = idMatch;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];

    return {
      docId,
      date,
      line,
      shift,
      title: payload.title || "",
      // `id` is carried through because the model-breakdown document
      // (see parseModelDocument below) keys its per-hour quantities by
      // this same row id — it's required to attribute model quantity
      // to the correct shift (model qty is stored once per day/line,
      // shared across both shifts).
      rows: rows.map(r => ({
        id: r.id || "",
        slot: r.slot || "",
        plan: num(r.plan),
        actual: num(r.actual),
        downtime: num(r.downtime),
        note: r.note || ""
      }))
    };
  }

  /**
   * parseModelDocument(docId, rawFirestoreData)
   * Parses a prod_{date}_{line}_models document into
   *   { date, line, models: [{id, name, door}], qty: { [modelId]: { [rowId]: number } } }
   * or null if it doesn't match the expected shape.
   *
   * NOTE: this document is shared by BOTH shifts of that day/line (the
   * original system keeps one model list + qty grid per day, not per
   * shift). Attributing a model's quantity to a specific shift requires
   * intersecting `qty[modelId]` against the row ids that belong to that
   * shift's document — see getProductionDataByModel().
   */
  function parseModelDocument(docId, rawFirestoreData) {
    const idMatch = MODEL_DOC_ID_PATTERN.exec(docId);
    if (!idMatch) return null;
    if (!rawFirestoreData || typeof rawFirestoreData.json !== "string") return null;

    let payload;
    try {
      payload = JSON.parse(rawFirestoreData.json);
    } catch (e) {
      console.error("Quality Dashboard: failed to JSON.parse model doc", docId, e);
      return null;
    }

    const [, date, line] = idMatch;
    const models = Array.isArray(payload.models) ? payload.models : [];
    const qty = (payload.qty && typeof payload.qty === "object") ? payload.qty : {};

    return {
      docId,
      date,
      line,
      models: models.map(m => ({ id: m.id || "", name: m.name || "", door: m.door || "" })),
      qty
    };
  }

  /**
   * normalizeProductionRecord(parsedDoc)
   * Collapses one parsed document (one date + line + shift, many hourly
   * rows) into the single normalized shape the dashboard UI consumes:
   *   { date, shift, line, model, productionQty, planQty, downtimeMin }
   *
   * `model` is null at this level: the existing system tracks per-model
   * quantity in a *separate* document (prod_{date}_{line}_models) rather
   * than per hourly row, and Phase 1's UI only needs line/shift/day
   * totals. A future phase can add a normalizeModelRecords() alongside
   * this one without changing this function's contract.
   */
  function normalizeProductionRecord(parsedDoc) {
    if (!parsedDoc) return null;
    const productionQty = parsedDoc.rows.reduce((s, r) => s + r.actual, 0);
    const planQty = parsedDoc.rows.reduce((s, r) => s + r.plan, 0);
    const downtimeMin = parsedDoc.rows.reduce((s, r) => s + r.downtime, 0);
    return {
      date: parsedDoc.date,
      line: parsedDoc.line,
      shift: parsedDoc.shift,
      model: null,
      productionQty,
      planQty,
      downtimeMin,
      hasData: parsedDoc.rows.length > 0
    };
  }

  /**
   * normalizeProductionByModel(shiftParsedDoc, modelParsedDoc)
   * Produces one normalized record PER MODEL for a given date+line+shift:
   *   { date, shift, line, model, productionQty }
   *
   * `shiftParsedDoc` is the parsed prod_{date}_{line}_{shift} document
   * (gives us which row ids belong to THIS shift).
   * `modelParsedDoc` is the parsed prod_{date}_{line}_models document
   * (gives us the model list and qty-per-row-id, shared across shifts).
   *
   * Returns [] if there's no model breakdown recorded for that day/line
   * (common for older dates, or days where the Leader only filled in
   * the hourly total without a per-model split) — callers should NOT
   * treat an empty array here as "zero production"; the day/shift/line
   * total from normalizeProductionRecord() is still the source of truth
   * for totals. This function is only for the "by Model" breakdown.
   */
  function normalizeProductionByModel(shiftParsedDoc, modelParsedDoc) {
    if (!shiftParsedDoc || !modelParsedDoc) return [];
    const shiftRowIds = new Set(shiftParsedDoc.rows.map(r => r.id).filter(Boolean));
    if (shiftRowIds.size === 0) return [];

    const out = [];
    for (const model of modelParsedDoc.models) {
      if (!model.name) continue;
      const rowQty = modelParsedDoc.qty[model.id] || {};
      let total = 0;
      for (const rowId of Object.keys(rowQty)) {
        if (!shiftRowIds.has(rowId)) continue; // belongs to the other shift
        total += num(rowQty[rowId]);
      }
      out.push({
        date: shiftParsedDoc.date,
        line: shiftParsedDoc.line,
        shift: shiftParsedDoc.shift,
        model: model.name,
        productionQty: total
      });
    }
    return out;
  }

  // ---- Fetching (READ ONLY) ---------------------------------------------

  /**
   * fetchOne(db, dateStr, lineCode, shiftCode)
   * Fetches exactly one production-log document by its known ID.
   * Returns one of:
   *   { status: 'found',     record: <normalized> }
   *   { status: 'not-found', record: null }   // valid empty day — NOT an error
   *   { status: 'error',     record: null, error }
   */
  async function fetchOne(db, dateStr, lineCode, shiftCode) {
    const docId = buildDocId(dateStr, lineCode, shiftCode);
    try {
      const snap = await db.collection(PRODUCTION_COLLECTION).doc(docId).get();
      if (!snap.exists) {
        return { status: "not-found", record: null, parsed: null };
      }
      const parsed = parseProductionDocument(docId, snap.data());
      const normalized = normalizeProductionRecord(parsed);
      return { status: "found", record: normalized, parsed };
    } catch (e) {
      console.error("Quality Dashboard: Firestore read failed for", docId, e);
      return { status: "error", record: null, parsed: null, error: e };
    }
  }

  /**
   * fetchModelDoc(db, dateStr, lineCode)
   * Fetches exactly one prod_{date}_{line}_models document. Same
   * found/not-found/error contract as fetchOne, but for the model doc.
   */
  async function fetchModelDoc(db, dateStr, lineCode) {
    const docId = buildModelDocId(dateStr, lineCode);
    try {
      const snap = await db.collection(PRODUCTION_COLLECTION).doc(docId).get();
      if (!snap.exists) {
        return { status: "not-found", parsed: null };
      }
      const parsed = parseModelDocument(docId, snap.data());
      return { status: "found", parsed };
    } catch (e) {
      console.error("Quality Dashboard: Firestore read failed for", docId, e);
      return { status: "error", parsed: null, error: e };
    }
  }

  /**
   * getProductionData(db, { dates, lines, shifts })
   * Fetches every (date x line x shift) combination requested, in
   * parallel, entirely via read-only .get() calls.
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
   *
   * For each (date, line) it fetches the models document ONCE (it's
   * shared across shifts) plus each requested shift's document, then
   * attributes model quantity to the correct shift via row ids.
   *
   * Returns:
   *   {
   *     records: [{date,shift,line,model,productionQty}, ...],
   *     errors:  [{date,line,error}]   // failed reads (connection problem)
   *   }
   * A (date,line) with no models document yet simply contributes no
   * records — that is a valid "no per-model breakdown recorded" state,
   * not an error, and must not be treated as zero production.
   */
  async function getProductionDataByModel(db, { dates, lines, shifts }) {
    if (!db) {
      throw new Error("No Firestore connection available (db is null).");
    }
    const dateLinePairs = [];
    for (const date of dates) {
      for (const line of lines) {
        dateLinePairs.push({ date, line });
      }
    }

    const results = await Promise.all(dateLinePairs.map(async ({ date, line }) => {
      const [modelResult, ...shiftResults] = await Promise.all([
        fetchModelDoc(db, date, line),
        ...shifts.map(shift => fetchOne(db, date, line, shift))
      ]);

      if (modelResult.status === "error") {
        return { date, line, errors: [{ date, line, error: modelResult.error }], records: [] };
      }
      const errors = shiftResults
        .map((r, i) => ({ r, shift: shifts[i] }))
        .filter(x => x.r.status === "error")
        .map(x => ({ date, line, shift: x.shift, error: x.r.error }));

      if (!modelResult.parsed) {
        // No model-breakdown document for this day/line — nothing to report
        // at the model level (not an error; totals still come from
        // getProductionData()).
        return { date, line, errors, records: [] };
      }

      const records = [];
      shiftResults.forEach((r) => {
        if (r.status === "found" && r.parsed) {
          records.push(...normalizeProductionByModel(r.parsed, modelResult.parsed));
        }
      });
      return { date, line, errors, records };
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
   * getModelListForDayLine(db, dateStr, lineCode)
   * Convenience read used by the Scrap Entry form so a Leader picks a
   * Model from the SAME list already recorded for that day/line in
   * Production, instead of free-typing a name that might not match
   * (which would silently break the Date+Shift+Line+Model join in
   * js/quality-adapter.js). Returns [] if there's no models doc yet for
   * that day/line (valid — not an error); the form should let the
   * Leader know no production model breakdown exists yet rather than
   * blocking scrap entry.
   * Returns { names: string[], error? }.
   */
  async function getModelListForDayLine(db, dateStr, lineCode) {
    const r = await fetchModelDoc(db, dateStr, lineCode);
    if (r.status === "error") return { names: [], error: r.error };
    if (!r.parsed) return { names: [] };
    const names = r.parsed.models.map(m => m.name).filter(Boolean);
    return { names: Array.from(new Set(names)) };
  }

  // ---- Public surface -----------------------------------------------------

  window.ProductionDataAdapter = {
    buildDocId,
    buildModelDocId,
    toDateStr,
    addDays,
    dateRange,
    parseProductionDocument,
    parseModelDocument,
    normalizeProductionRecord,
    normalizeProductionByModel,
    getProductionData,
    getProductionDataByModel,
    getModelListForDayLine
  };

})();
