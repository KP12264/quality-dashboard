# Security Rules Impact Matrix & Integration

> **BLOCKED G1:** ยังไม่มีสำเนา Rules ที่ Deploy อยู่จริงบน `daily-production-report-46b60`.
> การเปรียบเทียบทั้งหมดในเอกสารนี้ทำกับ **สำเนาใน repository** (`production-v2/firestore.rules` @ `431836a`,
> เก็บไว้ที่ `emulator/production-v2.firestore.rules.snapshot`) ซึ่ง **ไม่ได้รับการยืนยันว่าตรงกับ Production**
> และมีหลักฐานว่าไม่ตรง (ดูข้อ 3).

## 1. Collection ที่ใช้ (จากโค้ด)

| Collection | ระบบ | ใครอ่าน | ใครเขียน (Draft) | หมายเหตุ |
|---|---|---|---|---|
| `productionLogs` | Legacy | ทุกคน | ทุกคน (เปิดเหมือนเดิม) | QD อ่านอย่างเดียว |
| `prodV2_authorizedUsers` | PV2 | ทุกคน | ไม่มีใคร (Console เท่านั้น) | อ่านได้สาธารณะ = รายชื่อพนักงานรั่ว (ข้อสังเกตเดิม, ไม่แก้เพราะเป็นของ PV2) |
| `prodV2_*` (dailyPlans, actualLogs, …) | PV2 | ทุกคน | ผู้อยู่ใน `prodV2_authorizedUsers` | QD อ่าน Plan/Actual อย่างเดียว |
| `qdUsers` | QD | admin, เจ้าของเอกสาร | admin | ห้าม Public |
| `scrapLogs` | QD | ทุกคน (G4) | ผ่าน Ledger เท่านั้น + Slot ของตน + 7 วัน | |
| `scrapSlots` (+ `events/v,c,m,b`) | QD | ผู้มี Role QD ที่ active | ผ่าน Ledger/Close/Marker/Baseline | มี email ผู้ทำรายการ → ไม่ Public |
| `scrapCloseSummary` | QD | ทุกคน (G4) | เขียนพร้อม Slot เท่านั้น | ไม่มีข้อมูลบุคคล |
| `qdConfig/ledger` | QD | ผู้มี Role QD | admin | สถานะ Migration |
| `targetMaster`, `improvements`, `scrapModelMappings`, `scrapWeeklyPlans` | QD | ทุกคน (G4) | admin | Leader อ่านอย่างเดียว |
| อื่น ๆ | — | ไม่มี | ไม่มี | default deny |

## 2. Impact Matrix (ผลจากการทดสอบจริงใน Emulator)

`tests/rules/pv2-compat.test.js` ส่งคำขอชุดเดียวกัน (6 identity × 15 path × 5 operation = 450 คำขอ) ไปที่
(ก) PV2 Rules อย่างเดียว และ (ข) Rules รวม (Draft) แล้วสร้างตาราง → [generated/rules-impact-matrix.md](generated/rules-impact-matrix.md)

ข้อสรุปที่เทสต์ยืนยัน:

| ข้อ | ผล |
|---|---|
| Path ของ Production V2 และ `productionLogs` | **เหมือนเดิมทุก identity ทุก operation** (ไม่มีผลกระทบต่อ PV2) |
| Path ของ QD ภายใต้ PV2 Rules อย่างเดียว | **ถูกปฏิเสธทั้งหมด** → ถ้า Deploy PV2 Rules ทับ QD จะหยุดทำงาน (ทั้งอ่านและเขียน) |
| เขียนข้ามระบบ | Role QD เขียน `prodV2_*` ไม่ได้ · ผู้เขียน PV2 เขียน Collection ของ QD ไม่ได้ |
| ยกระดับสิทธิ์ | เฉพาะ QD admin เขียน `qdUsers` ได้ · Leader ตั้งตัวเองเป็น admin ไม่ได้ · ไม่มีใครเขียน `prodV2_authorizedUsers` ได้ |
| Public (ไม่ Sign-in) | อ่านข้อมูล Dashboard ได้ · อ่าน `qdUsers`, `scrapSlots`, Audit Events **ไม่ได้** |

