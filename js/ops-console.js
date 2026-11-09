/**
 * ops-console.js — Admin page "Operations" tab (Phase 8). For the go-live steps in docs/phase8.
 * ------------------------------------------------------------------
 * Runs IN THE BROWSER as the signed-in Admin, so every read and write goes through the Firestore
 * Rules (no service-account key anywhere). Shown only while sign-in is enforced and to Admins.
 *
 *   READ ONLY (always available)       Bridge audit · Post-candidate audit · Reconcile dry run ·
 *                                      Baseline dry run · download the report as JSON
 *   WRITE (locked by default)          Reconcile · Clear import marker · Baseline apply · Gate
 *     unlocked only when QD_OPS_WRITE_ENABLED is true (config; or ?qdOpsWrite=1 in local
 *     emulator test mode), AND the Admin types "<projectId>/(default)" exactly, AND gives an
 *     approval reference and a reason. Every write step leaves an immutable qdOpsLog record.
 * Uses tools/ops/bridge-ops.js and tools/migration/ledger-baseline.js (same code the emulator
 * tests run).
 * ------------------------------------------------------------------
 */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DATABASE = '(default)';
  let lastAudit = null, lastPlan = null, lastReport = {}, privacyPlan = null, privacyBackup = null, backupSaved = false, privacyResult = null, privacyVerified = null;

  const projectId = () => (window.qdDb && window.qdDb.app && window.qdDb.app.options && window.qdDb.app.options.projectId) || '?';
  const opts = () => ({ email: QDAuth.getState().email, serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp() });
  const isAdmin = () => { const st = window.QDAuth && QDAuth.getState(); return !!(st && st.profile && st.profile.active === true && st.profile.role === 'admin'); };
  const bkkDate = n => { const d = new Date(Date.now() + 7 * 3600000 - n * 86400000); return d.toISOString().slice(0, 10); };
  function out(id, html, kind) { const el = $(id); el.className = 'qd-form-message' + (kind ? ' ' + kind : ''); el.innerHTML = html; el.style.display = 'block'; }

  // The write lock: config flag + exact project/database text + approval reference + reason.
  function writeCheck() {
    if (!window.qdOpsWrite) return 'Writes are locked (QD_OPS_WRITE_ENABLED is false).';
    if ($('opsConfirm').value.trim() !== `${projectId()}/${DATABASE}`) return `Type exactly: ${projectId()}/${DATABASE}`;
    if ($('opsApproval').value.trim().length < 3) return 'Enter the approval reference.';
    if ($('opsReason').value.trim().length < 3) return 'Enter the reason.';
    return null;
  }
  // Every write step runs under an operation: a START record first (the rules require it for the
  // write itself), then a RESULT record. See tools/ops/bridge-ops.js startOp / finishOp.
  const opMeta = () => ({ approvalRef: $('opsApproval').value.trim(), reason: $('opsReason').value.trim(), projectId: projectId(), database: DATABASE });
  function saveJson(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function download() { saveJson(Object.assign({ projectId: projectId(), database: DATABASE, generatedAt: new Date().toISOString() }, lastReport), `qd-ops-report_${projectId()}_${Date.now()}.json`); }

  // ---- read only ----
  async function runAudit() {
    const from = $('opsFrom').value, to = $('opsTo').value;
    out('opsAuditOut', 'Reading…');
    try {
      lastAudit = await BridgeOps.bridgeAudit(window.qdDb, { from, to });
      let post = null;
      if ($('opsSince').value) post = await BridgeOps.offLedgerSince(window.qdDb, { from, to, sinceMs: new Date($('opsSince').value).getTime() });
      lastReport.audit = { from, to, summary: lastAudit.summary, problems: lastAudit.problems, postCandidate: post };
      out('opsAuditOut', `<b>${lastAudit.summary.problems} problem slot(s)</b> · ${lastAudit.summary.slots} slots · ${lastAudit.summary.logs} logs · ${lastAudit.summary.withoutLedger} slot(s) without ledger`
        + (post ? ` · post-candidate: <b>${post.offLedger.length} log(s) written around the ledger</b> of ${post.checked} created since` : '')
        + (lastAudit.problems.length ? `<ul data-role="ops-problems">${lastAudit.problems.map(p => `<li><label><input type="checkbox" data-slot="${esc(p.slotId)}" checked> ${esc(p.slotId)} — stored ${p.stored}, ledger ${p.liveLogCount == null ? '–' : p.liveLogCount}, ${esc(p.reasons.join(', '))}</label></li>`).join('')}</ul>` : ''),
        lastAudit.problems.length || (post && post.offLedger.length) ? 'error' : 'success');
    } catch (e) { out('opsAuditOut', 'Audit failed: ' + esc(e.message), 'error'); }
  }
  const selectedSlots = () => [...document.querySelectorAll('#opsAuditOut [data-slot]:checked')].map(i => i.dataset.slot);
  async function reconcileDryRun() {
    const slots = selectedSlots();
    if (!slots.length) return out('opsReconcileOut', 'Run the audit and tick the slots first.', 'error');
    const rows = [];
    for (const id of slots) { const [d, l, s] = id.split('_'); const cur = await ShiftClose.loadSlot(window.qdDb, d, l, s); rows.push({ slotId: id, ledger: cur.slot ? cur.slot.liveLogCount : null, stored: cur.logs.length, importPending: !!(cur.slot && cur.slot.importPending), closed: !!(cur.slot && cur.slot.closeState) }); }
    lastReport.reconcileDryRun = rows;
    out('opsReconcileOut', `<b>Dry run — nothing written.</b><ul>${rows.map(r => `<li>${esc(r.slotId)}: ledger ${r.ledger} → ${r.stored}${r.importPending ? ' · import marker would be cleared' : ''}${r.closed ? ' · closed shift becomes CHANGED (reconfirm)' : ''}</li>`).join('')}</ul>`);
  }
  async function baselineDryRun() {
    out('opsBaselineOut', 'Reading all scrap logs and slots…');
    const logs = [], slots = [];
    (await window.qdDb.collection('scrapLogs').get()).forEach(d => logs.push(Object.assign({ id: d.id }, d.data())));
    (await window.qdDb.collection('scrapSlots').get()).forEach(d => slots.push(d.id));
    lastPlan = LedgerBaseline.planBaseline(logs, slots);
    const problems = LedgerBaseline.verifyPlan(lastPlan), t = lastPlan.totals;
    lastReport.baselineDryRun = { totals: t, problems, excluded: lastPlan.excluded };
    out('opsBaselineOut', `<b>Dry run — nothing written.</b> ${t.logs} logs (${t.qty} pcs) → ${t.planned.slots} slots to create (${t.planned.logs} logs), ${t.skipped.slots} already in the ledger, ${t.excluded.logs} excluded · plan check: ${problems.length ? 'FAILED ' + esc(problems.join('; ')) : 'OK'}`, problems.length ? 'error' : 'success');
  }

  // ---- write (locked) ----
  async function guarded(outId, action, fn) {
    const why = writeCheck();
    if (why) return out(outId, '🔒 ' + esc(why), 'error');
    let opId = null;
    try {
      opId = await BridgeOps.startOp(window.qdDb, action, opMeta(), opts());
      const summary = await fn(Object.assign({ opId }, opts()));
      await BridgeOps.finishOp(window.qdDb, opId, action, summary, opMeta(), opts());
      lastReport[action] = summary; out(outId, `<b>Done.</b> ${esc(JSON.stringify(summary).slice(0, 600))}`, 'success');
    } catch (e) {
      if (opId) { try { await BridgeOps.finishOp(window.qdDb, opId, action, { error: e.message }, opMeta(), opts()); } catch (x) { /* logging failed too */ } }
      out(outId, 'Failed: ' + esc(e.message), 'error');
    }
  }
  const reconcileApply = () => guarded('opsReconcileOut', 'RECONCILE', async o => {
    const res = [];
    for (const id of selectedSlots()) {
      const [d, l, s] = id.split('_');
      const cur = await ShiftClose.loadSlot(window.qdDb, d, l, s);
      if (cur.slot && cur.slot.importPending) { await ScrapLedger.clearImportMarker(window.qdDb, id, o); res.push({ slotId: id, clearedImportMarker: true }); }
      const now = await ShiftClose.loadSlot(window.qdDb, d, l, s);
      if (now.slot && now.slot.liveLogCount !== now.logs.length) res.push(await BridgeOps.reconcileSlot(window.qdDb, id, $('opsReason').value.trim(), o));
    }
    return { slots: res };
  });
  const baselineApply = () => guarded('opsBaselineOut', 'BASELINE_APPLY', async o => {
    if (!lastPlan) throw new Error('Run the baseline dry run first.');
    const r = await LedgerBaseline.applyBaseline(window.qdDb, lastPlan, Object.assign({ migrationId: $('opsApproval').value.trim() }, o));
    return { created: r.created.length, skipped: r.skipped.length, failed: r.failed };
  });
  const baselineGate = () => guarded('opsBaselineOut', 'BASELINE_GATE', async o => {
    if (!lastPlan) throw new Error('Run the baseline dry run first.');
    // One read of each collection; every check is made from these in memory (Q1).
    const logs = []; (await window.qdDb.collection('scrapLogs').get()).forEach(d => logs.push(Object.assign({ id: d.id }, d.data())));
    const slots = []; (await window.qdDb.collection('scrapSlots').get()).forEach(d => slots.push(Object.assign({ id: d.id }, d.data())));
    const g = await LedgerBaseline.completeIfClean(window.qdDb, lastPlan, $('opsApproval').value.trim(), o, logs, slots);
    if (!g.complete) throw new Error('Gate closed: ' + g.problems.slice(0, 10).join('; '));
    return g;
  });

  // ---- privacy migration (Phase 9) ----
  async function privacyDryRun() {
    out('opsPrivacyOut', 'Reading scrap logs and improvements…');
    privacyPlan = await PrivacyMigration.scan(window.qdDb);
    privacyBackup = PrivacyMigration.backup(privacyPlan, { projectId: projectId(), database: DATABASE });
    backupSaved = false;
    lastReport.privacyDryRun = { totals: privacyPlan.totals, exceptions: privacyPlan.exceptions };
    const t = privacyPlan.totals;
    out('opsPrivacyOut', `<b>Dry run — nothing written.</b> ${t.logs} scrap record(s) with recordedBy · ${t.improvements} improvement(s) with owners · ${t.exceptions} exception(s)${privacyPlan.exceptions.length ? `<ul>${privacyPlan.exceptions.map(x => `<li>${esc(x.kind)}/${esc(x.id)}: ${esc(x.problem)}</li>`).join('')}</ul>` : ''} · download the backup before applying.`, t.exceptions ? 'error' : 'success');
  }
  function privacyBackupDownload() {
    if (!privacyBackup) return out('opsPrivacyOut', 'Run the dry run first.', 'error');
    saveJson(privacyBackup, `qd-privacy-backup_${projectId()}_${Date.now()}.json`);
    backupSaved = true;
  }
  const privacyApply = () => guarded('opsPrivacyOut', 'PRIVACY_MIGRATION', async o => {
    if (!privacyPlan) throw new Error('Run the dry run first.');
    if (!backupSaved) throw new Error('Download the backup first.');
    const r = await PrivacyMigration.apply(window.qdDb, privacyPlan, Object.assign({ fieldValue: { delete: () => firebase.firestore.FieldValue.delete() } }, o));
    const v = await PrivacyMigration.verify(window.qdDb, privacyBackup);
    privacyResult = r; privacyVerified = v;
    const ex = PrivacyMigration.exceptionReport(privacyPlan, r, v);
    return { result: { logs: r.logs, improvements: r.improvements }, verify: { clean: v.clean, problems: v.problems.length }, exceptions: ex.count };
  });
  function privacyExceptions() {
    if (!privacyPlan) return out('opsPrivacyOut', 'Run the dry run first.', 'error');
    const rep = PrivacyMigration.exceptionReport(privacyPlan, privacyResult, privacyVerified);
    saveJson(rep, `qd-privacy-exceptions_${projectId()}_${Date.now()}.json`);
  }
  async function privacyVerify() {
    const v = await PrivacyMigration.verify(window.qdDb, privacyBackup);
    lastReport.privacyVerify = v;
    out('opsPrivacyOut', v.clean ? '<b>Verified:</b> no personal data left on public documents; sidecars hold the backed-up values.' : `<b>Not clean:</b> ${esc(v.problems.concat(v.exceptions.map(x => x.kind + '/' + x.id + ': ' + x.problem)).slice(0, 20).join('; '))}`, v.clean ? 'success' : 'error');
  }

  function render() {
    const tabBtn = document.querySelector('#adminTabs button[data-tab="ops"]'), sec = $('tab-ops');
    if (!tabBtn || !sec) return;
    const show = window.qdAuthMode === 'enforce' && isAdmin();
    tabBtn.hidden = !show;
    if (!show) { sec.style.display = 'none'; return; }
    if (sec.dataset.built) return;
    sec.dataset.built = '1';
    sec.innerHTML = `
      <h2>Operations (go-live)</h2>
      <div class="qd-panel-note" data-role="ops-target">Project <b>${esc(projectId())}</b> · Database <b>${DATABASE}</b> · Writes <b data-role="ops-lock">${window.qdOpsWrite ? 'UNLOCKED' : 'LOCKED'}</b>. Audits and dry runs only read. See docs/phase8 for when each step is allowed.</div>
      <h3>1. Bridge / post-candidate audit (read only)</h3>
      <div class="qd-form-grid">
        <div class="qd-form-field"><label for="opsFrom">From</label><input type="date" id="opsFrom" value="${bkkDate(14)}"></div>
        <div class="qd-form-field"><label for="opsTo">To</label><input type="date" id="opsTo" value="${bkkDate(0)}"></div>
        <div class="qd-form-field"><label for="opsSince">Post-candidate: logs created since (optional)</label><input type="datetime-local" id="opsSince"></div>
      </div>
      <button type="button" class="mini-add-btn" id="opsAuditBtn">Run audit</button>
      <button type="button" class="mini-add-btn" id="opsDownloadBtn">Download report (JSON)</button>
      <div id="opsAuditOut" class="qd-form-message" style="display:none;"></div>
      <h3>2. Write confirmation (needed for steps 3–4)</h3>
      <div class="qd-form-grid">
        <div class="qd-form-field"><label for="opsConfirm">Type ${esc(projectId())}/${DATABASE}</label><input id="opsConfirm" autocomplete="off"></div>
        <div class="qd-form-field"><label for="opsApproval">Approval reference</label><input id="opsApproval" autocomplete="off" placeholder="e.g. CHG-2026-001"></div>
        <div class="qd-form-field"><label for="opsReason">Reason</label><input id="opsReason" autocomplete="off"></div>
      </div>
      <h3>3. Reconcile the ticked slots</h3>
      <button type="button" class="mini-add-btn" id="opsReconcileDryBtn">Dry run</button>
      <button type="button" class="qd-submit-btn" id="opsReconcileBtn" style="width:auto;">Apply reconcile</button>
      <div id="opsReconcileOut" class="qd-form-message" style="display:none;"></div>
      <h3>4. Ledger baseline (migration)</h3>
      <button type="button" class="mini-add-btn" id="opsBaselineDryBtn">Dry run (reads every scrap log)</button>
      <button type="button" class="qd-submit-btn" id="opsBaselineBtn" style="width:auto;">Apply baseline</button>
      <button type="button" class="qd-submit-btn" id="opsGateBtn" style="width:auto;">Run gate (set baselineComplete)</button>
      <div id="opsBaselineOut" class="qd-form-message" style="display:none;"></div>
      <h3>5. Privacy migration (old public recordedBy / owners → private)</h3>
      <button type="button" class="mini-add-btn" id="opsPrivacyDryBtn">Dry run</button>
      <button type="button" class="mini-add-btn" id="opsPrivacyBackupBtn">Download backup (JSON)</button>
      <button type="button" class="qd-submit-btn" id="opsPrivacyBtn" style="width:auto;">Apply privacy migration</button>
      <button type="button" class="mini-add-btn" id="opsPrivacyVerifyBtn">Verify</button>
      <button type="button" class="mini-add-btn" id="opsPrivacyExceptionsBtn">Download exception report (JSON)</button>
      <div id="opsPrivacyOut" class="qd-form-message" style="display:none;"></div>`;
    $('opsAuditBtn').onclick = runAudit;
    $('opsDownloadBtn').onclick = download;
    $('opsReconcileDryBtn').onclick = reconcileDryRun;
    $('opsReconcileBtn').onclick = reconcileApply;
    $('opsBaselineDryBtn').onclick = baselineDryRun;
    $('opsBaselineBtn').onclick = baselineApply;
    $('opsGateBtn').onclick = baselineGate;
    $('opsPrivacyDryBtn').onclick = privacyDryRun;
    $('opsPrivacyBackupBtn').onclick = privacyBackupDownload;
    $('opsPrivacyBtn').onclick = privacyApply;
    $('opsPrivacyVerifyBtn').onclick = privacyVerify;
    $('opsPrivacyExceptionsBtn').onclick = privacyExceptions;
  }

  function init() {
    render();
    if (window.QDAuth) QDAuth.onChange(render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.QDOpsConsole = { render };
})();
