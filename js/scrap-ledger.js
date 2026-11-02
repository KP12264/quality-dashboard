/**
 * scrap-ledger.js
 * ------------------------------------------------------------------
 * Slot ledger for scrap logs (Shift Scrap Close, Phase 2).
 *
 * One ledger document per production Date + Line + Shift:
 *   scrapSlots/{date}_{line}_{shift}
 *     { date, line, shift, logVersion, liveLogCount, legacyCount, updatedAt, updatedBy }
 *   scrapSlots/{slotId}/events/v{logVersion}            (audit trail, never changed)
 *     { type: "LOG_WRITE", version, at, by,
 *       creates: [logId], updates: [logId], deletes: [logId], movesIn: [logId], movesOut: [logId],
 *       changes: [{ logId, op, before, after }] }
 *
 * applyOps() writes the scrap logs, raises every touched slot's logVersion by
 * exactly 1 and creates one audit event per slot, all in ONE Firestore
 * transaction. Firestore Rules (emulator/firestore.rules) refuse any scrap-log
 * write that does not do all of this. A transaction is retried by Firestore when
 * another writer changed the same slot meanwhile, so concurrent writers never
 * reuse or skip a version.
 *
 * Used by js/scrap-adapter.js only when sign-in is enforced (QD_AUTH_MODE
 * "enforce" or the local emulator); with sign-in "off" nothing here runs.
 * Works with the Firebase compat SDK in the browser and in Node tests.
 * ------------------------------------------------------------------
 */
