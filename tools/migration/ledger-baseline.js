/**
 * ledger-baseline.js — Shift Scrap Close migration (Phase 5). NOT RUN AGAINST PRODUCTION.
 * ------------------------------------------------------------------
 * Creates the ledger "baseline" for scrap logs saved before the ledger existed:
 *   scrapSlots/{date}_{line}_{shift}   { logVersion: 0, liveLogCount = legacyCount = N, ... }
 *   scrapSlots/{slotId}/events/b1       { type: "BASELINE", migrationId, legacyCount, scrapQty,
 *                                         logIds, fingerprint, at, by }
 *   scrapCloseSummary/{date}.slots[..]  the public view (as for every slot write)
 *   qdConfig/ledger                     { baselineComplete: true, migrationId, at, by } (last step)
 * Scrap logs themselves are NEVER written, changed or deleted: the migration only adds documents,
 * so scrap totals cannot change (verified by verifyPlan / verifyApplied).
 *
 * Steps (see docs/phase5/deployment-runbook.md):
 *   1. planBaseline(logs, existingSlotIds)  — pure; dry run = plan + report, no writes
 *   2. applyBaseline(db, plan, opts)        — one transaction per slot, skips slots that exist
 *   3. verifyApplied(db, plan)              — re-reads every slot and its logs
 *   4. markComplete(db, migrationId, opts)  — only when 3 reports no mismatch
 * Uses the Firebase compat API (browser admin page or Node through tests/support/compat-shim.js).
 * ------------------------------------------------------------------
 */
