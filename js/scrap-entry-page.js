/**
 * scrap-entry-page.js
 * ------------------------------------------------------------------
 * Page 2 — Scrap Entry. Only talks to Firestore via ScrapDataAdapter
 * (scrapLogs) and ProductionDataAdapter.getModelListForDayLine()
 * (read-only, productionLogs). Never writes to productionLogs.
 *
 * UI shape: one row per Model + Defect, with a Door A / B / C qty
 * column each (Auto Total = sum of the three). On save, each row is
 * expanded into up to 3 separate scrapLogs documents (one per line
 * that has a qty > 0) via ScrapDataAdapter.addScrapEntries() — this
 * keeps the existing scrapLogs document shape (one line per doc)
 * unchanged, so Scrap Detail / Dashboard / Improvement all keep
 * working without any schema migration.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  let rows = [];
  let rowIdCounter = 0;

  function todayStr() { return ProductionDataAdapter.toDateStr(new Date()); }

  function newRow() {
    return { id: 'row' + (rowIdCounter++), model: '', defectType: DEFECT_TYPES[0], qtyA: '', qtyB: '', qtyC: '', remark: '' };
  }

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function rowTotal(row) { return num(row.qtyA) + num(row.qtyB) + num(row.qtyC); }

  // ---- Model options (fetched PER LINE, then filtered PER ROW by which Door has qty) ----
  // Sourced from Production V2's Plan (prodV2_dailyPlans), which is
  // per-shift — so the cache key and the adapter call both need shift,
  // not just date, unlike the legacy productionLogs-based version.
  //
  // Each row's Model dropdown shows only the models actually planned
  // for whichever Door(s) currently have a quantity entered in that
  // row — e.g. a row with only Door A filled in shows Line A's models
  // only, not a merged Door A+B+C list. Before any quantity is typed
  // (a fresh row), it falls back to the union of all 3 lines so the
  // dropdown isn't empty while the Leader is still deciding.

  let modelsByLineCache = { date: null, shift: null, byLine: { A: [], B: [], C: [] } };

  async function getModelOptionsByLine(date, shift) {
    if (modelsByLineCache.date === date && modelsByLineCache.shift === shift) return modelsByLineCache.byLine;
    if (window.qdFirebaseError) return { A: [], B: [], C: [] };
    const results = await Promise.all(
      LINES.map(l => ProductionDataAdapter.getModelListForDayLine(window.qdDb, date, l.code, shift))
    );
    const byLine = {};
    LINES.forEach((l, i) => { byLine[l.code] = results[i].names || []; });
    modelsByLineCache = { date, shift, byLine };
    return byLine;
  }

  // Which Door(s) currently have a quantity > 0 in this row.
  function activeLinesForRow(row) {
    return LINES.filter(l => num(row['qty' + l.code]) > 0).map(l => l.code);
  }

  // The model list for a single row: union of the model rosters of
  // whichever line(s) currently have qty entered, or all 3 lines if
  // none do yet.
  function computeRowModelOptions(row, byLine) {
    const active = activeLinesForRow(row);
    const linesToUse = active.length > 0 ? active : LINES.map(l => l.code);
    const merged = new Set();
    linesToUse.forEach(code => (byLine[code] || []).forEach(n => merged.add(n)));
    return { options: Array.from(merged), scopedToLines: active };
  }

  let currentModelsByLine = { A: [], B: [], C: [] };

  // ---- Rendering ------------------------------------------------------

  function buildModelSelectHtml(row) {
    const { options, scopedToLines } = computeRowModelOptions(row, currentModelsByLine);
    // Keep row.model in sync with what's actually shown — same fix as
    // before, just now applied to this row's FILTERED option set rather
    // than one global list, so it still can't drift out of sync when
    // the filter narrows because of a qty change.
    if (options.length > 0 && !options.includes(row.model)) {
      row.model = options[0];
    }
    if (options.length === 0) {
      const scopeLabel = scopedToLines.length > 0
        ? scopedToLines.map(c => 'Door ' + c).join('/')
        : 'this date/shift';
      return { html: `<option value="">No models planned for ${escapeHtml(scopeLabel)}</option>`, options };
    }
    const html = options.map(m => `<option value="${escapeHtml(m)}" ${row.model === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    return { html, options };
  }

  function refreshRowModelSelect(tr, row) {
    const select = tr.querySelector('.row-model');
    const { html } = buildModelSelectHtml(row);
    select.innerHTML = html;
  }

  async function renderTable() {
    const tbody = $('entryTableBody');
    const date = $('ctxDate').value;
    const shift = $('ctxShift').value;
    currentModelsByLine = await getModelOptionsByLine(date, shift);

    tbody.innerHTML = rows.map(row => {
      const { html: modelSelectHtml } = buildModelSelectHtml(row);
      return `
        <tr data-row-id="${row.id}">
          <td data-label="Model"><select class="row-model">${modelSelectHtml}</select></td>
          <td data-label="Defect"><select class="row-defect">${DEFECT_TYPES.map(d => `<option value="${escapeHtml(d)}" ${row.defectType === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select></td>
          <td data-label="Door A"><input type="number" class="row-qtyA" min="0" step="1" value="${row.qtyA}"></td>
          <td data-label="Door B"><input type="number" class="row-qtyB" min="0" step="1" value="${row.qtyB}"></td>
          <td data-label="Door C"><input type="number" class="row-qtyC" min="0" step="1" value="${row.qtyC}"></td>
          <td data-label="Total" class="row-total">${rowTotal(row)}</td>
          <td data-label="Remark"><input type="text" class="row-remark" maxlength="200" placeholder="Optional note" value="${escapeHtml(row.remark)}"></td>
          <td data-label=""><button type="button" class="row-del" title="Remove row" ${rows.length <= 1 ? 'disabled' : ''}>×</button></td>
        </tr>`;
    }).join('');

    // Wire per-row events
    tbody.querySelectorAll('tr').forEach(tr => {
      const rowId = tr.dataset.rowId;
      const row = rows.find(r => r.id === rowId);
      tr.querySelector('.row-model').addEventListener('change', e => { row.model = e.target.value; });
      tr.querySelector('.row-defect').addEventListener('change', e => { row.defectType = e.target.value; });
      tr.querySelector('.row-qtyA').addEventListener('input', e => { row.qtyA = e.target.value; updateTotals(tr, row); refreshRowModelSelect(tr, row); });
      tr.querySelector('.row-qtyB').addEventListener('input', e => { row.qtyB = e.target.value; updateTotals(tr, row); refreshRowModelSelect(tr, row); });
      tr.querySelector('.row-qtyC').addEventListener('input', e => { row.qtyC = e.target.value; updateTotals(tr, row); refreshRowModelSelect(tr, row); });
      tr.querySelector('.row-remark').addEventListener('input', e => { row.remark = e.target.value; });
      const delBtn = tr.querySelector('.row-del');
      if (!delBtn.disabled) {
        delBtn.addEventListener('click', () => {
          rows = rows.filter(r => r.id !== rowId);
          renderTable();
        });
      }
    });

    updateGrandTotal();
  }

  function updateTotals(tr, row) {
    tr.querySelector('.row-total').textContent = rowTotal(row);
    updateGrandTotal();
  }

  function updateGrandTotal() {
    const grand = rows.reduce((s, r) => s + rowTotal(r), 0);
    $('grandTotal').textContent = grand;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- Confirm + Save ---------------------------------------------------

  function buildEntriesFromRows() {
    const date = $('ctxDate').value;
    const shift = $('ctxShift').value;
    const entries = [];
    const problems = [];

    rows.forEach((row, i) => {
      const total = rowTotal(row);
      if (total === 0) return; // skip empty rows silently, they're just unused blank rows
      if (!row.model) { problems.push(`Row ${i + 1}: select a Model before saving.`); return; }
      LINES.forEach(l => {
        const qty = num(row['qty' + l.code]);
        if (qty > 0) {
          entries.push({ date, shift, line: l.code, model: row.model, defectType: row.defectType, scrapQty: qty, remark: row.remark || '' });
        }
      });
    });

    return { entries, problems };
  }

  function showConfirmModal(entries) {
    const lineLabel = code => (LINES.find(l => l.code === code) || {}).label || code;
    const shiftLabel = code => (SHIFTS.find(s => s.code === code) || {}).label || code;
    const rowsHtml = entries.map(e => `
      <tr>
        <td>${escapeHtml(e.model)}</td>
        <td>${escapeHtml(e.defectType)}</td>
        <td>${escapeHtml(lineLabel(e.line))}</td>
        <td style="text-align:right;">${e.scrapQty}</td>
        <td>${escapeHtml(e.remark) || '<span style="color:var(--muted-soft);">–</span>'}</td>
      </tr>`).join('');
    const grand = entries.reduce((s, e) => s + e.scrapQty, 0);
    $('confirmSummary').innerHTML = `
      <div>Date: <b>${escapeHtml(entries[0].date)}</b> · Shift: <b>${escapeHtml(shiftLabel(entries[0].shift))}</b></div>
      <table>
        <thead><tr><th>Model</th><th>Defect</th><th>Line</th><th style="text-align:right;">Qty</th><th>Remark</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div style="margin-top:10px;font-weight:700;">Grand Total: ${grand} pcs across ${entries.length} record${entries.length > 1 ? 's' : ''}</div>`;
    $('confirmOverlay').classList.add('show');
  }
  function hideConfirmModal() { $('confirmOverlay').classList.remove('show'); }

  function showMessage(kind, text) {
    const el = $('entryMessage');
    el.className = 'qd-form-message ' + kind;
    el.textContent = text;
    el.style.display = 'block';
  }

  async function doSave(entries) {
    const saveBtn = $('confirmSave');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const { succeeded, failed } = await ScrapDataAdapter.addScrapEntries(window.qdDb, entries);
      hideConfirmModal();
      if (failed.length === 0) {
        showMessage('success', `Saved ${succeeded.length} scrap record${succeeded.length > 1 ? 's' : ''} to scrapLogs.`);
        rows = [newRow()];
        renderTable();
      } else {
        showMessage('error', `⚠ Saved ${succeeded.length}, but ${failed.length} failed: ${failed[0].error && failed[0].error.message ? failed[0].error.message : 'unknown error'}`);
      }
    } catch (e) {
      console.error('Quality Dashboard: scrap entry save failed:', e);
      hideConfirmModal();
      showMessage('error', '⚠ Could not save: ' + (e && e.message ? e.message : String(e)));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Scrap Log';
    }
  }

  // ---- Event wiring ---------------------------------------------------

  function init() {
    $('ctxDate').value = todayStr();
    $('ctxShift').value = 'DAY';
    rows = [newRow()];
    renderTable();

    $('ctxDate').addEventListener('change', renderTable);
    $('ctxShift').addEventListener('change', renderTable); // Plan (and its Model roster) is per-shift, so shift changes must reload options

    $('addRowBtn').addEventListener('click', () => { rows.push(newRow()); renderTable(); });

    $('reviewBtn').addEventListener('click', () => {
      $('entryMessage').style.display = 'none';
      if (!$('ctxDate').value) { showMessage('error', 'Select a Date first.'); return; }
      const { entries, problems } = buildEntriesFromRows();
      if (problems.length > 0) { showMessage('error', '⚠ ' + problems[0]); return; }
      if (entries.length === 0) { showMessage('error', 'Enter at least one quantity (Door A/B/C) before saving.'); return; }
      showConfirmModal(entries);
    });

    $('confirmCancel').addEventListener('click', hideConfirmModal);
    $('confirmSave').addEventListener('click', () => {
      const { entries } = buildEntriesFromRows();
      doSave(entries);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