(function (root) {
  const SLOT_COLLECTION = "scrapSlots";
  const LOG_COLLECTION = "scrapLogs";
  const AUDIT_FIELDS = ["date", "shift", "line", "model", "defectType", "scrapQty", "remark"];
  // Most logs written in one transaction for one slot. Kept well under Firestore's 500
  // writes per transaction; the rules-access limit was measured in tests/rules (see report).
  const MAX_LOGS_PER_TRANSACTION = 200;

  function slotIdOf(r) { return `${r.date}_${r.line}_${r.shift}`; }
  function auditView(d) {
    const o = {};
    AUDIT_FIELDS.forEach(f => { if (d && d[f] !== undefined) o[f] = d[f]; });
    return o;
  }

  // Groups ops by the slots they touch. befores: Map(logId -> stored data) for update/delete.
  function planSlots(ops, befores) {
    const slots = new Map();
    const touch = id => {
      if (!slots.has(id)) slots.set(id, { creates: [], updates: [], deletes: [], movesIn: [], movesOut: [], changes: [] });
      return slots.get(id);
    };
    ops.forEach(o => {
      const id = o.ref.id;
      if (o.op === "create") {
        const s = touch(slotIdOf(o.data));
        s.creates.push(id); s.changes.push({ logId: id, op: "create", before: null, after: auditView(o.data) });
      } else if (o.op === "delete") {
        const b = befores.get(id);
        const s = touch(slotIdOf(b));
        s.deletes.push(id); s.changes.push({ logId: id, op: "delete", before: auditView(b), after: null });
      } else {
        const b = befores.get(id), a = Object.assign({}, b, o.data);
        const from = slotIdOf(b), to = slotIdOf(a);
        if (from === to) {
          const s = touch(from);
          s.updates.push(id); s.changes.push({ logId: id, op: "update", before: auditView(b), after: auditView(a) });
        } else {
          const out = touch(from), inn = touch(to);
          out.movesOut.push(id); out.changes.push({ logId: id, op: "move_out", before: auditView(b), after: auditView(a) });
          inn.movesIn.push(id); inn.changes.push({ logId: id, op: "move_in", before: auditView(b), after: auditView(a) });
        }
      }
    });
    return slots;
  }
  function deltaOf(c) { return c.creates.length + c.movesIn.length - c.deletes.length - c.movesOut.length; }

  /**
   * applyOps(db, ops, opts) → { slots: [{ slotId, version, liveLogCount }] }
   *   db:   Firestore (compat)
   *   ops:  [{ op: "create", ref, data } | { op: "update", ref, data } | { op: "delete", ref }]
   *         (ref = db.collection("scrapLogs").doc(...); update data = the changed fields)
   *   opts: { email (required: the signer, stamped on slot and event),
   *           serverTimestamp: () => FieldValue.serverTimestamp() }
   */
  // Under contention the rules see the slot's NEW version before Firestore checks the
  // transaction's preconditions, so a lost race comes back as permission-denied instead of
  // "aborted" (and the SDK does not retry it). Retry only when a slot really moved meanwhile;
  // a real permission problem leaves the versions unchanged and is reported at once.
  const MAX_ATTEMPTS = 20;   // each round of a pile-up lets one writer through
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function applyOps(db, ops, opts) {
    if (!ops || ops.length === 0) return { slots: [] };
    for (let attempt = 1; ; attempt++) {
      const seen = new Map();   // slotId -> logVersion read by this attempt (0 = slot did not exist)
      try {
        return await applyOnce(db, ops, opts, seen);
      } catch (err) {
        const denied = /permission/i.test((err && (err.code || err.message)) || "");
        if (!denied || attempt >= MAX_ATTEMPTS || seen.size === 0) throw err;
        let moved = false;
        for (const [id, v] of seen) {
          const now = await db.collection(SLOT_COLLECTION).doc(id).get();
          if ((now.exists ? now.data().logVersion : 0) !== v) { moved = true; break; }
        }
        if (!moved) throw err;
        await sleep(Math.min(1000, 25 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random()));   // backoff with jitter
      }
    }
  }

  async function applyOnce(db, ops, opts, seen) {
    if (!opts || !opts.email) throw new Error("Ledger write needs the signed-in email.");
    const ts = opts.serverTimestamp;
    const slotRef = id => db.collection(SLOT_COLLECTION).doc(id);

    // Logs saved before the ledger existed are counted once, when a slot gets its first ledger
    // write (the rules accept this count as stated by the writer: legacyCount).
    const legacyCounts = new Map();
    async function legacyCountFor(slotId) {
      if (legacyCounts.has(slotId)) return legacyCounts.get(slotId);
      const [date, line, shift] = slotId.split("_");
      const snap = await db.collection(LOG_COLLECTION).where("date", "==", date).where("line", "==", line).where("shift", "==", shift).get();
      legacyCounts.set(slotId, snap.size);
      return snap.size;
    }
    // Pre-read (outside the transaction) which slots are new, so their legacy logs can be counted.
    const preIds = new Set(ops.filter(o => o.op === "create").map(o => slotIdOf(o.data)));
    for (const o of ops) if (o.op !== "create") { const s = await o.ref.get(); if (s.exists) { preIds.add(slotIdOf(s.data())); if (o.op === "update") preIds.add(slotIdOf(Object.assign({}, s.data(), o.data))); } }
    for (const id of preIds) { const s = await slotRef(id).get(); if (!s.exists) await legacyCountFor(id); }

    return db.runTransaction(async tx => {
      const befores = new Map();
      for (const o of ops) {
        if (o.op === "create") continue;
        const s = await tx.get(o.ref);
        if (!s.exists) throw new Error("This scrap record no longer exists (it may have been deleted). Reload and try again.");
        befores.set(o.ref.id, s.data());
      }
      const plan = planSlots(ops, befores);
      const slotSnaps = new Map();
      for (const id of plan.keys()) {
        const snap = await tx.get(slotRef(id));
        slotSnaps.set(id, snap);
        seen.set(id, snap.exists ? snap.data().logVersion : 0);
      }
      for (const id of plan.keys()) if (!slotSnaps.get(id).exists && !legacyCounts.has(id)) {
        // Rare: slot not seen in the pre-read (e.g. a record moved into a new slot after a retry).
        throw new Error("The slot changed while saving. Please try again.");
      }

      ops.forEach(o => {
        if (o.op === "create") tx.set(o.ref, o.data);
        else if (o.op === "update") tx.update(o.ref, o.data);
        else tx.delete(o.ref);
      });

      const out = [];
      for (const [id, c] of plan) {
        const snap = slotSnaps.get(id);
        const prev = snap.exists ? snap.data() : null;
        const version = (prev ? prev.logVersion : 0) + 1;
        const live = (prev ? prev.liveLogCount : legacyCounts.get(id)) + deltaOf(c);
        if (prev) {
          tx.update(slotRef(id), { logVersion: version, liveLogCount: live, updatedAt: ts(), updatedBy: opts.email });
        } else {
          const [date, line, shift] = id.split("_");
          tx.set(slotRef(id), { date, line, shift, logVersion: version, liveLogCount: live, legacyCount: legacyCounts.get(id), updatedAt: ts(), updatedBy: opts.email });
        }
        tx.set(slotRef(id).collection("events").doc("v" + version), {
          type: "LOG_WRITE", version, at: ts(), by: opts.email,
          creates: c.creates, updates: c.updates, deletes: c.deletes, movesIn: c.movesIn, movesOut: c.movesOut, changes: c.changes
        });
        out.push({ slotId: id, version, liveLogCount: live });
      }
      return { slots: out };
    });
  }

  // Splits import rows into transactions of one slot each, at most MAX_LOGS_PER_TRANSACTION rows.
  function chunkBySlot(entries, max) {
    const size = max || MAX_LOGS_PER_TRANSACTION;
    const bySlot = new Map();
    entries.forEach(e => { const id = slotIdOf(e); if (!bySlot.has(id)) bySlot.set(id, []); bySlot.get(id).push(e); });
    const chunks = [];
    for (const list of bySlot.values()) for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
    return chunks;
  }

  const api = { applyOps, chunkBySlot, slotIdOf, planSlots, auditView, MAX_LOGS_PER_TRANSACTION, SLOT_COLLECTION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ScrapLedger = api;
})(this);