(function (root) {
  const LINES = ["A", "B", "C"], SHIFTS = ["DAY", "NIGHT"];
  const dep = name => (root && root[name]) || require(name === "ScrapLedger" ? "../../js/scrap-ledger.js" : "../../js/shift-close.js");
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  /** planBaseline(logs, existingSlotIds) → { slots, skipped, excluded, totals } (pure) */
  function planBaseline(logs, existingSlotIds) {
    const SC = dep("ShiftClose");
    const existing = new Set(existingSlotIds || []);
    const bySlot = new Map(), excluded = [];
    (logs || []).forEach(l => {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(l.date || "") && LINES.includes(l.line) && SHIFTS.includes(l.shift);
      if (!ok) { excluded.push({ id: l.id, date: l.date, line: l.line, shift: l.shift, scrapQty: num(l.scrapQty), reason: "not Door A/B/C x DAY/NIGHT with a YYYY-MM-DD date (never counted by the target either)" }); return; }
      const id = `${l.date}_${l.line}_${l.shift}`;
      if (!bySlot.has(id)) bySlot.set(id, []);
      bySlot.get(id).push(l);
    });
    const slots = [], skipped = [];
    for (const [slotId, list] of bySlot) {
      const [date, line, shift] = slotId.split("_");
      const entry = { slotId, date, line, shift, count: list.length, qty: list.reduce((s, l) => s + num(l.scrapQty), 0),
        logIds: list.map(l => l.id).sort(), fingerprint: SC.fingerprint(list) };
      (existing.has(slotId) ? skipped : slots).push(entry);
    }
    slots.sort((a, b) => a.slotId < b.slotId ? -1 : 1);
    const totals = {
      logs: (logs || []).length, qty: (logs || []).reduce((s, l) => s + num(l.scrapQty), 0),
      planned: { slots: slots.length, logs: slots.reduce((s, x) => s + x.count, 0), qty: slots.reduce((s, x) => s + x.qty, 0) },
      skipped: { slots: skipped.length, logs: skipped.reduce((s, x) => s + x.count, 0), qty: skipped.reduce((s, x) => s + x.qty, 0) },
      excluded: { logs: excluded.length, qty: excluded.reduce((s, x) => s + x.scrapQty, 0) }
    };
    return { slots, skipped, excluded, totals };
  }

  /** verifyPlan(plan) → [] when every log is accounted for exactly once (planned + skipped + excluded). */
  function verifyPlan(plan) {
    const t = plan.totals, problems = [];
    if (t.planned.logs + t.skipped.logs + t.excluded.logs !== t.logs) problems.push(`log count: ${t.planned.logs} + ${t.skipped.logs} + ${t.excluded.logs} != ${t.logs}`);
    const q = t.planned.qty + t.skipped.qty + t.excluded.qty;
    if (Math.abs(q - t.qty) > 1e-9) problems.push(`scrap qty: ${q} != ${t.qty}`);
    const ids = new Set();
    [...plan.slots, ...plan.skipped].forEach(s => s.logIds.forEach(id => { if (ids.has(id)) problems.push(`log ${id} in two slots`); ids.add(id); }));
    return problems;
  }

  /** applyBaseline(db, plan, { email, serverTimestamp, migrationId }) → { created, skipped, failed } */
  async function applyBaseline(db, plan, opts) {
    const L = dep("ScrapLedger");
    if (!opts || !opts.email || !opts.migrationId) throw new Error("applyBaseline needs email and migrationId.");
    const ts = opts.serverTimestamp, out = { created: [], skipped: [], failed: [] };
    for (const s of plan.slots) {
      const ref = db.collection(L.SLOT_COLLECTION).doc(s.slotId);
      try {
        const made = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const sums = await L.readSummaries(tx, db, [s.date]);
          if (snap.exists) return false;                                   // created meanwhile: leave it
          const slot = { date: s.date, line: s.line, shift: s.shift, logVersion: 0, liveLogCount: s.count, legacyCount: s.count, updatedAt: ts(), updatedBy: opts.email };
          tx.set(ref, slot);
          tx.set(ref.collection("events").doc("b1"), { type: "BASELINE", migrationId: opts.migrationId, opId: opts.opId || "", legacyCount: s.count, scrapQty: s.qty, logIds: s.logIds, fingerprint: s.fingerprint, at: ts(), by: opts.email });
          L.writeSummaries(tx, db, sums, new Map([[s.slotId, L.publicView(slot)]]), ts);
          return true;
        });
        (made ? out.created : out.skipped).push(s.slotId);
      } catch (e) {
        // A concurrent run (or a Leader's first save) may have created the slot first; under contention
        // the rules answer permission-denied instead of a retryable abort. If the slot exists now, it
        // was not created by us: skipped, not failed.
        const now = await ref.get().catch(() => null);
        if (now && now.exists) out.skipped.push(s.slotId);
        else out.failed.push({ slotId: s.slotId, error: (e && (e.code || e.message)) || String(e) });
      }
    }
    return out;
  }

  /** verifyApplied(db, plan) → mismatches: re-reads every planned slot and the logs stored for it. */
  async function verifyApplied(db, plan) {
    const SC = dep("ShiftClose"), mismatches = [];
    for (const s of plan.slots) {
      const cur = await SC.loadSlot(db, s.date, s.line, s.shift);
      if (!cur.slot) { mismatches.push({ slotId: s.slotId, problem: "slot missing" }); continue; }
      if (cur.slot.liveLogCount !== cur.logs.length) mismatches.push({ slotId: s.slotId, problem: `liveLogCount ${cur.slot.liveLogCount} != stored logs ${cur.logs.length}` });
      // Untouched since the baseline: must still be exactly the planned records. Once a Leader has saved
      // through the ledger (logVersion > 0) the plan is history; the ledger checks above apply.
      if (cur.slot.logVersion === 0 && (cur.info.qty !== s.qty || cur.logs.length !== s.count)) mismatches.push({ slotId: s.slotId, problem: `scrap qty ${cur.info.qty} / ${cur.logs.length} logs != planned ${s.qty} / ${s.count}` });
      if (cur.info.status === "CONFLICT") mismatches.push({ slotId: s.slotId, problem: "status CONFLICT: " + cur.info.reasons.join(",") });
    }
    return mismatches;
  }

  /**
   * completeIfClean(db, plan, migrationId, opts) — the migration gate (Phase 7). Sets
   * baselineComplete ONLY when (1) every planned slot exists with a count equal to its stored logs
   * and no CONFLICT, and (2) the logs stored NOW still match the plan (nothing was saved around the
   * ledger since the plan was made). Otherwise nothing is written and the problems are returned.
   * → { complete: true } | { complete: false, problems: [...] }
   */
  /**
   * gateProblems(plan, logs, slotDocs) → { problems, extra }   (pure: no reads)
   * The gate checks computed in memory from ONE read of scrapLogs (`logs`: [{ id, ...data }]) and ONE
   * read of scrapSlots (`slotDocs`: [{ id, ...data }]), instead of one slot read + one log query per
   * planned slot plus a second full read of the logs.
   *  problems: exactly what verifyApplied + the "saved after the plan" check report (same text, same order).
   *            Logs are matched to a slot like the `==` queries of ShiftClose.loadSlot: date, line and
   *            shift must be strings equal to the slot's (a value of another type never matches).
   *  extra:    stricter checks the old gate does not make, at no extra read — for planned slots still at
   *            logVersion 0, the stored log ids and the fingerprint (id, date, line, shift, model, defect,
   *            qty) must equal the plan, so an edit that keeps the count and quantity is caught too.
   */
  function gateProblems(plan, logs, slotDocs) {
    const SC = dep("ShiftClose");
    const key = (d, l, s) => d + "\u0000" + l + "\u0000" + s;
    const byKey = new Map();
    (logs || []).forEach(x => {
      if (typeof x.date !== "string" || typeof x.line !== "string" || typeof x.shift !== "string") return;
      const k = key(x.date, x.line, x.shift);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(x);
    });
    const slots = new Map((slotDocs || []).map(d => { const { id, ...data } = d; return [id, data]; }));
    const problems = [], extra = [];
    for (const s of plan.slots) {
      const slot = slots.has(s.slotId) ? slots.get(s.slotId) : null;
      const stored = byKey.get(key(s.date, s.line, s.shift)) || [];
      if (!slot) { problems.push(`${s.slotId}: slot missing`); continue; }
      const info = SC.deriveStatus({ slot, logs: stored });
      if (slot.liveLogCount !== stored.length) problems.push(`${s.slotId}: liveLogCount ${slot.liveLogCount} != stored logs ${stored.length}`);
      if (slot.logVersion === 0 && (info.qty !== s.qty || stored.length !== s.count)) problems.push(`${s.slotId}: scrap qty ${info.qty} / ${stored.length} logs != planned ${s.qty} / ${s.count}`);
      if (info.status === "CONFLICT") problems.push(`${s.slotId}: status CONFLICT: ` + info.reasons.join(","));
      if (slot.logVersion === 0) {
        const ids = stored.map(x => x.id).sort();
        if (ids.join("\n") !== (s.logIds || []).join("\n")) extra.push(`${s.slotId}: stored log ids differ from the plan (records added, removed or moved around the ledger)`);
        else if (SC.fingerprint(stored) !== s.fingerprint) extra.push(`${s.slotId}: records changed since the plan (fingerprint; e.g. model, defect or quantity edited around the ledger)`);
      }
    }
    const again = planBaseline(logs, [...slots.keys()]);
    again.slots.forEach(s => problems.push(`${s.slotId}: ${s.count} logs without a ledger slot (saved after the plan)`));
    return { problems, extra };
  }

  async function completeIfClean(db, plan, migrationId, opts, currentLogs, currentSlots) {
    if (currentLogs && currentSlots) {
      // One read of each collection (done by the caller); same checks, plus the log-id / fingerprint checks.
      const g = gateProblems(plan, currentLogs, currentSlots);
      const all = g.problems.concat(g.extra);
      if (all.length) return { complete: false, problems: all };
      await markComplete(db, migrationId, opts);
      return { complete: true };
    }
    const problems = (await verifyApplied(db, plan)).map(m => `${m.slotId}: ${m.problem}`);
    if (currentLogs) {
      const existing = [];
      (await db.collection("scrapSlots").get()).forEach(d => existing.push(d.id));
      const again = planBaseline(currentLogs, existing);
      again.slots.forEach(s => problems.push(`${s.slotId}: ${s.count} logs without a ledger slot (saved after the plan)`));
    }
    if (problems.length) return { complete: false, problems };
    await markComplete(db, migrationId, opts);
    return { complete: true };
  }

  async function markComplete(db, migrationId, opts) {
    await db.collection("qdConfig").doc("ledger").set({ baselineComplete: true, migrationId, opId: opts.opId || "", at: opts.serverTimestamp(), by: opts.email });
  }

  const api = { planBaseline, verifyPlan, applyBaseline, verifyApplied, gateProblems, completeIfClean, markComplete };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.LedgerBaseline = api;
})(this);
