/**
 * scrap-entry-page.js
 * ------------------------------------------------------------------
 * Page 2 — Scrap Entry (V5 layout, Phase A).
 *
 * One scrap record per save: Date + Shift + Line + Model + Qty + Defect
 * (+ optional Remark). Saved through the SAME function as before,
 * ScrapDataAdapter.addScrapEntries(db, [entry]) → addScrapEntry(), so the
 * scrapLogs document shape is unchanged:
 *   { date, shift, line, model, defectType, scrapQty, remark, createdAt }
 *
 * Reads: ProductionDataAdapter.getModelListForDayLine() for the selected
 * date + line + shift only (prodV2_dailyPlans, read-only; one document,
 * cached per date/shift/line). Never writes to prodV2_*.
 *
 * The Import Excel tab is handled entirely by js/scrap-import.js and is
 * not touched here.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);
  const lineLabel = code => (LINES.find(l => l.code === code) || {}).label || code;
  const shiftLabel = code => (SHIFTS.find(s => s.code === code) || {}).label || code;

  let saving = false;                 // double-submit guard
  const modelCache = new Map();       // "date|shift|line" -> { names, error }
  let modelRequestSeq = 0;

  function todayStr() { return ProductionDataAdapter.toDateStr(new Date()); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const getShift = () => (document.querySelector('input[name="ctxShift"]:checked') || {}).value || '';
  const getLine = () => (document.querySelector('input[name="ctxLine"]:checked') || {}).value || '';
  function setLine(code) {
    document.querySelectorAll('input[name="ctxLine"]').forEach(r => { r.checked = r.value === code; });
  }

  // ---- Model options: roster of the selected date + shift + line ----------

  async function loadModels() {
    const sel = $('fModel');
    const date = $('ctxDate').value, shift = getShift(), line = getLine();
    const keep = sel.value;
    if (!line || !date) {
      sel.innerHTML = `<option value="">${!line ? 'Select a line first' : 'Select a date first'}</option>`;
      sel.disabled = true;
      return;
    }
    if (window.qdFirebaseError) {
      sel.innerHTML = '<option value="">Cannot connect to the database</option>';
      sel.disabled = true;
      return;
    }
    const key = `${date}|${shift}|${line}`;
    const seq = ++modelRequestSeq;
    if (!modelCache.has(key)) {
      sel.innerHTML = '<option value="">Loading models…</option>';
      sel.disabled = true;
      const res = await ProductionDataAdapter.getModelListForDayLine(window.qdDb, date, line, shift);
      if (!res.error) modelCache.set(key, res);   // never cache a failed read
      if (seq !== modelRequestSeq) return;        // a newer selection superseded this one
      return renderModelOptions(res, keep, date, shift, line);
    }
    renderModelOptions(modelCache.get(key), keep, date, shift, line);
  }

  function renderModelOptions(res, keep, date, shift, line) {
    const sel = $('fModel');
    const names = res.names || [];
    if (res.error) {
      sel.innerHTML = '<option value="">Could not load the production plan. Please select again.</option>';
      sel.disabled = true;
      return;
    }
    if (names.length === 0) {
      sel.innerHTML = `<option value="">No models planned for ${escapeHtml(lineLabel(line))} · ${escapeHtml(shiftLabel(shift))} · ${escapeHtml(date)}</option>`;
      sel.disabled = true;
      return;
    }
    sel.innerHTML = '<option value="">Select Model</option>' +
      names.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    sel.disabled = false;
    if (keep && names.includes(keep)) sel.value = keep;
  }

  // ---- Validation -------------------------------------------------------

  function setError(field, text) {
    const el = $('err-' + field);
    if (el) el.textContent = text || '';
    const input = { date: 'ctxDate', model: 'fModel', qty: 'fQty', defect: 'fDefect' }[field];
    if (input) $(input).setAttribute('aria-invalid', text ? 'true' : 'false');
    if (field === 'line') $('ctxLineGroup').classList.toggle('invalid', !!text);
  }
  function clearErrors() { ['date', 'line', 'model', 'qty', 'defect'].forEach(f => setError(f, '')); }

  function readEntry() {
    clearErrors();
    const entry = {
      date: $('ctxDate').value, shift: getShift(), line: getLine(),
      model: $('fModel').value, defectType: $('fDefect').value,
      scrapQty: $('fQty').value.trim(), remark: $('fRemark').value.trim()
    };
    let first = null;
    const fail = (f, msg, el) => { setError(f, msg); if (!first) first = el; };
    if (!entry.date) fail('date', 'Select a production date.', $('ctxDate'));
    if (!entry.line) fail('line', 'Select a line.', document.querySelector('input[name="ctxLine"]'));
    if (!entry.model) fail('model', entry.line ? 'Select a model.' : 'Select a line first, then a model.', $('fModel'));
    if (entry.scrapQty === '') fail('qty', 'Enter the scrap quantity.', $('fQty'));
    else if (!/^\d+$/.test(entry.scrapQty) || Number(entry.scrapQty) <= 0) fail('qty', 'Quantity must be a whole number greater than 0.', $('fQty'));
    if (!entry.defectType) fail('defect', 'Select a defect type.', $('fDefect'));
    if (first) { if (!first.disabled) first.focus(); return null; }
    entry.scrapQty = Number(entry.scrapQty);
    return entry;
  }

  // ---- Messages + busy state --------------------------------------------

  function showMessage(kind, text) {
    const el = $('entryMessage');
    el.className = 'se-msg ' + kind;
    el.textContent = text;
    el.hidden = false;
  }
  function hideMessage() { $('entryMessage').hidden = true; }

  function setBusy(busy, which) {
    saving = busy;
    ['saveBtn', 'saveAnotherBtn', 'clearBtn'].forEach(id => { $(id).disabled = busy; });
    $('seForm').setAttribute('aria-busy', busy ? 'true' : 'false');
    $('saveBtn').textContent = busy && which === 'save' ? 'Saving…' : 'Save Scrap';
    $('saveAnotherBtn').textContent = busy && which === 'another' ? 'Saving…' : 'Save & Add Another';
  }

  // ---- Reset helpers ------------------------------------------------------

  function clearItemFields() {
    $('fModel').value = '';
    $('fQty').value = '';
    $('fDefect').value = '';
    $('fRemark').value = '';
    clearErrors();
  }

  // ---- Save (existing adapter, one record) -------------------------------

  async function save(mode) {
    if (saving) return;
    hideMessage();
    if (window.qdFirebaseError) { showMessage('error', '⚠ Cannot connect to the database: ' + window.qdFirebaseError); return; }
    const entry = readEntry();
    if (!entry) { showMessage('error', 'Please complete all required fields (*) before saving.'); return; }

    setBusy(true, mode);
    try {
      const { succeeded, failed } = await ScrapDataAdapter.addScrapEntries(window.qdDb, [entry]);
      if (failed.length === 0 && succeeded.length === 1) {
        const summary = `${lineLabel(entry.line)} · ${shiftLabel(entry.shift)} · ${entry.date} · ${entry.model} · ${entry.defectType} · ${entry.scrapQty} pcs`;
        clearItemFields();
        if (mode === 'save') setLine('');   // finished: Line must be picked again for the next record
        await loadModels();
        showMessage('success', `✓ Saved: ${summary}`);
        if (mode === 'another') $('fModel').focus();
      } else {
        const err = failed[0] && failed[0].error;
        showMessage('error', '⚠ Save failed. Your entries have been kept — please try again.' + (err && err.message ? ` (${err.message})` : ''));
      }
    } catch (e) {
      console.error('Quality Dashboard: scrap entry save failed:', e);
      showMessage('error', '⚠ Save failed. Your entries have been kept — please try again. (' + (e && e.message ? e.message : String(e)) + ')');
    } finally {
      setBusy(false);
    }
  }

  // ---- Mobile sidebar drawer (UI only; same behaviour as the Dashboard) ---

  function wireMobileSidebar() {
    const sidebar = $('dashboardSidebar'), toggle = $('dashboardMobileToggle'), overlay = $('dashboardSidebarOverlay');
    if (!sidebar || !toggle || !overlay) return;
    const set = open => {
      sidebar.classList.toggle('open', open); overlay.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', () => set(!sidebar.classList.contains('open')));
    overlay.addEventListener('click', () => set(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
  }

  // ---- Init -------------------------------------------------------------

  function init() {
    wireMobileSidebar();
    if (window.qdFirebaseError) {
      const b = $('connectionBanner');
      b.className = 'qd-banner error'; b.textContent = '⚠ ' + window.qdFirebaseError; b.style.display = 'flex';
    }
    $('ctxDate').value = todayStr();
    $('fDefect').innerHTML = '<option value="">Select Defect Type</option>' +
      DEFECT_TYPES.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    loadModels();

    // Plan (and its Model roster) is per date + shift + line.
    $('ctxDate').addEventListener('change', () => { setError('date', ''); loadModels(); });
    document.querySelectorAll('input[name="ctxShift"]').forEach(r => r.addEventListener('change', loadModels));
    document.querySelectorAll('input[name="ctxLine"]').forEach(r => r.addEventListener('change', () => { setError('line', ''); loadModels(); }));
    $('fModel').addEventListener('change', () => setError('model', ''));
    $('fDefect').addEventListener('change', () => setError('defect', ''));
    $('fQty').addEventListener('input', () => setError('qty', ''));

    $('seForm').addEventListener('submit', e => { e.preventDefault(); save('save'); });
    $('saveAnotherBtn').addEventListener('click', () => save('another'));
    $('clearBtn').addEventListener('click', () => {
      // Form only — never touches Firestore. Date and Shift are kept.
      if (saving) return;
      clearItemFields(); setLine(''); hideMessage(); loadModels();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
