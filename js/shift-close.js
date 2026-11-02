/**
 * shift-close.js
 * ------------------------------------------------------------------
 * Shift Scrap Close (Phase 3): status of a Date + Line + Shift and the close / reconfirm
 * transaction. Works only with sign-in enforced (the slot ledger, js/scrap-ledger.js, must be
 * the only way scrap is written).
 *
 * Close fields on scrapSlots/{date}_{line}_{shift}:
 *   closeState        SUBMITTED | CONFIRMED_ZERO | NO_PRODUCTION
 *   closedVersion     the slot's logVersion that was confirmed
 *   closeRevision     1, 2, 3 … (each close / reconfirm)
 *   closedLogCount, closedScrapQty, closedLogIds, closedFingerprint   snapshot of the logs confirmed
 *   closeNote, noProductionReason, closedBy, closedAt
 * Audit: scrapSlots/{slotId}/events/c{closeRevision}  { type: "CLOSE", …, previous }
 *
 * Status (deriveStatus) is ALWAYS computed from the scrap logs actually stored, never from the
 * slot counters alone:
 *   PENDING         not closed (no close at all is never read as 0)
 *   SUBMITTED       closed with scrap; logs unchanged since
 *   CONFIRMED_ZERO  closed as "no scrap"; still no logs
 *   NO_PRODUCTION   closed as "line did not run" (a person's statement with a reason —
 *                   Actual = 0 or a missing Plan is never used as proof)
 *   CHANGED         scrap was written after the close (logVersion moved) → reconfirm needed
 *   CONFLICT        the data does not add up (import not finished, logs written outside the
 *                   ledger, counter mismatch) → cannot be closed until resolved
 * ------------------------------------------------------------------
 */
