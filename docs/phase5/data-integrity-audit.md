# Shift Close — Data Integrity Audit

ทุกข้อด้านล่างมีเทสต์อัตโนมัติรองรับ (Emulator). คอลัมน์ "Enforced by": R = Firestore Rules, C = Client, T = ตรวจตอนแสดงผล.

| # | ข้อตรวจ | ผล | Enforced by | เทสต์ |
|---|---|---|---|---|
| 1 | `legacyCount` ไม่ใช่หลักฐานเดียว | ✅ สถานะเทียบ fingerprint + จำนวน log จริงทุกครั้ง; หลัง Baseline Client ระบุ legacyCount > 0 ไม่ได้ | R + T | `migration.test.js`, `shift-close.test.js` (legacy), `target-close.test.js` |
| 2 | Audit Event ครบ: `v{n}` ทุกการเขียน log, `c{n}` ทุกการปิด/Reconfirm (มี `previous`), `m{n}` ทุก Marker, `b1` Baseline; แก้/ลบไม่ได้ | ✅ | R | `rules.test.js`, `shift-close.test.js`, `close-summary.test.js`, `migration.test.js` |
| 3 | Fingerprint ตรวจว่า log ที่ปิดยอดยังเป็นชุดเดิม (id/จำนวน/รุ่น/defect) | ✅ เปลี่ยนโดยไม่ผ่าน Ledger → CONFLICT | T | `shift-close.test.js` (unit + rules) |
| 4 | แก้ Scrap หลังปิดยอด → CHANGED → ต้อง Reconfirm, ไม่นับเป็นปิดแล้ว | ✅ | R (version) + T | `shift-close*.test.js`, `target-close.test.js`, E2E |
| 5 | Import ล้มบางส่วน → `importPending` ค้าง → CONFLICT, ปิดยอดไม่ได้ (ทั้ง Leader/Admin); Import ซ้ำในกะที่ค้างถูกปฏิเสธก่อนเขียน | ✅ ทดสอบด้วยไฟล์ CSV จริงผ่าน UI | R + C | `shift-close.test.js`, `target-close.e2e.test.js` |
| 6 | ล้าง `importPending` เฉพาะ Admin, เฉพาะ importId ของตน, มี Audit `m{n}`; Ledger write ล้างเองไม่ได้ | ✅ | R | `close-summary.test.js` |
| 7 | ปิดยอดพร้อมแก้ Scrap (20 รอบชนกัน) — การปิดที่บันทึกได้ตรงกับ version ที่นับเสมอ | ✅ | R (transaction + version) | `shift-close.test.js` |
| 8 | ไม่มีช่องทางเขียน Scrap ข้าม Ledger | ✅ Rules ปฏิเสธ; สแกนโค้ดทุกไฟล์ + ตรวจ adapter แบบ dynamic | R + C | `rules.test.js`, `no-ledger-bypass.test.js` |
| 9 | ปิดซ้ำ version เดิม: Leader ไม่ได้, Admin Reconfirm ได้; กดปิดพร้อมกัน 2 คน → บันทึก 1 | ✅ | R + C | `shift-close.test.js` |
| 10 | Public Summary ตรงกับ Slot ทุกการเขียน; เขียนค่าผิด/แทนสายอื่น/ไม่ Sign-in ไม่ได้; ไม่มี email/เหตุผล/โน้ต | ✅ | R | `close-summary.test.js` |
| 11 | ปิดยอดก่อนเวลาจบกะไม่ได้ แม้ปรับนาฬิกาเครื่อง (ใช้เวลา Server) | ✅ ระดับนาที (19:49/19:50, 07:59/08:00) | R | `shift-time.test.js`, E2E clock test |
| 12 | Leader แก้/ปิดย้อนหลังได้ 7 วันตามวันผลิต (วันที่ไทย) | ✅ วันที่ 7 23:59 ได้ / วันที่ 8 00:00 ไม่ได้ | R + C | `shift-time.test.js` |
| 13 | ไม่มี Scrap Log ≠ 0 (PENDING / INCOMPLETE / NO DATA) | ✅ | T | `target-close.test.js` |
| 14 | ออฟไลน์ระหว่างบันทึก → ล้มทั้งหมด ไม่มีครึ่ง ๆ, ต่อเน็ตแล้วบันทึกได้ | ✅ | Transaction | E2E offline test |

## ข้อจำกัดที่ยังเหลือ

- Rules ไม่ตรวจ `closedLogIds` ทีละ id (ตรวจขนาด + fingerprint ตอนแสดงผล)
- การเขียน `scrapLogs` แบบไม่ผ่าน Ledger ยังทำได้ถ้า Rules จริงเปิดอยู่ (ปัจจุบันโหมด off) — ปิดได้ก็ต่อเมื่อ Deploy Rules (G1/G2)
- ผู้มีสิทธิ์ Console/Admin SDK ข้าม Rules ได้ทั้งหมด (โดยธรรมชาติของ Firebase)
