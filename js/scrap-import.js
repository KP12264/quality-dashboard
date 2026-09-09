/**
 * scrap-import.js
 * ------------------------------------------------------------------
 * Page 2 (Scrap Entry) — bulk import of scrap records from a .csv or
 * .xlsx file, for backlog data recorded elsewhere before this system
 * existed. Only talks to Firestore via ScrapDataAdapter.addScrapEntryBatch()
 * (scrapLogs) — native Firestore batched writes, one atomic commit per
 * 200 rows, so a multi-thousand-row import takes a dozen or so network
 * round trips instead of hundreds. Never touches productionLogs or any
 * prodV2_* collection; this page only READS a local file the user
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
    shift: ['shift2', 'shift'], // 'shift2' checked FIRST — some real-world exports have a column literally named "Shift" that holds something else entirely (e.g. a date+code string); "shift2" (or similar) holding the real Day/Night label wins if both exist.
    line: ['line', 'door'],
    model: ['model'],
    defect: ['defect', 'defecttype', 'problem'],
    qty: ['qty', 'quantity', 'scrapqty'],
    remark: ['remark', 'remarks', 'note', 'notes'],
    cause: ['cause'] // not written on its own — only used as a Remark fallback when Remark itself is blank (see parseRow)
  };

  // Some exports use "#N/A" as a broken-lookup placeholder rather than
  // truly leaving the cell blank — treat it the same as empty everywhere.
  function cleanCell(v) {
    const s = String(v ?? '').trim();
    return (s.toUpperCase() === '#N/A') ? '' : s;
  }

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
    if (!s) return null;
    if (s.includes('night') || s.includes('ดึก')) return 'NIGHT';
    if (s.includes('day') || s.includes('เช้า') || s.includes('morning')) return 'DAY';
    if (s === 'n') return 'NIGHT';
    if (s === 'd') return 'DAY';
    return null;
  }

  function normalizeLineValue(v) {
    const s = String(v ?? '').trim().toUpperCase();
    if (!s) return null;
    // Real-world Line text varies a lot ("Door C", "Door ตู้ B", "Door C ฝา
    // Project", " Door In Door") — rather than requiring an exact "Door A"
    // shape, look for a standalone A/B/C token anywhere in the string.
    // Thai characters aren't \w, so \b correctly finds a boundary around
    // an English letter even with no space ("ตู้B"). A value with no such
    // standalone letter (e.g. "Door In Door") is genuinely ambiguous and
    // correctly returns null rather than guessing.
    const m = s.match(/\b([ABC])\b/);
    return m ? m[1] : null;
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

    const model = cleanCell(get('model'));
    if (!model) errors.push('Model is required');

    const defectType = cleanCell(get('defect'));
    if (!defectType) errors.push('Defect is required');

    const scrapQty = normalizeQtyValue(get('qty'));
    if (scrapQty === null) errors.push('Qty must be a positive number');

    let remark = cleanCell(get('remark'));
    if (!remark) {
      const cause = cleanCell(get('cause'));
      if (cause) remark = `Cause: ${cause}`;
    }

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

  const PREVIEW_ROW_LIMIT = 200; // rendering thousands of <tr> elements makes the page heavy/laggy — validation still runs on ALL rows, only the on-screen table is capped

  function renderPreview() {
    const validCount = parsedRows.filter(r => r.valid).length;
    const errorCount = parsedRows.length - validCount;

    $('importSummary').innerHTML = `
      <span>Total rows: <b>${parsedRows.length}</b></span>
      <span class="valid-count">Valid: <b>${validCount}</b></span>
      <span class="error-count">Errors: <b>${errorCount}</b></span>`;

    const rowsToShow = parsedRows.slice(0, PREVIEW_ROW_LIMIT);
    let html = rowsToShow.map(r => `
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
    if (parsedRows.length > PREVIEW_ROW_LIMIT) {
      html += `<tr class="empty-row"><td colspan="9">+ ${parsedRows.length - PREVIEW_ROW_LIMIT} more row(s) not shown here — all of them are still validated and will be imported if valid.</td></tr>`;
    }
    $('importPreviewBody').innerHTML = html;

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

  const BATCH_TIMEOUT_MS = 30000; // a stuck Firestore call must not be able to freeze the whole import forever

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms))
    ]);
  }

  async function doImport() {
    const validEntries = parsedRows.filter(r => r.valid).map(r => r.entry);
    if (validEntries.length === 0) return;

    const btn = $('importConfirmBtn');
    btn.disabled = true;
    const msgEl = $('importMessage');
    msgEl.style.display = 'none';
    msgEl.className = 'qd-form-message';
    msgEl.textContent = '';

    const chunks = chunk(validEntries, 200); // one Firestore batch.commit() per chunk — see addScrapEntryBatch
    let succeeded = 0;
    const failures = [];
    const importStartedAt = Date.now();

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const chunkStartedAt = Date.now();
      // Progress reflects what's ACTUALLY completed so far, updated after
      // each chunk finishes — not before it starts (which previously made
      // the counter look stuck at the very first chunk's count).
      btn.textContent = `Importing… (${succeeded}/${validEntries.length}) — batch ${i + 1}/${chunks.length}`;
      msgEl.style.display = 'block';
      msgEl.className = 'qd-form-message';
      msgEl.textContent = `In progress: ${succeeded} of ${validEntries.length} saved so far. Keep this tab open.`;
      try {
        const result = await withTimeout(
          ScrapDataAdapter.addScrapEntryBatch(window.qdDb, c),
          BATCH_TIMEOUT_MS,
          `Batch ${i + 1}/${chunks.length}`
        );
        succeeded += result.succeeded.length;
        failures.push(...result.failed);
        const chunkMs = Date.now() - chunkStartedAt;
        console.log(`Quality Dashboard: import batch ${i + 1}/${chunks.length} done in ${chunkMs}ms (${result.succeeded.length} ok, ${result.failed.length} failed)`);
        if (chunkMs > 15000) {
          console.warn(`Quality Dashboard: batch ${i + 1} took unusually long (${(chunkMs / 1000).toFixed(1)}s) — check the Network tab for slow/stalled Firestore requests.`);
        }
      } catch (e) {
        // Includes a genuine timeout — the batch's actual Firestore commit
        // may or may not still land after this point (a timed-out promise
        // can't be cancelled), so a timed-out batch's true status should
        // be confirmed in Firestore directly rather than assumed failed.
        console.error(`Quality Dashboard: import batch ${i + 1}/${chunks.length} failed or timed out:`, e);
        c.forEach(entry => failures.push({ entry, error: e }));
      }
    }

    const totalSec = ((Date.now() - importStartedAt) / 1000).toFixed(1);
    console.log(`Quality Dashboard: import finished in ${totalSec}s — ${succeeded} succeeded, ${failures.length} failed.`);

    btn.textContent = 'Import Valid Rows';
    btn.disabled = false;

    if (failures.length === 0) {
      msgEl.className = 'qd-form-message success';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''} into scrapLogs in ${totalSec}s. Check Scrap Detail to review them.`;
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
