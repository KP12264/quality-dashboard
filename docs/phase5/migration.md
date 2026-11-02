# Data Migration — Ledger Baseline (Dry Run Report & Plan)

> ไม่มีการอ่านหรือเขียนข้อมูล Firebase Production ใน Phase นี้. Dry Run ทำบน **ข้อมูลจำลอง** ใน Emulator เท่านั้น.
> การรันกับข้อมูลจริงต้องได้รับอนุญาต (BLOCKED M1) และใช้ได้เฉพาะสำเนาที่อนุญาตหรือในหน้าต่าง Deploy ตาม Runbook.

## 1. โครงสร้าง Scrap Logs เดิม (จากโค้ด)

`scrapLogs/{auto-id}`: `date` (YYYY-MM-DD), `shift` (DAY/NIGHT — ข้อมูลเก่าบางส่วนอาจเป็น "เช้า"/"ดึก"), `line` (A/B/C),
`model`, `defectType`, `scrapQty` (>0), `remark`, `createdAt` และฟิลด์จาก Excel import (`importBatchId`, `scrapCost`, …).
ไม่มี Ledger, ไม่มี version, ไม่มี createdBy (บันทึกแบบไม่ Sign-in).

## 2. ทำไมต้องมี Baseline

ถ้าไม่มี Migration, Slot จะถูกสร้างครั้งแรกโดย Client (Leader) ซึ่ง **ระบุ `legacyCount` เอง** (นับจาก query) — Rules ตรวจไม่ได้ว่าตรงจริง.
Baseline ทำให้ตัวเลขนี้มาจากการนับของ Admin ครั้งเดียว มี Audit `b1` (รายการ log id + fingerprint) และหลังตั้ง
`qdConfig/ledger.baselineComplete = true` Rules จะ **ยอมให้สร้าง Slot ใหม่ได้เฉพาะ `legacyCount == 0`**.
(สถานะยังตรวจเทียบกับ log จริงทุกครั้งที่โหลด — `legacyCount` ไม่เคยเป็นหลักฐานเดียว)

## 3. สิ่งที่ Migration สร้าง (additive เท่านั้น — ไม่แก้/ลบ scrapLogs)

| เอกสาร | ค่า |
|---|---|
| `scrapSlots/{date}_{line}_{shift}` | `logVersion 0`, `liveLogCount = legacyCount = จำนวน log`, `updatedBy` = Admin |
| `scrapSlots/{id}/events/b1` | `type BASELINE`, `migrationId`, `legacyCount`, `scrapQty`, `logIds`, `fingerprint`, `at`, `by` |
| `scrapCloseSummary/{date}.slots[LINE_SHIFT]` | public view (ไม่มีข้อมูลบุคคล) |
| `qdConfig/ledger` (ขั้นสุดท้าย) | `baselineComplete true`, `migrationId`, `at`, `by` |

Version Counter เริ่ม 0 → การเขียนแรกผ่าน Ledger = v1. Fingerprint = FNV-1a ของ (id, date, line, shift, model, defectType, scrapQty).
Log ที่ไม่ใช่ Door A/B/C × DAY/NIGHT หรือวันที่ผิดรูปแบบ **ไม่ถูก Migrate** (Target ไม่เคยนับอยู่แล้ว) และถูกรายงานแยก.

เครื่องมือ: `tools/migration/ledger-baseline.js` — `planBaseline` → `verifyPlan` → `applyBaseline` → `verifyApplied` → `markComplete`.

## 4. ผล Dry Run (ข้อมูลจำลอง, Emulator)

ดูรายละเอียด: [generated/migration-dry-run.md](generated/migration-dry-run.md) (สร้างโดย `tests/rules/migration.test.js`)

- 539 logs / 2,747 pcs → Baseline 216 slots (531 logs, 2,726 pcs) · ข้าม 1 slot ที่มี Ledger แล้ว · ยกเว้น 6 logs (รหัสกะภาษาไทย, Door D, วันที่ผิดรูปแบบ)
- ทุก log ถูกนับครั้งเดียวพอดี · หลัง Apply ตรวจซ้ำ 0 mismatch · รันซ้ำ = idempotent (สร้าง 0)
- **scrapLogs ไม่เปลี่ยนแม้แต่ไบต์เดียว** (SHA-256 ก่อน/หลังตรงกัน) · ยอดรายวันเท่าเดิมทุกวัน
- หลัง Baseline ทุก Slot เป็น PENDING (ไม่มี CONFLICT ปลอม)
- เฉพาะ Admin สร้าง Baseline ได้ · `b1` ที่จำนวนไม่ตรงถูกปฏิเสธ
- หลัง `baselineComplete`: log ที่เขียนอ้อม Ledger (โหมด off) บน Slot ใหม่ → การเขียน/ปิดยอดถูกปฏิเสธ (ไม่ถูกกลืน) · บน Slot ที่ Migrate แล้ว → CONFLICT · Admin แก้ด้วย Baseline ซ้ำเฉพาะ Slot (มี Audit)
- Slot ที่มี 450 logs: Baseline และการปิดยอดผ่าน Rules (budget test)

## 5. ข้อมูลเก่าที่นำเข้าโดยไม่มี Ledger

- ก่อน Migration: Slot ถูกสร้างตอนเขียนครั้งแรก (lazy) — ยังใช้ได้ แต่ `legacyCount` มาจาก Client
- ระหว่าง Migration ถึงการเปิด enforce: **ต้อง freeze การบันทึก** (Runbook ขั้น 4) ไม่งั้น log ใหม่แบบ off จะไม่อยู่ใน Baseline → ถูกจับได้ (CONFLICT หรือถูกปฏิเสธ) แต่ต้องแก้ทีละ Slot
- Excel import ย้อนหลังหลังเปิดใช้: ผ่าน Ledger + Import Marker ตามปกติ (Slot ใหม่มี legacyCount 0)

## 6. Recovery & Rollback

| สถานการณ์ | วิธีแก้ |
|---|---|
| Apply ล้มบาง Slot | รัน `applyBaseline` ซ้ำ (ข้าม Slot ที่มีแล้ว) → `verifyApplied` จน 0 mismatch → ค่อย `markComplete` |
| พบ mismatch หลัง Apply (มีคนเขียนระหว่าง freeze) | ห้าม `markComplete`; ตรวจ Slot นั้น, ลบ log ที่ผิด (ถ้าอนุมัติ) หรือรอ — Slot ที่สร้างแล้วลบผ่าน Rules ไม่ได้ ใช้ Restore จาก Backup หรือ Admin SDK (นอกขอบเขต Rules) |
| ต้องยกเลิกการเปิดใช้ทั้งหมด | ดู Runbook ส่วน R: กลับ `QD_AUTH_MODE = "off"` + Rules เดิม. เอกสารที่ Migration สร้างไม่ถูกใช้เมื่อ off (ไม่ต้องลบ) |
| ต้องลบข้อมูล Migration จริง ๆ | Restore จาก Firestore export ที่ทำในขั้น Backup (Runbook ขั้น 2) |

## 7. ค่าใช้จ่าย Migration (ประมาณ)

Reads ≈ จำนวน scrapLogs ทั้งหมด (1 ครั้ง) + 2 ต่อ Slot · Writes ≈ 3 ต่อ Slot (+1 config).
ตัวอย่าง 10,000 logs / ~3,000 slots ≈ 16,000 reads + 9,000 writes (ราคาต่อหน่วยตาม Region — NOT VERIFIED).
