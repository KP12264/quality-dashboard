// Unit tests for the Quality Dashboard permission matrix (js/qd-auth.js).
// The same matrix is enforced by emulator/firestore.rules (see tests/rules/).
const test = require('node:test');
const assert = require('node:assert/strict');
const { canRole, codeToEmail, PERMISSIONS, ALL_SLOTS, describeProfile } = require('../../js/qd-auth.js');

const admin = { role: 'admin', active: true, slots: [] };
const leaderA = { role: 'leader', active: true, slots: ['A_DAY', 'A_NIGHT'] };
const viewer = { role: 'viewer', active: true, slots: [] };
const disabledAdmin = { role: 'admin', active: false, slots: [] };

test('employee code becomes the Production V2 sign-in address', () => {
  assert.equal(codeToEmail(' KP001 '), 'kp001@prodv2.local');
  assert.equal(codeToEmail('Kp 0 01'), 'kp001@prodv2.local');
  assert.equal(codeToEmail('A1', '@x.local'), 'a1@x.local');
});

test('admin may do every action', () => {
  for (const action of Object.keys(PERMISSIONS)) assert.equal(canRole(admin, action, { line: 'C', shift: 'NIGHT' }), true, action);
});

test('viewer may not write anything', () => {
  for (const action of Object.keys(PERMISSIONS)) assert.equal(canRole(viewer, action, { line: 'A', shift: 'DAY' }), false, action);
});

test('leader writes scrap only on assigned Line/Shift', () => {
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'A', shift: 'DAY' }), true);
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'A', shift: 'NIGHT' }), true);
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'B', shift: 'DAY' }), false);
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'C', shift: 'NIGHT' }), false);
});

test('leader moving a record needs both the old and the new slot', () => {
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'A', shift: 'NIGHT', fromLine: 'A', fromShift: 'DAY' }), true);
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'B', shift: 'DAY', fromLine: 'A', fromShift: 'DAY' }), false);
  assert.equal(canRole(leaderA, 'scrap.write', { line: 'A', shift: 'DAY', fromLine: 'C', fromShift: 'DAY' }), false);
});

test('leader without any slot cannot write scrap at all', () => {
  const none = { role: 'leader', active: true, slots: [] };
  assert.equal(canRole(none, 'scrap.write', {}), false);
  assert.equal(canRole(none, 'scrap.write', { line: 'A', shift: 'DAY' }), false);
});

test('leader: improvements and weekly plans yes; import, mappings, targets, users no', () => {
  assert.equal(canRole(leaderA, 'improvement.write'), true);
  assert.equal(canRole(leaderA, 'weeklyPlan.write'), true);
  for (const a of ['scrap.import', 'mapping.write', 'targetMaster.write', 'users.manage']) assert.equal(canRole(leaderA, a), false, a);
});

test('disabled, missing or unknown profiles get nothing', () => {
  for (const action of Object.keys(PERMISSIONS)) {
    assert.equal(canRole(disabledAdmin, action), false);
    assert.equal(canRole(null, action), false);
    assert.equal(canRole({ role: 'superuser', active: true }, action), false);
  }
  assert.equal(canRole(admin, 'no.such.action'), false);
});

test('six slots per day: Door A/B/C x Day/Night', () => {
  assert.deepEqual(ALL_SLOTS, ['A_DAY', 'A_NIGHT', 'B_DAY', 'B_NIGHT', 'C_DAY', 'C_NIGHT']);
});

test('profile description shown in the sign-in box', () => {
  assert.equal(describeProfile(leaderA), 'Leader · A Day, A Night');
  assert.equal(describeProfile(admin), 'Admin');
  assert.equal(describeProfile(null), 'No Quality Dashboard role');
  assert.equal(describeProfile(disabledAdmin), 'Account disabled');
});
