# Phase 5 — Production Readiness & Deployment Preparation

Shift Scrap Close · Quality Dashboard · branch `claude/vigilant-pasteur-l91qt3`

> สถานะ: **พร้อมในระดับ Emulator / Development Branch เท่านั้น** — ยังไม่ Deploy, ยังไม่แตะ Firebase Production,
> `QD_AUTH_MODE = "off"`, `QD_CLOSE_REQUIRED_FROM = null`. การเปิดใช้จริงต้องผ่านรายการ BLOCKED ใน [blocked.md](blocked.md) ก่อน

| # | เอกสาร | ไฟล์ |
|---|---|---|
| 1 | Production Readiness Checklist | หน้านี้ (ด้านล่าง) |
| 2 | Security Rules Impact Matrix | [rules-impact.md](rules-impact.md) · ตารางที่สร้างจากเทสต์: [generated/rules-impact-matrix.md](generated/rules-impact-matrix.md) |
| 3 | Data Migration / Dry Run Report | [migration.md](migration.md) · ผล Dry Run: [generated/migration-dry-run.md](generated/migration-dry-run.md) |
| 4 | Data Integrity Audit | [data-integrity-audit.md](data-integrity-audit.md) |
| 5 | Performance & Firestore Cost Assessment | [performance-cost.md](performance-cost.md) |
| 6 | Deployment & Rollback Runbook (GO / NO-GO) | [deployment-runbook.md](deployment-runbook.md) |
| 7 | ผลทดสอบ | [test-results.md](test-results.md) |
| 8 | รายการ BLOCKED | [blocked.md](blocked.md) |

## 1. Production Readiness Checklist

สถานะ: ✅ พร้อม (ทดสอบแล้วใน Emulator) · ⛔ BLOCKED (ต้องมีผู้ตัดสินใจ/ข้อมูลจริง) · ⏳ ทำตอน Deploy

### Configuration (`js/config.js`)

| รายการ | ค่าปัจจุบัน | ค่าที่จะใช้ตอนเปิดจริง | สถานะ |
|---|---|---|---|
| `QD_AUTH_MODE` | `"off"` | `"enforce"` — เปลี่ยน **พร้อมกับ** Deploy Rules ในหน้าต่างเวลาเดียวกัน (ดู Runbook ขั้น 6–8) | ⛔ รออนุมัติ + Rules จริง (G1/G2) |
| `QD_CLOSE_REQUIRED_FROM` | `null` | วันที่อนุมัติ (ไม่ย้อนหลัง, ต้อง ≥ วันที่ Migration + เปิด enforce เสร็จ) | ⛔ รออนุมัติวันที่ |
| `QD_SHIFT_END` | DAY `19:50` วันผลิต · NIGHT `08:00` วันถัดไป | เท่าเดิม (ยืนยันแล้ว Phase 5) | ✅ Client = Rules (`qdShiftEndMinutes` 1190/1920) ตรวจระดับนาที |
| `QD_LEADER_EDIT_WINDOW_DAYS` | `7` | `7` (นโยบายเริ่มต้น) | ✅ Client = Rules (`qdLeaderWindowDays`) ตามวันที่ไทย |
| `QD_TZ_OFFSET_HOURS` / `QD_TIME_ZONE` | `7` / `Asia/Bangkok` | เท่าเดิม | ✅ Rules ใช้ `request.time` (เวลา Server) |

### Firebase

| รายการ | สถานะ |
|---|---|
| Firebase Auth: ใช้บัญชีเดียวกับ Production V2 (`<code>@prodv2.local`), ไม่มี Sign-up | ✅ ออกแบบ+ทดสอบแล้ว (Phase 1) |
| Role แยกใน `qdUsers/{email}` (admin / leader / viewer) — ไม่อ่าน `prodV2_authorizedUsers` | ✅ ทดสอบการยกระดับสิทธิ์/เขียนข้ามระบบแล้ว |
| Admin คนแรกของ `qdUsers` (สร้างผ่าน Console โดยผู้มีสิทธิ์) | ⛔ ต้องมีผู้รับผิดชอบ (ห้ามสร้างบัญชีใน Phase นี้) |
| Rules ที่ Deploy จริงของ `daily-production-report-46b60` | ⛔ G1 — ยังไม่มีสำเนา **ห้ามสมมติว่าไฟล์ใน repo ตรงกับ Production** |
| ผู้รับผิดชอบ Deploy Rules (ไฟล์เดียวใช้ร่วม PV2 + QD) | ⛔ G2 |
| Public Read Policy (`scrapLogs`, `scrapCloseSummary`, `targetMaster`, `improvements`, …) | ⛔ G4 — ต้องอนุมัติ |
| Backup ก่อน Deploy (Firestore export) | ⏳ Runbook ขั้น 2 |
| Smoke Test หลัง Deploy | ⏳ Runbook ขั้น 9 |
| Rollback | ✅ วางแผนแล้ว (Runbook ส่วน R) — ข้อมูลที่เพิ่มเป็นแบบ additive ไม่ต้องลบ |

### ฟังก์ชันและข้อมูล

| รายการ | สถานะ |
|---|---|
| Ledger + Version + Audit (`v{n}`), Close (`c{n}`), Import Marker (`m{n}`), Baseline (`b1`) | ✅ |
| Public Summary `scrapCloseSummary` (ไม่มี email/เหตุผล/โน้ต) ถูกบังคับให้ตรงกับ Slot | ✅ |
| Migration Baseline + `qdConfig/ledger.baselineComplete` (หลังจากนั้น Client ระบุ `legacyCount` ไม่ได้) | ✅ Dry Run บนข้อมูลจำลอง · ⛔ การรันจริงต้องได้รับอนุญาต |
| Target Evaluator เดียว (Dashboard V5 / Executive Report / CSV) 7 สถานะ | ✅ |
| พฤติกรรมเดิมเมื่อ `QD_AUTH_MODE = "off"` | ✅ Regression ตรงเดิม 107/107 + 21/21 + 15/15 |
| Production V2 Rules Compatibility (Emulator, differential) | ✅ ทุก path ของ PV2/legacy ให้ผลเหมือนเดิมทุก identity/operation |
