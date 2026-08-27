/**
 * improvement-adapter.js
 * ------------------------------------------------------------------
 * Adapter for the NEW `improvements` Firestore collection. This is
 * data this website owns (like scrapLogs/targetMaster) — it never
 * touches productionLogs.
 *
 * SCOPE NOTE (Phase — page shells): this adapter supports create +
 * list + update-status, which is enough for the Improvement page to
 * be genuinely functional for recording and tracking an improvement.
 * Two things are intentionally NOT built yet:
 *   - Photo fields are plain URL text (no real file upload / Storage
 *     integration — that's a separate feature to add later).
 *   - There's no per-field change history/audit trail; only the
 *     record's current status and a status-change log array are kept.
 *
 * Exposed as window.ImprovementAdapter = { ... }
 * ------------------------------------------------------------------
 */

(function () {

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * normalizeImprovement(id, raw)
   */
  function normalizeImprovement(id, raw) {
    if (!raw) return null;
    const beforeScrap = num(raw.beforeScrapQty);
    const afterScrap = num(raw.afterScrapQty);
    let reductionPct = null;
    if (beforeScrap !== null && beforeScrap > 0 && afterScrap !== null) {
      reductionPct = ((beforeScrap - afterScrap) / beforeScrap) * 100;
    }
    return {
      id,
      improvementId: raw.improvementId || id,
      problem: raw.problem || "",
      defectType: raw.defectType || "",
      line: raw.line || "",
      model: raw.model || "",
      fourM: raw.fourM || "",
      whys: Array.isArray(raw.whys) ? raw.whys : ["", "", "", "", ""],
      rootCause: raw.rootCause || "",
      actions: Array.isArray(raw.actions) ? raw.actions : [],
      beforePhotoUrl: raw.beforePhotoUrl || "",
      rootCausePhotoUrl: raw.rootCausePhotoUrl || "",
      actionPhotoUrl: raw.actionPhotoUrl || "",
      afterPhotoUrl: raw.afterPhotoUrl || "",
      beforeScrapQty: beforeScrap,
      afterScrapQty: afterScrap,
      reductionPct,
      status: raw.status || "Monitoring",
      statusHistory: Array.isArray(raw.statusHistory) ? raw.statusHistory : [],
      createdAt: raw.createdAt || null,
      updatedAt: raw.updatedAt || null
    };
  }

  /**
   * getImprovements(db, { limit })
   * Reads the most recent improvement records (ordered by createdAt
   * desc client-side, since a small factory's improvement log is a
   * modest list — no composite index needed).
   * Returns { records: [...normalized], error? }.
   */
  async function getImprovements(db, { limit } = {}) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    try {
      const snap = await db.collection(IMPROVEMENT_COLLECTION).get();
      const records = [];
      snap.forEach(doc => {
        const r = normalizeImprovement(doc.id, doc.data());
        if (r) records.push(r);
      });
      records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { records: limit ? records.slice(0, limit) : records };
    } catch (e) {
      console.error("Quality Dashboard: failed to read improvements", e);
      return { records: [], error: e };
    }
  }

  /**
   * addImprovement(db, payload)
   * Creates a new improvement record. Only `problem` and `defectType`
   * are required at creation — everything else (root cause, actions,
   * photos, after-scrap) is normally filled in as the investigation
   * progresses, via updateImprovement().
   */
  async function addImprovement(db, payload) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    if (!payload || !payload.problem || !payload.defectType) {
      throw new Error("addImprovement requires at least: problem, defectType");
    }
    const now = Date.now();
    const doc = {
      problem: payload.problem,
      defectType: payload.defectType,
      line: payload.line || "",
      model: payload.model || "",
      fourM: payload.fourM || "",
      whys: payload.whys || ["", "", "", "", ""],
      rootCause: payload.rootCause || "",
      actions: payload.actions || [],
      beforePhotoUrl: payload.beforePhotoUrl || "",
      rootCausePhotoUrl: payload.rootCausePhotoUrl || "",
      actionPhotoUrl: payload.actionPhotoUrl || "",
      afterPhotoUrl: payload.afterPhotoUrl || "",
      beforeScrapQty: payload.beforeScrapQty === "" || payload.beforeScrapQty == null ? null : num(payload.beforeScrapQty),
      afterScrapQty: payload.afterScrapQty === "" || payload.afterScrapQty == null ? null : num(payload.afterScrapQty),
      status: payload.status || "Monitoring",
      statusHistory: [{ status: payload.status || "Monitoring", at: now }],
      createdAt: now,
      updatedAt: now
    };
    return db.collection(IMPROVEMENT_COLLECTION).add(doc);
  }

  /**
   * updateImprovement(db, id, patch)
   * Partial update (e.g. fill in root cause later, attach an action,
   * change status). If `patch.status` is present and differs from what
   * we can infer, the caller is responsible for appending to
   * statusHistory via patch.statusHistory — this function just writes
   * whatever patch object it's given plus a fresh updatedAt.
   */
  async function updateImprovement(db, id, patch) {
    if (!db) throw new Error("No Firestore connection available (db is null).");
    if (!id) throw new Error("updateImprovement requires an id.");
    return db.collection(IMPROVEMENT_COLLECTION).doc(id).update({
      ...patch,
      updatedAt: Date.now()
    });
  }

  window.ImprovementAdapter = {
    normalizeImprovement,
    getImprovements,
    addImprovement,
    updateImprovement
  };

})();
