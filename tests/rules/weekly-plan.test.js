// Weekly Plan V5 — Firestore Rules, EMULATOR ONLY (candidate rules; nothing is published).
//   scrapWeeklyPlans/{ym}_{W#}           public read (numbers only); Admin write, ALWAYS with its history entry
//   scrapWeeklyPlans/{id}/history/{rev}  signed-in read; Admin create only; immutable
//   scrapWeeklyReviews/{ym}_{W#}         signed-in read; Admin write
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, collection, query, where, serverTimestamp } = require('firebase/firestore');

const E = c => `${c.toLowerCase()}@prodv2.local`;
let env;
const fsOf = c => c ? env.authenticatedContext('uid-' + c, { email: E(c) }).firestore() : env.unauthenticatedContext().firestore();
async function raw(fn) { let o; await env.withSecurityRulesDisabled(async ctx => { o = await fn(ctx.firestore()); }); return o; }
const YM = '2026-11', ID = '2026-11_W2';

// One plan change the way js/weekly-plan-data.js writes it (a batch here: same commit semantics).
function change(c, { id = ID, ym = YM, week = 'W2', planOverride, rev, from = null, reason = 'Line B trial run', plan = {}, hist = {}, skipHistory = false, skipPlan = false }) {
  const db = fsOf(c), b = writeBatch(db);
  if (!skipPlan) b.set(doc(db, 'scrapWeeklyPlans', id), Object.assign({ ym, week, planOverride, historyRev: rev, updatedAt: serverTimestamp() }, plan));
  if (!skipHistory) b.set(doc(db, 'scrapWeeklyPlans', id, 'history', String(rev)), Object.assign({ from, to: planOverride, reason, at: serverTimestamp(), by: E(c || 'anon') }, hist));
  return b.commit();
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-quality-dashboard', firestore: { rules: fs.readFileSync(path.join(__dirname, '../..', process.env.QD_RULES_FILE || 'emulator/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await raw(async db => {
    const u = (role, slots, active = true) => ({ role, active, displayName: role, slots, updatedAt: 1, updatedBy: E('admin') });
    await setDoc(doc(db, 'qdUsers', E('admin')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('admin2')), u('admin', []));
    await setDoc(doc(db, 'qdUsers', E('leaderA')), u('leader', ['A_DAY']));
    await setDoc(doc(db, 'qdUsers', E('viewer')), u('viewer', []));
    await setDoc(doc(db, 'qdUsers', E('gone')), u('admin', [], false));
  });
});
after(async () => { if (env) await env.cleanup(); });

describe('weekly plan: who may write', () => {
  it('Admin: first override with history rev 1 (from = default)', async () => {
    await assertSucceeds(change('admin', { planOverride: 300, rev: 1 }));
    const p = await raw(async db => (await getDoc(doc(db, 'scrapWeeklyPlans', ID))).data());
    assert.equal(p.planOverride, 300); assert.equal(p.historyRev, 1);
  });
  it('Admin: next change needs rev 2 and from = the previous value; back to default (null) is allowed', async () => {
    await assertFails(change('admin', { planOverride: 250, rev: 2, from: null }));        // wrong "from"
    await assertFails(change('admin', { planOverride: 250, rev: 3, from: 300 }));         // skips a revision
    await assertFails(change('admin', { planOverride: 250, rev: 1, from: 300 }));         // re-uses a revision
    await assertSucceeds(change('admin2', { planOverride: 250, rev: 2, from: 300 }));
    await assertSucceeds(change('admin', { planOverride: null, rev: 3, from: 250 }));
  });
  it('a plan change without its history entry (or history without the plan change) is refused', async () => {
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, skipHistory: true }));
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, skipPlan: true }));
  });
  it('history must state the new value, a reason, the signed-in admin and server time', async () => {
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, hist: { to: 199 } }));
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, reason: 'x' }));
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, reason: 'y'.repeat(201) }));
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, hist: { by: E('admin2') } }));
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, hist: { at: new Date() } }));
    await assertFails(change('admin', { planOverride: 200, rev: 4, from: null, hist: { note: 'extra' } }));
  });
  it('plan values: whole pcs 0…350 (50 × 7) or null; no other fields (no personal data, no review note)', async () => {
    for (const v of [-1, 351, 12.5, '100']) await assertFails(change('admin', { planOverride: v, rev: 4, from: null }));
    for (const extra of [{ reviewNote: 'n' }, { updatedBy: E('admin') }, { createdBy: E('admin') }]) await assertFails(change('admin', { planOverride: 100, rev: 4, from: null, plan: extra }));
    await assertFails(change('admin', { planOverride: 100, rev: 4, from: null, plan: { updatedAt: new Date() } }));
    await assertSucceeds(change('admin', { planOverride: 0, rev: 4, from: null }));
  });
  it('document id must be {ym}_{week} with a valid month and week', async () => {
    await assertFails(change('admin', { id: '2026-11_W3', planOverride: 100, rev: 1 }));
    await assertFails(change('admin', { id: '2026-13_W1', ym: '2026-13', week: 'W1', planOverride: 100, rev: 1 }));
    await assertFails(change('admin', { id: '2026-11_W7', week: 'W7', planOverride: 100, rev: 1 }));
    await assertSucceeds(change('admin', { id: '2026-11_W5', week: 'W5', planOverride: 100, rev: 1 }));
  });
  it('Leader, Viewer, an inactive admin and anonymous users cannot change plans', async () => {
    for (const c of ['leaderA', 'viewer', 'gone', null, 'nobody']) await assertFails(change(c, { id: '2026-11_W1', week: 'W1', planOverride: 10, rev: 1 }));
  });
  it('nobody may delete a plan or change / delete history', async () => {
    await assertFails(deleteDoc(doc(fsOf('admin'), 'scrapWeeklyPlans', ID)));
    await assertFails(updateDoc(doc(fsOf('admin'), 'scrapWeeklyPlans', ID, 'history', '1'), { reason: 'rewritten' }));
    await assertFails(deleteDoc(doc(fsOf('admin'), 'scrapWeeklyPlans', ID, 'history', '1')));
    await assertFails(setDoc(doc(fsOf('admin'), 'scrapWeeklyPlans', ID, 'history', '9'), { from: null, to: 1, reason: 'orphan', at: serverTimestamp(), by: E('admin') }));
  });
});

