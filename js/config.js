/**
 * config.js
 * ------------------------------------------------------------------
 * Central, isolated configuration for the Quality Dashboard.
 *
 * IMPORTANT — READ ONLY BOUNDARY
 * This dashboard is a NEW, SEPARATE website. It connects to the
 * EXISTING Firebase project / Firestore collection used by the
 * original "daily-production-report" site, but it must never write
 * to it. Every value below that touches that collection is consumed
 * only by read (`.get()` / `.onSnapshot()`) calls in js/data-adapter.js.
 *
 * Nothing in this file, or anywhere else in this project, should be
 * changed to point at a *different* collection name than the one
 * documented in the audit — doing so would silently break the
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

// The one Firestore collection this dashboard is allowed to READ from
// the EXISTING production system, and only ever with .get() /
// .onSnapshot() — never .set()/.update()/.add()/.delete(). See
// js/data-adapter.js. This collection belongs to the original site;
// this dashboard must never write to it.
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

// Shifts as they exist in the original system's document IDs (Thai),
// mapped to the English labels this dashboard's UI uses.
const SHIFTS = [
  { code: "เช้า", label: "Day" },
  { code: "ดึก", label: "Night" }
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
  "เช้า": 30, // Day
  "ดึก": 30   // Night
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
