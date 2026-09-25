/**
 * scrap-import.js
 * ------------------------------------------------------------------
 * Lives inside the "Import Excel" tab of Scrap Entry. Only talks to
 * Firestore via:
 *   - ProductionDataAdapter.getModelListForDayLine() — READ ONLY against
 *     prodV2_dailyPlans, for model matching
 *   - ScrapDataAdapter.getScrapData() — READ ONLY against scrapLogs, for
 *     duplicate detection
 *   - ScrapDataAdapter.addScrapEntryBatch() — WRITES to scrapLogs, and
 *     ONLY when "Import Valid Rows" is explicitly clicked
 * Never touches productionLogs or any prodV2_* collection with a write.
 * Selecting a file, choosing a sheet, detecting columns, and previewing
 * — including Production model matching — perform ZERO Firestore writes.
 *
 * ARCHITECTURE (rewritten after a real failure: an earlier version
 * assumed the sheet named "Data" was always the scrap table and row 1
 * was always the header. Against one real workbook that produced
 * 58,099 "rows" that were actually a Material Master reference list,
 * not scrap transactions — the wrong sheet/range entirely. Never again
 * assume; always let the user choose and always verify before parsing
 * thousands of rows):
 *
 *   1. File chosen -> read the workbook, list EVERY sheet name (with a
 *      row/column count for context) -> user picks one (auto-skipped
 *      only when there's just one sheet, e.g. a .csv).
 *   2. Sheet chosen -> scan the first 40 rows of THAT sheet, score each
 *      one by how many recognizable Scrap-table column headers it
 *      contains (Material, MaterialName, Quantity, Location, Problem,
 *      Cause, Solution, Model, a Date/Shift-ish column...) -> the
 *      highest-scoring row is the detected header row. Shown to the
 *      user as an editable "Excel row #" — never silently trusted.
 *   3. Every row after the detected header is checked against a
 *      candidate-row filter BEFORE it's treated as a scrap record:
 *      blank rows, rows containing "Total"/"Subtotal"/"รวม" anywhere,
 *      and rows with no Defect/Qty/Date-ish value in ANY recognized
 *      column are excluded as "ignored" — never counted as errors,
 *      never sent to Production matching.
 *   4. An "Excel Detection Preview" (sheet, header row, column map,
 *      candidate count, first 10 raw candidate rows) is shown and the
 *      user must click through it explicitly before full per-row
 *      parsing/validation or any Firestore read happens.
 *   5. Only THEN does per-row field parsing (Date/Shift, Line, Model,
 *      Cost, etc. — unchanged from before, this part was already
 *      correct) run, followed by Production model matching and
 *      duplicate detection — now scoped to a small, sane candidate set
 *      instead of tens of thousands of unrelated rows.
 * ------------------------------------------------------------------
 */

