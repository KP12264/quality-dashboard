/**
 * config.js
 * ------------------------------------------------------------------
 * Central, isolated configuration for the Quality Dashboard.
 *
 * IMPORTANT — READ ONLY BOUNDARY
 * This dashboard reads production data from Production V2's Firestore
 * collections (prodV2_actualLogs, prodV2_dailyPlans) — same Firebase
 * project as the original "daily-production-report" site, but a
 * completely separate set of collections. Every value below that
 * touches a prodV2_* collection is consumed only by read (`.get()`)
 * calls in js/data-adapter.js — this dashboard never writes there.
 *
 * Nothing in this file, or anywhere else in this project, should be
 * changed to point at a *different* collection name than the ones
 * documented here — doing so would silently break the
 * "read the real production data" requirement.
 * ------------------------------------------------------------------
 */

// Firebase project connection info for the EXISTING production system.
// This is the same public client config already shipped in the original
// site's index.html — Firebase client API keys are not secrets; the
// real access boundary is the Firestore Security Rules on the project.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCJQtvQE6DCk64hPZz4WATTC2c01GiJ53c",
  authDomain: "daily-production-report-46b60.firebaseapp.com",
  projectId: "daily-production-report-46b60",
  storageBucket: "daily-production-report-46b60.firebasestorage.app",
  messagingSenderId: "275988223035",
  appId: "1:275988223035:web:11e2c55c8c38c2f9e5f81e"
};

// A distinct Firebase app instance name so this dashboard never collides
// with any other Firebase app instance (e.g. the original site open in
// another tab, or a future admin tool in a later phase).
const FIREBASE_APP_NAME = "qualityDashboardReadOnly";

// Firestore collections belonging to Production V2 (the system this
// dashboard now reads production data from — READ ONLY, same rules as
// the legacy collection below: only .get() calls anywhere in this
// project, never .set()/.update()/.add()/.delete()).
//   prodV2_actualLogs : actual production qty, doc id actual_{date}_{LINE}_{SHIFT}
//   prodV2_dailyPlans : the shift's planned Model/Door roster + qty,
//                        doc id plan_{date}_{LINE}_{SHIFT} — this is what
//                        the Scrap Entry Model dropdown reads from, since
//                        it's set before the shift starts (unlike actual
//                        data, which may not exist yet while a Leader is
//                        recording scrap mid-shift).
const PROD_V2_ACTUAL_COLLECTION = "prodV2_actualLogs";
const PROD_V2_PLAN_COLLECTION = "prodV2_dailyPlans";

// The legacy collection this dashboard READ from before switching to
// Production V2 above. No longer read anywhere in this project — kept
// only as a documented historical reference. If it's ever reintroduced,
// the same read-only rule applies: .get() only, never a write.
const PRODUCTION_COLLECTION = "productionLogs";

// Collections that belong to THIS new website (Scrap / Quality). These
// are brand new — nothing in the existing production system reads or
// writes them, so normal read/write is fine here. See
// js/scrap-adapter.js and js/target-adapter.js.
const SCRAP_COLLECTION = "scrapLogs";
const TARGET_MASTER_COLLECTION = "targetMaster";
const IMPROVEMENT_COLLECTION = "improvements";

// Production lines and their display labels, per the existing system.
// Keyed by the same single-letter line codes used in the existing
// Firestore document IDs (prod_{date}_{line}_{shift}).
const LINES = [
  { code: "A", label: "Door A" },
  { code: "B", label: "Door B" },
  { code: "C", label: "Door C" }
];

// Shifts, using the codes Production V2 uses in its own document IDs
// and dropdowns (e.g. actual_2026-08-28_A_DAY). Scrap records now save
// this same DAY/NIGHT code. Note: any scrapLogs/targetMaster documents
// saved before this switch used the old Thai codes ("เช้า"/"ดึก") and
// will no longer match — per instruction, that old test data is not
// being migrated and can be discarded via the normal Edit/Delete UI.
const SHIFTS = [
  { code: "DAY", label: "Day" },
  { code: "NIGHT", label: "Night" }
];

/**
 * Fallback scrap target, in pieces per shift — used ONLY when no
 * targetMaster document exists yet for a given shift/date (e.g. brand
 * new install, before anyone has set a target). This is a TOTAL across
 * all 3 lines combined for that shift, per the business rule — never
 * multiplied by line count.
 *
 * This constant is never read directly by dashboard/business logic —
 * everything goes through js/target-adapter.js's getTargetForShift(),
 * which checks targetMaster (with effective-dating) first and only
 * falls back to this default if no record applies yet. That keeps this
 * number from being "hard-coded into the business logic" as required:
 * it's a documented fallback default in one isolated place.
 */
const DEFAULT_TARGET_PER_SHIFT_PCS = {
  DAY: 30,
  NIGHT: 30
};

// Defect types available when recording a scrap entry. Kept as a plain
// list here (not hard-coded inline in the entry form) so it's one place
// to edit; a later phase can move this to its own Master Data doc the
// same way targets moved to targetMaster.
const DEFECT_TYPES = [
  "Scratch",
  "Dent",
  "Crack",
  "Short Mold / ไม่เต็ม",
  "Warp / บิดงอ",
  "Color / สีเพี้ยน",
  "Dimension / ขนาดผิด",
  "Contamination / สิ่งแปลกปลอม",
  "Other / อื่นๆ"
];

// 4M categories used to classify a defect's root cause on the
// Improvement page (Man / Machine / Material / Method).
const FOUR_M_TYPES = ["Man", "Machine", "Material", "Method"];

// Improvement record lifecycle status, per the business requirement.
const IMPROVEMENT_STATUSES = ["Monitoring", "Controlled", "Not Effective", "Recurring"];

// A Line+Model+Defect combination is flagged "recurring" once it has
// shown up on at least this many DISTINCT dates within the lookback
// window used by the caller (Dashboard / Scrap Detail). One isolated
// occurrence is not "recurring" — this is the only place that number
// lives, so it can be tuned without touching the detection logic in
// js/quality-adapter.js.
const RECURRING_THRESHOLD_DISTINCT_DATES = 3;
