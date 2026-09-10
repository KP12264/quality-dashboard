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

// Defect types available when recording a scrap entry. Sourced from the
// real historical scrap log ("Scrap_Door_Line__NEW_7_9_26.xlsx", sheet
// "Data") — every defect name occurring at least 3 times, then manually
// consolidated: variants that only differed by WHERE/WHEN the defect
// was found, or by spelling/typo, were merged into one canonical name
// (e.g. "ฝาบุบจากรถ", "ฝาบุบบนรถ" -> "ฝาบุบ"). Different physical parts
// (ฝา outer vs ฝาใน inner vs ฝาเหล็ก steel vs Cap vs Sheet vs กระจก...)
// and different defect types on the same part (บุบ dent vs หัก broken
// vs รอยขีด scratched vs ยุบ/ย่น sunken...) were kept as SEPARATE
// entries — only true near-duplicates were merged. Reduced 136 raw
// names down to 74 (+ the "Other / อื่นๆ" catch-all), covering the same
// 93.5% of the 6,344 historical records. "Other / อื่นๆ" is the
// catch-all for anything not in this list. Kept as a plain list here
// (not hard-coded inline in the entry form) so it's one place to edit;
// a later phase can move this to its own Master Data doc the same way
// targets moved to targetMaster.
const DEFECT_TYPES = [
  "ฝาบุบ",
  "โฟมล้น",
  "รอยขีด (ไม่ระบุตำแหน่ง)",
  "ฝาหัก",
  "โฟมรั่ว",
  "Jigไม่Lock",
  "ขอบม้วน",
  "โฟมกระจาย",
  "ฝาในเป็นรอย/รอยขีด",
  "ฝาในยุบ/ย่น",
  "ฝาเป็นรอย/รอยขีด",
  "Capหลุด",
  "ฝาในเป็นเม็ด",
  "ฝาในแตก",
  "Capเป็นรอย/รอยขีด",
  "โฟมไม่เต็ม",
  "ฝาในเสียรูป",
  "คราบโฟม",
  "ฝานูน",
  "ไม่มีแม่เหล็ก",
  "Capไม่เข้า",
  "ฝาในบุบ",
  "แม่เหล็กเอียง",
  "Capเสียรูป",
  "กระจกแตก",
  "กล่องเอียง",
  "ฝาในหลุดขอบ",
  "รูHandleเอียง",
  "ใส่ฝาในผิดรุ่น/สี",
  "ฝาเป็นเม็ด",
  "ใส่ฝาผิดรุ่น/สี",
  "ฝาในเป็นคลื่น",
  "สายไฟขาด",
  "ใส่ฝากลับด้าน/ทาง",
  "กระจกเป็นรอย/รอยขีด",
  "ฝาในลอย",
  "ฝาเหล็กเป็นเม็ด",
  "ฝาในเป็นเส้น",
  "Capบิ่น",
  "ฝาในหยาบ",
  "ใส่ฝาเหล็กกลับด้าน/ผิด",
  "ฝาด่าง",
  "ฝาเหล็กเป็นเส้น",
  "สีถลอก",
  "ฝายุบ",
  "ฝาในบี้",
  "ฝาในหัก",
  "ฝารอยถลอก",
  "Sheetด่าง",
  "Capอ้า",
  "ฝาในมุด",
  "Capหัก",
  "โฟมไม่เกาะ",
  "ใส่Capผิด",
  "Capแตก",
  "ฝาในหลุด",
  "Capบุบ",
  "ฝาในนูน",
  "ฝาในฉีก",
  "ฝาในบวม",
  "ฝาเหล็กหลุด",
  "ฝาเหล็กเป็นรอย",
  "แร็คงัด",
  "ไม่ใส่ฝาใน",
  "ฝาในตก",
  "ฝาเหล็กนูน",
  "Door Rack หัก",
  "HotStampเป็นรอย",
  "ฝาหลุดขอบ",
  "ไม่มีสายไฟ",
  "ฝาประกอบไม่เข้า",
  "ฝาไม่ใส่กันกกระแทก",
  "ฝาเป็นดวงน้ำมัน",
  "ฝารอยขูดจากรถ",
  "Other / อื่นๆ"
];


