/**
 * scrap-import.js  —  STAGE 2 (parser + preview; no Model Mapping, no
 * Firestore-backed duplicate detection yet — those are Stage 3 / Stage 4)
 * ------------------------------------------------------------------
 * Lives inside the "Import Excel" tab of Scrap Entry. Only talks to
 * Firestore via ScrapDataAdapter.addScrapEntryBatch() (scrapLogs) —
 * native Firestore batched writes. Never touches productionLogs or any
 * prodV2_* collection; this page only READS a local file the user
 * picks (via SheetJS, entirely client-side — nothing is uploaded
 * anywhere) and WRITES to scrapLogs.
 *
 * Supports TWO real-world file shapes, verified against actual sample
 * workbooks rather than assumed:
 *
 *   RICH  (e.g. Scrap_Door_Line__NEW_7_9_26.xlsx — the authoritative
 *          format going forward): Line, Date, Material, MaterialName,
 *          Quantity, Location, Problem, Cause, Solution, Remark,
 *          Shift (messy free text — NOT used, see below), Price, Amt,
 *          Model, shift2 (clean "Day Shift"/"Night Shift" — used).
 *          Sits on a sheet literally named "Data" — NOT the first
 *          sheet in that workbook (the first sheet is a pivot/summary
 *          named "Dashbord"). Picking SheetNames[0] blindly (the old
 *          behavior) would silently import pivot-table junk instead —
 *          fixed below to prefer a sheet named "Data" when present.
 *
 *   SIMPLE (e.g. for-D.xlsx and anything shaped like the original
 *          Stage-1 template): Line, Date, Model, Qty, Defect, Cause,
 *          shift. No Material/Price/Amt/Solution/Remark columns at
 *          all — every field this file lacks simply comes back
 *          undefined from buildHeaderMap() and is treated as "not
 *          provided", never as an error, so this shape keeps working
 *          exactly as before.
 *
 * Field mapping decisions (confirmed with real data, not assumed):
 *   Date          <- Date column (real Excel date cell, UTC-safe)
 *   Shift         <- shift2 if present, else shift/Shift            (NOT the messy "1 Jun 2026 #N"-style column)
 *   sourceDateText<- the messy Shift-style column's raw text, ONLY when shift2 was what's actually used for `shift` (audit only, never parsed)
 *   Line          <- Line column directly (NOT derived from Location)
 *   sourceLocation<- Location column, informational only
 *   Model         <- Model column if non-blank, else MaterialName, else Material (RAW text — Stage 3 replaces this with real Model Mapping lookup)
 *   sourceMaterial, sourceMaterialName <- Material / MaterialName, kept verbatim (Stage 3's mapping key is the PAIR of these two — verified
 *                                          against the real file that NEITHER field alone is a stable unique key, but the pair has zero conflicts)
 *   Defect        <- Problem/Defect (+ consolidation map, unchanged from before)
 *   Qty           <- Quantity/Qty
 *   remark        <- Remark column ONLY (no longer falls back to Cause — Cause has its own field now)
 *   rootCause     <- Cause column
 *   actionPlan    <- Solution column
 *   scrapCost     <- Amt column, taken AS-IS — never computed as Price × Qty. Blank -> null (never 0), flagged with a visible (non-blocking) warning.
 *   unitPrice     <- Price column, informational only, never used to derive scrapCost
 *   importFingerprint <- stable hash of raw source values (date, shift, line, sourceMaterial, raw defect text, qty, raw cost text) — computed
 *                         now so Stage 4 can use it, but NOT checked against anything yet in this stage.
 *
 * Every row is validated and previewed BEFORE anything is written —
 * only rows marked "READY" are ever sent to Firestore, and only after
 * the user clicks "Import Valid Rows".
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);

  let parsedRows = []; // [{ rowNum, raw, entry, valid, errors: [], warnings: [] }]
  let currentFileName = '';
  let currentSheetName = '';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shiftLabel(code) { return (SHIFTS.find(s => s.code === code) || {}).label || code; }
  function lineLabel(code) { return (LINES.find(l => l.code === code) || {}).label || code; }
  function fmtThb(n) {
    return '฿' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---- Column header matching (case/space-insensitive, with aliases) ----

  const HEADER_ALIASES = {
    date: ['date'],
    // 'shift2' checked FIRST — the rich format has a genuinely messy
    // "Shift" column (e.g. "1 Jun 2026 #N", "02/06/26 #D Lineตู้", even
    // some rows with no #D/#N code at all) that is NOT reliable to
    // parse; "shift2" holds a clean "Day Shift"/"Night Shift" label and
    // wins whenever both exist. The simple format only has one such
    // column, literally named "shift", which IS clean — falls back to
    // it correctly since shift2 won't exist there.
    shift: ['shift2', 'shift'],
    line: ['line'], // deliberately NOT 'location' — Line is already clean in every real file seen; Location is noisier and kept separate (sourceLocation) rather than parsed
    model: ['model'],
    material: ['material'],
    materialname: ['materialname'],
    location: ['location'],
    defect: ['defect', 'defecttype', 'problem'],
    qty: ['qty', 'quantity', 'scrapqty'],
    remark: ['remark', 'remarks', 'note', 'notes'],
    cause: ['cause'],
    solution: ['solution'],
    price: ['price', 'unitprice'],
    amt: ['amt', 'amount', 'cost', 'scrapcost']
  };

  // Some exports use "#N/A" as a broken-lookup placeholder rather than
  // truly leaving the cell blank — treat it the same as empty everywhere.
  function cleanCell(v) {
    const s = String(v ?? '').trim();
    return (s.toUpperCase() === '#N/A') ? '' : s;
  }

  function normalizeHeaderKey(h) {
    // Strip whitespace/underscore/hyphen AND punctuation like periods —
    // real files use headers like "Amt." (with a trailing period) or
    // "Material name" (with a space), and both need to collapse to the
    // same normalized key as a header with none of that noise.
    return String(h || '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');
  }

  function buildHeaderMap(rawRow) {
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
    const m = s.match(/\b([ABC])\b/);
    return m ? m[1] : null;
  }

  function normalizeDateValue(v) {
    // A real Excel date cell arrives here as a JS Date (SheetJS with
    // cellDates:true). Excel date-only cells are anchored to UTC
    // midnight by SheetJS — reading them back with UTC getters is
    // correct in every timezone (verified: local getters lose a day in
    // any timezone west of UTC).
    if (v instanceof Date && !isNaN(v.getTime())) {
      const y = v.getUTCFullYear();
      const mo = String(v.getUTCMonth() + 1).padStart(2, '0');
      const d = String(v.getUTCDate()).padStart(2, '0');
      return `${y}-${mo}-${d}`;
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

  // Cost is taken AS-IS from Excel — never computed. Blank/non-numeric
  // returns null (not 0), matching "do not silently convert blank cost
  // to zero" — the caller shows a warning for a null cost, but this is
  // NOT a validation error (the row can still import).
  function normalizeCostValue(v) {
    const s = cleanCell(v);
    if (!s) return null;
    const n = parseFloat(String(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // Looks up the raw Defect text against the consolidation map (see
  // config.js) — a recognized variant becomes its canonical name;
  // anything not in the map is kept exactly as written.
  function normalizeDefectType(v) {
    const cleaned = cleanCell(v);
    if (!cleaned) return '';
    if (typeof DEFECT_CONSOLIDATION_MAP !== 'undefined' && DEFECT_CONSOLIDATION_MAP[cleaned]) {
      return DEFECT_CONSOLIDATION_MAP[cleaned];
    }
    return cleaned;
  }

  // ---- Fingerprint (dependency-free 32-bit FNV-1a hash) -----------------
  // Not cryptographic — doesn't need to be. Just needs to be stable
  // (same input -> same output every time) so Stage 4 can detect "this
  // exact row was already imported" even if the file is re-uploaded
  // with rows in a different order (sourceRow is deliberately NOT part
  // of the input, per the approved design).

  function fnv1aHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function buildImportFingerprint(fields) {
    // Stable raw source values, NOT sourceRow. Includes sourceMaterial
    // per the approved design (it represents the original Excel
    // record's identity). Uses the RAW defect text (pre-consolidation)
    // and raw cost text so the fingerprint reflects exactly what was in
    // the file, not our own normalization choices.
    const parts = [
      fields.date || '', fields.shift || '', fields.line || '',
      fields.sourceMaterial || '', fields.rawDefectText || '',
      fields.scrapQtyRaw || '', fields.amtRaw || ''
    ];
    return 'fp_' + fnv1aHash(parts.join('|||'));
  }

  // ---- Parse + validate one raw row -----------------------------------

  function parseRow(rawRow, headerMap, rowNum) {
    const get = field => headerMap[field] !== undefined ? rawRow[headerMap[field]] : undefined;
    const errors = [];
    const warnings = [];

    const date = normalizeDateValue(get('date'));
    if (!date) errors.push('Date must be YYYY-MM-DD (or a real Excel date cell)');

    const shift = normalizeShiftValue(get('shift'));
    if (!shift) errors.push('Shift must be DAY/NIGHT (or Day/Night, เช้า/ดึก)');

    const line = normalizeLineValue(get('line'));
    if (!line) errors.push('Line must be A/B/C (or "Door A", "Line A")');

    const sourceMaterial = cleanCell(get('material'));
    const sourceMaterialName = cleanCell(get('materialname'));
    const sourceLocation = cleanCell(get('location'));
    const rawModel = cleanCell(get('model'));

    // Stage 2 model resolution: raw text only (Model, else MaterialName,
    // else Material) — Stage 3 replaces this with a real lookup against
    // scrapModelMappings + the Production V2 model roster.
    const model = rawModel || sourceMaterialName || sourceMaterial;
    if (!model) errors.push('Model/Material is required');

    const rawDefectText = cleanCell(get('defect'));
    const defectType = normalizeDefectType(rawDefectText);
    if (!defectType) errors.push('Defect is required');

    const scrapQtyRaw = get('qty');
    const scrapQty = normalizeQtyValue(scrapQtyRaw);
    if (scrapQty === null) errors.push('Qty must be a positive number');

    const remark = cleanCell(get('remark'));
    const rootCause = cleanCell(get('cause'));
    const actionPlan = cleanCell(get('solution'));

    const amtRaw = get('amt');
    const scrapCost = normalizeCostValue(amtRaw);
    if (scrapCost === null && headerMap.amt !== undefined) {
      // Only warn if there IS a cost column but this particular row's
      // value is blank/unparseable — a file with no cost column at all
      // (the simple format) is not a warning, just "no cost data here".
      warnings.push('No Scrap Cost for this row (left blank, not treated as ฿0)');
    }
    const unitPrice = normalizeCostValue(get('price'));

    // sourceDateText: capture the messy Shift-style column's raw text
    // ONLY when it's a DIFFERENT column than the one actually used for
    // `shift` (i.e. shift2 existed and won) — for audit, never parsed.
    let sourceDateText = '';
    if (headerMap.shift !== undefined) {
      const usedKey = normalizeHeaderKey(headerMap.shift);
      const rawShiftKey = Object.keys(rawRow).find(k => normalizeHeaderKey(k) === 'shift');
      if (rawShiftKey && normalizeHeaderKey(rawShiftKey) !== usedKey) {
        sourceDateText = cleanCell(rawRow[rawShiftKey]);
      } else if (usedKey === 'shift' || usedKey === 'shift2') {
        sourceDateText = cleanCell(get('shift'));
      }
    }

    const importFingerprint = buildImportFingerprint({
      date, shift, line, sourceMaterial, rawDefectText,
      scrapQtyRaw: String(scrapQtyRaw ?? ''), amtRaw: String(amtRaw ?? '')
    });

    const entry = {
      date, shift, line, model, defectType, scrapQty, remark,
      rootCause, actionPlan,
      scrapCost, unitPrice,
      sourceMaterial, sourceMaterialName, sourceLocation, sourceDateText,
      importFingerprint
    };
    return { rowNum, raw: rawRow, entry, valid: errors.length === 0, errors, warnings };
  }

  // ---- File parsing (SheetJS handles both .csv and .xlsx uniformly) -------

  function pickSheetName(workbook) {
    // Prefer a sheet literally named "Data" (case-insensitive) — the
    // authoritative rich format's real data lives there, NOT on the
    // first sheet (which is a pivot/summary named "Dashbord"). Falls
    // back to the first sheet for simple single-sheet files.
    const dataSheet = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'data');
    return dataSheet || workbook.SheetNames[0];
  }

  function readFileAsRows(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const sheetName = pickSheetName(workbook);
          if (!sheetName) { resolve({ rows: [], sheetName: '' }); return; }
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          resolve({ rows, sheetName });
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // ---- Preview rendering ---------------------------------------------

  const PREVIEW_ROW_LIMIT = 200; // rendering thousands of <tr> elements makes the page heavy/laggy — validation still runs on ALL rows, only the on-screen table is capped

  function renderSummaryCards() {
    const validRows = parsedRows.filter(r => r.valid);
    const errorRows = parsedRows.filter(r => !r.valid);
    const totalQty = validRows.reduce((s, r) => s + (r.entry.scrapQty || 0), 0);
    const rowsWithCost = validRows.filter(r => r.entry.scrapCost !== null);
    const totalCost = rowsWithCost.reduce((s, r) => s + r.entry.scrapCost, 0);
    const missingCostCount = validRows.length - rowsWithCost.length;

    $('importSummaryCards').innerHTML = `
      <div class="qd-import-card"><div class="qd-import-card-label">Total Rows</div><div class="qd-import-card-value">${parsedRows.length}</div></div>
      <div class="qd-import-card good"><div class="qd-import-card-label">Ready</div><div class="qd-import-card-value">${validRows.length}</div></div>
      <div class="qd-import-card bad"><div class="qd-import-card-label">Error</div><div class="qd-import-card-value">${errorRows.length}</div></div>
      <div class="qd-import-card neutral"><div class="qd-import-card-label">Model Mapping</div><div class="qd-import-card-value">Stage 3</div></div>
      <div class="qd-import-card neutral"><div class="qd-import-card-label">Duplicate Check</div><div class="qd-import-card-value">Stage 4</div></div>
      <div class="qd-import-card"><div class="qd-import-card-label">Total Scrap Qty</div><div class="qd-import-card-value">${totalQty.toLocaleString('en-US')}</div></div>
      <div class="qd-import-card"><div class="qd-import-card-label">Total Scrap Cost</div><div class="qd-import-card-value">${fmtThb(totalCost)}${missingCostCount > 0 ? `<span class="qd-import-card-note">(${missingCostCount} row${missingCostCount > 1 ? 's' : ''} w/o cost)</span>` : ''}</div></div>
    `;
  }

  function renderPreview() {
    renderSummaryCards();

    const rowsToShow = parsedRows.slice(0, PREVIEW_ROW_LIMIT);
    let html = rowsToShow.map(r => {
      const e = r.entry;
      let statusHtml;
      if (!r.valid) {
        statusHtml = `<span class="status-error" title="${escapeHtml(r.errors.join('; '))}">✕ ${escapeHtml(r.errors[0])}</span>`;
      } else if (r.warnings.length > 0) {
        statusHtml = `<span class="status-warn" title="${escapeHtml(r.warnings.join('; '))}">⚠ ${escapeHtml(r.warnings[0])}</span>`;
      } else {
        statusHtml = '<span class="status-ok">✓ READY</span>';
      }
      return `
      <tr class="${r.valid ? (r.warnings.length ? 'row-warn' : '') : 'row-invalid'}">
        <td>${statusHtml}</td>
        <td>${escapeHtml(e.date || '–')}</td>
        <td>${e.shift ? escapeHtml(shiftLabel(e.shift)) : '–'}</td>
        <td>${e.line ? escapeHtml(lineLabel(e.line)) : '–'}</td>
        <td title="${escapeHtml(e.sourceMaterial)}">${escapeHtml(e.sourceMaterial || '–')}</td>
        <td>${escapeHtml(e.model || '–')}</td>
        <td>${escapeHtml(e.defectType || '–')}</td>
        <td class="num">${e.scrapQty ?? '–'}</td>
        <td class="num">${e.scrapCost !== null ? fmtThb(e.scrapCost) : '<span class="na">N/A</span>'}</td>
        <td>${escapeHtml(e.rootCause) || '–'}</td>
        <td>${escapeHtml(e.actionPlan) || '–'}</td>
      </tr>`;
    }).join('');
    if (parsedRows.length > PREVIEW_ROW_LIMIT) {
      html += `<tr class="empty-row"><td colspan="11">+ ${parsedRows.length - PREVIEW_ROW_LIMIT} more row(s) not shown here — all of them are still validated and will be imported if valid.</td></tr>`;
    }
    $('importPreviewBody').innerHTML = html;

    const validCount = parsedRows.filter(r => r.valid).length;
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

  const BATCH_TIMEOUT_MS = 30000;

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms))
    ]);
  }

  async function doImport() {
    const validRows = parsedRows.filter(r => r.valid);
    if (validRows.length === 0) return;

    const importBatchId = 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const importedAt = Date.now();
    const validEntries = validRows.map(r => ({
      ...r.entry,
      entrySource: 'excel',
      sourceFileName: currentFileName,
      sourceSheet: currentSheetName,
      sourceRow: r.rowNum,
      importBatchId,
      importedAt
    }));

    const btn = $('importConfirmBtn');
    btn.disabled = true;
    const msgEl = $('importMessage');
    msgEl.style.display = 'none';
    msgEl.className = 'qd-form-message';
    msgEl.textContent = '';

    const chunks = chunk(validEntries, 200);
    let succeeded = 0;
    const failures = [];
    const importStartedAt = Date.now();

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const chunkStartedAt = Date.now();
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
      } catch (e) {
        console.error(`Quality Dashboard: import batch ${i + 1}/${chunks.length} failed or timed out:`, e);
        c.forEach(entry => failures.push({ entry, error: e }));
      }
    }

    const totalSec = ((Date.now() - importStartedAt) / 1000).toFixed(1);
    btn.textContent = 'Import Valid Rows';
    btn.disabled = false;

    if (failures.length === 0) {
      msgEl.className = 'qd-form-message success';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''} into scrapLogs in ${totalSec}s (batch ${importBatchId}). Check Scrap Detail to review them.`;
    } else {
      msgEl.className = 'qd-form-message error';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''}, but ${failures.length} failed: ${failures[0].error && failures[0].error.message ? failures[0].error.message : 'unknown error'}`;
    }
    msgEl.style.display = 'block';
  }

  // ---- Template download -----------------------------------------------

  function downloadTemplate() {
    const header = 'Date,Shift,Line,Model,Defect,Qty,Remark,Cause,Solution,Amt,Price,Material,MaterialName';
    const example = '2026-07-15,DAY,A,ModelX,Scratch,5,Optional note,Root cause text,Action taken,4863.52,2431.76,0060878042,MATERIAL NAME HERE';
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
      currentFileName = file.name;
      $('importFileName').textContent = file.name;
      if (typeof XLSX === 'undefined') {
        $('importSummaryCards').innerHTML = '';
        $('importPreviewBody').innerHTML = '<tr class="empty-row"><td colspan="11">File-parsing library failed to load (check internet connection) — cannot read this file.</td></tr>';
        $('importPreviewWrap').style.display = '';
        return;
      }
      try {
        const { rows: rawRows, sheetName } = await readFileAsRows(file);
        currentSheetName = sheetName;
        if (rawRows.length === 0) {
          parsedRows = [];
          $('importPreviewBody').innerHTML = '<tr class="empty-row"><td colspan="11">No rows found in this file.</td></tr>';
          $('importSummaryCards').innerHTML = '';
          $('importPreviewWrap').style.display = '';
          $('importConfirmBtn').disabled = true;
          return;
        }
        const headerMap = buildHeaderMap(rawRows[0]);
        parsedRows = rawRows
          .map((row, i) => ({ row, rowNum: i + 2 }))
          // Skip rows that are entirely blank across every field we care about
          .filter(({ row }) => Object.values(row).some(v => String(v ?? '').trim() !== ''))
          .map(({ row, rowNum }) => parseRow(row, headerMap, rowNum));
        renderPreview();
      } catch (err) {
        console.error('Quality Dashboard: failed to parse import file:', err);
        parsedRows = [];
        $('importPreviewBody').innerHTML = `<tr class="empty-row"><td colspan="11">Could not read this file: ${escapeHtml(err && err.message ? err.message : String(err))}</td></tr>`;
        $('importSummaryCards').innerHTML = '';
        $('importPreviewWrap').style.display = '';
        $('importConfirmBtn').disabled = true;
      }
    });

    $('importConfirmBtn').addEventListener('click', doImport);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
