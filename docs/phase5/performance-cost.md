# Performance & Firestore Cost Assessment

ตัวเลขด้านล่าง **วัดจริงใน Emulator** (นับตามวิธีคิดเงินของ Firestore: query = จำนวนเอกสารที่ได้ ขั้นต่ำ 1; get = 1).
ราคาต่อหน่วยขึ้นกับ Region และไม่ได้ยืนยัน (NOT VERIFIED). ไม่มี `onSnapshot` หรือ `setInterval` ใหม่ในทุก Phase.

## 1. Reads ต่อการเปิดหน้า

| หน้า | การอ่าน | เพิ่มจาก Shift Close |
|---|---|---|
| Dashboard V5 (Public), ช่วง 9 วัน | production 60 + scrapLogs 8 + improvements 1 | `scrapCloseSummary` 6 (≤ 1 ต่อวันที่ต้องปิดยอด; 0 เมื่อ `QD_CLOSE_REQUIRED_FROM = null`) |
| Dashboard 30 วัน (ประมาณ) | production ~180 + scrapLogs N | ≤ 30 |
| Executive Report (รายเดือน) | เหมือน Dashboard | ≤ 30 |
| Daily Confirmation (Sign-in) | `qdUsers` 1 + scrapLogs ของวัน (1 query) + `scrapSlots` 6 | — (Phase 5 แก้การโหลดซ้ำจาก 12 → 6) |
| แผง Shift Close ใน Scrap Entry | `qdUsers` 1 + slot 1 + scrapLogs ของกะ 1 query | — (Phase 5 แก้การโหลดซ้ำจาก 2 → 1) |

scrapLogs ถูกอ่านครั้งเดียวต่อการแสดงผล (ไม่อ่านซ้ำเพื่อคำนวณสถานะ).

## 2. Writes ต่อการกระทำ

| การกระทำ | Writes | Reads ใน transaction |
|---|---|---|
| บันทึก/แก้/ลบ Scrap 1 รายการ | log 1 + slot 1 + event 1 + summary 1 = 4 | log (แก้/ลบ) + slot + summary (+ query นับ legacy ครั้งแรกของ Slot ก่อน Baseline) |
| ปิดยอด / Reconfirm | slot 1 + event 1 + summary 1 = 3 | slot + summary + query log ของกะ (ก่อนและหลัง เพื่อยืนยัน) |
| Import n แถว (Slot เดียว) | n + 3 ต่อ chunk + marker set/clear 2×3 | |
| Migration | ~3 ต่อ Slot | ~2 ต่อ Slot + อ่าน scrapLogs ทั้งหมดครั้งเดียว |

**getAfter/existsAfter/get ใน Rules:** เอกสารของ Firebase ระบุว่าการเรียกเอกสารใน Rules คิดเป็น read — ยังไม่ได้ยืนยันกับบิลจริง (NOT VERIFIED). ต่อการบันทึก 1 ครั้งมีการเข้าถึงเอกสารประมาณ 5–7 รายการ (profile, slot ก่อน/หลัง, event, summary, qdConfig).

## 3. ขีดจำกัดของ Rules (วัดจริง, `tests/rules/budget.test.js` + `ledger-load.test.js`)

| กรณี | ผล |
|---|---|
| log ต่อ transaction (Slot เดียว) | 450 ผ่าน (Import ใช้ 200) |
| Slot ต่อ transaction | 4 ผ่าน, 5–6 ถูกปฏิเสธ (access-call limit) → Client จำกัดที่ 4; หน้าเว็บใช้ 1–2 |
| ledger v1: legacy 300 + ใหม่ 200 (Leader) | ผ่าน |
| ปิดยอด Slot ที่มี 450 log | ผ่าน |
| Import chunk 450 แถวเข้า Slot ที่มี Marker | ผ่าน |
| Baseline 450 log ids | ผ่าน |
| ย้ายรายการข้ามกะ/ข้ามวัน (2 Slot, 2 Summary) | ผ่าน |
| **1000-expression limit** | Phase 5 พบว่า Slot create (กรณี legacyCount > 0) เกินขีดเมื่อเงื่อนไข Baseline อยู่ต้น branch → ย้ายไปท้าย branch แล้วผ่านทุกกรณี. **ต้องรัน budget test ทุกครั้งที่แก้ Rules** |

## 4. Concurrency / Network

- 15 การบันทึกพร้อมกันใน Slot เดียว (5 Leader): บันทึกครบ 15, version 1..15 ไม่ข้าม
- 6 Slot ของวันเดียวกันเขียนพร้อมกัน (ใช้ Summary เอกสารเดียวกัน): ผ่านทั้งหมด
- ปิดยอดชนกับการแก้ 20 รอบ: ไม่มีการปิดที่ผิด version
- ออฟไลน์: transaction ล้มทันที (`unavailable`), ไม่มีการเขียนครึ่ง ๆ, ต่อเน็ตแล้วบันทึกได้
- Retry: เฉพาะเมื่อ version ของ Slot เปลี่ยนจริง (สูงสุด 20 ครั้ง, backoff + jitter)

## 5. ข้อจำกัด/ค่าใช้จ่ายที่ยังยืนยันไม่ได้

- บิลจริงของการอ่านใน Rules (getAfter/exists) — NOT VERIFIED
- Contention จริงของ Summary ต่อวัน เมื่อ Leader หลายคนบันทึกพร้อมกันบนเครือข่ายโรงงาน (Emulator ไม่มี latency จริง)
- ราคา Region ของ project — ต้องดูใน Console
