# รายการ BLOCKED และสิ่งที่ต้องดำเนินการ

| รหัส | เรื่อง | ทำไม BLOCKED | สิ่งที่ต้องทำ / ใคร |
|---|---|---|---|
| G1 | Rules ที่ Deploy จริงบน `daily-production-report-46b60` | ไม่มีสำเนา; หลักฐานว่าต่างจาก repo (QD โหมด off เขียนได้ ทั้งที่ snapshot ปฏิเสธ) | Firebase Owner ส่งออกข้อความ Rules ปัจจุบัน (Console > Rules) ให้ทีม → แทน PV2 block แล้วรันเทสต์ซ้ำ |
| G2 | ผู้รับผิดชอบ Deploy / ไฟล์ Rules เดียวของทั้งสองระบบ | Deploy ไฟล์ของระบบใดระบบหนึ่งเดี่ยว ๆ จะทำให้อีกระบบหยุด (ทดสอบแล้ว: PV2 rules เดี่ยว → QD ถูกปฏิเสธทั้งหมด) | ตกลงว่าไฟล์รวมอยู่ repo ไหน, ใครอนุมัติ/Publish |
| G4 | Public Read Policy | `scrapLogs`, `scrapCloseSummary`, `targetMaster`, `improvements`, `scrapModelMappings`, `scrapWeeklyPlans` อ่านได้โดยไม่ Sign-in (Dashboard Public ต้องใช้) | ผู้บริหาร/IT อนุมัติ; ถ้าไม่อนุมัติต้องออกแบบ Dashboard แบบ Sign-in |
| B1 | วันเริ่มใช้ `QD_CLOSE_REQUIRED_FROM` | ต้องอนุมัติ และต้องไม่ย้อนหลัง | Release Owner กำหนดหลังอบรม Leader |
| B2 | Admin คนแรก + รายชื่อ Role/Slot | ห้ามสร้าง/แก้บัญชีใน Phase นี้ | QD Owner เตรียมรายชื่อ, Firebase Owner สร้าง `qdUsers` ตอน Go-live |
| M1 | Migration กับข้อมูลจริง | ห้ามอ่าน/แก้ Production โดยไม่ได้รับอนุญาต | อนุมัติให้ Dry Run กับสำเนา (export) หรืออ่านอย่างเดียว |
| M2 | ตัวรัน Migration สำหรับ Production | มีไลบรารี (`tools/migration/ledger-baseline.js`) แต่ยังไม่มีหน้า Admin/สคริปต์ที่ใช้สิทธิ์จริง (ตั้งใจไม่ทำโดยไม่มีสิทธิ์) | Phase ถัดไป: ปุ่มใน Admin page (ต้อง Sign-in admin) หรือสคริปต์ที่ใช้ credentials ที่อนุมัติ |
| C1 | ค่าใช้จ่ายการอ่านใน Rules (getAfter/exists) | Emulator ไม่คิดเงิน | ดูบิลจริงหลัง Go-live สัปดาห์แรก |
| C2 | Region / ราคาต่อหน่วย | ไม่เข้าถึง Console | Firebase Owner ระบุ |
| L1 | หน้าเก่า (`dashboard.html`, `js/scrap-entry.html`, `dashboard-classic.html`) | ยังเข้าถึงได้; ใน enforce จะบันทึกไม่ได้ (fail-closed) | ตัดสินใจลบ/redirect |
| L2 | `prodV2_authorizedUsers` อ่านได้สาธารณะ (รายชื่อพนักงาน) | เป็น Rules ของ PV2 — ห้ามแก้ | แจ้ง PV2 Owner |

## ความเสี่ยงที่อาจทำให้ระบบหยุดทำงาน (ไม่ได้แก้ระบบจริง — รายงานเท่านั้น)

1. **Deploy Rules ของ PV2 จาก repo PV2 ทับ** → Quality Dashboard ทั้งหมดหยุด (อ่าน+เขียน). ป้องกัน: G2.
2. **Deploy Draft รวมโดยไม่มี Rules จริง (G1)** → อาจตัดสิทธิ์ที่ PV2 ใช้อยู่จริงแต่ไม่อยู่ใน snapshot → PV2 หยุด.
3. **Deploy Draft รวมขณะเว็บ QD ยังเป็น off** → การบันทึก Scrap/Target/Improvement ของ QD ถูกปฏิเสธทันที.
