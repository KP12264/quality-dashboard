# Phase 5 — Test Results

ทั้งหมดรันใน Emulator project `demo-quality-dashboard` (หรือ mock สำหรับ Regression) — ไม่แตะ Firebase Production.

| ชุด | คำสั่ง | ผล |
|---|---|---|
| Unit | `npm run test:unit` | 38/38 |
| Rules (Emulator) | `npm run test:rules` | 98/98 — รวม `pv2-compat`, `shift-time`, `migration`, `budget`, `close-summary`, `shift-close`, `ledger-load`, `rules` |
| E2E (Chromium + Emulator) | `npm run test:e2e` | 34/34 — Auth/Permission, Scrap Entry/Detail, Shift Close/Reconfirm, Daily Confirmation, Dashboard V5, Executive Report + CSV, Excel import ไฟล์ CSV จริง, Public Dashboard, นาฬิกาเครื่อง, ออฟไลน์ |
| Regression (repo) | `npm run test:regression` | 15/15 |
| Dashboard V5 off-mode matrix (107 สถานการณ์) | scratch harness | ตรงกับ Phase 2 ทุกสถานการณ์ (diff 0) |
| ix (ทั้งระบบ, รวม Executive Report) | scratch harness | 21/21 |

## ครอบคลุมตามที่ขอ

| หัวข้อ | เทสต์ |
|---|---|
| DAY 19:49 ไม่ได้ / 19:50 ได้ · NIGHT 07:59 ไม่ได้ / 08:00 ได้ · NIGHT ผูกวันเริ่มกะ | `rules/shift-time.test.js` (เวลา Server), `unit/target-close.test.js` (Client) |
| Leader ย้อนหลัง 7 วันตามวันผลิต (วันที่ไทย) | `rules/shift-time.test.js`, `rules/close-summary.test.js` |
| เปลี่ยนนาฬิกาเครื่องเพื่อปิดก่อนเวลาไม่ได้ | `e2e/shift-close.e2e.test.js` (clock test) |
| Production V2 Rules Compatibility | `rules/pv2-compat.test.js` (differential 450 คำขอ) |
| ยกระดับสิทธิ์ / เขียนข้ามระบบ | `rules/pv2-compat.test.js`, `rules/rules.test.js` |
| Migration ไม่เปลี่ยนยอด | `rules/migration.test.js` |
| ไม่มีช่องเขียนข้าม Ledger | `unit/no-ledger-bypass.test.js`, `rules/rules.test.js` |
| Rules access calls / 1000 expressions | `rules/budget.test.js`, `rules/ledger-load.test.js` |
| Network failure / concurrent / retry | `e2e/shift-close.e2e.test.js` (offline), `rules/ledger-load.test.js`, `rules/shift-close.test.js` |
| พฤติกรรมเดิมเมื่อ `QD_AUTH_MODE = "off"` | Regression + matrix + ix + `e2e/auth.e2e.test.js` (off mode) |
