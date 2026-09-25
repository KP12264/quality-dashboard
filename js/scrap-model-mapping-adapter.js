/**
 * scrap-model-mapping-adapter.js
 * ------------------------------------------------------------------
 * Reads and writes ONLY scrapModelMappings — a small persistent lookup
 * table this app owns: { excelModel (the raw Excel Material/Model
 * identity) -> productionModel (the confirmed canonical Production V2
 * model string) }. Built so that once a Leader confirms "this Excel
 * Material means this Production Model" once, future imports recognize
 * the same Excel Material automatically, without needing Production V2
 * itself to change or be written to.
 *
 * Never touches productionLogs or any prodV2_* collection. Never
 * touches scrapLogs (that's scrap-adapter.js's job).
 * ------------------------------------------------------------------
 */

(function () {
  /**
   * getAllMappings(db)
   * Reads the whole scrapModelMappings collection once (expected to
   * stay small — one doc per distinct Excel identity ever confirmed).
   * Returns { excelModel: productionModel }. On any read failure
   * (including a permission error, e.g. before Security Rules have
   * been updated to include this collection), returns an empty map and
   * an `error` field rather than throwing — a missing/unreadable
   * mapping table should degrade to "no saved mappings yet", not break
   * the whole import flow.
   */
  async function getAllMappings(db) {
    if (!db) return { mappings: {}, error: "No Firestore connection available (db is null)." };
    try {
      const snap = await db.collection(SCRAP_MODEL_MAPPING_COLLECTION).get();
      const mappings = {};
      snap.forEach(doc => {
        const d = doc.data();
        if (d && d.excelModel && d.productionModel) mappings[d.excelModel] = d.productionModel;
      });
      return { mappings };
    } catch (err) {
      return { mappings: {}, error: err };
    }
  }

  // Firestore document IDs can't contain "/", and Excel Material/Model
  // text often does (e.g. "FRZ FOAM DR ASSY-/MX_HAIER_EXP") — encode it
  // into a safe, deterministic, reversible ID so saving the same
  // excelModel again naturally upserts the same document instead of
  // accumulating duplicates.
  function mappingDocId(excelModel) {
    return encodeURIComponent(excelModel).slice(0, 1400); // stay well under Firestore's ~1500-byte doc ID limit
  }

  /**
   * saveMappings(db, pairs)
   * pairs: [{ excelModel, productionModel }]
   * Writes (upserts) each pair as one document, in a single Firestore
   * batch. Only ever writes to scrapModelMappings. Returns
   * { succeeded: number, error? }.
   */
  async function saveMappings(db, pairs) {
    if (!db) return { succeeded: 0, error: "No Firestore connection available (db is null)." };
    if (!pairs || pairs.length === 0) return { succeeded: 0 };
    try {
      const batch = db.batch();
      pairs.forEach(p => {
        const ref = db.collection(SCRAP_MODEL_MAPPING_COLLECTION).doc(mappingDocId(p.excelModel));
        batch.set(ref, {
          excelModel: p.excelModel,
          productionModel: p.productionModel,
          updatedAt: Date.now()
        });
      });
      await batch.commit();
      return { succeeded: pairs.length };
    } catch (err) {
      return { succeeded: 0, error: err };
    }
  }

  window.ScrapModelMappingAdapter = { getAllMappings, saveMappings };
})();
