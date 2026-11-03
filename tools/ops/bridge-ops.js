/**
 * bridge-ops.js — operations for the rollout (Phase 7). Emulator-tested; NOT run against production.
 * ------------------------------------------------------------------
 * While the BRIDGE rules are published, pages still in sign-in "off" can save scrap logs around the
 * ledger. These tools make that period measurable and repairable:
 *
 *   bridgeAudit(db, { from, to })      READ ONLY. Per slot in the date range: stored logs vs the
 *                                      ledger count, closed shifts whose records changed, import
 *                                      markers, and logs saved without a ledger slot.
 *                                      → { slots: [...], problems: [...], summary }
 *   reconcileSlot(db, slotId, reason, opts)   ADMIN. Re-counts a slot from the logs actually
 *                                      stored (event v{n} type RECONCILE: logIds, fingerprint,
 *                                      previous count, reason). A closed shift becomes CHANGED and
 *                                      must be reconfirmed. Allowed by the candidate rules only.
 *
 * Bridge exit condition (docs/phase7): two audits at least one full production day apart, the
 * second one taken after everyone reloaded, show NO new problem — then publish the candidate,
 * then reconcile what the audits listed.
 * Uses the Firebase compat API (admin page or Node through tests/support/compat-shim.js).
 * ------------------------------------------------------------------
 */
(function (root) {
  const dep = name => (root && root[name]) || require(name === 'ScrapLedger' ? '../../js/scrap-ledger.js' : '../../js/shift-close.js');
  const LINES = ['A', 'B', 'C'], SHIFTS = ['DAY', 'NIGHT'];

  async function bridgeAudit(db, { from, to }) {
    const SC = dep('ShiftClose');
    const logs = [], slots = new Map();
    (await db.collection('scrapLogs').where('date', '>=', from).where('date', '<=', to).get()).forEach(d => logs.push(Object.assign({ id: d.id }, d.data())));
    (await db.collection('scrapSlots').where('date', '>=', from).where('date', '<=', to).get()).forEach(d => slots.set(d.id, d.data()));
    const byId = new Map();
    logs.forEach(l => {
      if (!LINES.includes(l.line) || !SHIFTS.includes(l.shift)) return;
      const id = `${l.date}_${l.line}_${l.shift}`;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(l);
    });
    const ids = new Set([...slots.keys(), ...byId.keys()]);
    const out = [], problems = [];
    for (const id of [...ids].sort()) {
      const slot = slots.get(id) || null, list = byId.get(id) || [];
      const info = SC.deriveStatus({ slot, logs: list });
      const row = { slotId: id, ledger: !!slot, stored: list.length, liveLogCount: slot ? slot.liveLogCount : null, status: info.status, reasons: info.reasons };
      out.push(row);
      if (info.status === 'CONFLICT') problems.push(row);
    }
    return { slots: out, problems, summary: { slots: out.length, logs: logs.length, problems: problems.length, withoutLedger: out.filter(r => !r.ledger).length } };
  }

  async function reconcileSlot(db, slotId, reason, opts) {
    const L = dep('ScrapLedger'), SC = dep('ShiftClose');
    if (!opts || !opts.email) throw new Error('reconcileSlot needs the signed-in admin e-mail.');
    const [date, line, shift] = slotId.split('_');
    const pre = await SC.loadSlot(db, date, line, shift);
    if (!pre.slot) throw new Error(`${slotId} has no ledger slot: nothing to reconcile (its logs are counted when the slot is first written or by the baseline).`);
    const ts = opts.serverTimestamp, ref = db.collection(L.SLOT_COLLECTION).doc(slotId);
    const ids = pre.logs.map(l => l.id).sort(), fp = SC.fingerprint(pre.logs), qty = pre.logs.reduce((s, l) => s + (Number(l.scrapQty) || 0), 0);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const sums = await L.readSummaries(tx, db, [date]);
      const cur = snap.data();
      if (cur.logVersion !== pre.slot.logVersion) { const e = new Error('The slot changed meanwhile; run the audit again.'); e.code = 'qd/changed-while-closing'; throw e; }
      const version = cur.logVersion + 1;
      const fields = { logVersion: version, liveLogCount: ids.length, updatedAt: ts(), updatedBy: opts.email };
      tx.update(ref, fields);
      tx.set(ref.collection('events').doc('v' + version), { type: 'RECONCILE', version, at: ts(), by: opts.email, logIds: ids, fingerprint: fp, scrapQty: qty, before: cur.liveLogCount, reason });
      L.writeSummaries(tx, db, sums, new Map([[slotId, L.publicView(Object.assign({}, cur, fields))]]), ts);
      return { slotId, version, before: cur.liveLogCount, after: ids.length };
    });
  }

  /**
   * offLedgerSince(db, { from, to, sinceMs }) — POST-CANDIDATE AUDIT, read only.
   * Scrap logs created at or after `sinceMs` (createdAt) that no ledger event accounts for
   * (v{n} creates / movesIn, RECONCILE logIds, baseline b1 logIds). After the candidate rules are
   * published this must stay EMPTY: anything listed was written by a client around the ledger.
   * Reads only the events of the slots that have such logs.
   */
  async function offLedgerSince(db, { from, to, sinceMs }) {
    const recent = [];
    (await db.collection('scrapLogs').where('date', '>=', from).where('date', '<=', to).get()).forEach(d => {
      const l = Object.assign({ id: d.id }, d.data());
      if (Number(l.createdAt) >= sinceMs) recent.push(l);
    });
    const bySlot = new Map();
    recent.forEach(l => { const id = `${l.date}_${l.line}_${l.shift}`; if (!bySlot.has(id)) bySlot.set(id, []); bySlot.get(id).push(l); });
    const offLedger = [];
    for (const [slotId, list] of bySlot) {
      const known = new Set();
      (await db.collection('scrapSlots').doc(slotId).collection('events').get()).forEach(d => {
        const e = d.data();
        [].concat(e.creates || [], e.movesIn || [], e.logIds || []).forEach(x => known.add(x));
      });
      list.forEach(l => { if (!known.has(l.id)) offLedger.push({ id: l.id, slotId, createdAt: l.createdAt, scrapQty: l.scrapQty }); });
    }
    return { checked: recent.length, offLedger };
  }

  const api = { bridgeAudit, reconcileSlot, offLedgerSince };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BridgeOps = api;
})(this);
