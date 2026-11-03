/**
 * privacy-migration.js — move personal data off public documents (Phase 9). NOT RUN ON PRODUCTION.
 * ------------------------------------------------------------------
 *   scrapLogs/{id}.recordedBy        → scrapLogPrivate/{id}.recordedBy   (field removed from the log)
 *   improvements/{id}.actions[].owner → improvementOwners/{id}.owners[i]  (owner set to "")
 *
 * Steps (Admin page → Operations, or Node in the emulator tests):
 *   1. scan(db)              READ ONLY: every document that still holds personal data (old AND new),
 *                            plus exceptions that cannot be migrated as is (e.g. a code > 64 chars,
 *                            an improvement with > 20 actions).
 *   2. backup(plan)          the original values as JSON — keep it before step 3 (also the undo data).
 *   3. apply(db, plan, opts) one transaction per document, idempotent: a document that was already
 *                            migrated (or changed meanwhile) is skipped; safe to stop and resume
 *                            (re-run scan + apply: only what is left is done).
 *                            opts.opId = a PRIVACY_MIGRATION run opened with startOp (the rules
 *                            require it for the log change).
 *   4. verify(db, backup)    re-scan = 0 personal fields left, and every sidecar holds the backed-up
 *                            value.
 * Scrap quantities, ledger counts and close fingerprints never include these fields, so closes and
 * the target are unaffected (tested).
 * ------------------------------------------------------------------
 */
(function (root) {
  const MAX_CODE = 64, MAX_ACTIONS = 20;

  async function scan(db) {
    const logs = [], imps = [], exceptions = [];
    (await db.collection('scrapLogs').get()).forEach(d => {
      const v = d.data().recordedBy;
      if (v === undefined || v === null) return;
      if (String(v).trim() === '') { logs.push({ id: d.id, recordedBy: v, emptyOnly: true }); return; }
      if (String(v).length > MAX_CODE) exceptions.push({ kind: 'scrapLog', id: d.id, problem: `recordedBy longer than ${MAX_CODE} characters` });
      else logs.push({ id: d.id, recordedBy: v });
    });
    (await db.collection('improvements').get()).forEach(d => {
      const a = Array.isArray(d.data().actions) ? d.data().actions : [];
      if (!a.some(x => x && String(x.owner || '').trim())) return;
      if (a.length > MAX_ACTIONS) exceptions.push({ kind: 'improvement', id: d.id, problem: `${a.length} actions (max ${MAX_ACTIONS})` });
      else imps.push({ id: d.id, owners: a.map(x => String((x && x.owner) || '')) });
    });
    return { logs, improvements: imps, exceptions, totals: { logs: logs.length, improvements: imps.length, exceptions: exceptions.length } };
  }

  function backup(plan, meta) {
    return Object.assign({ kind: 'qd-privacy-migration-backup', createdAt: new Date().toISOString() }, meta || {},
      { scrapLogs: plan.logs.map(l => ({ id: l.id, recordedBy: l.recordedBy })), improvements: plan.improvements.map(i => ({ id: i.id, owners: i.owners })) });
  }

  async function apply(db, plan, opts) {
    const FV = opts.fieldValue;   // { delete: () => FieldValue.delete() }
    const out = { logs: { migrated: 0, skipped: 0, failed: [] }, improvements: { migrated: 0, skipped: 0, failed: [] } };
    for (const l of plan.logs) {
      const ref = db.collection('scrapLogs').doc(l.id), pref = db.collection('scrapLogPrivate').doc(l.id);
      try {
        const done = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const priv = await tx.get(pref);
          if (!snap.exists || snap.data().recordedBy !== l.recordedBy) return false;   // gone / already migrated / changed
          if (!l.emptyOnly) {
            if (priv.exists && priv.data().recordedBy && priv.data().recordedBy !== l.recordedBy) throw new Error('private record holds a different value');
            tx.set(pref, { recordedBy: String(l.recordedBy), opId: opts.opId });
          } else {
            tx.set(pref, { recordedBy: '', opId: opts.opId });   // empty value: keep the strip rule's proof uniform
          }
          tx.update(ref, { recordedBy: FV.delete() });
          return true;
        });
        done ? out.logs.migrated++ : out.logs.skipped++;
      } catch (e) { out.logs.failed.push({ id: l.id, error: (e && (e.code || e.message)) || String(e) }); }
    }
    for (const i of plan.improvements) {
      const ref = db.collection('improvements').doc(i.id), oref = db.collection('improvementOwners').doc(i.id);
      try {
        const done = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const own = await tx.get(oref);
          if (!snap.exists) return false;
          const actions = Array.isArray(snap.data().actions) ? snap.data().actions : [];
          if (!actions.some(x => x && String(x.owner || '').trim())) return false;   // already migrated
          const prev = own.exists ? own.data().owners || [] : [];
          const owners = actions.map((x, k) => String((x && x.owner) || '') || prev[k] || '');
          tx.set(oref, { owners, updatedAt: Date.now(), opId: opts.opId });
          tx.update(ref, { actions: actions.map(x => Object.assign({}, x, { owner: '' })), updatedAt: Date.now() });
          return true;
        });
        done ? out.improvements.migrated++ : out.improvements.skipped++;
      } catch (e) { out.improvements.failed.push({ id: i.id, error: (e && (e.code || e.message)) || String(e) }); }
    }
    return out;
  }

  async function verify(db, bak) {
    const left = await scan(db), problems = [];
    left.logs.forEach(l => problems.push(`scrapLogs/${l.id} still has recordedBy`));
    left.improvements.forEach(i => problems.push(`improvements/${i.id} still has owners`));
    for (const l of (bak && bak.scrapLogs) || []) {
      const p = await db.collection('scrapLogPrivate').doc(l.id).get();
      if (String(l.recordedBy).trim() && (!p.exists || p.data().recordedBy !== String(l.recordedBy))) problems.push(`scrapLogPrivate/${l.id} does not hold the backed-up value`);
    }
    for (const i of (bak && bak.improvements) || []) {
      const o = await db.collection('improvementOwners').doc(i.id).get();
      const owners = o.exists ? o.data().owners || [] : [];
      i.owners.forEach((v, k) => { if (v && owners[k] !== v) problems.push(`improvementOwners/${i.id}[${k}] does not hold the backed-up value`); });
    }
    return { clean: problems.length === 0 && left.exceptions.length === 0, problems, exceptions: left.exceptions };
  }

  const api = { scan, backup, apply, verify, MAX_CODE, MAX_ACTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PrivacyMigration = api;
})(this);