## 3. ความเสี่ยงจากการ Deploy Rules ทับกัน (Firestore มี Rules ได้ชุดเดียวต่อ Project)

| ความเสี่ยง | ผลกระทบ | ระดับ | การป้องกัน |
|---|---|---|---|
| Deploy `production-v2/firestore.rules` (repo PV2) | QD ทุก Collection ถูกปฏิเสธ → Dashboard/Scrap Entry/Executive Report ใช้ไม่ได้ | **สูง** | ห้าม Deploy ไฟล์ PV2 เดี่ยว ๆ อีกต่อไป → ต้องมีไฟล์รวมไฟล์เดียว (G2) |
| Deploy Draft รวมของ QD ทั้งที่ Production มี Rules ที่ต่างจาก snapshot | อาจลบสิทธิ์ที่ PV2 ใช้อยู่จริงแต่ไม่อยู่ใน snapshot → PV2 หยุดทำงาน | **สูง** | **BLOCKED G1**: ต้องได้สำเนา Rules จริง แล้ว diff + เทสต์ซ้ำก่อน |
| QD ที่ใช้งานอยู่วันนี้ (`off`) เขียน `scrapLogs`/`targetMaster`/… โดยไม่ Sign-in | แปลว่า Rules จริงตอนนี้ **เปิดกว้างกว่า** snapshot (snapshot ปฏิเสธ) → หลักฐานว่า Production ≠ snapshot | — | ยืนยัน G1 |
| Deploy Draft รวม ขณะที่เว็บยังเป็น `QD_AUTH_MODE = "off"` | การบันทึก Scrap/Target/Improvement แบบไม่ Sign-in ถูกปฏิเสธทันที (Dashboard อ่านได้ปกติ) | **สูง** | เปลี่ยน `enforce` + Deploy Rules ในหน้าต่างเวลาเดียวกัน, แจ้งผู้ใช้ปิดแท็บเก่า |
| หน้าเก่าที่ยังเข้าถึงได้ (`dashboard.html`, `js/scrap-entry.html`, `dashboard-classic.html`) | เมื่อ enforce: เขียนไม่ได้ (fail-closed: `qd/ledger-missing` + Rules ปฏิเสธ) | ต่ำ | แนะนำลบ/redirect ใน Phase ถัดไป |
| Rules ใกล้ขีดจำกัด 1000 expressions ใน Slot create | Phase 5 พบว่าลำดับเงื่อนไขทำให้เกินขีดได้ → แก้แล้ว + มี `tests/rules/budget.test.js` | กลาง | ต้องรัน budget test ทุกครั้งที่แก้ Rules |

## 4. Authentication ร่วม / Role แยก

- บัญชี Firebase Auth เดียวกับ PV2 (`<code>@prodv2.local`, ไม่มี Sign-up ทั้งสองระบบ)
- สิทธิ์ PV2 = มีเอกสารใน `prodV2_authorizedUsers` · สิทธิ์ QD = `qdUsers/{email}` ที่ `active == true`
- สองชุดไม่อ้างถึงกัน → การมีสิทธิ์ในระบบหนึ่งไม่ให้สิทธิ์อีกระบบ (เทสต์: pv2Writer เขียน QD ไม่ได้, qdAdmin เขียน PV2 ไม่ได้)
- การตรวจสิทธิ์ฝั่ง Client เป็นเพียง UI; Rules เป็นตัวบังคับจริง

## 5. Rules ฉบับรวมสำหรับ Emulator

`emulator/firestore.rules` = PV2 block (verbatim จาก snapshot, เทสต์ยืนยันว่าตรงตัวอักษร) + QD block.
**ห้าม Deploy.** ก่อนใช้งานจริงต้อง: (1) ได้ Rules จริง (G1) (2) แทน PV2 block ด้วยของจริง (3) รัน `npm run test:rules` ทั้งหมด รวม `pv2-compat` และ `budget` (4) ผู้รับผิดชอบทั้งสองระบบอนุมัติ (G2)