describe('weekly plan: who may read', () => {
  it('anyone (public Dashboard card) reads the plan numbers, also with the month query', async () => {
    await assertSucceeds(getDoc(doc(fsOf(null), 'scrapWeeklyPlans', ID)));
    await assertSucceeds(getDocs(query(collection(fsOf(null), 'scrapWeeklyPlans'), where('ym', '==', YM))));
  });
  it('override history (who, reason) is signed-in only: Admin, Leader and Viewer read it, the public does not', async () => {
    await assertFails(getDocs(collection(fsOf(null), 'scrapWeeklyPlans', ID, 'history')));
    await assertFails(getDoc(doc(fsOf('nobody'), 'scrapWeeklyPlans', ID, 'history', '1')));
    await assertFails(getDoc(doc(fsOf('gone'), 'scrapWeeklyPlans', ID, 'history', '1')));
    for (const c of ['admin', 'leaderA', 'viewer']) await assertSucceeds(getDocs(collection(fsOf(c), 'scrapWeeklyPlans', ID, 'history')));
  });
});

describe('weekly review notes (not public)', () => {
  const note = (c, o = {}) => setDoc(doc(fsOf(c), 'scrapWeeklyReviews', o.id || ID), Object.assign({ ym: YM, week: 'W2', reviewNote: 'Dent on B: jig check', updatedAt: serverTimestamp(), updatedBy: E(c || 'anon') }, o.data || {}));
  it('Admin writes; Leader / Viewer / anonymous cannot', async () => {
    await assertSucceeds(note('admin'));
    for (const c of ['leaderA', 'viewer', null]) await assertFails(note(c));
  });
  it('bad review documents are refused', async () => {
    await assertFails(note('admin', { data: { reviewNote: 'z'.repeat(2001) } }));
    await assertFails(note('admin', { data: { updatedBy: E('admin2') } }));
    await assertFails(note('admin', { data: { updatedAt: new Date() } }));
    await assertFails(note('admin', { id: '2026-11_W3' }));
    await assertFails(note('admin', { data: { extra: 1 } }));
  });
  it('signed-in users read them (also by month query); the public cannot', async () => {
    await assertFails(getDoc(doc(fsOf(null), 'scrapWeeklyReviews', ID)));
    await assertFails(getDocs(query(collection(fsOf(null), 'scrapWeeklyReviews'), where('ym', '==', YM))));
    for (const c of ['admin', 'leaderA', 'viewer']) await assertSucceeds(getDocs(query(collection(fsOf(c), 'scrapWeeklyReviews'), where('ym', '==', YM))));
  });
});