(function (root) {
  const SLOT_COLLECTION = "scrapSlots";
  const LOG_COLLECTION = "scrapLogs";
  const STATUS = {
    PENDING: "PENDING", SUBMITTED: "SUBMITTED", CONFIRMED_ZERO: "CONFIRMED_ZERO",
    NO_PRODUCTION: "NO_PRODUCTION", CHANGED: "CHANGED", CONFLICT: "CONFLICT"
  };
  const CLOSE_STATES = [STATUS.SUBMITTED, STATUS.CONFIRMED_ZERO, STATUS.NO_PRODUCTION];
  const REASONS = {
    "import-incomplete": "An Excel import into this shift has not finished (or partly failed). Admin must check it before the shift can be closed.",
    "ledger-count-mismatch": "The number of scrap records does not match the ledger (records were changed outside the ledger).",
    "changed-outside-ledger": "Scrap records differ from what was confirmed, without a ledger version change.",
    "logs-on-zero": "Confirmed as zero / no production, but scrap records exist."
  };

  function slotIdOf(r) { return `${r.date}_${r.line}_${r.shift}`; }
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  // FNV-1a (32-bit) over the confirmed fields of every log, sorted by id. Identifies exactly which
  // records (and quantities) were confirmed.
  function fingerprint(logs) {
    const rows = (logs || []).map(l => [l.id, l.date, l.line, l.shift, l.model, l.defectType, num(l.scrapQty)].join("|")).sort();
    let h = 0x811c9dc5;
    const text = rows.length + "#" + rows.join("\n");
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return "f1-" + rows.length + "-" + h.toString(16).padStart(8, "0");
  }
  function summarize(logs) {
    const list = logs || [];
    return { count: list.length, qty: list.reduce((n, l) => n + num(l.scrapQty), 0), ids: list.map(l => l.id).sort() };
  }

  /** deriveStatus({ slot, logs }) → { status, reasons, count, qty, closed, needsReconfirm } */
  function deriveStatus({ slot, logs }) {
    const sum = summarize(logs);
    const out = { status: STATUS.PENDING, reasons: [], count: sum.count, qty: sum.qty, closed: null, needsReconfirm: false, version: slot ? slot.logVersion || 0 : 0 };
    if (slot && slot.closeState) {
      out.closed = {
        state: slot.closeState, version: slot.closedVersion, revision: slot.closeRevision,
        by: slot.closedBy, at: slot.closedAt, count: slot.closedLogCount, qty: slot.closedScrapQty,
        note: slot.closeNote || "", reason: slot.noProductionReason || ""
      };
    }
    if (slot && slot.importPending) out.reasons.push("import-incomplete");
    if (slot && typeof slot.liveLogCount === "number" && slot.liveLogCount !== sum.count) out.reasons.push("ledger-count-mismatch");
    if (out.closed && out.closed.version === out.version) {
      if (slot.closedFingerprint !== fingerprint(logs)) out.reasons.push("changed-outside-ledger");
      if (out.closed.state !== STATUS.SUBMITTED && sum.count > 0) out.reasons.push("logs-on-zero");
    }
    if (out.reasons.length) { out.status = STATUS.CONFLICT; return out; }
    if (!out.closed) return out;
    if (out.closed.version !== out.version) { out.status = STATUS.CHANGED; out.needsReconfirm = true; return out; }
    out.status = out.closed.state;
    return out;
  }

  // ---- shift timing -------------------------------------------------------------------------
  function shiftEnd(date, shift, ends) {
    const cfg = (ends || (typeof QD_SHIFT_END !== "undefined" ? QD_SHIFT_END : null) || {})[shift];
    if (!cfg) return null;
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = cfg.time.split(":").map(Number);
    return new Date(y, m - 1, d + (cfg.dayOffset || 0), hh, mm, 0, 0);
  }
  function shiftEnded(date, shift, now, ends) {
    const end = shiftEnd(date, shift, ends);
    return !!end && (now || new Date()).getTime() >= end.getTime();
  }

  // ---- reading ------------------------------------------------------------------------------
  async function loadSlot(db, date, line, shift) {
    const id = slotIdOf({ date, line, shift });
    const [snap, logSnap] = await Promise.all([
      db.collection(SLOT_COLLECTION).doc(id).get(),
      db.collection(LOG_COLLECTION).where("date", "==", date).where("line", "==", line).where("shift", "==", shift).get()
    ]);
    const logs = [];
    logSnap.forEach(d => logs.push(Object.assign({ id: d.id }, d.data())));
    const slot = snap.exists ? snap.data() : null;
    return { id, date, line, shift, slot, logs, info: deriveStatus({ slot, logs }) };
  }
  // One date, all Line × Shift: one scrap-log query + one read per slot.
  async function loadDay(db, date, lines, shifts) {
    const logSnap = await db.collection(LOG_COLLECTION).where("date", "==", date).get();
    const all = [];
    logSnap.forEach(d => all.push(Object.assign({ id: d.id }, d.data())));
    const out = [];
    for (const line of lines) for (const shift of shifts) {
      const id = slotIdOf({ date, line, shift });
      const snap = await db.collection(SLOT_COLLECTION).doc(id).get();
      const slot = snap.exists ? snap.data() : null;
      const logs = all.filter(l => l.line === line && l.shift === shift);
      out.push({ id, date, line, shift, slot, logs, info: deriveStatus({ slot, logs }) });
    }
    return out;
  }
  async function loadHistory(db, slotId) {
    const snap = await db.collection(SLOT_COLLECTION).doc(slotId).collection("events").get();
    const list = [];
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    const ms = t => (t && typeof t.toMillis === "function") ? t.toMillis() : 0;
    return list.sort((a, b) => ms(b.at) - ms(a.at) || (b.id < a.id ? -1 : 1));
  }

  // ---- closing ------------------------------------------------------------------------------
  function fail(code, message) { const e = new Error(message); e.code = code; return e; }

  /**
   * closeSlot(db, req, opts)
   *   req:  { date, line, shift, state, note, reason, expectedVersion, expectedRevision, reconfirm }
   *         expectedVersion / expectedRevision = what the person was looking at when they pressed
   *         the button; if the slot moved since, nothing is written (qd/changed-while-closing).
   *   opts: { email, serverTimestamp }
   * → { slotId, revision, version, verified }
   */
  async function closeSlot(db, req, opts) {
    if (!opts || !opts.email) throw fail("qd/not-signed-in", "Sign in to close a shift.");
    if (!CLOSE_STATES.includes(req.state)) throw fail("qd/invalid", "Unknown close state.");
    const pre = await loadSlot(db, req.date, req.line, req.shift);
    const st = pre.info;
    const version = st.version;
    const revision = pre.slot ? pre.slot.closeRevision || 0 : 0;
    if (req.expectedVersion !== undefined && req.expectedVersion !== version) throw fail("qd/changed-while-closing", "Scrap for this shift changed while you were reviewing it. Check the new figures and try again.");
    if (req.expectedRevision !== undefined && req.expectedRevision !== revision) throw fail("qd/changed-while-closing", "Someone else closed this shift meanwhile. Check it and try again.");
    if (pre.slot && pre.slot.importPending) throw fail("qd/import-pending", REASONS["import-incomplete"]);
    if (st.status === STATUS.CONFLICT) throw fail("qd/conflict", st.reasons.map(r => REASONS[r] || r).join(" "));
    if ((st.status === req.state || CLOSE_STATES.includes(st.status)) && !req.reconfirm) throw fail("qd/already-closed", "This shift is already closed at this version.");
    if (req.state === STATUS.SUBMITTED && !(st.count > 0 && st.qty > 0)) throw fail("qd/invalid", "There is no scrap to submit. Use Confirm zero scrap or No production.");
    if (req.state !== STATUS.SUBMITTED && st.count > 0) throw fail("qd/invalid", "This shift has scrap records, so it cannot be confirmed as zero / no production.");
    const reason = (req.reason || "").trim();
    if (req.state === STATUS.NO_PRODUCTION && reason.length < 3) throw fail("qd/invalid", "Give the reason the line did not run (at least 3 characters).");

    const sum = summarize(pre.logs);
    const fp = fingerprint(pre.logs);
    const ts = opts.serverTimestamp;
    const ref = db.collection(SLOT_COLLECTION).doc(pre.id);
    const rev = revision + 1;
    const fields = {
      closeState: req.state, closedVersion: version, closeRevision: rev,
      closedBy: opts.email, closedAt: ts(), closedLogCount: sum.count, closedScrapQty: sum.qty,
      closedLogIds: sum.ids, closedFingerprint: fp,
      closeNote: (req.note || "").trim() || null,
      noProductionReason: req.state === STATUS.NO_PRODUCTION ? reason : null,
      updatedAt: ts(), updatedBy: opts.email
    };
    const previous = pre.slot && pre.slot.closeState
      ? { state: pre.slot.closeState, version: pre.slot.closedVersion, revision: pre.slot.closeRevision, by: pre.slot.closedBy }
      : null;
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const cur = snap.exists ? snap.data() : null;
        if ((cur ? cur.logVersion || 0 : 0) !== version || (cur ? cur.closeRevision || 0 : 0) !== revision) {
          throw fail("qd/changed-while-closing", "Scrap for this shift changed while closing. Nothing was saved — check the new figures and try again.");
        }
        if (cur && cur.importPending) throw fail("qd/import-pending", REASONS["import-incomplete"]);
        if (cur && cur.liveLogCount !== sum.count) throw fail("qd/conflict", REASONS["ledger-count-mismatch"]);
        if (cur) tx.update(ref, fields);
        else tx.set(ref, Object.assign({ date: req.date, line: req.line, shift: req.shift, logVersion: 0, liveLogCount: sum.count, legacyCount: sum.count }, fields));
        tx.set(ref.collection("events").doc("c" + rev), {
          type: "CLOSE", revision: rev, closeState: req.state, version, logCount: sum.count, scrapQty: sum.qty,
          logIds: sum.ids, fingerprint: fp, note: fields.closeNote, noProductionReason: fields.noProductionReason,
          previous, at: ts(), by: opts.email
        });
      });
    } catch (err) {
      if (err && err.code && String(err.code).startsWith("qd/")) throw err;
      // A lost race can come back from the rules as permission-denied: tell the person what happened.
      const now = await ref.get();
      const d = now.exists ? now.data() : null;
      if ((d ? d.logVersion || 0 : 0) !== version || (d ? d.closeRevision || 0 : 0) !== revision) {
        throw fail("qd/changed-while-closing", "Scrap for this shift changed while closing. Nothing was saved — check the new figures and try again.");
      }
      throw err;
    }
    // Re-read the stored logs: anything written outside the ledger meanwhile shows up as CONFLICT.
    const after = await loadSlot(db, req.date, req.line, req.shift);
    return { slotId: pre.id, revision: rev, version, verified: after.info.status === req.state, status: after.info };
  }

  const api = { STATUS, CLOSE_STATES, REASONS, fingerprint, summarize, deriveStatus, shiftEnd, shiftEnded, loadSlot, loadDay, loadHistory, closeSlot, slotIdOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ShiftClose = api;
})(this);
