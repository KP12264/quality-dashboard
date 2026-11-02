// Shift end at minute precision and the Leader window — Firestore Rules in the EMULATOR ONLY.
// The emulator runs on the real clock, so to test exact minutes the harness loads the rules with
// ONE change: qdBkkNow() gets a fixed offset so the server's "now" lands on the wanted instant.
// Everything else (the shift-end minutes, the window, request.time checks) is the real file.
// The browser's clock plays no part: closes are judged on request.time (server time).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
const SC = require('../../js/shift-close.js');
const { compatDb } = require('../support/compat-shim.js');

const RULES = fs.readFileSync(path.join(__dirname, '../../emulator/firestore.rules'), 'utf8');
const NOW_LINE = "return request.time + duration.value(7, 'h');";
const E = c => `${c.toLowerCase()}@prodv2.local`;
const X = '2026-06-10';   // production date used in every scenario (the server clock is moved to it)
let env;

// Rules whose "now" is `iso` (UTC instant) at the moment of the call (± a few seconds of test time).
async function envAt(iso) {
  if (env) await env.cleanup();
  assert.equal(RULES.split(NOW_LINE).length, 2, 'qdBkkNow() must contain the expected line exactly once');
  const offset = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const rules = RULES.replace(NOW_LINE, `return request.time + duration.value(7, 'h') + duration.value(${offset}, 's');`);
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules, host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const u = (role, slots) => ({ role, active: true, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(db, 'qdUsers', E('admin')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('leaderA')), u('leader', ['A_DAY', 'A_NIGHT']));
  });
}
async function close(code, date, shift) {
  const db = compatDb(env.authenticatedContext('uid-' + code, { email: E(code) }).firestore());
  try { await SC.closeSlot(db, { date, line: 'A', shift, state: 'CONFIRMED_ZERO' }, { email: E(code), serverTimestamp }); return 'closed'; }
  catch (e) { return /permission/i.test(e.code || e.message) ? 'refused' : 'error: ' + e.message; }
}
after(async () => { if (env) await env.cleanup(); });

describe('shift end (Door Line, Asia/Bangkok), judged on server time', () => {
  // DAY of X ends 19:50 Bangkok = 12:50 UTC on X. NIGHT of X ends 08:00 Bangkok on X+1 = 01:00 UTC on X+1.
  const cases = [
    ['DAY 19:49:30 → refused', '2026-06-10T12:49:30Z', 'DAY', 'refused'],
    ['DAY 19:50:30 → closed', '2026-06-10T12:50:30Z', 'DAY', 'closed'],
    ['NIGHT 07:59:30 next day → refused', '2026-06-11T00:59:30Z', 'NIGHT', 'refused'],
    ['NIGHT 08:00:30 next day → closed', '2026-06-11T01:00:30Z', 'NIGHT', 'closed'],
    ['NIGHT on its own date at 23:00 → refused (it belongs to the date it started)', '2026-06-10T16:00:00Z', 'NIGHT', 'refused']
  ];
  for (const [name, iso, shift, want] of cases) {
    it(name, async () => {
      await envAt(iso);
      assert.equal(await close('admin', X, shift), want);
    });
  }
});

describe('Leader window: 7 days back by production date (Thailand date)', () => {
  it('day 7 at 23:59:30 → allowed; day 8 at 00:00:30 → refused (Admin still allowed)', async () => {
    await envAt('2026-06-17T16:59:30Z');            // 2026-06-17 23:59:30 Bangkok = X + 7 days
    assert.equal(await close('leaderA', X, 'NIGHT'), 'closed');
    await envAt('2026-06-17T17:00:30Z');            // 2026-06-18 00:00:30 Bangkok = X + 8 days
    assert.equal(await close('leaderA', X, 'DAY'), 'refused');
    assert.equal(await close('admin', X, 'DAY'), 'closed');
  });
  it('the UTC date does not matter: 2026-06-17 18:00 UTC is already 2026-06-18 in Thailand', async () => {
    await envAt('2026-06-17T18:00:00Z');
    assert.equal(await close('leaderA', X, 'DAY'), 'refused');
  });
});