// Raw historical defect name -> consolidated canonical name (see the
// comment above DEFECT_TYPES for the merge rules). Used ONLY by the
// bulk file-import feature (js/scrap-import.js) to normalize the
// Defect column of an imported file, so imported scrapLogs records use
// the same clean category names as the manual-entry dropdown instead
// of hundreds of near-duplicate raw variants. A defect name with no
// entry here (i.e. it occurred fewer than 3 times in the historical
// data this was built from, or is new/unrecognized) is left exactly
// as written in the file — this map only ever RENAMES a recognized
// variant to its canonical form, never invents or discards data.
const DEFECT_CONSOLIDATION_MAP = {
  "CAP บิ่น": "Capบิ่น",
  "Cap บิ่น": "Capบิ่น",
  "Cap รอย": "Capเป็นรอย/รอยขีด",
  "Cap รอยชีด": "Capเป็นรอย/รอยขีด",
  "Cap ลอย": "Capหลุด",
  "Cap เป็นรอย": "Capเป็นรอย/รอยขีด",
  "Cap ไม่เข้า": "Capไม่เข้า",
  "Capกเป็นรอย": "Capเป็นรอย/รอยขีด",
  "Capงอ": "Capเสียรูป",
  "Capบิ่นจากการซ่อม": "Capบิ่น",
  "Capประกอบไม่เข้า": "Capไม่เข้า",
  "Capฝารอย": "Capเป็นรอย/รอยขีด",
  "Capม้วน": "Capเสียรูป",
  "Capรอย": "Capเป็นรอย/รอยขีด",
  "Capรอยขีด": "Capเป็นรอย/รอยขีด",
  "Capรอยขีดลึก": "Capเป็นรอย/รอยขีด",
  "Capรอยขีดลึกด้านหน้า": "Capเป็นรอย/รอยขีด",
  "Capรอยลึก": "Capเป็นรอย/รอยขีด",
  "Capอ้าง": "Capอ้า",
  "Capอ้าจากโฟม": "Capอ้า",
  "Capเป็นรอย": "Capเป็นรอย/รอยขีด",
  "Capเป็นเม็ดนูน": "Capเป็นเม็ด",
  "Capเส้นเป็นรอย": "Capเป็นรอย/รอยขีด",
  "Capไม่ตรง": "Capไม่เข้า",
  "Door Sheet ด่าง": "Sheetด่าง",
  "DoorSheetด่าง": "Sheetด่าง",
  "Fixingเอียง": "รูHandleเอียง",
  "JigUnLock": "Jigไม่Lock",
  "Jigปิดไม่ทัน": "Jigไม่Lock",
  "Partฝาในมุด": "ฝาในมุด",
  "Sheet ด่าง": "Sheetด่าง",
  "กระจกบิ่นแตก": "กระจกแตก",
  "กระจกรอย": "กระจกเป็นรอย/รอยขีด",
  "กระจกรอยขีด": "กระจกเป็นรอย/รอยขีด",
  "กระจกรอยขีดด้านนอก": "กระจกเป็นรอย/รอยขีด",
  "กระจกรอยขีดด้านใน": "กระจกเป็นรอย/รอยขีด",
  "กระจกรอยขีดใน": "กระจกเป็นรอย/รอยขีด",
  "กระจกรอยถลอก": "กระจกเป็นรอย/รอยขีด",
  "กระจกเป็นรอย": "กระจกเป็นรอย/รอยขีด",
  "กระจกแตกเจอบนรถ": "กระจกแตก",
  "กล่องDisplayเอียง": "กล่องเอียง",
  "กล่องก็อกน้ำเอียง": "กล่องเอียง",
  "กล่องจอLEDเอียง": "กล่องเอียง",
  "กล่องหน้าจอเอียง": "กล่องเอียง",
  "กล่องแม่เหล็กเอียง": "กล่องเอียง",
  "กล่องใส่Displayเอียง": "กล่องเอียง",
  "กล่องใส่หน้าจอเอียง": "กล่องเอียง",
  "บุบจากรถ": "ฝาบุบ",
  "บุบจากรถเข็น": "ฝาบุบ",
  "บุบฝาใน": "ฝาในบุบ",
  "บุบเจอบนรถ": "ฝาบุบ",
  "ประกอบCapไม่เข้า": "Capไม่เข้า",
  "ฝากระจกรอยขีดด้านนอก": "กระจกเป็นรอย/รอยขีด",
  "ฝากระจกแตก": "กระจกแตก",
  "ฝาขอบม้วน": "ขอบม้วน",
  "ฝาด่างด้านล่าง": "ฝาด่าง",
  "ฝาด่างแผ่นSheet": "ฝาด่าง",
  "ฝาด้านหน้าเป็นเม็ด": "ฝาเป็นเม็ด",
  "ฝาบุบ F ประกอบ": "ฝาบุบ",
  "ฝาบุบ(Line ฝาทำเสียเอง)": "ฝาบุบ",
  "ฝาบุบCap": "ฝาบุบ",
  "ฝาบุบRRประกอบ": "ฝาบุบ",
  "ฝาบุบRประกอบ": "ฝาบุบ",
  "ฝาบุบก่อนประกอบ": "ฝาบุบ",
  "ฝาบุบจากJIg": "ฝาบุบ",
  "ฝาบุบจากรถ": "ฝาบุบ",
  "ฝาบุบชนรถ": "ฝาบุบ",
  "ฝาบุบด้านข้าง": "ฝาบุบ",
  "ฝาบุบด้านข้างเจอในรถ": "ฝาบุบ",
  "ฝาบุบตกรถ": "ฝาบุบ",
  "ฝาบุบตกรถเข็น": "ฝาบุบ",
  "ฝาบุบตรงFix": "ฝาบุบ",
  "ฝาบุบตู้ล้ม": "ฝาบุบ",
  "ฝาบุบตู้ล้มตกหลุม": "ฝาบุบ",
  "ฝาบุบบนรถ": "ฝาบุบ",
  "ฝาบุบปูแผ่นPEไม่ดี": "ฝาบุบ",
  "ฝาบุบมาจากข้างบน": "ฝาบุบ",
  "ฝาบุบมีเศษในJig": "ฝาบุบ",
  "ฝาบุบยาว": "ฝาบุบ",
  "ฝาบุบรยขีด": "ฝาบุบ",
  "ฝาบุบรอยขีด": "ฝาบุบ",
  "ฝาบุบสีลอกจากการซ่อม": "ฝาบุบ",
  "ฝาบุบเขอในรถ": "ฝาบุบ",
  "ฝาบุบเจอก่อนประกอบ": "ฝาบุบ",
  "ฝาบุบเจอบนรถ": "ฝาบุบ",
  "ฝาบุบเป็นเม็ด": "ฝาเป็นเม็ด",
  "ฝาบุบแหลม": "ฝาบุบ",
  "ฝายุบหัก": "ฝายุบ",
  "ฝารอย": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยกระแทก": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยขีด": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยขีดด้านล่าง": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยขีดด้านหน้า": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยขีดบุบ": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยขีดยาว": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยขีดหน้า": "ฝาเป็นรอย/รอยขีด",
  "ฝารอยยุบ": "ฝายุบ",
  "ฝารอยลึก": "ฝาเป็นรอย/รอยขีด",
  "ฝาสีลอก": "สีถลอก",
  "ฝาหน้าเป็นรอยขีด": "ฝาเป็นรอย/รอยขีด",
  "ฝาหักกลาง": "ฝาหัก",
  "ฝาหักขอบ": "ฝาหัก",
  "ฝาหักขอบข้าง": "ฝาหัก",
  "ฝาหักจากJIg": "ฝาหัก",
  "ฝาหักจากการเตรียม": "ฝาหัก",
  "ฝาหักด้านบน": "ฝาหัก",
  "ฝาหักมุม": "ฝาหัก",
  "ฝาหักยาวขอบข้าง": "ฝาหัก",
  "ฝาหักยุบ": "ฝาหัก",
  "ฝาเป็นรอย": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอย(กระจก)": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยขีด": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยขีดSheet": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยขีดในกระจก": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยขูดรถ": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยถลอก": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยที่แผ่น": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยนูน": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยปั๊ม": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยปากการ": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยปากกาเมจิก": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยเจอในรถ": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยเจาะ": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นรอยไหม้": "ฝาเป็นรอย/รอยขีด",
  "ฝาเป็นเม็ดนูน": "ฝาเป็นเม็ด",
  "ฝาเป็นเม็ดสี": "ฝาเป็นเม็ด",
  "ฝาเหล็กกลับด้าน": "ใส่ฝาเหล็กกลับด้าน/ผิด",
  "ฝาเหล็กเป็นเม็ดนูน": "ฝาเหล็กเป็นเม็ด",
  "ฝาในบยุบย่น": "ฝาในยุบ/ย่น",
  "ฝาในผิด": "ใส่ฝาในผิดรุ่น/สี",
  "ฝาในผิดรุ่น": "ใส่ฝาในผิดรุ่น/สี",
  "ฝาในผิดสี": "ใส่ฝาในผิดรุ่น/สี",
  "ฝาในมุดขอบ": "ฝาในมุด",
  "ฝาในม้วน": "ฝาในเป็นคลื่น",
  "ฝาในยุบ": "ฝาในยุบ/ย่น",
  "ฝาในยุบบุบ": "ฝาในยุบ/ย่น",
  "ฝาในยุบย่น": "ฝาในยุบ/ย่น",
  "ฝาในย่น": "ฝาในยุบ/ย่น",
  "ฝาในย่น/ยุบ": "ฝาในยุบ/ย่น",
  "ฝาในรลอย": "ฝาในลอย",
  "ฝาในรอย": "ฝาในเป็นรอย/รอยขีด",
  "ฝาในรอยขีด": "ฝาในเป็นรอย/รอยขีด",
  "ฝาในรอยลึก": "ฝาในเป็นรอย/รอยขีด",
  "ฝาในลอยสูง": "ฝาในลอย",
  "ฝาในหักหลุดขอบ": "ฝาในหลุดขอบ",
  "ฝาในเป็นรอย": "ฝาในเป็นรอย/รอยขีด",
  "ฝาในเป็นรอยขีด": "ฝาในเป็นรอย/รอยขีด",
  "ฝาในเป็นเม็ดนูน": "ฝาในเป็นเม็ด",
  "ฝาในเป็นเม็ดบนCap": "ฝาในเป็นเม็ด",
  "ฝาในเป็นเส้นนูน": "ฝาในเป็นเส้น",
  "ฝาในแป็นคลื่น": "ฝาในเป็นคลื่น",
  "ฝาไม่มีแม่เหล็ก": "ไม่มีแม่เหล็ก",
  "รอยCap": "Capเป็นรอย/รอยขีด",
  "รอยขีด": "รอยขีด (ไม่ระบุตำแหน่ง)",
  "รอยขีดCap": "Capเป็นรอย/รอยขีด",
  "รอยขีดจากSheet": "Capเป็นรอย/รอยขีด",
  "รอยขีดฝาใน": "ฝาในเป็นรอย/รอยขีด",
  "รูFixingเอียง": "รูHandleเอียง",
  "รูFixingไม่ตรง": "รูHandleเอียง",
  "รูใส่Handleเอียง": "รูHandleเอียง",
  "สายไฟขาดใน": "สายไฟขาด",
  "สายไฟสั้น": "สายไฟขาด",
  "สีลอก": "สีถลอก",
  "โฟมรั่ว Door Cap": "โฟมรั่ว",
  "โฟมรั่วCap": "โฟมรั่ว",
  "โฟมรั่วCapล่าง": "โฟมรั่ว",
  "โฟมรั่วCover": "โฟมรั่ว",
  "โฟมรั่วDisplay": "โฟมรั่ว",
  "โฟมรั่วDoor Cap": "โฟมรั่ว",
  "โฟมรั่วDoorCap": "โฟมรั่ว",
  "โฟมรั่วHandle": "โฟมรั่ว",
  "โฟมรั่วhandle": "โฟมรั่ว",
  "โฟมรั่วกล่องสายไฟ": "โฟมรั่ว",
  "โฟมรั่วก๊อก": "โฟมรั่ว",
  "โฟมรั่วก๊อกน้ำ": "โฟมรั่ว",
  "โฟมรั่วสายไฟ": "โฟมรั่ว",
  "โฟมรั่วหัว": "โฟมรั่ว",
  "โฟมรั่วออกCap": "โฟมรั่ว",
  "โฟมล้นCap": "โฟมล้น",
  "โฟมล้นCapบน": "โฟมล้น",
  "โฟมล้นDisplay": "โฟมล้น",
  "โฟมล้นขอบข้าง": "โฟมล้น",
  "โฟมล้นฝาใน": "โฟมล้น",
  "โฟมล้นหัวฉีด": "โฟมล้น",
  "โฟมล้นออกDisplay": "โฟมล้น",
  "ใส่Capไม่ลง": "Capไม่เข้า",
  "ใส่Capไม่เข้า": "Capไม่เข้า",
  "ใส่ฝากลับด้าน": "ใส่ฝากลับด้าน/ทาง",
  "ใส่ฝากลับทาง": "ใส่ฝากลับด้าน/ทาง",
  "ใส่ฝาผิด": "ใส่ฝาผิดรุ่น/สี",
  "ใส่ฝาผิดข้าง": "ใส่ฝากลับด้าน/ทาง",
  "ใส่ฝาผิดทาง": "ใส่ฝากลับด้าน/ทาง",
  "ใส่ฝาผิดรุ่น": "ใส่ฝาผิดรุ่น/สี",
  "ใส่ฝาผิดสี": "ใส่ฝาผิดรุ่น/สี",
  "ใส่ฝาเหล็กกลับด้าน": "ใส่ฝาเหล็กกลับด้าน/ผิด",
  "ใส่ฝาเหล็กกลับทาง": "ใส่ฝาเหล็กกลับด้าน/ผิด",
  "ใส่ฝาเหล็กผิด": "ใส่ฝาเหล็กกลับด้าน/ผิด",
  "ใส่ฝาในผิด": "ใส่ฝาในผิดรุ่น/สี",
  "ใส่ฝาในผิดรุ่น": "ใส่ฝาในผิดรุ่น/สี",
  "ใส่ฝาในหลุดขอบ": "ฝาในหลุดขอบ",
  "ไม่ใส่แม่เหล็ก": "ไม่มีแม่เหล็ก",
};

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
