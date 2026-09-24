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
    // some rows with no #D/#N code at all) that is unreliable to parse
    // on its own; "shift2" holds a clean "Day Shift"/"Night Shift" label
    // and wins whenever both exist. The simple format only has one such
    // column, literally named "shift", which IS clean.
    shift: ['shift2', 'shift'],
    line: ['line'], // Line is already clean in every real file seen; Location is a FALLBACK only (see parseRow), not a primary alias
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
    amt: ['amt', 'amount', 'cost', 'scrapcost'],
    recordedby: ['empld', 'emplead', 'employeelead', 'leader', 'pic', 'รหัสพนักงาน'] // "Emp. Ld" and common real-world equivalents seen in the actual file
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

  // ---- #D / #N combined Date+Shift text parser (FALLBACK ONLY) -----------
  // Used only when the clean Date and/or shift2/shift columns are missing
  // or didn't resolve for a row — the clean columns are still preferred
  // whenever they're available and valid, per the verified finding that
  // this free-text field is inconsistent in the real file (mixed date
  // formats, extra trailing text like "Lineตู้", and some rows with no
  // #D/#N code at all). When it DOES parse cleanly, this recovers a
  // usable Date+Shift for files/rows that have no other source.
  const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

  function parseDateShiftText(raw) {
    const s = cleanCell(raw);
    if (!s) return null;
    const shiftMatch = s.match(/#\s*([DN])\b/i);
    const shift = shiftMatch ? (shiftMatch[1].toUpperCase() === 'D' ? 'DAY' : 'NIGHT') : null;

    // "25 Jul 2026" style
    let m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
    if (m) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mon !== undefined) {
        const d = parseInt(m[1], 10), y = parseInt(m[3], 10);
        return { date: `${y}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, shift };
      }
    }
    // "02/06/26" or "03/06/2026" style (DD/MM/YY or DD/MM/YYYY — this
    // file's own convention, day-first; never guessed against US MM/DD)
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, shift };
      }
    }
    return null; // genuinely unparseable (e.g. "03/06/2026 Line ตู้" with no #D/#N, or missing date entirely) — never guessed
  }

  // ---- Location -> Line (FALLBACK ONLY, when the Line column itself is
  // missing or blank for a row) — real Location values include many
  // non-Door-Foaming process stations ("RAC5 SystemAssyA-Line", "RBC9-PU
  // Foam B"...), so this only recognizes the specific "Door Foaming X"
  // pattern and returns null (not a guess) for anything else.
  function lineFromLocation(v) {
    const s = cleanCell(v);
    const m = s.match(/Door\s*Foaming\s*([ABC])\b/i);
    return m ? m[1].toUpperCase() : null;
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

    // Date + Shift: prefer the clean Date column + shift2/shift columns.
    // Only fall back to parsing the combined "25 Jul 2026 #D"-style text
    // (wherever it appears — the messy 'shift' alias slot, if that's what
    // resolved, or a raw 'Shift'-named column if a distinct one exists)
    // when the clean columns didn't produce a usable value for this row.
    let date = normalizeDateValue(get('date'));
    let shift = normalizeShiftValue(get('shift'));
    const rawShiftKey = Object.keys(rawRow).find(k => normalizeHeaderKey(k) === 'shift');
    const rawShiftText = rawShiftKey ? cleanCell(rawRow[rawShiftKey]) : '';
    if (!date || !shift) {
      const fallback = parseDateShiftText(rawShiftText) || parseDateShiftText(get('shift'));
      if (fallback) {
        if (!date && fallback.date) date = fallback.date;
        if (!shift && fallback.shift) shift = fallback.shift;
      }
    }
    if (!date) errors.push('Date must be YYYY-MM-DD, a real Excel date cell, or a parseable "25 Jul 2026 #D"-style value');
    if (!shift) errors.push('Shift must be DAY/NIGHT (or Day/Night, เช้า/ดึก, or a "#D"/"#N" code)');

    // Line: prefer the clean Line column; fall back to parsing Location
    // ("...Door Foaming A...") only when Line itself is missing/blank.
    let line = normalizeLineValue(get('line'));
    if (!line) line = lineFromLocation(get('location'));
    if (!line) errors.push('Line must be A/B/C (or "Door A", "Line A"), or Location must contain "Door Foaming A/B/C"');

    const sourceMaterial = cleanCell(get('material'));
    const sourceMaterialName = cleanCell(get('materialname'));
    const sourceLocation = cleanCell(get('location'));
    const rawModel = cleanCell(get('model'));
    const recordedBy = cleanCell(get('recordedby'));

    // Raw Model/Material text — Production-model MATCHING (not renaming)
    // happens later, once all rows are parsed, against the real Production
    // V2 roster for each row's date+line+shift (see checkProductionMatches).
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

    // sourceDateText: the raw text of whatever column holds the
    // combined "25 Jul 2026 #D"-style value, kept verbatim for
    // traceability regardless of whether it was actually needed to
    // resolve Date/Shift (the clean columns may have already done that).
    const sourceDateText = rawShiftText;

    const importFingerprint = buildImportFingerprint({
      date, shift, line, sourceMaterial, rawDefectText,
      scrapQtyRaw: String(scrapQtyRaw ?? ''), amtRaw: String(amtRaw ?? '')
    });

    const entry = {
      date, shift, line, model, defectType, scrapQty, remark,
      rootCause, actionPlan,
      scrapCost, unitPrice,
      sourceMaterial, sourceMaterialName, sourceLocation, sourceDateText,
      recordedBy,
      importFingerprint
    };
    return { rowNum, raw: rawRow, entry, formatValid: errors.length === 0, errors, warnings, unmapped: false, matchedProductionModel: null, duplicateStatus: null };
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

  // ---- Production model matching (READ-ONLY against prodV2_dailyPlans) ----
  // For every row that's format-valid so far, check whether its resolved
  // `model` text exists in Production V2's REAL planned model roster for
  // that exact date+line+shift (the same read-only function the Scrap
  // Entry Model dropdown already uses — js/data-adapter.js, .get() only,
  // never a write). A row whose model isn't found is marked UNMAPPED and
  // excluded from the importable set, per the "do not automatically
  // import an unmapped model" requirement — this is a real check against
  // live Production data, not a guess.
  async function checkProductionMatches(rows) {
    const comboKeySet = new Set();
    rows.forEach(r => {
      if (r.formatValid) comboKeySet.add(`${r.entry.date}|${r.entry.line}|${r.entry.shift}`);
    });
    const combos = Array.from(comboKeySet).map(k => { const [date, line, shift] = k.split('|'); return { date, line, shift }; });
    console.log(`Quality Dashboard: checking Production V2 model match for ${combos.length} distinct date/line/shift combination(s)...`);

    const results = await Promise.all(combos.map(c =>
      ProductionDataAdapter.getModelListForDayLine(window.qdDb, c.date, c.line, c.shift)
        .then(r => ({ key: `${c.date}|${c.line}|${c.shift}`, names: r.names || [] }))
        .catch(() => ({ key: `${c.date}|${c.line}|${c.shift}`, names: [] }))
    ));
    const modelsByCombo = {};
    results.forEach(r => { modelsByCombo[r.key] = new Set(r.names); });

    rows.forEach(r => {
      if (!r.formatValid) { r.unmapped = false; r.matchedProductionModel = null; return; }
      const key = `${r.entry.date}|${r.entry.line}|${r.entry.shift}`;
      const set = modelsByCombo[key] || new Set();
      if (set.has(r.entry.model)) {
        r.unmapped = false;
        r.matchedProductionModel = r.entry.model;
      } else {
        r.unmapped = true;
        r.matchedProductionModel = null;
      }
    });
  }

  // ---- Duplicate detection (reads EXISTING scrapLogs — the collection
  // this app already owns and writes to; never touches Production) ------
  // Two tiers, per the approved design:
  //   DUPLICATE          — exact importFingerprint match (this exact row
  //                         was already imported, e.g. the same file was
  //                         uploaded twice)
  //   POSSIBLE DUPLICATE — same business key (date+shift+line+model+
  //                         defect+qty+cost) but a different fingerprint
  //                         (e.g. re-entered by hand, or from a different
  //                         file) — shown for review, not silently merged
  // Both are excluded from the importable set by default; nothing is
  // ever auto-overwritten or auto-deleted.
  function buildBusinessKey(r) {
    return [r.date, r.shift, r.line, r.model, r.defectType, r.scrapQty, r.scrapCost === null ? 'null' : r.scrapCost].join('|');
  }

  async function checkDuplicates(rows) {
    const validRows = rows.filter(r => r.formatValid);
    if (validRows.length === 0) return;
    const dates = validRows.map(r => r.entry.date).sort();
    const startDate = dates[0], endDate = dates[dates.length - 1];

    let existing;
    try {
      existing = await ScrapDataAdapter.getScrapData(window.qdDb, { startDate, endDate });
    } catch (e) {
      console.error('Quality Dashboard: duplicate check failed to read scrapLogs — skipping duplicate detection for this preview:', e);
      return;
    }
    if (existing.error) {
      console.error('Quality Dashboard: duplicate check could not read scrapLogs:', existing.error);
      return;
    }

    const fingerprintSet = new Set();
    const businessKeySet = new Set();
    existing.records.forEach(rec => {
      if (rec.importFingerprint) fingerprintSet.add(rec.importFingerprint);
      businessKeySet.add(buildBusinessKey(rec));
    });

    rows.forEach(r => {
      if (!r.formatValid) { r.duplicateStatus = null; return; }
      if (fingerprintSet.has(r.entry.importFingerprint)) {
        r.duplicateStatus = 'DUPLICATE';
      } else if (businessKeySet.has(buildBusinessKey(r.entry))) {
        r.duplicateStatus = 'POSSIBLE_DUPLICATE';
      } else {
        r.duplicateStatus = null;
      }
    });
  }

  // ---- Preview rendering ---------------------------------------------

  const PREVIEW_ROW_LIMIT = 200; // rendering thousands of <tr> elements makes the page heavy/laggy — validation still runs on ALL rows, only the on-screen table is capped

  function renderSummaryCards() {
    const formatValidRows = parsedRows.filter(r => r.formatValid);
    const errorRows = parsedRows.filter(r => !r.formatValid);
    const unmappedRows = formatValidRows.filter(r => r.unmapped);
    const duplicateRows = formatValidRows.filter(r => r.duplicateStatus);
    const readyRows = formatValidRows.filter(r => !r.unmapped && !r.duplicateStatus);

    const totalQty = readyRows.reduce((s, r) => s + (r.entry.scrapQty || 0), 0);
    const rowsWithCost = readyRows.filter(r => r.entry.scrapCost !== null);
    const totalCost = rowsWithCost.reduce((s, r) => s + r.entry.scrapCost, 0);
    const missingCostCount = readyRows.length - rowsWithCost.length;

    $('importSummaryCards').innerHTML = `
      <div class="qd-import-card"><div class="qd-import-card-label">Rows Found</div><div class="qd-import-card-value">${parsedRows.length}</div></div>
      <div class="qd-import-card good"><div class="qd-import-card-label">Ready</div><div class="qd-import-card-value">${readyRows.length}</div></div>
      <div class="qd-import-card warn"><div class="qd-import-card-label">Unmapped</div><div class="qd-import-card-value">${unmappedRows.length}</div></div>
      <div class="qd-import-card warn"><div class="qd-import-card-label">Duplicate</div><div class="qd-import-card-value">${duplicateRows.length}</div></div>
      <div class="qd-import-card bad"><div class="qd-import-card-label">Error</div><div class="qd-import-card-value">${errorRows.length}</div></div>
      <div class="qd-import-card"><div class="qd-import-card-label">Total Scrap Qty</div><div class="qd-import-card-value">${totalQty.toLocaleString('en-US')}</div></div>
      <div class="qd-import-card"><div class="qd-import-card-label">Total Scrap Cost</div><div class="qd-import-card-value">${fmtThb(totalCost)}${missingCostCount > 0 ? `<span class="qd-import-card-note">(${missingCostCount} row${missingCostCount > 1 ? 's' : ''} w/o cost)</span>` : ''}</div></div>
    `;
  }

  function renderPreview() {
    renderSummaryCards();

    const rowsToShow = parsedRows.slice(0, PREVIEW_ROW_LIMIT);
    let html = rowsToShow.map(r => {
      const e = r.entry;
      let statusHtml, rowClass;
      if (!r.formatValid) {
        statusHtml = `<span class="status-error" title="${escapeHtml(r.errors.join('; '))}">✕ ${escapeHtml(r.errors[0])}</span>`;
        rowClass = 'row-invalid';
      } else if (r.duplicateStatus === 'DUPLICATE') {
        statusHtml = '<span class="status-error" title="An identical row (same file content) is already in scrapLogs">✕ DUPLICATE</span>';
        rowClass = 'row-invalid';
      } else if (r.duplicateStatus === 'POSSIBLE_DUPLICATE') {
        statusHtml = '<span class="status-warn" title="A record with the same Date+Shift+Line+Model+Defect+Qty+Cost already exists — review before re-importing">⚠ POSSIBLE DUPLICATE</span>';
        rowClass = 'row-warn';
      } else if (r.unmapped) {
        statusHtml = `<span class="status-warn" title="\u201C${escapeHtml(e.model)}\u201D was not found in Production V2's plan for ${escapeHtml(e.date)} / ${escapeHtml(lineLabel(e.line))} / ${escapeHtml(shiftLabel(e.shift))}">⚠ UNMAPPED MODEL</span>`;
        rowClass = 'row-warn';
      } else if (r.warnings.length > 0) {
        statusHtml = `<span class="status-warn" title="${escapeHtml(r.warnings.join('; '))}">⚠ ${escapeHtml(r.warnings[0])}</span>`;
        rowClass = 'row-warn';
      } else {
        statusHtml = '<span class="status-ok">✓ READY</span>';
        rowClass = '';
      }
      return `
      <tr class="${rowClass}">
        <td>${statusHtml}</td>
        <td>${escapeHtml(e.date || '–')}</td>
        <td>${e.shift ? escapeHtml(shiftLabel(e.shift)) : '–'}</td>
        <td>${e.line ? escapeHtml(lineLabel(e.line)) : '–'}</td>
        <td title="${escapeHtml(e.sourceMaterial)}">${escapeHtml(e.sourceMaterial || e.model || '–')}</td>
        <td>${r.matchedProductionModel ? escapeHtml(r.matchedProductionModel) : '<span class="na">— not matched</span>'}</td>
        <td>${escapeHtml(e.defectType || '–')}</td>
        <td class="num">${e.scrapQty ?? '–'}</td>
        <td class="num">${e.scrapCost !== null ? fmtThb(e.scrapCost) : '<span class="na">N/A</span>'}</td>
      </tr>`;
    }).join('');
    if (parsedRows.length > PREVIEW_ROW_LIMIT) {
      html += `<tr class="empty-row"><td colspan="9">+ ${parsedRows.length - PREVIEW_ROW_LIMIT} more row(s) not shown here — all of them are still validated and will be imported if valid.</td></tr>`;
    }
    $('importPreviewBody').innerHTML = html;

    const importableCount = parsedRows.filter(r => r.formatValid && !r.unmapped && !r.duplicateStatus).length;
    $('importPreviewWrap').style.display = parsedRows.length > 0 ? '' : 'none';
    $('importConfirmBtn').disabled = importableCount === 0;
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
    const importableRows = parsedRows.filter(r => r.formatValid && !r.unmapped && !r.duplicateStatus);
    if (importableRows.length === 0) return;

    const importBatchId = 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const importedAt = Date.now();
    const validEntries = importableRows.map(r => ({
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
        $('importPreviewBody').innerHTML = '<tr class="empty-row"><td colspan="9">File-parsing library failed to load (check internet connection) — cannot read this file.</td></tr>';
        $('importPreviewWrap').style.display = '';
        return;
      }
      try {
        const { rows: rawRows, sheetName } = await readFileAsRows(file);
        currentSheetName = sheetName;
        if (rawRows.length === 0) {
          parsedRows = [];
          $('importPreviewBody').innerHTML = '<tr class="empty-row"><td colspan="9">No rows found in this file.</td></tr>';
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

        // Model matching + duplicate detection both need Firestore reads
        // (Production V2 read-only; scrapLogs read-only at this point) —
        // show a loading state while they run, since a large file means
        // many distinct date/line/shift combinations to check.
        $('importPreviewWrap').style.display = '';
        $('importSummaryCards').innerHTML = '<div class="qd-import-loading">Checking against Production V2 and existing scrapLogs…</div>';
        $('importPreviewBody').innerHTML = '';
        await checkProductionMatches(parsedRows);
        await checkDuplicates(parsedRows);
        renderPreview();
      } catch (err) {
        console.error('Quality Dashboard: failed to parse import file:', err);
        parsedRows = [];
        $('importPreviewBody').innerHTML = `<tr class="empty-row"><td colspan="9">Could not read this file: ${escapeHtml(err && err.message ? err.message : String(err))}</td></tr>`;
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