(function () {
  const $ = id => document.getElementById(id);

  // ---- State --------------------------------------------------------------
  let currentWorkbook = null;
  let currentFileName = '';
  let currentSheetName = '';
  let currentAOA = [];              // the chosen sheet as an array-of-arrays (raw, 0-indexed)
  let currentHeaderRowIndex = 0;    // 0-based index into currentAOA
  let currentColumnMap = {};        // { field: columnIndex, _rawShiftColIndex?: columnIndex }
  let candidateRows = [];           // [{ rowNum, cells }] — rowNum is the real 1-based Excel row number
  let parsedRows = [];              // [{ rowNum, entry, formatValid, errors, warnings, unmapped, matchedProductionModel, duplicateStatus, availableModelsForDropdown }]

  // ---- Model Mapping state (Requirement: Date+Shift+Line scoped, saved-
  // mapping-first, dropdown fallback, propagates across rows sharing the
  // same Excel identity within one import session) ------------------------
  let modelsByCombo = {};        // "date|line|shift" -> Set(production model strings) — read-only Production V2 data, fetched once per Continue-to-Validation
  let savedModelMappings = {};   // excelModel -> productionModel, loaded from scrapModelMappings (read-only during Preview/Validation)
  let sessionModelChoices = {};  // excelModel -> productionModel, chosen by the user THIS session (not yet saved unless "Remember" is checked)
  let rememberFlags = {};        // excelModel -> boolean, whether to persist that choice to scrapModelMappings on final Confirm Import
  let identitiesNeedingAttention = []; // excelModels that needed a decision at the START of this validation pass — snapshotted once so a resolved group doesn't vanish from "Resolve Mappings" mid-decision (e.g. before the user gets to check "Remember")
  let resolveMappingsFilter = 'all'; // 'all' | 'suggested' | 'unresolved' | 'resolved'
  let resolveMappingsSearch = '';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shiftLabel(code) { return (SHIFTS.find(s => s.code === code) || {}).label || code; }
  function lineLabel(code) { return (LINES.find(l => l.code === code) || {}).label || code; }
  function fmtThb(n) {
    return '฿' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // DISPLAY ONLY — converts the internally-stored "YYYY-MM-DD" date to
  // "DD/MM/YYYY" for the UI. The stored/internal value (entry.date,
  // Firestore documents, fingerprint, duplicate-key matching, Production
  // matching) always stays "YYYY-MM-DD" — this is never used for anything
  // except what's shown on screen. Anything that isn't a clean
  // YYYY-MM-DD string (e.g. "(unparsed)") passes through unchanged.
  function formatDateDisplay(isoDateStr) {
    const m = String(isoDateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(isoDateStr || '');
  }

  // ---- Column header matching (case/space/punctuation-insensitive, with aliases) ----

  const HEADER_ALIASES = {
    date: ['date'],
    shift: ['shift2', 'shift'], // 'shift2' (clean "Day Shift"/"Night Shift") preferred; the messy combined-text column falls back via parseDateShiftText, see parseRow
    line: ['line'],
    model: ['model'],
    material: ['material'],
    materialname: ['materialname'],
    location: ['location'],
    defect: ['defect', 'defecttype', 'problem'],
    qty: ['qty', 'quantity', 'scrapqty'],
    remark: ['remark', 'remarks', 'note', 'notes'],
    cause: ['cause'],
    solution: ['solution'],
    price: ['price', 'unitprice', 'ราคา', 'ราคาต่อหน่วย'],
    amt: ['amt', 'amount', 'cost', 'scrapcost', 'จำนวนเงิน', 'ยอดเงิน', 'รวมเงิน', 'มูลค่า'],
    recordedby: ['empld', 'emplead', 'employeelead', 'leader', 'pic', 'รหัสพนักงาน']
  };

  const FIELD_LABELS = {
    date: 'Date', shift: 'Date + Shift', line: 'Line', model: 'Model',
    material: 'Material', materialname: 'Material Name', location: 'Location (Line fallback)',
    defect: 'Defect', qty: 'Scrap Qty', remark: 'Remark', cause: 'Cause',
    solution: 'Initial Action', price: 'Unit Price (info only)', amt: 'Scrap Cost',
    recordedby: 'Recorded By'
  };

  const HEADER_ALIASES_FLAT = {};
  Object.keys(HEADER_ALIASES).forEach(field => {
    HEADER_ALIASES[field].forEach(alias => {
      if (!(alias in HEADER_ALIASES_FLAT)) HEADER_ALIASES_FLAT[alias] = field;
    });
  });

  // Some exports use "#N/A" as a broken-lookup placeholder rather than
  // truly leaving the cell blank — treat it the same as empty everywhere.
  function cleanCell(v) {
    const s = String(v ?? '').trim();
    return (s.toUpperCase() === '#N/A') ? '' : s;
  }

  function normalizeHeaderKey(h) {
    return String(h || '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');
  }

  function buildColumnMap(headerRowArray) {
    const normalizedCols = (headerRowArray || []).map(c => normalizeHeaderKey(c));
    const map = {};
    for (const field of Object.keys(HEADER_ALIASES)) {
      for (const alias of HEADER_ALIASES[field]) {
        const idx = normalizedCols.indexOf(alias);
        if (idx !== -1) { map[field] = idx; break; }
      }
    }
    const rawShiftIdx = normalizedCols.indexOf('shift');
    if (rawShiftIdx !== -1) map._rawShiftColIndex = rawShiftIdx;
    return map;
  }

  // ---- Header-row auto-detection -----------------------------------------

  const HEADER_SCAN_LIMIT = 40; // how many leading rows to consider as a possible header
  const MIN_HEADER_SCORE = 3;   // need at least this many recognized columns to trust a row as the header

  function scoreRowAsHeader(rowArray) {
    const matched = new Set();
    (rowArray || []).forEach(cell => {
      const key = normalizeHeaderKey(cell);
      if (key && HEADER_ALIASES_FLAT[key]) matched.add(HEADER_ALIASES_FLAT[key]);
    });
    return matched.size;
  }

  function detectHeaderRow(aoa) {
    let best = { rowIndex: 0, score: 0 };
    for (let i = 0; i < Math.min(aoa.length, HEADER_SCAN_LIMIT); i++) {
      const score = scoreRowAsHeader(aoa[i]);
      if (score > best.score) best = { rowIndex: i, score };
    }
    return best;
  }

  // ---- Candidate-row filtering (BEFORE any per-row parsing) --------------

  const JUNK_KEYWORDS = ['total', 'subtotal', 'grand total', 'รวม', 'รวมทั้งหมด', 'summary', 'สรุป'];

  function isBlankRow(rowArray) {
    return !(rowArray || []).some(c => String(c ?? '').trim() !== '');
  }
  function isJunkRow(rowArray) {
    return (rowArray || []).some(cell => {
      const s = String(cell ?? '').trim().toLowerCase();
      return s && JUNK_KEYWORDS.some(kw => s === kw || s.startsWith(kw));
    });
  }
  function isCandidateScrapRow(rowArray, columnMap) {
    if (isBlankRow(rowArray)) return false;
    if (isJunkRow(rowArray)) return false;
    const get = field => columnMap[field] !== undefined ? rowArray[columnMap[field]] : undefined;
    const hasDefect = cleanCell(get('defect')) !== '';
    const qtyVal = get('qty');
    const hasQty = String(qtyVal ?? '').trim() !== '' && Number.isFinite(parseFloat(qtyVal));
    // Date/Shift signal: the authoritative #D/#N column when one was
    // detected for this sheet, otherwise the clean Date column.
    let hasDateSignal;
    if (columnMap._dateShiftColIndex !== undefined) {
      hasDateSignal = looksLikeDateShiftPattern(rowArray[columnMap._dateShiftColIndex]);
    } else {
      const dateVal = get('date');
      hasDateSignal = (dateVal instanceof Date && !isNaN(dateVal.getTime())) || /^\d{4}-\d{2}-\d{2}$/.test(String(dateVal ?? '').trim());
    }
    return hasDefect || hasQty || hasDateSignal;
  }

  // ---- Date+Shift combined-text column detection (content-based) --------
  // Both supported workbook layouts carry a row-level field like
  // "23 Sep 2026 #N" / "24 Sep 2026 #D" — but it can sit in a different
  // column (and under a different header) in each layout, so it's found
  // by CONTENT, not by a fixed column letter or even header name alone:
  // sample real data-row values in every column and pick whichever one
  // has the highest hit-rate against the DD-MMM-YYYY-#D/#N pattern. When
  // found, this column is the AUTHORITATIVE Date+Shift source for every
  // row in the table — never overridden by a separate Date/shift2 column,
  // per the explicit requirement. A layout without such a field at all
  // (the plain simple format) simply won't have any column clear this
  // threshold, and falls back to whatever clean Date/Shift columns it has.
  const DATE_SHIFT_COL_SAMPLE_SIZE = 50;
  const DATE_SHIFT_COL_MIN_MATCH_RATIO = 0.5;

  function looksLikeDateShiftPattern(v) {
    const parsed = parseDateShiftText(v);
    return !!(parsed && parsed.date && parsed.shift);
  }

  function detectDateShiftColumn(aoa, headerRowIndex) {
    const colCount = (aoa[headerRowIndex] || []).length;
    if (colCount === 0) return -1;
    const sampleRows = aoa.slice(headerRowIndex + 1, headerRowIndex + 1 + DATE_SHIFT_COL_SAMPLE_SIZE * 3); // scan a bit further in case of leading blank rows
    let bestCol = -1, bestRatio = 0;
    for (let c = 0; c < colCount; c++) {
      let nonBlank = 0, matches = 0, sampled = 0;
      for (let i = 0; i < sampleRows.length && sampled < DATE_SHIFT_COL_SAMPLE_SIZE; i++) {
        const v = sampleRows[i][c];
        const s = String(v ?? '').trim();
        if (!s) continue;
        sampled++;
        nonBlank++;
        if (looksLikeDateShiftPattern(v)) matches++;
      }
      const ratio = nonBlank > 0 ? matches / nonBlank : 0;
      if (ratio > bestRatio) { bestRatio = ratio; bestCol = c; }
    }
    return bestRatio >= DATE_SHIFT_COL_MIN_MATCH_RATIO ? bestCol : -1;
  }

  // ---- Amount/Price column detection by FORMULA STRUCTURE (fallback,
  // used only when header-based detection finds nothing) -----------------
  // Some real workbooks have NO header text at all for the Amount/Price
  // columns (confirmed: a real file has blank header cells above columns
  // holding "=VLOOKUP(H2,ราคา!A:L,12,0)" for Price and "=U2*J2" for
  // Amount) — header-alias matching can never find these. This looks for
  // a column whose FORMULAS are consistently "<cell> * <cell>" where one
  // operand is the already-known Qty column — that structural shape is a
  // strong, narrow signal for "this is the pre-calculated Amount", found
  // by inspecting the formula TEXT only. The value actually used as
  // scrapCost always comes from that column's own cached result (.v) —
  // this function never multiplies anything itself.
  const MULTIPLY_FORMULA_RE = /^([A-Za-z]+)(\d+)\s*\*\s*([A-Za-z]+)(\d+)$/;
  const AMOUNT_FORMULA_SAMPLE_LIMIT = 30;
  const AMOUNT_FORMULA_MIN_CONFIRM = 3;

  function detectAmountColumnByFormula(sheet, aoa, headerRowIndex, qtyCol) {
    if (qtyCol === undefined || !sheet) return { amtCol: -1, priceCol: -1 };
    const numCols = (aoa[headerRowIndex] || []).length;
    let bestAmtCol = -1, bestPriceCol = -1, bestScore = 0;

    for (let c = 0; c < numCols; c++) {
      if (c === qtyCol) continue;
      const otherColCounts = {};
      let sampled = 0;
      for (let r = headerRowIndex + 1; r < aoa.length && sampled < AMOUNT_FORMULA_SAMPLE_LIMIT; r++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (!cell || cell.f === undefined) continue;
        sampled++;
        const m = String(cell.f).trim().match(MULTIPLY_FORMULA_RE);
        if (!m) continue;
        const col1 = XLSX.utils.decode_col(m[1]);
        const col2 = XLSX.utils.decode_col(m[3]);
        let otherCol = null;
        if (col1 === qtyCol) otherCol = col2;
        else if (col2 === qtyCol) otherCol = col1;
        if (otherCol !== null) otherColCounts[otherCol] = (otherColCounts[otherCol] || 0) + 1;
      }
      let topOther = -1, topCount = 0;
      Object.keys(otherColCounts).forEach(k => {
        if (otherColCounts[k] > topCount) { topCount = otherColCounts[k]; topOther = parseInt(k, 10); }
      });
      if (topCount > bestScore) { bestScore = topCount; bestAmtCol = c; bestPriceCol = topOther; }
    }
    return bestScore >= AMOUNT_FORMULA_MIN_CONFIRM ? { amtCol: bestAmtCol, priceCol: bestPriceCol } : { amtCol: -1, priceCol: -1 };
  }

  // ---- Aggregate/Total row detection (positive-evidence only) -----------
  // A Total/Subtotal/Grand-Total row is never assumed just because Date/
  // Shift/Line/Defect are blank — a genuinely malformed Scrap row looks
  // the same way and must still surface as an Error (never silently
  // dropped). The ONLY thing this checks for is a SUM() formula spanning
  // a MULTIPLE-row range in the Qty or Amount cell — real scrap rows are
  // typed by hand (plain numbers or a per-row Price×Qty formula, never a
  // range-sum), so this is a reliable, narrow, positive signal, not a
  // guess. Confirmed against a real workbook: the actual offending row
  // has Qty cell formula "SUM(J2:J67)" and Amount cell formula
  // "SUM(V2:V67)", with every other column blank.
  function isSumRangeFormula(formulaText) {
    if (!formulaText) return false;
    const m = String(formulaText).trim().match(/^SUM\(([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)\)$/i);
    if (!m) return false;
    return parseInt(m[4], 10) > parseInt(m[2], 10); // spans more than one row -> an aggregate, not a single-cell calc
  }

  function isAggregateFormulaRow(sheet, rowIndex, columnMap) {
    if (!sheet) return false;
    const checkCols = [columnMap.qty, columnMap.amt].filter(c => c !== undefined);
    return checkCols.some(c => {
      const addr = XLSX.utils.encode_cell({ r: rowIndex, c });
      const cell = sheet[addr];
      return cell && isSumRangeFormula(cell.f);
    });
  }

  // ---- Field normalizers (unchanged logic — only the `get` accessor that
  // feeds them, below in parseRow, changed from object-keyed to
  // column-index-keyed) --------------------------------------------------

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
    if (v instanceof Date && !isNaN(v.getTime())) {
      const y = v.getUTCFullYear();
      const mo = String(v.getUTCMonth() + 1).padStart(2, '0');
      const d = String(v.getUTCDate()).padStart(2, '0');
      return `${y}-${mo}-${d}`;
    }
    const s = String(v ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  function normalizeQtyValue(v) {
    const n = parseFloat(v);
    return (Number.isFinite(n) && n > 0) ? n : null;
  }

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseDateShiftText(raw) {
    const s = cleanCell(raw);
    if (!s) return null;
    const shiftMatch = s.match(/#\s*([DN])\b/i);
    const shift = shiftMatch ? (shiftMatch[1].toUpperCase() === 'D' ? 'DAY' : 'NIGHT') : null;

    let m = s.match(/(\d{1,2})\s*([A-Za-z]{3,})\s+(\d{4})/);
    if (m) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mon !== undefined) {
        const d = parseInt(m[1], 10), y = parseInt(m[3], 10);
        return { date: `${y}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, shift };
      }
    }
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, shift };
      }
    }
    return null;
  }

  function lineFromLocation(v) {
    const s = cleanCell(v);
    const m = s.match(/Door\s*Foaming\s*([ABC])\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  function normalizeCostValue(v) {
    const s = cleanCell(v);
    if (!s) return null;
    const n = parseFloat(String(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function normalizeDefectType(v) {
    const cleaned = cleanCell(v);
    if (!cleaned) return '';
    if (typeof DEFECT_CONSOLIDATION_MAP !== 'undefined' && DEFECT_CONSOLIDATION_MAP[cleaned]) {
      return DEFECT_CONSOLIDATION_MAP[cleaned];
    }
    return cleaned;
  }

  function fnv1aHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function buildImportFingerprint(fields) {
    const parts = [
      fields.date || '', fields.shift || '', fields.line || '',
      fields.sourceMaterial || '', fields.rawDefectText || '',
      fields.scrapQtyRaw || '', fields.amtRaw || ''
    ];
    return 'fp_' + fnv1aHash(parts.join('|||'));
  }

  // ---- Parse + validate ONE candidate row (array-based) -------------------

  function parseRow(rowArray, columnMap, rowNum) {
    const get = field => columnMap[field] !== undefined ? rowArray[columnMap[field]] : undefined;
    const errors = [];
    const warnings = [];

    // Date + Shift: when a #D/#N combined-text column was detected for
    // this sheet (by content, see detectDateShiftColumn), it is the
    // AUTHORITATIVE source — never overridden by a separate Date/shift2
    // column, per the explicit requirement. No timezone/Date-object
    // handling is applied to it at all: it's parsed as plain text into a
    // calendar date, and the date portion is used exactly as printed
    // (Night Shift rows are NOT shifted to the next/previous day).
    // Only when NO such column exists for this sheet (the plain simple
    // format) do the clean Date/shift columns become the source.
    let date, shift, sourceDateText;
    if (columnMap._dateShiftColIndex !== undefined) {
      const rawText = cleanCell(rowArray[columnMap._dateShiftColIndex]);
      const parsed = parseDateShiftText(rawText);
      date = parsed ? parsed.date : null;
      shift = parsed ? parsed.shift : null;
      sourceDateText = rawText;
      if (!date || !shift) errors.push('Missing/Invalid Date-Shift');
    } else {
      date = normalizeDateValue(get('date'));
      shift = normalizeShiftValue(get('shift'));
      sourceDateText = columnMap._rawShiftColIndex !== undefined ? cleanCell(rowArray[columnMap._rawShiftColIndex]) : '';
      if (!date) errors.push('Date must be YYYY-MM-DD or a real Excel date cell');
      if (!shift) errors.push('Shift must be DAY/NIGHT (or Day/Night, เช้า/ดึก)');
    }

    let line = normalizeLineValue(get('line'));
    if (!line) line = lineFromLocation(get('location'));
    if (!line) errors.push('Line must be A/B/C (or "Door A", "Line A"), or Location must contain "Door Foaming A/B/C"');

    const sourceMaterial = cleanCell(get('material'));
    const sourceMaterialName = cleanCell(get('materialname'));
    const sourceLocation = cleanCell(get('location'));
    const rawModel = cleanCell(get('model'));
    const recordedBy = cleanCell(get('recordedby'));

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
    if (scrapCost === null && columnMap.amt !== undefined) {
      warnings.push('No Scrap Cost for this row (left blank, not treated as ฿0)');
    }
    const unitPrice = normalizeCostValue(get('price'));

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
    return { rowNum, entry, formatValid: errors.length === 0, errors, warnings, unmapped: false, matchedProductionModel: null, duplicateStatus: null };
  }

  // ---- Production model matching (READ-ONLY against prodV2_dailyPlans) ----

  // ---- Production model roster fetch (READ-ONLY against prodV2_dailyPlans)
  // Fetches the available model list for every distinct date+line+shift
  // combination among the format-valid rows, ONCE, and caches it in
  // modelsByCombo for the whole Validation session (dropdown population +
  // re-resolution after a manual pick both reuse this — no re-fetching).
  async function fetchProductionRosters(rows) {
    const comboKeySet = new Set();
    rows.forEach(r => {
      if (r.formatValid) comboKeySet.add(`${r.entry.date}|${r.entry.line}|${r.entry.shift}`);
    });
    const combos = Array.from(comboKeySet).map(k => { const [date, line, shift] = k.split('|'); return { date, line, shift }; });
    console.log(`Quality Dashboard: fetching Production V2 model rosters for ${combos.length} distinct date/line/shift combination(s) across ${rows.filter(r=>r.formatValid).length} candidate rows...`);

    const results = await Promise.all(combos.map(c =>
      ProductionDataAdapter.getModelListForDayLine(window.qdDb, c.date, c.line, c.shift)
        .then(r => ({ key: `${c.date}|${c.line}|${c.shift}`, names: r.names || [] }))
        .catch(() => ({ key: `${c.date}|${c.line}|${c.shift}`, names: [] }))
    ));
    modelsByCombo = {};
    results.forEach(r => { modelsByCombo[r.key] = new Set(r.names); });
  }

  // ---- Model Mapping resolution ------------------------------------------
  // For ONE row: try this session's own choice first (propagates a pick
  // made on one row to every other row sharing the same Excel identity),
  // then the persistently saved mapping — but EITHER way, the resolved
  // Production Model must actually be in THIS row's own date+line+shift
  // roster before it counts as matched (requirement 7: verify before
  // marking READY — a mapping that worked for one row's date doesn't
  // automatically apply to a different date where that model wasn't run).
  // Strict text normalization for comparing an Excel model identity
  // against a Production V2 model string — lowercase, strip whitespace
  // and common punctuation. Used ONLY for an EXACT match after
  // normalization, never a fuzzy/similarity score — "never guess when
  // ambiguous" means this tier either finds exactly one clean match or
  // it finds nothing; it never picks a "closest" one.
  function normalizeModelText(s) {
    return String(s || '').toLowerCase().replace(/[\s_\-./()]+/g, '');
  }

  // ---- Family-based suggestions (a NARROWING aid only — never bypasses
  // the Date+Shift+Line valid-roster check, and never picks a "closest"
  // match; it only auto-resolves when family-filtering leaves exactly
  // one candidate from the roster, exactly like the exact-match/singleton
  // tiers above it). Normalization strips spacing/punctuation the same
  // way as normalizeModelText, so a clue like "FUF18/22" and text like
  // "FRZ FOAM DR ASSY-/FUF18/22_S" compare on equal footing.
  const MODEL_FAMILY_CLUES_RAW = [
    '159', '199', 'FUF14', 'FUF18/22', 'TM14', 'TM19/21', '520', '620/550',
    '636', 'BM28', 'BM23/29', 'G3 320', 'G3 350', 'CAFE', 'T-DOOR'
  ];
  function normalizeFamilyText(s) {
    return String(s || '').toUpperCase().replace(/É/g, 'E').replace(/[\s_\-./()]+/g, '');
  }
  const MODEL_FAMILY_CLUES = MODEL_FAMILY_CLUES_RAW.map(c => ({ raw: c, norm: normalizeFamilyText(c) }));

  function detectFamilies(text) {
    const norm = normalizeFamilyText(text);
    if (!norm) return [];
    return MODEL_FAMILY_CLUES.filter(c => norm.includes(c.norm)).map(c => c.raw);
  }

  function sharesFamily(familiesA, familiesB) {
    return familiesA.some(f => familiesB.includes(f));
  }

  // ---- Door-type narrowing (a FURTHER narrowing step, only applied
  // within an already-ambiguous family-filtered candidate set — never a
  // standalone signal, never applied to the whole roster). Two strict,
  // literal, non-fuzzy rules:
  //   - the EXCEL text's own PREFIX (not any letter appearing anywhere
  //     else in it) must literally start with "REF FOAM DR ASSY" (-> R)
  //     or "FRZ FOAM DR ASSY" (-> F). This is why "HR-SD159F_HPS" is
  //     safe — the "F" inside that model number is never scanned; only
  //     the dedicated prefix at the very start of the string is.
  //   - a candidate Production Model only counts as matching a door type
  //     if it has an EXPLICIT trailing "(F)" or "(R)" marker — a model
  //     name that merely contains the letter F/R somewhere (e.g. from a
  //     suffix like SS/WW/BB/BG/HPS/HPMS) is never treated as a match.
  function detectDoorType(excelModelText) {
    const s = String(excelModelText || '').trim().toUpperCase();
    if (s.startsWith('REF FOAM DR ASSY')) return 'R';
    if (s.startsWith('FRZ FOAM DR ASSY')) return 'F';
    return null;
  }
  function detectExplicitDoorTypeMarker(productionModelText) {
    const m = String(productionModelText || '').trim().match(/\(([FR])\)\s*$/i);
    return m ? m[1].toUpperCase() : null;
  }

  /**
   * resolveRowMapping(r)
   * Auto-mapping tiers, in order — the row is auto-mapped by the FIRST
   * tier that produces exactly one confident answer; if none do, it's
   * left for manual resolution (never guessed):
   *   1. saved/session mapping for this Excel identity, if it's valid
   *      for THIS row's own date+line+shift roster
   *   2. exactly one available model whose normalized text matches the
   *      Excel identity's normalized text (a real, reliable match —
   *      not similarity/fuzzy matching)
   *   3. exactly one model available at all for this combo (nothing to
   *      choose between — it can only be that one)
   *   4. otherwise: NEEDS MAPPING (multiple plausible candidates, or
   *      zero — either way, not something to guess)
   * Also tracks r.hadInvalidSavedMapping — a saved mapping existed for
   * this identity but didn't hold for this specific combo, so the
   * summary can surface that distinctly from "never mapped at all".
   */
  function resolveRowMapping(r) {
    if (!r.formatValid) {
      r.unmapped = false; r.matchedProductionModel = null; r.availableModelsForDropdown = [];
      r.mappingTier = null; r.hadInvalidSavedMapping = false; r.detectedFamilies = []; r.suggestedModels = [];
      return;
    }
    const comboKey = `${r.entry.date}|${r.entry.line}|${r.entry.shift}`;
    const available = modelsByCombo[comboKey] || new Set();
    const excelModel = r.entry.model;

    const savedCandidate = sessionModelChoices[excelModel] || savedModelMappings[excelModel];
    r.hadInvalidSavedMapping = !!savedCandidate && !available.has(savedCandidate);

    if (savedCandidate && available.has(savedCandidate)) {
      r.unmapped = false; r.matchedProductionModel = savedCandidate;
      r.mappingTier = sessionModelChoices[excelModel] ? 'session' : 'saved';
      r.availableModelsForDropdown = []; r.detectedFamilies = []; r.suggestedModels = [];
      return;
    }

    // Tier 2: exactly one available model normalizes identically to the
    // Excel identity text.
    const normExcel = normalizeModelText(excelModel);
    const normMatches = Array.from(available).filter(m => normalizeModelText(m) === normExcel);
    if (normMatches.length === 1) {
      r.unmapped = false; r.matchedProductionModel = normMatches[0]; r.mappingTier = 'exact-match';
      r.availableModelsForDropdown = []; r.detectedFamilies = []; r.suggestedModels = [];
      return;
    }

    // Tier 3: only one model exists for this combo at all — no real
    // choice to make.
    if (available.size === 1) {
      r.unmapped = false; r.matchedProductionModel = Array.from(available)[0]; r.mappingTier = 'singleton';
      r.availableModelsForDropdown = []; r.detectedFamilies = []; r.suggestedModels = [];
      return;
    }

    // Tier 4: family-based narrowing — a NARROWING aid on top of the
    // valid roster, never a replacement for it. Only auto-maps when
    // narrowing by shared family leaves exactly one candidate; with 2+
    // it becomes a "Suggested" candidate set for the user to pick from
    // (shown first, marked ★, in Resolve Mappings) rather than a guess.
    const excelFamilies = detectFamilies(excelModel);
    let suggestedModels = [];
    if (excelFamilies.length > 0) {
      suggestedModels = Array.from(available).filter(m => sharesFamily(excelFamilies, detectFamilies(m)));
    }
    r.detectedFamilies = excelFamilies;
    if (suggestedModels.length === 1) {
      r.unmapped = false; r.matchedProductionModel = suggestedModels[0]; r.mappingTier = 'family';
      r.availableModelsForDropdown = []; r.suggestedModels = [];
      return;
    }

    // Tier 4b: door-type narrowing — ONLY applied when family-filtering
    // above left 2+ still-ambiguous candidates (never on the whole
    // roster, never replacing family filtering). If the Excel text's own
    // prefix identifies a door type AND narrowing the family-filtered
    // set by that type leaves exactly one candidate, auto-map it. If it
    // narrows to 2+, THOSE become the (tighter) suggestions. If it
    // narrows to 0 — e.g. the family's candidates don't carry an
    // explicit (F)/(R) marker at all — fall back to the original,
    // unnarrowed family suggestions untouched.
    if (suggestedModels.length >= 2) {
      const doorType = detectDoorType(excelModel);
      if (doorType) {
        const doorTypeFiltered = suggestedModels.filter(m => detectExplicitDoorTypeMarker(m) === doorType);
        if (doorTypeFiltered.length === 1) {
          r.unmapped = false; r.matchedProductionModel = doorTypeFiltered[0]; r.mappingTier = 'door-type';
          r.availableModelsForDropdown = []; r.suggestedModels = [];
          return;
        }
        if (doorTypeFiltered.length >= 2) {
          suggestedModels = doorTypeFiltered;
        }
        // doorTypeFiltered.length === 0 -> suggestedModels stays as the
        // original family-level set, i.e. the safe fallback.
      }
    }

    // No confident auto-answer — needs a human decision. suggestedModels
    // (2+ entries) surfaces as "Suggested" in the UI; an empty array here
    // means family-filtering found nothing, so the UI shows the plain
    // full roster with no suggestions marked.
    r.unmapped = true; r.matchedProductionModel = null; r.mappingTier = null;
    r.availableModelsForDropdown = Array.from(available).sort();
    r.suggestedModels = suggestedModels.sort();
  }

  function resolveAllModelMappings(rows) {
    rows.forEach(resolveRowMapping);
  }

  // Called when the user picks a value in a row's dropdown — applies it to
  // THIS session (not Firestore yet) for every row sharing the same raw
  // Excel Material/Model text (requirement: "multiple rows with the same
  // Excel Material/Model should reuse the same mapping where applicable"),
  // then re-resolves and re-renders so sibling rows update immediately.
  function applyModelChoice(excelModel, productionModel) {
    if (!productionModel) {
      delete sessionModelChoices[excelModel];
    } else {
      sessionModelChoices[excelModel] = productionModel;
      // A manual selection defaults "Remember Mapping" to checked — the
      // user can still uncheck it afterward if they don't want it saved.
      rememberFlags[excelModel] = true;
    }
    resolveAllModelMappings(parsedRows);
    renderPreview();
  }

  function setRememberFlag(excelModel, checked) {
    rememberFlags[excelModel] = checked;
  }

  // ---- Duplicate detection (reads EXISTING scrapLogs only) --------------

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
      if (fingerprintSet.has(r.entry.importFingerprint)) r.duplicateStatus = 'DUPLICATE';
      else if (businessKeySet.has(buildBusinessKey(r.entry))) r.duplicateStatus = 'POSSIBLE_DUPLICATE';
      else r.duplicateStatus = null;
    });
  }

  // ---- Step 1: file -> workbook -> sheet list ----------------------------

  function readWorkbook(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          resolve(XLSX.read(data, { type: 'array', cellDates: true }));
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function sheetDims(sheet) {
    if (!sheet || !sheet['!ref']) return { rows: 0, cols: 0 };
    try {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      return { rows: range.e.r - range.s.r + 1, cols: range.e.c - range.s.c + 1 };
    } catch (e) { return { rows: 0, cols: 0 }; }
  }

  function renderSheetSelector() {
    const names = currentWorkbook.SheetNames;
    const rowsHtml = names.map(name => {
      const dims = sheetDims(currentWorkbook.Sheets[name]);
      return `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${dims.rows.toLocaleString('en-US')} rows × ${dims.cols} cols)</option>`;
    }).join('');
    $('sheetSelect').innerHTML = rowsHtml;
    const dataSheet = names.find(n => n.trim().toLowerCase() === 'data');
    if (dataSheet) $('sheetSelect').value = dataSheet;
    $('sheetSelectorWrap').style.display = '';
    $('detectionPreviewWrap').style.display = 'none';
    $('importPreviewWrap').style.display = 'none';
  }

  // ---- Step 2: sheet chosen -> header-row detection + candidate rows -----

  function useSheet(sheetName) {
    currentSheetName = sheetName;
    const sheet = currentWorkbook.Sheets[sheetName];
    currentAOA = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const detected = detectHeaderRow(currentAOA);
    currentHeaderRowIndex = detected.rowIndex;
    $('headerRowInput').value = currentHeaderRowIndex + 1;
    if (detected.score < MIN_HEADER_SCORE) {
      showDetectionWarning(`Could not confidently detect a header row on "${sheetName}" (best guess: Excel row ${currentHeaderRowIndex + 1}, only ${detected.score} recognizable column${detected.score === 1 ? '' : 's'}). Check the row number below and correct it if needed.`);
    } else {
      hideDetectionWarning();
    }
    refreshDetectionPreview();
    $('sheetSelectorWrap').style.display = 'none';
    $('detectionPreviewWrap').style.display = '';
    $('importPreviewWrap').style.display = 'none';
  }

  function showDetectionWarning(msg) {
    const el = $('detectionWarning');
    el.textContent = '⚠ ' + msg;
    el.style.display = 'block';
  }
  function hideDetectionWarning() { $('detectionWarning').style.display = 'none'; }

  function refreshDetectionPreview() {
    const headerRowArray = currentAOA[currentHeaderRowIndex] || [];
    currentColumnMap = buildColumnMap(headerRowArray);

    // Content-based detection of the authoritative "23 Sep 2026 #N"-style
    // Date+Shift column — independent of header text, works whichever of
    // the two workbook layouts this is.
    const dateShiftCol = detectDateShiftColumn(currentAOA, currentHeaderRowIndex);
    if (dateShiftCol !== -1) currentColumnMap._dateShiftColIndex = dateShiftCol;

    // Amount/Price fallback: ONLY runs when the header row had no
    // "Amt."/"Amount"/"Price"-style text to match at all — never
    // overrides a header-based match, so the original workbook format
    // (which DOES have these headers) is completely unaffected.
    const sheet = currentWorkbook.Sheets[currentSheetName];
    if (currentColumnMap.amt === undefined) {
      const detected = detectAmountColumnByFormula(sheet, currentAOA, currentHeaderRowIndex, currentColumnMap.qty);
      if (detected.amtCol !== -1) currentColumnMap.amt = detected.amtCol;
      if (detected.priceCol !== -1 && currentColumnMap.price === undefined) currentColumnMap.price = detected.priceCol;
    }

    candidateRows = [];
    for (let i = currentHeaderRowIndex + 1; i < currentAOA.length; i++) {
      const rowArray = currentAOA[i];
      if (isAggregateFormulaRow(sheet, i, currentColumnMap)) continue; // Total/Subtotal row — positive SUM-range-formula evidence, never counted as candidate OR error
      if (isCandidateScrapRow(rowArray, currentColumnMap)) {
        candidateRows.push({ rowNum: i + 1, cells: rowArray });
      }
    }
    const ignoredCount = (currentAOA.length - currentHeaderRowIndex - 1) - candidateRows.length;

    const mappingRows = Object.keys(currentColumnMap)
      .filter(f => f !== '_rawShiftColIndex' && f !== '_dateShiftColIndex')
      .map(field => {
        const colIdx = currentColumnMap[field];
        const excelColName = headerRowArray[colIdx];
        return `<tr><td>${escapeHtml(excelColName)}</td><td>→</td><td>${escapeHtml(FIELD_LABELS[field] || field)}</td></tr>`;
      }).join('');
    const dateShiftMappingRow = (currentColumnMap._dateShiftColIndex !== undefined)
      ? `<tr><td>${escapeHtml(headerRowArray[currentColumnMap._dateShiftColIndex] || '(unlabeled column)')}</td><td>→</td><td><b>Date + Shift (authoritative — e.g. "23 Sep 2026 #N")</b></td></tr>`
      : '<tr><td colspan="3"><i>No "DD MMM YYYY #D/#N"-style column detected — using separate Date/Shift columns instead.</i></td></tr>';

    $('detectionSummary').innerHTML = `
      <div class="qd-import-card"><div class="qd-import-card-label">Selected Sheet</div><div class="qd-import-card-value">${escapeHtml(currentSheetName)}</div></div>
      <div class="qd-import-card"><div class="qd-import-card-label">Header Row</div><div class="qd-import-card-value">Excel row ${currentHeaderRowIndex + 1}</div></div>
      <div class="qd-import-card good"><div class="qd-import-card-label">Candidate Scrap Rows</div><div class="qd-import-card-value">${candidateRows.length.toLocaleString('en-US')}</div></div>
      <div class="qd-import-card neutral"><div class="qd-import-card-label">Ignored Rows</div><div class="qd-import-card-value">${ignoredCount.toLocaleString('en-US')}</div></div>
    `;

    $('columnMappingBody').innerHTML = dateShiftMappingRow + mappingRows || '<tr><td colspan="3">No recognizable Scrap columns found on this row.</td></tr>';

    renderRawPreviewTable(candidateRows.slice(0, 10));
    $('continueToValidationBtn').disabled = candidateRows.length === 0;
  }

  // ---- Raw Preview table: header and rows are BOTH generated from this
  // single array, in this exact order, so the two can never drift apart —
  // there is no other place in the code that lists these 9 columns.
  const RAW_PREVIEW_COLUMNS = [
    { key: 'excelRow', label: 'Excel Row' },
    { key: 'sourceDateText', label: 'Source Date/Shift' },
    { key: 'date', label: 'Date' },
    { key: 'shift', label: 'Shift' },
    { key: 'line', label: 'Line' },
    { key: 'materialModel', label: 'Material/Model' },
    { key: 'defect', label: 'Defect' },
    { key: 'scrapQty', label: 'Qty' },
    { key: 'scrapCost', label: 'Scrap Cost (THB)' }
  ];

  function renderRawPreviewHeader() {
    $('rawPreviewHeadRow').innerHTML = RAW_PREVIEW_COLUMNS.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  }

  // Builds the exact 9-field object for one candidate row — field NAMES
  // match RAW_PREVIEW_COLUMNS' keys 1:1, so renderRawPreviewTable can map
  // straight from this object to <td> cells with no separate ordering
  // logic to keep in sync. Date/Shift parsing itself is UNCHANGED here —
  // this only decides what to DISPLAY, reusing the same parseDateShiftText
  // call parseRow() uses for the authoritative field.
  function buildRawPreviewRowData(r) {
    const get = field => currentColumnMap[field] !== undefined ? r.cells[currentColumnMap[field]] : '';
    let dateDisplay, shiftDisplay, sourceDateText;
    if (currentColumnMap._dateShiftColIndex !== undefined) {
      const rawText = String(r.cells[currentColumnMap._dateShiftColIndex] ?? '').trim();
      const parsed = parseDateShiftText(rawText);
      dateDisplay = parsed ? parsed.date : '(unparsed)';
      shiftDisplay = parsed && parsed.shift ? shiftLabel(parsed.shift) : '(unparsed)';
      sourceDateText = rawText; // ONLY the original Excel value — no "→" audit formatting
    } else {
      const dateCell = get('date');
      dateDisplay = dateCell instanceof Date ? dateCell.toISOString().slice(0, 10) : String(dateCell ?? '');
      shiftDisplay = shiftLabel(normalizeShiftValue(get('shift')) || '') || String(get('shift') ?? '');
      sourceDateText = '(no combined field — using separate Date/Shift columns)';
    }
    const lineCode = normalizeLineValue(get('line')) || lineFromLocation(get('location'));
    const lineDisplay = lineCode ? lineLabel(lineCode) : String(get('line') ?? get('location') ?? '');

    return {
      excelRow: r.rowNum,
      sourceDateText,
      date: formatDateDisplay(dateDisplay),
      shift: shiftDisplay,
      line: lineDisplay,
      materialModel: String(get('material') || get('model') || ''),
      defect: String(get('defect') ?? ''),
      scrapQty: String(get('qty') ?? ''),
      scrapCost: String(get('amt') ?? '')
    };
  }

  function renderRawPreviewTable(rows) {
    renderRawPreviewHeader();
    if (rows.length === 0) {
      $('rawPreviewBody').innerHTML = `<tr class="empty-row"><td colspan="${RAW_PREVIEW_COLUMNS.length}">No candidate scrap rows found with this header row — try adjusting the row number above, or pick a different sheet.</td></tr>`;
      return;
    }
    $('rawPreviewBody').innerHTML = rows.map(r => {
      const data = buildRawPreviewRowData(r);
      // Map STRICTLY through RAW_PREVIEW_COLUMNS' key order — this is the
      // only place cells are emitted, so header/row correspondence is
      // structural, not something that can silently drift on a future edit.
      const cellsHtml = RAW_PREVIEW_COLUMNS.map(c => `<td${c.key === 'sourceDateText' ? ' class="qd-import-sourcecol"' : ''}>${escapeHtml(data[c.key])}</td>`).join('');
      return `<tr>${cellsHtml}</tr>`;
    }).join('');
  }

  // ---- Step 3: user confirms detection -> parse + validate + match ------

  async function continueToValidation() {
    parsedRows = candidateRows.map(r => parseRow(r.cells, currentColumnMap, r.rowNum));
    // Fresh session state for this validation run — a previous file's
    // in-session picks/remember-flags must not leak into a new one.
    sessionModelChoices = {};
    rememberFlags = {};
    resolveMappingsFilter = 'all';
    resolveMappingsSearch = '';

    $('importPreviewWrap').style.display = '';
    $('importSummaryCards').innerHTML = '<div class="qd-import-loading">Checking against Production V2 and existing scrapLogs…</div>';
    $('importPreviewBody').innerHTML = '';

    await fetchProductionRosters(parsedRows);
    const mappingResult = await ScrapModelMappingAdapter.getAllMappings(window.qdDb);
    savedModelMappings = mappingResult.mappings;
    const noticeEl = $('scrapModelMappingNotice');
    if (mappingResult.error) {
      console.error('Quality Dashboard: could not read scrapModelMappings (saved mappings unavailable for this session):', mappingResult.error);
      noticeEl.textContent = '⚠ Could not read saved Model Mappings (scrapModelMappings) — every row will need manual mapping this time. This usually means Firestore Security Rules don\'t yet include this collection.';
      noticeEl.style.display = 'block';
    } else {
      noticeEl.style.display = 'none';
    }
    resolveAllModelMappings(parsedRows);
    // Snapshot which Excel identities need a decision, ONCE, right after
    // this first resolution pass — "Resolve Mappings" keeps showing these
    // for the rest of the session even after a pick resolves them, so the
    // group doesn't vanish out from under the user before they get to
    // check "Remember Mapping".
    const attentionSet = new Set();
    parsedRows.forEach(r => {
      if (r.formatValid && r.unmapped && r.availableModelsForDropdown && r.availableModelsForDropdown.length > 0) {
        attentionSet.add(r.entry.model);
      }
    });
    identitiesNeedingAttention = Array.from(attentionSet);

    await checkDuplicates(parsedRows);
    renderPreview();
    $('importPreviewWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Preview rendering (post-validation) --------------------------------

  const PREVIEW_ROW_LIMIT = 200;

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

  // ---- Mapping summary line (Auto Mapped | Needs Mapping | Invalid Saved) --
  function renderMappingSummary() {
    const formatValidRows = parsedRows.filter(r => r.formatValid);
    const autoMapped = formatValidRows.filter(r => !r.unmapped).length;
    const needsMapping = formatValidRows.filter(r => r.unmapped).length;
    const invalidSaved = formatValidRows.filter(r => r.hadInvalidSavedMapping).length;
    $('mappingSummaryCards').innerHTML = `
      <div class="qd-import-card good"><div class="qd-import-card-label">Auto Mapped</div><div class="qd-import-card-value">${autoMapped}</div></div>
      <div class="qd-import-card warn"><div class="qd-import-card-label">Needs Mapping</div><div class="qd-import-card-value">${needsMapping}</div></div>
      <div class="qd-import-card warn"><div class="qd-import-card-label">Invalid Saved Mapping</div><div class="qd-import-card-value">${invalidSaved}</div></div>
    `;
  }

  // ---- Compact "Resolve Mappings" — each unique unresolved Excel identity
  // shown ONCE, not once per Scrap row. Picking a value here goes through
  // the exact same applyModelChoice() as before, which still re-verifies
  // each individual row's own Date+Line+Shift before accepting it.
  // Computes the per-group summary data (used for both filtering/counts
  // and rendering) so both stay perfectly consistent with each other.
  function buildMappingGroups() {
    return identitiesNeedingAttention.map(excelModel => {
      const memberRows = parsedRows.filter(r => r.formatValid && r.entry.model === excelModel);
      const availableUnion = new Set();
      const suggestedUnion = new Set();
      let anyInvalidSaved = false;
      let families = [];
      memberRows.forEach(r => {
        (r.availableModelsForDropdown || []).forEach(m => availableUnion.add(m));
        (r.suggestedModels || []).forEach(m => suggestedUnion.add(m));
        if (r.hadInvalidSavedMapping) anyInvalidSaved = true;
        if (r.detectedFamilies && r.detectedFamilies.length) families = r.detectedFamilies;
      });
      const stillUnresolvedCount = memberRows.filter(r => r.unmapped).length;
      let status;
      if (stillUnresolvedCount === 0) status = 'resolved';
      else if (suggestedUnion.size > 0) status = 'suggested';
      else status = 'unresolved';
      return {
        excelModel, memberRows, availableUnion, suggestedUnion, anyInvalidSaved, families,
        stillUnresolvedCount, status
      };
    });
  }

  function renderResolveMappingsSection() {
    const el = $('resolveMappingsSection');
    if (identitiesNeedingAttention.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }

    // The whole section re-renders on every filter/search/pick change —
    // preserve focus+cursor position in the search box across that, or
    // typing would lose focus after every keystroke.
    const searchHadFocus = document.activeElement && document.activeElement.id === 'resolveMappingsSearchInput';
    const priorSelectionStart = searchHadFocus ? document.activeElement.selectionStart : null;

    const allGroups = buildMappingGroups();
    const counts = { all: allGroups.length, suggested: 0, unresolved: 0, resolved: 0 };
    allGroups.forEach(g => { counts[g.status]++; });

    const searchLower = resolveMappingsSearch.trim().toLowerCase();
    const visibleGroups = allGroups.filter(g => {
      if (resolveMappingsFilter !== 'all' && g.status !== resolveMappingsFilter) return false;
      if (searchLower && !g.excelModel.toLowerCase().includes(searchLower)) return false;
      return true;
    });

    const filterBtn = (key, label) =>
      `<button type="button" class="qd-mapfilter-btn ${resolveMappingsFilter === key ? 'active' : ''}" data-filter="${key}">${label} <span class="qd-mapfilter-count">${counts[key]}</span></button>`;

    const rowsHtml = visibleGroups.map(g => {
      const currentChoice = sessionModelChoices[g.excelModel] || '';
      const suggestedOptions = Array.from(g.suggestedUnion).sort().map(m =>
        `<option value="${escapeHtml(m)}" ${m === currentChoice ? 'selected' : ''}>★ Suggested — ${escapeHtml(m)}</option>`
      ).join('');
      const restOptions = Array.from(g.availableUnion).filter(m => !g.suggestedUnion.has(m)).sort().map(m =>
        `<option value="${escapeHtml(m)}" ${m === currentChoice ? 'selected' : ''}>${escapeHtml(m)}</option>`
      ).join('');
      const rememberChecked = rememberFlags[g.excelModel] ? 'checked' : '';

      let statusNote;
      if (g.status === 'resolved') statusNote = '<span class="status-ok">✓ Resolved</span>';
      else if (g.status === 'suggested') statusNote = '<span class="status-warn">★ Suggested</span>';
      else statusNote = '<span class="status-warn">⚠ Unresolved</span>';
      if (g.anyInvalidSaved) statusNote += ' <span class="status-warn" title="A saved mapping exists for this identity but is not valid for at least one of these rows\' own Date+Shift+Line">(stale saved mapping)</span>';

      const chipsHtml = g.status !== 'resolved' && g.suggestedUnion.size > 0
        ? `<div class="qd-suggest-chips">${Array.from(g.suggestedUnion).sort().map(m =>
            `<button type="button" class="qd-suggest-chip" data-excel-model="${escapeHtml(g.excelModel)}" data-model-value="${escapeHtml(m)}">★ ${escapeHtml(m)}</button>`
          ).join('')}</div>`
        : '';

      return `<tr>
        <td title="${escapeHtml(g.excelModel)}">${escapeHtml(g.excelModel)}</td>
        <td class="num">${g.memberRows.length}${g.stillUnresolvedCount < g.memberRows.length && g.stillUnresolvedCount > 0 ? ` (${g.stillUnresolvedCount} still unresolved)` : ''}</td>
        <td>${g.families.length ? escapeHtml(g.families.join(', ')) : '<span class="na">—</span>'}</td>
        <td>${statusNote}</td>
        <td>
          <div class="qd-model-map">
            ${chipsHtml}
            <select class="qd-model-map-select" data-excel-model="${escapeHtml(g.excelModel)}">
              <option value="">— select Production Model —</option>
              ${suggestedOptions}
              ${restOptions}
            </select>
            <label class="qd-model-map-remember">
              <input type="checkbox" class="qd-model-map-remember-cb" data-excel-model="${escapeHtml(g.excelModel)}" ${rememberChecked}> Remember Mapping
            </label>
          </div>
        </td>
      </tr>`;
    }).join('') || `<tr class="empty-row"><td colspan="5">No mappings match this filter/search.</td></tr>`;

    el.style.display = '';
    el.innerHTML = `
      <h3>Resolve Mappings</h3>
      <div class="qd-panel-note">${identitiesNeedingAttention.length} distinct Excel Material/Model${identitiesNeedingAttention.length > 1 ? 's' : ''} needed a decision — resolve each once here; it applies to every matching Scrap row where that model is actually valid for its own Date+Shift+Line.</div>
      <div class="qd-mapfilter-bar">
        <input type="text" id="resolveMappingsSearchInput" class="qd-mapfilter-search" placeholder="Search Excel Material/Model…" value="${escapeHtml(resolveMappingsSearch)}">
        <div class="qd-mapfilter-btns">
          ${filterBtn('all', 'All')}
          ${filterBtn('suggested', 'Suggested')}
          ${filterBtn('unresolved', 'Unresolved')}
          ${filterBtn('resolved', 'Resolved')}
        </div>
      </div>
      <div class="qd-table-scroll">
        <table class="qd-datatable">
          <thead><tr><th>Excel Material/Model</th><th>Rows</th><th>Family</th><th>Status</th><th>Map to Production Model</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
    if (searchHadFocus) {
      const newInput = $('resolveMappingsSearchInput');
      if (newInput) { newInput.focus(); newInput.setSelectionRange(priorSelectionStart, priorSelectionStart); }
    }
  }

  function buildMatchedModelCellHtml(r) {
    if (!r.unmapped) {
      return r.matchedProductionModel ? escapeHtml(r.matchedProductionModel) : '<span class="na">— not matched</span>';
    }
    if (!r.availableModelsForDropdown || r.availableModelsForDropdown.length === 0) {
      return '<span class="na">— not matched (no Production plan for this date/line/shift)</span>';
    }
    return '<span class="na">— see "Resolve Mappings" above</span>';
  }

  function renderPreview() {
    renderSummaryCards();
    renderMappingSummary();
    renderResolveMappingsSection();

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
        if (r.availableModelsForDropdown && r.availableModelsForDropdown.length > 0) {
          statusHtml = '<span class="status-warn">⚠ NEEDS MAPPING</span>';
        } else {
          statusHtml = `<span class="status-warn" title="No Production V2 plan exists at all for ${escapeHtml(formatDateDisplay(e.date))} / ${escapeHtml(lineLabel(e.line))} / ${escapeHtml(shiftLabel(e.shift))} — nothing to map to">⚠ UNMAPPED MODEL</span>`;
        }
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
        <td>${e.date ? escapeHtml(formatDateDisplay(e.date)) : '–'}</td>
        <td>${e.shift ? escapeHtml(shiftLabel(e.shift)) : '–'}</td>
        <td>${e.line ? escapeHtml(lineLabel(e.line)) : '–'}</td>
        <td title="${escapeHtml(e.sourceMaterial)}">${escapeHtml(e.sourceMaterial || e.model || '–')}</td>
        <td>${buildMatchedModelCellHtml(r)}</td>
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
    $('importConfirmBtn').disabled = importableCount === 0;
    $('importMessage').style.display = 'none';
  }

  // ---- Import (write only READY rows, in modest-sized chunks) -----------

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
      model: r.matchedProductionModel, // write the CONFIRMED Production Model, not the raw Excel text — entry.sourceMaterial/sourceMaterialName still keep the original Excel identity for audit
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
        console.log(`Quality Dashboard: import batch ${i + 1}/${chunks.length} done (${result.succeeded.length} ok, ${result.failed.length} failed)`);
      } catch (e) {
        console.error(`Quality Dashboard: import batch ${i + 1}/${chunks.length} failed or timed out:`, e);
        c.forEach(entry => failures.push({ entry, error: e }));
      }
    }

    const totalSec = ((Date.now() - importStartedAt) / 1000).toFixed(1);

    // Model Mapping is only ever persisted here — at confirmed-import time,
    // never during Preview/Validation. Best-effort: a failure here doesn't
    // undo or fail the scrapLogs write that already succeeded above.
    const rememberedPairs = Object.keys(rememberFlags)
      .filter(excelModel => rememberFlags[excelModel] && sessionModelChoices[excelModel])
      .map(excelModel => ({ excelModel, productionModel: sessionModelChoices[excelModel] }));
    let mappingSaveNote = '';
    if (rememberedPairs.length > 0) {
      const mappingResult = await ScrapModelMappingAdapter.saveMappings(window.qdDb, rememberedPairs);
      if (mappingResult.error) {
        console.error('Quality Dashboard: failed to save Model Mappings:', mappingResult.error);
        mappingSaveNote = ` (Note: ${rememberedPairs.length} model mapping${rememberedPairs.length > 1 ? 's' : ''} could NOT be remembered for next time — check Firestore Security Rules include scrapModelMappings.)`;
      } else {
        mappingSaveNote = ` Remembered ${mappingResult.succeeded} model mapping${mappingResult.succeeded > 1 ? 's' : ''} for next time.`;
      }
    }

    btn.textContent = 'Import Valid Rows';
    btn.disabled = false;

    if (failures.length === 0) {
      msgEl.className = 'qd-form-message success';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''} into scrapLogs in ${totalSec}s (batch ${importBatchId}). Check Scrap Detail to review them.${mappingSaveNote}`;
    } else {
      msgEl.className = 'qd-form-message error';
      msgEl.textContent = `Imported ${succeeded} record${succeeded > 1 ? 's' : ''}, but ${failures.length} failed: ${failures[0].error && failures[0].error.message ? failures[0].error.message : 'unknown error'}${mappingSaveNote}`;
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

  function resetImportUI() {
    $('sheetSelectorWrap').style.display = 'none';
    $('detectionPreviewWrap').style.display = 'none';
    $('importPreviewWrap').style.display = 'none';
    hideDetectionWarning();
  }

  function init() {
    $('downloadTemplateBtn').addEventListener('click', downloadTemplate);

    $('importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      currentFileName = file.name;
      $('importFileName').textContent = file.name;
      resetImportUI();

      if (typeof XLSX === 'undefined') {
        showDetectionWarning('File-parsing library failed to load (check internet connection) — cannot read this file.');
        $('sheetSelectorWrap').style.display = '';
        return;
      }
      try {
        currentWorkbook = await readWorkbook(file);
        if (!currentWorkbook.SheetNames || currentWorkbook.SheetNames.length === 0) {
          showDetectionWarning('This file has no worksheets.');
          $('sheetSelectorWrap').style.display = '';
          return;
        }
        if (currentWorkbook.SheetNames.length === 1) {
          useSheet(currentWorkbook.SheetNames[0]);
        } else {
          renderSheetSelector();
        }
      } catch (err) {
        console.error('Quality Dashboard: failed to read workbook:', err);
        showDetectionWarning('Could not read this file: ' + (err && err.message ? err.message : String(err)));
        $('sheetSelectorWrap').style.display = '';
      }
    });

    $('useSheetBtn').addEventListener('click', () => {
      const sheetName = $('sheetSelect').value;
      if (sheetName) useSheet(sheetName);
    });

    $('headerRowInput').addEventListener('change', () => {
      const v = parseInt($('headerRowInput').value, 10);
      if (Number.isFinite(v) && v >= 1 && v <= currentAOA.length) {
        currentHeaderRowIndex = v - 1;
        hideDetectionWarning();
        refreshDetectionPreview();
      }
    });

    $('backToSheetSelectBtn').addEventListener('click', () => {
      $('detectionPreviewWrap').style.display = 'none';
      $('sheetSelectorWrap').style.display = '';
    });

    $('continueToValidationBtn').addEventListener('click', continueToValidation);
    $('importConfirmBtn').addEventListener('click', doImport);

    // Delegated — the preview table body's innerHTML is replaced on every
    // re-render (e.g. after a dropdown pick propagates to sibling rows),
    // but the <tbody> element itself persists, so one listener here
    // covers every dropdown/checkbox that ever appears in it.
    // Delegated on the whole preview wrapper (covers both the main table's
    // rows AND the "Resolve Mappings" section above it) — both areas'
    // innerHTML gets replaced on every re-render, but this ancestor
    // element itself persists, so one listener here covers all of it.
    $('importPreviewWrap').addEventListener('change', (e) => {
      const select = e.target.closest('.qd-model-map-select');
      if (select) {
        applyModelChoice(select.dataset.excelModel, select.value);
        return;
      }
      const checkbox = e.target.closest('.qd-model-map-remember-cb');
      if (checkbox) {
        setRememberFlag(checkbox.dataset.excelModel, checkbox.checked);
      }
    });

    $('importPreviewWrap').addEventListener('click', (e) => {
      const filterBtn = e.target.closest('.qd-mapfilter-btn');
      if (filterBtn) {
        resolveMappingsFilter = filterBtn.dataset.filter;
        renderResolveMappingsSection();
        return;
      }
      const chip = e.target.closest('.qd-suggest-chip');
      if (chip) {
        applyModelChoice(chip.dataset.excelModel, chip.dataset.modelValue);
      }
    });

    $('importPreviewWrap').addEventListener('input', (e) => {
      if (e.target.id === 'resolveMappingsSearchInput') {
        resolveMappingsSearch = e.target.value;
        renderResolveMappingsSection();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
