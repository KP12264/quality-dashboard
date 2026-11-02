# Deployment & Rollback Runbook — Shift Scrap Close

> **ห้ามดำเนินการใน Phase 5.** เอกสารนี้ใช้ตอนได้รับอนุมัติ Go-live แล้วเท่านั้น และทุกขั้นที่แตะ Production
> ต้องทำโดยผู้รับผิดชอบที่ได้รับมอบหมาย (G2). ระบบที่กระทบ: Production V2 + Quality Dashboard (Firestore Rules ชุดเดียวกัน).

## บทบาท

| บทบาท | หน้าที่ | ผู้รับผิดชอบ |
|---|---|---|
| Release Owner | ตัดสิน GO/NO-GO ทุก Gate | ⛔ ต้องระบุ |
| Firebase Owner | Backup, ดึง/Deploy Rules, สร้าง Admin คนแรก | ⛔ ต้องระบุ (G2) |
| PV2 Owner | ยืนยัน Rules ส่วน PV2 + Smoke Test PV2 | ⛔ ต้องระบุ |
| QD Admin | รัน Migration, ตั้ง Role, Smoke Test QD | ⛔ ต้องระบุ |

## Gate 0 — ก่อนเริ่ม (GO เมื่อทุกข้อ ✔)

- [ ] ได้สำเนา Rules ที่ Deploy จริง (G1) และแทน PV2 block ใน `emulator/firestore.rules` แล้ว
- [ ] `npm test` ผ่านทั้งหมด (unit / regression / rules รวม `pv2-compat` + `budget` + `migration` / e2e) บน commit ที่จะ Deploy
- [ ] PV2 Owner อนุมัติ diff ของ Rules ส่วน PV2 (ต้องว่างเปล่าเทียบกับของจริง)
- [ ] อนุมัติ Public Read Policy (G4) — รวม `scrapCloseSummary`
- [ ] รายชื่อ Admin/Leader/Viewer และ Slot ของ Leader พร้อม (ไม่มีบัญชีใหม่ — ใช้บัญชี PV2 ที่มีอยู่)
- [ ] ประกาศหน้าต่างเวลา + การ freeze การบันทึก Scrap ของ QD
- **NO-GO** ถ้าข้อใดไม่ครบ

## ขั้นตอน

| ขั้น | การกระทำ | ตรวจผล / GO เมื่อ | ถ้าล้ม |
|---|---|---|---|
| 1 | ประกาศ freeze: หยุดบันทึก/Import Scrap ใน QD (PV2 ใช้งานต่อได้) | ไม่มี scrapLogs ใหม่ในช่วง freeze | เลื่อน |
| 2 | **Backup**: `gcloud firestore export gs://<bucket>/qd-golive-<date>` + บันทึกไฟล์ Rules ปัจจุบัน (ข้อความเต็ม) | export สำเร็จ, เก็บ Rules ไว้ 2 ที่ | NO-GO |
| 3 | Dry Run Migration กับสำเนาที่อนุญาต (หรืออ่านอย่างเดียว) → `planBaseline` + `verifyPlan` | `verifyPlan = []`, ยอดรวม/รายวันตรงกับ Dashboard ปัจจุบัน | NO-GO |
| 4 | สร้าง Admin คนแรกใน `qdUsers/{code@prodv2.local}` ผ่าน Console (`role admin, active true, slots []`) | Admin Sign-in ใน QD เห็น role | แก้เอกสาร |
| 5 | **Deploy Rules รวม** (Console > Rules > Publish ไฟล์ที่ผ่าน Gate 0) | Rules Playground: PV2 writer เขียน `prodV2_*` ได้, ไม่ Sign-in อ่าน Dashboard ได้ | **R2 ทันที** |
| 6 | Smoke PV2 (ภายใน 10 นาที): เปิด Dashboard PV2, บันทึก Entry 1 รายการด้วยบัญชีจริงที่ได้รับอนุญาต | บันทึกได้ อ่านได้ | **R2 ทันที** |
| 7 | Deploy เว็บ QD ที่ `QD_AUTH_MODE = "enforce"` (`QD_CLOSE_REQUIRED_FROM` ยัง `null`) | หน้าเว็บแสดงกล่อง Sign-in; Dashboard Public เปิดได้ไม่ต้อง Sign-in | R1 |
| 8 | **Migration** (Admin): `applyBaseline` → `verifyApplied` (0 mismatch) → `markComplete` | `qdConfig/ledger.baselineComplete = true`; ยอด Dashboard ทุกวันเท่าก่อน Migration | ห้าม markComplete; รันซ้ำ/ตรวจ (ดู migration.md §6) |
| 9 | Smoke QD: Leader บันทึก 1 รายการ (Slot ตัวเอง) → ลบ; Leader บันทึก Slot อื่นถูกปฏิเสธ; Viewer บันทึกไม่ได้; Admin เปิด Daily Confirmation; Dashboard/Executive Report ยอดตรงก่อน Deploy; Public ไม่เห็น email | ทุกข้อผ่าน | R1 (+R2 ถ้าเป็นที่ Rules) |
| 10 | ยกเลิก freeze; เฝ้าดู 1–3 วัน (Leader ปิดยอดจริงได้, ไม่มี CONFLICT แปลก ๆ) | | R1 |
| 11 | (Release แยก หลังอบรม) ตั้ง `QD_CLOSE_REQUIRED_FROM` = วันที่อนุมัติ (≥ วันขั้น 10, **ไม่ย้อนหลัง**) แล้ว Deploy เว็บ | วันก่อนหน้านั้นสถานะเท่าเดิม; วันนั้นเป็นต้นไปใช้ 6 กะ | ตั้งกลับเป็น `null` |

## Rollback

| รหัส | เมื่อไร | วิธี | ผล |
|---|---|---|---|
| R1 | ปัญหาฝั่งเว็บ QD | Deploy เว็บที่ `QD_AUTH_MODE = "off"` (หรือ revert commit config) | QD กลับเป็นแบบเดิม — **แต่ถ้า Rules รวมยังอยู่ การบันทึกแบบ off จะถูกปฏิเสธ** → ใช้ R2 ร่วมถ้าต้องให้บันทึกได้ |
| R2 | PV2 หรือ QD ใช้งานไม่ได้หลังเปลี่ยน Rules | Publish ไฟล์ Rules เดิมที่เก็บไว้ในขั้น 2 | กลับสู่สภาพก่อน Deploy ทันที |
| R3 | ข้อมูลผิดร้ายแรง | Restore จาก export ขั้น 2 (เฉพาะ Collection ที่เสีย) — ต้องอนุมัติ | ข้อมูลหลัง export หายใน Collection ที่ restore |
| R4 | สถานะ Target ผิดหลังตั้งวันเริ่มใช้ | `QD_CLOSE_REQUIRED_FROM = null` แล้ว Deploy | Target กลับกฎเดิมทันที (ไม่ต้องแก้ข้อมูล) |

ข้อมูลที่ Shift Close สร้าง (`scrapSlots`, events, `scrapCloseSummary`, `qdConfig`) เป็นแบบ additive: เมื่อ Rollback ไม่ต้องลบ และไม่กระทบ PV2.

## NO-GO ทันทีเมื่อ

- ไม่มีสำเนา Rules จริง / PV2 Owner ไม่อนุมัติ
- เทสต์ใด ๆ ไม่ผ่านบน commit ที่จะ Deploy
- Backup ไม่สำเร็จ
- Smoke Test ของ PV2 ล้มเหลวหลัง Deploy Rules (→ R2 ทันที)
