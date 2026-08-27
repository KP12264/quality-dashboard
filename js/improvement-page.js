/**
 * improvement-page.js
 * ------------------------------------------------------------------
 * Page 4 — Improvement. Only talks to Firestore via ImprovementAdapter
 * (the `improvements` collection this app owns). Never touches
 * productionLogs or scrapLogs directly — Scrap Detail links here with
 * query params to prefill a new improvement against a specific
 * Line+Model+Defect, but the actual scrap numbers are typed in by the
 * user (Before/After Scrap Qty), not fetched automatically.
 *
 * SCOPE NOTE: this page is functional for create/list/edit. It does
 * NOT yet do real photo upload (URL fields only) or a full per-field
 * audit trail — see the header comment in improvement-adapter.js.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const fmtPct = n => Number.isFinite(n) ? n.toFixed(1) + '%' : '–';

  let editingId = null; // set when editing an existing record (via ?id=)

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showBanner(kind, message) {
    const el = $('connectionBanner');
    el.className = 'qd-banner ' + kind;
    el.textContent = message;
    el.style.display = 'flex';
  }

  // ---- Tabs ---------------------------------------------------------------

  function switchTab(tab) {
    $('impTabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('listPanel').style.display = tab === 'list' ? '' : 'none';
    $('formPanel').style.display = tab === 'new' ? '' : 'none';
  }

  // ---- Static field population ---------------------------------------------

  function populateStaticFields() {
    $('fDefectType').innerHTML = DEFECT_TYPES.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    $('fFourM').innerHTML = '<option value="">–</option>' + FOUR_M_TYPES.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    $('fStatus').innerHTML = IMPROVEMENT_STATUSES.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    renderWhyFields(["", "", "", "", ""]);
    renderActionRows([]);
  }

  function renderWhyFields(whys) {
    $('whyFields').innerHTML = whys.map((w, i) => `
      <div class="qd-why-row">
        <span>Why ${i + 1}</span>
        <input type="text" class="why-input" data-idx="${i}" value="${escapeHtml(w)}">
      </div>`).join('');
  }
  function collectWhys() {
    return Array.from(document.querySelectorAll('.why-input')).map(i => i.value);
  }

  function renderActionRows(actions) {
    const container = $('actionRows');
    container.innerHTML = actions.map((a, i) => `
      <div class="qd-action-row" data-idx="${i}">
        <input type="text" class="action-desc" placeholder="Action" value="${escapeHtml(a.action || '')}">
        <input type="text" class="action-owner" placeholder="Owner" value="${escapeHtml(a.owner || '')}">
        <input type="date" class="action-due" value="${escapeHtml(a.dueDate || '')}">
        <button type="button" class="row-del" title="Remove">×</button>
      </div>`).join('');
    container.querySelectorAll('.row-del').forEach(btn => {
      btn.addEventListener('click', () => { btn.closest('.qd-action-row').remove(); });
    });
  }
  function collectActions() {
    return Array.from(document.querySelectorAll('#actionRows .qd-action-row')).map(row => ({
      action: row.querySelector('.action-desc').value,
      owner: row.querySelector('.action-owner').value,
      dueDate: row.querySelector('.action-due').value
    })).filter(a => a.action);
  }

  $('addActionBtn').addEventListener('click', () => {
    const container = $('actionRows');
    const div = document.createElement('div');
    div.className = 'qd-action-row';
    div.innerHTML = `
      <input type="text" class="action-desc" placeholder="Action">
      <input type="text" class="action-owner" placeholder="Owner">
      <input type="date" class="action-due">
      <button type="button" class="row-del" title="Remove">×</button>`;
    div.querySelector('.row-del').addEventListener('click', () => div.remove());
    container.appendChild(div);
  });

  // ---- Prefill from query params (Scrap Detail "+ Create" link) or ?id= edit ----

  function prefillFromQuery() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('id')) {
      editingId = params.get('id');
      loadForEdit(editingId);
      switchTab('new');
      return;
    }
    if (params.get('new')) {
      if (params.get('problem')) $('fProblem').value = params.get('problem');
      if (params.get('defectType')) $('fDefectType').value = params.get('defectType');
      if (params.get('line')) $('fLine').value = params.get('line');
      if (params.get('model')) $('fModel').value = params.get('model');
      switchTab('new');
    }
  }

  async function loadForEdit(id) {
    if (window.qdFirebaseError) return;
    try {
      const { records } = await ImprovementAdapter.getImprovements(window.qdDb, {});
      const rec = records.find(r => r.id === id);
      if (!rec) { showBanner('warn', '⚠ Improvement record not found.'); return; }
      $('formTitle').textContent = 'Edit Improvement — ' + rec.improvementId;
      $('fProblem').value = rec.problem;
      $('fDefectType').value = rec.defectType;
      $('fFourM').value = rec.fourM;
      $('fLine').value = rec.line;
      $('fModel').value = rec.model;
      renderWhyFields(rec.whys.length === 5 ? rec.whys : ["", "", "", "", ""]);
      $('fRootCause').value = rec.rootCause;
      renderActionRows(rec.actions);
      $('fBeforePhoto').value = rec.beforePhotoUrl;
      $('fRootCausePhoto').value = rec.rootCausePhotoUrl;
      $('fActionPhoto').value = rec.actionPhotoUrl;
      $('fAfterPhoto').value = rec.afterPhotoUrl;
      $('fBeforeScrap').value = rec.beforeScrapQty ?? '';
      $('fAfterScrap').value = rec.afterScrapQty ?? '';
      $('fStatus').value = rec.status;
      $('saveImprovementBtn').textContent = 'Update Improvement';
    } catch (e) {
      console.error('Quality Dashboard: failed to load improvement for edit:', e);
      showBanner('error', '⚠ Could not load this improvement record.');
    }
  }

  // ---- List ---------------------------------------------------------------

  async function loadList() {
    const tbody = $('improvementTableBody');
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
    if (window.qdFirebaseError) {
      showBanner('error', '⚠ ' + window.qdFirebaseError);
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Data unavailable.</td></tr>';
      return;
    }
    try {
      const { records, error } = await ImprovementAdapter.getImprovements(window.qdDb, {});
      if (error) { tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Could not load improvement records.</td></tr>'; return; }
      if (records.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No improvement records yet — create one from the "+ New Improvement" tab.</td></tr>'; return; }
      tbody.innerHTML = records.map(r => `
        <tr>
          <td><a class="qd-link-btn" href="improvement.html?id=${encodeURIComponent(r.id)}">${escapeHtml(r.improvementId)}</a></td>
          <td>${escapeHtml(r.problem)}</td>
          <td>${escapeHtml(r.defectType)}</td>
          <td>${escapeHtml(r.line || '–')} / ${escapeHtml(r.model || '–')}</td>
          <td>${escapeHtml(r.fourM || '–')}</td>
          <td class="num">${r.beforeScrapQty ?? '–'} → ${r.afterScrapQty ?? '–'}</td>
          <td class="num">${fmtPct(r.reductionPct)}</td>
          <td><span class="qd-badge status-${r.status.replace(/\s+/g, '-')}">${escapeHtml(r.status)}</span></td>
        </tr>`).join('');
    } catch (e) {
      console.error('Quality Dashboard: failed to load improvement list:', e);
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Could not load improvement records.</td></tr>';
    }
  }

  // ---- Save ---------------------------------------------------------------

  function showMessage(kind, text) {
    const el = $('improvementMessage');
    el.className = 'qd-form-message ' + kind;
    el.textContent = text;
    el.style.display = 'block';
  }

  $('improvementForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = $('saveImprovementBtn');
    $('improvementMessage').style.display = 'none';

    const payload = {
      problem: $('fProblem').value.trim(),
      defectType: $('fDefectType').value,
      fourM: $('fFourM').value,
      line: $('fLine').value,
      model: $('fModel').value.trim(),
      whys: collectWhys(),
      rootCause: $('fRootCause').value.trim(),
      actions: collectActions(),
      beforePhotoUrl: $('fBeforePhoto').value.trim(),
      rootCausePhotoUrl: $('fRootCausePhoto').value.trim(),
      actionPhotoUrl: $('fActionPhoto').value.trim(),
      afterPhotoUrl: $('fAfterPhoto').value.trim(),
      beforeScrapQty: $('fBeforeScrap').value,
      afterScrapQty: $('fAfterScrap').value,
      status: $('fStatus').value
    };

    if (!payload.problem || !payload.defectType) {
      showMessage('error', 'Problem/Symptom and Defect Type are required.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (editingId) {
        await ImprovementAdapter.updateImprovement(window.qdDb, editingId, payload);
        showMessage('success', 'Improvement updated.');
      } else {
        await ImprovementAdapter.addImprovement(window.qdDb, payload);
        showMessage('success', 'Improvement created.');
      }
      loadList();
      switchTab('list');
    } catch (err) {
      console.error('Quality Dashboard: failed to save improvement:', err);
      showMessage('error', '⚠ Could not save: ' + (err && err.message ? err.message : String(err)));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = editingId ? 'Update Improvement' : 'Save Improvement';
    }
  });

  // ---- Init ---------------------------------------------------------------

  function init() {
    populateStaticFields();
    $('impTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });
    prefillFromQuery();
    loadList();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
