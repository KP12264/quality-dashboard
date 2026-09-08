/**
 * scrap-detail-page.js
 * ------------------------------------------------------------------
 * Page 3 — Scrap Detail. Reads scrapLogs (via ScrapDataAdapter) and
 * improvements (via ImprovementAdapter, just to know which defect
 * groups already have a linked improvement). Never touches
 * productionLogs — this page has nothing to do with production reads,
 * only scrap records.
 *
 * "4M" column: a scrap entry itself has no 4M field (per the business
 * rule — the Leader records qty/defect only). 4M only exists once an
 * Improvement record classifies the root cause, so this column shows
 * the 4M from the FIRST matching improvement (by Line+Model+Defect) if
 * one exists, or "–" otherwise — it's derived, not stored on the scrap
 * record.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';

  let allRecords = [];      // scrap records for the current date range (before Shift/Line/Model/Defect filters)
  let improvements = [];    // all improvement records, for the 4M/link lookup
  let expandedRowId = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function lineLabel(code) { return (LINES.find(l => l.code === code) || {}).label || code; }
  function shiftLabel(code) { return (SHIFTS.find(s => s.code === code) || {}).label || code; }

  function showBanner(kind, message) {
    const el = $('connectionBanner');
    el.className = 'qd-banner ' + kind;
    el.textContent = message;
    el.style.display = 'flex';
  }
  function hideBanner() { $('connectionBanner').style.display = 'none'; }

  function currentFilters() {
    return {
      shift: $('fShift').value,
      line: $('fLine').value,
      model: $('fModel').value,
      defect: $('fDefect').value
    };
  }

  function applyFilters(records) {
    const f = currentFilters();
    return records.filter(r =>
      (f.shift === 'all' || r.shift === f.shift) &&
      (f.line === 'all' || r.line === f.line) &&
      (f.model === 'all' || r.model === f.model) &&
      (f.defect === 'all' || r.defectType === f.defect)
    );
  }

  function populateOptionFilters(records) {
    const models = Array.from(new Set(records.map(r => r.model).filter(Boolean))).sort();
    const defects = Array.from(new Set(records.map(r => r.defectType).filter(Boolean))).sort();
    const modelSel = $('fModel'), defectSel = $('fDefect');
    const prevModel = modelSel.value, prevDefect = defectSel.value;
    modelSel.innerHTML = '<option value="all">All</option>' + models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    defectSel.innerHTML = '<option value="all">All</option>' + defects.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if (models.includes(prevModel)) modelSel.value = prevModel;
    if (defects.includes(prevDefect)) defectSel.value = prevDefect;
  }

  function findLinkedImprovement(line, model, defectType) {
    return improvements.find(imp => imp.line === line && imp.model === model && imp.defectType === defectType) || null;
  }

  // ---- Main load --------------------------------------------------------

  async function load() {
    if (window.qdFirebaseError) {
      showBanner('error', '⚠ ' + window.qdFirebaseError);
      return;
    }
    const startDate = $('fStartDate').value;
    const endDate = $('fEndDate').value;
    if (!startDate || !endDate) return;

    try {
      const [scrapResult, impResult] = await Promise.all([
        ScrapDataAdapter.getScrapData(window.qdDb, { startDate, endDate }),
        (typeof ImprovementAdapter !== 'undefined') ? ImprovementAdapter.getImprovements(window.qdDb, {}) : Promise.resolve({ records: [] })
      ]);
      if (scrapResult.error) {
        showBanner('warn', '⚠ Could not read scrap data — try refreshing.');
      } else {
        hideBanner();
      }
      allRecords = scrapResult.records;
      improvements = impResult.records || [];
      populateOptionFilters(allRecords);
      renderAll();
    } catch (e) {
      console.error('Quality Dashboard: scrap detail load failed:', e);
      showBanner('error', '⚠ Could not load scrap detail data.');
    }
  }

  function renderAll() {
    const filtered = applyFilters(allRecords);
    const recurringGroups = QualityAdapter.buildRecurringProblems(filtered, RECURRING_THRESHOLD_DISTINCT_DATES);
    const recurringLookup = new Map(recurringGroups.map(g => [`${g.line}|${g.model}|${g.defectType}`, g]));

    renderTopDefect(filtered);
    renderTable(filtered, recurringLookup);
  }

  function renderTopDefect(records) {
    const container = $('topDefectRow');
    const pareto = QualityAdapter.buildParetoDefects(records).slice(0, 3);
    if (pareto.length === 0) {
      container.innerHTML = '<div class="qd-placeholder">No scrap records in this filter range.</div>';
      return;
    }
    container.innerHTML = pareto.map((d, i) => `
      <div class="qd-top-defect-card">
        <div class="rank">#${i + 1}</div>
        <div class="name">${escapeHtml(d.defectType)}</div>
        <div class="qty">${fmt(d.qty)} pcs</div>
      </div>`).join('');
  }

  function renderTable(records, recurringLookup) {
    const tbody = $('scrapDetailBody');
    if (records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No scrap records match the current filters.</td></tr>';
      return;
    }
    const sorted = records.slice().sort((a, b) => (b.date + (b.createdAt || 0)) < (a.date + (a.createdAt || 0)) ? -1 : 1);

    tbody.innerHTML = sorted.map(r => {
      const gk = `${r.line}|${r.model}|${r.defectType}`;
      const group = recurringLookup.get(gk);
      const linked = findLinkedImprovement(r.line, r.model, r.defectType);
      const fourM = linked && linked.fourM ? escapeHtml(linked.fourM) : '–';
      const improvementCell = linked
        ? `<span class="qd-badge linked">LINKED</span> <a class="qd-link-btn" href="improvement.html?id=${encodeURIComponent(linked.id)}">View</a>`
        : `<span class="qd-badge unlinked">NONE</span> <a class="qd-link-btn" href="improvement.html?new=1&problem=${encodeURIComponent(r.defectType + ' — ' + r.model)}&defectType=${encodeURIComponent(r.defectType)}&line=${encodeURIComponent(r.line)}&model=${encodeURIComponent(r.model)}">+ Create</a>`;
      return `
        <tr class="qd-detail-row" data-id="${r.id}">
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(shiftLabel(r.shift))}</td>
          <td>${escapeHtml(lineLabel(r.line))}</td>
          <td>${escapeHtml(r.model)}</td>
          <td>${escapeHtml(r.defectType)} ${group && group.recurring ? '<span class="qd-badge recurring">RECURRING</span>' : ''}</td>
          <td class="num">${fmt(r.scrapQty)}</td>
          <td>${escapeHtml(r.remark) || '<span style="color:var(--muted-soft);">–</span>'}</td>
          <td>${fourM}</td>
          <td>${improvementCell}</td>
          <td>
            <button type="button" class="qd-action-btn edit" data-action="edit" data-id="${r.id}">Edit</button>
            <button type="button" class="qd-action-btn delete" data-action="delete" data-id="${r.id}">Delete</button>
          </td>
        </tr>
        <tr class="qd-detail-drilldown" data-drilldown-for="${r.id}" style="display:none;">
          <td colspan="10">Record ID: ${escapeHtml(r.id)} · Recorded: ${r.createdAt ? new Date(r.createdAt).toLocaleString('en-US') : 'unknown'}${group ? ` · Seen on ${group.distinctDates} distinct day(s) in this range: ${group.dates.join(', ')}` : ''}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.qd-detail-row').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return; // don't toggle when clicking a link/button
        const id = tr.dataset.id;
        const dd = tbody.querySelector(`.qd-detail-drilldown[data-drilldown-for="${CSS.escape(id)}"]`);
        if (!dd) return;
        const isOpen = dd.style.display !== 'none';
        tbody.querySelectorAll('.qd-detail-drilldown').forEach(d => d.style.display = 'none');
        dd.style.display = isOpen ? 'none' : 'table-row';
      });
    });

    tbody.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => openEditModal(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
    });
  }

  // ---- Edit flow (Step 1: editable form -> Step 2: confirm -> write) ----

  let editingRecord = null;

  async function refreshEditModelOptions() {
    const modelSelect = $('eModel');
    const date = $('eDate').value;
    const line = $('eLine').value;
    const shift = $('eShift').value;
    modelSelect.innerHTML = '<option value="">Loading models…</option>';
    if (window.qdFirebaseError) { modelSelect.innerHTML = '<option value="">Firebase unavailable</option>'; return; }
    try {
      const { names, error } = await ProductionDataAdapter.getModelListForDayLine(window.qdDb, date, line, shift);
      if (error) { modelSelect.innerHTML = '<option value="">Could not load models</option>'; return; }
      const currentModel = editingRecord ? editingRecord.model : '';
      const options = names.length > 0 ? names : (currentModel ? [currentModel] : []);
      if (options.length === 0) {
        modelSelect.innerHTML = '<option value="">No models planned for this date/line/shift</option>';
        return;
      }
      modelSelect.innerHTML = options.map(m => `<option value="${escapeHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    } catch (e) {
      console.error('Quality Dashboard: failed to load model list for edit:', e);
      modelSelect.innerHTML = '<option value="">Could not load models</option>';
    }
  }

  function openEditModal(id) {
    const rec = allRecords.find(r => r.id === id);
    if (!rec) return;
    editingRecord = rec;
    $('eDate').value = rec.date;
    $('eShift').value = rec.shift;
    $('eLine').value = rec.line;
    $('eDefect').innerHTML = DEFECT_TYPES.map(d => `<option value="${escapeHtml(d)}" ${d === rec.defectType ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('');
    $('eQty').value = rec.scrapQty;
    $('eRemark').value = rec.remark || '';
    refreshEditModelOptions();
    $('editOverlay').classList.add('show');
  }
  function closeEditModal() { $('editOverlay').classList.remove('show'); editingRecord = null; }

  $('eDate').addEventListener('change', refreshEditModelOptions);
  $('eShift').addEventListener('change', refreshEditModelOptions);
  $('eLine').addEventListener('change', refreshEditModelOptions);
  $('editCancel').addEventListener('click', closeEditModal);

  $('editForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingRecord) return;
    const patch = {
      date: $('eDate').value,
      shift: $('eShift').value,
      line: $('eLine').value,
      model: $('eModel').value,
      defectType: $('eDefect').value,
      scrapQty: $('eQty').value,
      remark: $('eRemark').value
    };
    if (!patch.model) { alert('Select a Model before continuing.'); return; }
    showEditConfirm(editingRecord.id, patch);
  });

  function showEditConfirm(id, patch) {
    $('editOverlay').classList.remove('show');
    const kv = (k, v) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`;
    $('editConfirmSummary').innerHTML =
      kv('Date', patch.date) +
      kv('Shift', shiftLabel(patch.shift)) +
      kv('Line', lineLabel(patch.line)) +
      kv('Model', patch.model) +
      kv('Defect', patch.defectType) +
      kv('Scrap Qty', patch.scrapQty) +
      kv('Remark', patch.remark || '–');
    $('editConfirmOverlay').dataset.pendingId = id;
    $('editConfirmOverlay').dataset.pendingPatch = JSON.stringify(patch);
    $('editConfirmOverlay').classList.add('show');
  }
  $('editConfirmCancel').addEventListener('click', () => { $('editConfirmOverlay').classList.remove('show'); });

  $('editConfirmSave').addEventListener('click', async () => {
    const overlay = $('editConfirmOverlay');
    const id = overlay.dataset.pendingId;
    const patch = JSON.parse(overlay.dataset.pendingPatch);
    const btn = $('editConfirmSave');
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      await ScrapDataAdapter.updateScrapEntry(window.qdDb, id, patch);
      overlay.classList.remove('show');
      editingRecord = null;
      await load(); // reload so the table reflects the update
    } catch (e) {
      console.error('Quality Dashboard: updateScrapEntry failed:', e);
      const msgEl = $('editMessage');
      msgEl.className = 'qd-form-message error';
      msgEl.textContent = '⚠ Could not update: ' + (e && e.message ? e.message : String(e));
      msgEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Update';
    }
  });

  // ---- Delete flow (always confirm first) ----

  function openDeleteModal(id) {
    const rec = allRecords.find(r => r.id === id);
    if (!rec) return;
    const kv = (k, v) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`;
    $('deleteSummary').innerHTML =
      kv('Date', rec.date) +
      kv('Shift', shiftLabel(rec.shift)) +
      kv('Line', lineLabel(rec.line)) +
      kv('Model', rec.model) +
      kv('Defect', rec.defectType) +
      kv('Scrap Qty', rec.scrapQty);
    $('deleteOverlay').dataset.pendingId = id;
    $('deleteOverlay').classList.add('show');
  }
  $('deleteCancel').addEventListener('click', () => { $('deleteOverlay').classList.remove('show'); });

  $('deleteConfirm').addEventListener('click', async () => {
    const overlay = $('deleteOverlay');
    const id = overlay.dataset.pendingId;
    const btn = $('deleteConfirm');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await ScrapDataAdapter.deleteScrapEntry(window.qdDb, id);
      overlay.classList.remove('show');
      await load(); // reload so the deleted row disappears
    } catch (e) {
      console.error('Quality Dashboard: deleteScrapEntry failed:', e);
      const msgEl = $('deleteMessage');
      msgEl.className = 'qd-form-message error';
      msgEl.textContent = '⚠ Could not delete: ' + (e && e.message ? e.message : String(e));
      msgEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });

  // ---- Init ---------------------------------------------------------------

  function init() {
    const today = ProductionDataAdapter.toDateStr(new Date());
    const start = ProductionDataAdapter.addDays(today, -29);
    $('fEndDate').value = today;
    $('fStartDate').value = start;

    $('applyFilters').addEventListener('click', load);
    ['fShift', 'fLine', 'fModel', 'fDefect'].forEach(id => $(id).addEventListener('change', renderAll));

    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
