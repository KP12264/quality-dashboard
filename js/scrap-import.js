/**
 * scrap-import.js
 * ------------------------------------------------------------------
 * Page 2 (Scrap Entry) — bulk import of scrap records from a .csv or
 * .xlsx file, for backlog data recorded elsewhere before this system
 * existed. Only talks to Firestore via ScrapDataAdapter.addScrapEntries()
 * (scrapLogs) — the same, already-tested batch-write function the
 * manual multi-row entry form uses. Never touches productionLogs or
 * any prodV2_* collection; this page only READS a local file the user
 * picks (via SheetJS, entirely client-side — nothing is uploaded
 * anywhere) and WRITES to scrapLogs.
 *
 * Expected columns (case-insensitive, some aliases accepted):
 *   Date    — YYYY-MM-DD, or a real Excel date cell (auto-detected)
 *   Shift   — DAY/NIGHT, Day/Night, or เช้า/ดึก
 *   Line    — A/B/C, or "Door A"/"Line A"
 *   Model   — free text
 *   Defect  — free text
 *   Qty     — positive number
 *   Remark  — optional, free text
 *
 * Every row is validated and previewed BEFORE anything is written —
 * only rows the user can see marked "OK" are ever sent to Firestore,
 * and only after they click "Import Valid Rows".
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);

  let parsedRows = []; // [{ rowNum, raw, entry, valid, errors: [] }]

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shiftLabel(code) { return (SHIFTS.find(s => s.code === code) || {}).label || code; }
  function lineLabel(code) { return (LINES.find(l => l.code === code) || {}).label || code; }

  // ---- Column header matching (case/space-insensitive, with aliases) ----

  const HEADER_ALIASES = {
    date: ['date'],
    shift: ['shift'],
    line: ['line', 'door'],
    model: ['model'],
    defect: ['defect', 'defecttype'],
    qty: ['qty', 'quantity', 'scrapqty'],
    remark: ['remark', 'remarks', 'note', 'notes']
  };

  function normalizeHeaderKey(h) {
    return String(h || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  }

  function buildHeaderMap(rawRow) {
    // rawRow is an object keyed by the file's own header text. Map each
    // expected field to whichever actual key matches one of its aliases.
    const normalizedKeys = {};
    Object.keys(rawRow).forEach(k => { normalizedKeys[normalizeHeaderKey(k)] = k; });
    const map = {};
    for (const field of Object.keys(HEADER_ALIASES)) {
      for (const alias of HEADER_ALIASES[field]) {
        if (normalizedKeys[alias] !== undefined) { map[field] = normalizedKeys[alias]; break; }
      }
    }
    return map;
  }

  // ---- Field normalizers ------------------------------------------------

  function normalizeShiftValue(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (['day', 'd', 'เช้า', 'morning'].includes(s)) return 'DAY';
    if (['night', 'n', 'ดึก'].includes(s)) return 'NIGHT';
    const upper = String(v ?? '').trim().toUpperCase();
    if (upper === 'DAY' || upper === 'NIGHT') return upper;
    return null;
  }

  function normalizeLineValue(v) {
    let s = String(v ?? '').trim().toUpperCase();
    s = s.replace(/^(DOOR|LINE)\s*/, '').trim();
    return ['A', 'B', 'C'].includes(s) ? s : null;
  }

  function normalizeDateValue(v) {
    // A real Excel date cell arrives here as a JS Date (SheetJS with
    // cellDates:true) — trust it directly rather than re-parsing text,
    // since re-parsing a Date's toString() risks locale/format bugs.
    if (v instanceof Date && !isNaN(v.getTime())) {
      return ProductionDataAdapter.toDateStr(v);
    }
    const s = String(v ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Deliberately NOT guessing other formats (e.g. "8/9/2026" is
    // ambiguous between Aug-9 and Sep-8) — safer to reject than silently
    // import a misread date.
    return null;
  }

  function normalizeQtyValue(v) {
    const n = parseFloat(v);
    return (Number.isFinite(n) && n > 0) ? n : null;
  }

  // ---- Parse + validate one raw row -----------------------------------

  function parseRow(rawRow, headerMap, rowNum) {
    const get = field => headerMap[field] !== undefined ? rawRow[headerMap[field]] : undefined;
    const errors = [];

    const date = normalizeDateValue(get('date'));
    if (!date) errors.push('Date must be YYYY-MM-DD (or a real Excel date cell)');

    const shift = normalizeShiftValue(get('shift'));
    if (!shift) errors.push('Shift must be DAY/NIGHT (or Day/Night, เช้า/ดึก)');

    const line = normalizeLineValue(get('line'));
    if (!line) errors.push('Line must be A/B/C (or "Door A", "Line A")');

    const model = String(get('model') ?? '').trim();
    if (!model) errors.push('Model is required');

    const defectType = String(get('defect') ?? '').trim();
    if (!defectType) errors.push('Defect is required');

    const scrapQty = normalizeQtyValue(get('qty'));
    if (scrapQty === null) errors.push('Qty must be a positive number');

    const remark = String(get('remark') ?? '').trim();

    const entry = { date, shift, line, model, defectType, scrapQty, remark };
    return { rowNum, raw: rawRow, entry, valid: errors.length === 0, errors };
  }

  // ---- File parsing (SheetJS handles both .csv and .xlsx uniformly) -------

  function readFileAsRows(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const firstSheetName = workbook.SheetNames[0];
          if (!firstSheetName) { resolve([]); return; }
          const sheet = workbook.Sheets[firstSheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // ---- Preview rendering ---------------------------------------------

  function renderPreview() {
    const validCount = parsedRows.filter(r => r.valid).length;
    const errorCount = parsedRows.length - validCount;

    $('importSummary').innerHTML = `
      <span>Total rows: <b>${parsedRows.length}</b></span>
      <span class="valid-count">Valid: <b>${validCount}</b></span>
      <span class="error-count">Errors: <b>${errorCount}</b></span>`;

    $('importPreviewBody').innerHTML = parsedRows.map(r => `
      <tr class="${r.valid ? '' : 'row-invalid'}">
        <td>${r.rowNum}</td>
        <td>${escapeHtml(r.entry.date || '–')}</td>
        <td>${r.entry.shift ? escapeHtml(shiftLabel(r.entry.shift)) : '–'}</td>
        <td>${r.entry.line ? escapeHtml(lineLabel(r.entry.line)) : '–'}</td>
        <td>${escapeHtml(r.entry.model || '–')}</td>
        <td>${escapeHtml(r.entry.defectType || '–')}</td>
        <td class="num">${r.entry.scrapQty ?? '–'}</td>
        <td>${escapeHtml(r.entry.remark) || '–'}</td>
        <td>${r.valid ? '<span class="status-ok">OK</span>' : `<span class="status-error" title="${escapeHtml(r.errors.join('; '))}">⚠ ${escapeHtml(r.errors[0])}</span>`}</td>
      </tr>`).join('');

    $('importPreviewWrap').style.display = parsedRows.length > 0 ? '' : 'none';
    $('importConfirmBtn').disabled = validCount === 0;
    $('importMessage').style.display = 'none';
  }

  // ---- Import (write only valid rows, in modest-sized chunks) -----------

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function doImport() {
    const validEntries = parsedRows.filter(r => r.valid).map(r => r.entry);
    if (validEntries.length === 0) return;

    const btn = $('importConfirmBtn');
    btn.disabled = true;
    const msgEl = $('importMessage');
    msgEl.style.display = 'none';

    const chunks = chunk(validEntries, 25); // modest concurrency per batch, not a correctness requirement
    let succeeded = 0;
    const failures = [];

    for (const c of chunks) {
      btn.textContent = `Importing… (${succeeded}/${validEntries.length})`;
      try {
        const result = await ScrapDataAdapter.addScrapEntries(window.qdDb, c);
        succeeded += result.succeeded.length;
        failures.push(...result.failed);
      } catch (e) {
        console.error('Quality Dashboard: import chunk failed:', e);
        c.forEach(entry => failures.push({ entry, error: e }));
      }
    }

    btn.textContent = 'Import Valid Rows';
    btn.disabled = false;

    if (failures.length === 0) {
      msgEl.className = 'qd-form-message success';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''} into scrapLogs. Check Scrap Detail to review them.`;
    } else {
      msgEl.className = 'qd-form-message error';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''}, but ${failures.length} failed: ${failures[0].error && failures[0].error.message ? failures[0].error.message : 'unknown error'}`;
    }
    msgEl.style.display = 'block';
  }

  // ---- Template download -----------------------------------------------

  function downloadTemplate() {
    const header = 'Date,Shift,Line,Model,Defect,Qty,Remark';
    const example = '2026-07-15,DAY,A,ModelX,Scratch,5,Optional note';
    const csv = header + '\n' + example + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scrap-import-template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- Init ---------------------------------------------------------------

  function init() {
    $('downloadTemplateBtn').addEventListener('click', downloadTemplate);

    $('importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('importFileName').textContent = file.name;
      if (typeof XLSX === 'undefined') {
        $('importSummary').textContent = '';
        $('importPreviewBody').innerHTML = '<tr class="empty-row"><td colspan="9">File-parsing library failed to load (check internet connection) — cannot read this file.</td></tr>';
        $('importPreviewWrap').style.display = '';
        return;
      }
      try {
        const rawRows = await readFileAsRows(file);
        if (rawRows.length === 0) {
          parsedRows = [];
          $('importPreviewBody').innerHTML = '<tr class="empty-row"><td colspan="9">No rows found in this file.</td></tr>';
          $('importSummary').innerHTML = '';
          $('importPreviewWrap').style.display = '';
          $('importConfirmBtn').disabled = true;
          return;
        }
        const headerMap = buildHeaderMap(rawRows[0]);
        parsedRows = rawRows.map((row, i) => parseRow(row, headerMap, i + 2)); // +2: row 1 is the header
        renderPreview();
      } catch (err) {
        console.error('Quality Dashboard: failed to parse import file:', err);
        parsedRows = [];
        $('importPreviewBody').innerHTML = `<tr class="empty-row"><td colspan="9">Could not read this file: ${escapeHtml(err && err.message ? err.message : String(err))}</td></tr>`;
        $('importSummary').innerHTML = '';
        $('importPreviewWrap').style.display = '';
        $('importConfirmBtn').disabled = true;
      }
    });

    $('importConfirmBtn').addEventListener('click', doImport);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
