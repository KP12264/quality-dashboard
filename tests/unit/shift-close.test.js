// Unit tests for js/shift-close.js (status derivation, fingerprint, shift timing) and the
// Leader date window (js/qd-auth.js + js/config.js vs emulator/firestore.rules).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SC = require('../../js/shift-close.js');
const { canRole, withinWindow } = require('../../js/qd-auth.js');
const S = SC.STATUS;

const log = (id, qty = 2, o = {}) => Object.assign({ id, date: '2026-11-01', line: 'A', shift: 'DAY', model: 'M1', defectType: 'Dent', scrapQty: qty }, o);
const closed = (logs, o = {}) => Object.assign({
  logVersion: 3, liveLogCount: logs.length, legacyCount: 0, closeState: logs.length ? S.SUBMITTED : S.CONFIRMED_ZERO,
  closedVersion: 3, closeRevision: 1, closedBy: 'a@prodv2.local', closedLogCount: logs.length,
  closedScrapQty: logs.reduce((n, l) => n + l.scrapQty, 0), closedLogIds: logs.map(l => l.id).sort(), closedFingerprint: SC.fingerprint(logs)
}, o);

test('no slot / no close document is PENDING, never zero', () => {
  assert.equal(SC.deriveStatus({ slot: null, logs: [] }).status, S.PENDING);
  assert.equal(SC.deriveStatus({ slot: { logVersion: 2, liveLogCount: 1 }, logs: [log('a')] }).status, S.PENDING);
});

test('closed and unchanged keeps its close state', () => {
  const logs = [log('a', 2), log('b', 5)];
  const r = SC.deriveStatus({ slot: closed(logs), logs });
  assert.equal(r.status, S.SUBMITTED);
  assert.equal(r.qty, 7);
  assert.equal(SC.deriveStatus({ slot: closed([]), logs: [] }).status, S.CONFIRMED_ZERO);
  assert.equal(SC.deriveStatus({ slot: closed([], { closeState: S.NO_PRODUCTION, noProductionReason: 'holiday' }), logs: [] }).status, S.NO_PRODUCTION);
});

test('a ledger write after the close is CHANGED and needs reconfirm', () => {
  const logs = [log('a'), log('b')];
  const r = SC.deriveStatus({ slot: closed([log('a')], { logVersion: 4, liveLogCount: 2 }), logs });
  assert.equal(r.status, S.CHANGED);
  assert.equal(r.needsReconfirm, true);
  // zero confirmed, then scrap added through the ledger → CHANGED (not a conflict)
  assert.equal(SC.deriveStatus({ slot: closed([], { logVersion: 4, liveLogCount: 1 }), logs: [log('x')] }).status, S.CHANGED);
});

test('logs changed without a version change are CONFLICT', () => {
  const logs = [log('a', 2)];
  const r = SC.deriveStatus({ slot: closed(logs), logs: [log('a', 9)] });
  assert.equal(r.status, S.CONFLICT);
  assert.ok(r.reasons.includes('changed-outside-ledger'));
});

test('ledger count mismatch (writes outside the ledger) is CONFLICT, even when not closed', () => {
  const r = SC.deriveStatus({ slot: { logVersion: 2, liveLogCount: 1 }, logs: [log('a'), log('b')] });
  assert.equal(r.status, S.CONFLICT);
  assert.ok(r.reasons.includes('ledger-count-mismatch'));
});

test('an unfinished import marker is CONFLICT', () => {
  const r = SC.deriveStatus({ slot: { logVersion: 1, liveLogCount: 1, importPending: { importId: 'i1', rows: 3 } }, logs: [log('a')] });
  assert.equal(r.status, S.CONFLICT);
  assert.deepEqual(r.reasons, ['import-incomplete']);
});

test('fingerprint depends on ids and quantities, not order', () => {
  const a = [log('a', 1), log('b', 2)];
  assert.equal(SC.fingerprint(a), SC.fingerprint([a[1], a[0]]));
  assert.notEqual(SC.fingerprint(a), SC.fingerprint([log('a', 1), log('b', 3)]));
  assert.notEqual(SC.fingerprint(a), SC.fingerprint([log('a', 1), log('c', 2)]));
  assert.notEqual(SC.fingerprint([]), SC.fingerprint(a));
});

test('shift end (Thailand time): DAY same evening, NIGHT next morning, whatever the device time zone', () => {
  const ends = { DAY: { dayOffset: 0, time: '20:00' }, NIGHT: { dayOffset: 1, time: '08:00' } };
  const at = iso => new Date(iso);
  assert.equal(SC.shiftEnded('2026-11-01', 'DAY', at('2026-11-01T12:59:00Z'), ends), false);   // 19:59 Bangkok
  assert.equal(SC.shiftEnded('2026-11-01', 'DAY', at('2026-11-01T13:00:00Z'), ends), true);    // 20:00 Bangkok
  assert.equal(SC.shiftEnded('2026-11-01', 'NIGHT', at('2026-11-01T16:00:00Z'), ends), false);
  assert.equal(SC.shiftEnded('2026-11-01', 'NIGHT', at('2026-11-02T01:00:00Z'), ends), true);  // 08:00 Bangkok next day
  assert.equal(SC.shiftEnded('2026-11-30', 'NIGHT', at('2026-12-01T01:01:00Z'), ends), true);  // month rollover
});

test('leader close window: 7 days back yes, 8 no; nobody closes the future', () => {
  const L = { role: 'leader', active: true, slots: ['A_DAY'] }, A = { role: 'admin', active: true, slots: [] };
  const ctx = date => ({ line: 'A', shift: 'DAY', date, today: '2026-11-10', windowDays: 7 });
  assert.equal(canRole(L, 'shift.close', ctx('2026-11-10')), true);
  assert.equal(canRole(L, 'shift.close', ctx('2026-11-03')), true);
  assert.equal(canRole(L, 'shift.close', ctx('2026-11-02')), false);
  assert.equal(canRole(L, 'shift.close', ctx('2026-11-11')), false);
  assert.equal(canRole(A, 'shift.close', ctx('2025-01-01')), true);
  assert.equal(canRole(A, 'shift.close', ctx('2026-11-11')), false);
  assert.equal(canRole(L, 'scrap.write', ctx('2026-11-02')), false);
  assert.equal(withinWindow('2026-10-31', '2026-11-07', 7), true);   // across a month end
});

test('config window and rules window are the same number', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '../../js/config.js'), 'utf8').match(/QD_LEADER_EDIT_WINDOW_DAYS\s*=\s*(\d+)/)[1];
  const rules = fs.readFileSync(path.join(__dirname, '../../emulator/firestore.rules'), 'utf8').match(/function qdLeaderWindowDays\(\)\s*\{\s*return\s+(\d+);/)[1];
  assert.equal(Number(cfg), Number(rules));
});

test('QD_AUTH_MODE is still off', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../../js/config.js'), 'utf8'), /const QD_AUTH_MODE = "off";/);
});
