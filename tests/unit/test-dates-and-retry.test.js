// (1) tests/support/dates.js: Asia/Bangkok dates and the 7-day leader window, also with a clock
//     30 days ahead (the tests must not go stale).
// (2) Guard: Rules / E2E tests may not hard-code a YYYY-MM-DD date (it leaves the leader window
//     after 7 days and the test starts failing for the wrong reason). Deliberate fixed dates carry
//     "fixed-date-ok" on the same line, or "fixed-date-ok (next line)" on the line above.
//     shift-time.test.js is exempt: it moves the emulator clock to the date it uses.
// (3) KI-1: which ledger transaction errors are retried (only refused commits).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('../support/dates.js');
const Ledger = require('../../js/scrap-ledger.js');

const H = 3600000;
test('dates: Thailand day boundary (UTC+7)', () => {
  assert.equal(D.thaiToday(Date.parse('2026-11-11T16:59:59Z')), '2026-11-11');
  assert.equal(D.thaiToday(Date.parse('2026-11-11T17:00:00Z')), '2026-11-12');
  assert.equal(D.daysAgo(1, Date.parse('2026-11-11T17:00:00Z')), '2026-11-11');
  assert.equal(D.daysAhead(2, Date.parse('2026-12-30T12:00:00Z')), '2027-01-01');
});

test('dates: leader window matches the rules (Thailand-now < date + 8 days)', () => {
  const now = Date.parse('2026-11-11T08:00:00Z');   // 15:00 ICT
  assert.equal(D.inLeaderWindow('2026-11-04', 7, now), true);    // 7 days ago: allowed
  assert.equal(D.inLeaderWindow('2026-11-03', 7, now), false);   // 8 days ago: refused (the old fixed date)
  assert.equal(D.inLeaderWindow('2026-11-03', 7, Date.parse('2026-11-10T16:59:59Z')), true);   // last second (23:59:59 ICT)
  assert.equal(D.inLeaderWindow('2026-11-03', 7, Date.parse('2026-11-10T17:00:00Z')), false);  // 00:00 ICT
});

test('dates: relative test dates stay valid with the clock 0 / 30 / 365 days ahead', () => {
  for (const ahead of [0, 30, 365]) {
    const now = Date.now() + ahead * 24 * H;
    for (const n of [1, 3, 4, 5, 6]) assert.equal(D.inLeaderWindow(D.daysAgo(n, now), 7, now), true, `daysAgo(${n}) +${ahead}d`);
    assert.equal(D.inLeaderWindow(D.daysAgo(10, now), 7, now), false, `daysAgo(10) +${ahead}d`);
  }
});

test('guard: no hard-coded YYYY-MM-DD in Rules / E2E tests (except fixed-date-ok and shift-time)', () => {
  const root = path.join(__dirname, '..');
  const files = ['rules', 'e2e'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.test.js')).map(f => path.join(d, f)))
    .filter(f => !/shift-time\.test\.js$/.test(f));
  const DATE = /['"`]20\d\d-\d\d-\d\d|`20\d\d-\d\d-\$\{/;
  const found = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, (m) => /fixed-date-ok/.test(m) ? m : '');
      if (!DATE.test(code)) return;
      if (/fixed-date-ok/.test(l) || /fixed-date-ok \(next line\)/.test(lines[i - 1] || '')) return;
      found.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, [], 'hard-coded dates:\n' + found.join('\n'));
});

test('KI-1: only refused commits are retried', () => {
  const k = Ledger.retryKind;
  assert.equal(k({ code: 'failed-precondition', message: '9 FAILED_PRECONDITION: the stored version (17) does not match the required base version (16)' }), 'conflict');
  assert.equal(k({ code: 'aborted', message: 'Transaction lock timeout.' }), 'conflict');
  assert.equal(k({ code: 'permission-denied', message: 'x' }), 'denied');
  // not retried: other failed-precondition, already-exists, and ambiguous outcomes
  assert.equal(k({ code: 'failed-precondition', message: 'The query requires an index.' }), null);
  assert.equal(k({ code: 'already-exists', message: 'Document already exists' }), null);
  assert.equal(k({ code: 'unavailable', message: 'x' }), null);
  assert.equal(k({ code: 'deadline-exceeded', message: 'x' }), null);
  assert.equal(k({ code: 'qd/busy', message: 'x' }), null);
  assert.equal(k(new Error('This scrap record no longer exists')), null);
  assert.ok(Ledger.MAX_CONFLICT_ATTEMPTS >= 3 && Ledger.MAX_CONFLICT_ATTEMPTS <= 10);
});
