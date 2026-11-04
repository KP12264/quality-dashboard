// Final UI review & release readiness — Firebase EMULATOR ONLY (npm run test:e2e).
// A realistic month (tests/support/release-seed.js) is seeded, then:
//   1. Dashboard V5 with the Scrap Budget card at 1440 / 1024 / 820 / 390 px: section order,
//      no horizontal scroll, card size; screenshots.
//   2. weekly-plan.html in every important state (summary, weeks, days, Line × Shift, Improve,
//      Admin edit, review note, No data, So far, Provisional, Final, Over); screenshots.
//   3. Default plan: no plan document vs. plans denied by the rules (production snapshot) vs.
//      a read error — never shown as a confirmed plan.
//   4. Firestore cost: queries and document reads, Dashboard 1 / 7 / 30 / 31 days, filter
//      changes, Refresh, reopen; Weekly Plan month switching, Reload, previous-month goal.
// Screenshots go to docs/release-readiness/screens (QD_SHOT_DIR) at QD_SHOT_SCALE (default 1);
// the cost table to docs/release-readiness/generated/read-cost.md.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { seedRelease, E } = require('../support/release-seed.js');

const ROOT = path.join(__dirname, '../..');
const PORT = 5516;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = 'demo-quality-dashboard';
const AUTH = 'http://127.0.0.1:9099';
const SDK = path.join(__dirname, '../node_modules/firebase-compat');
const CHART = path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js');
const PASSWORD = 'test-password-1';
const SHOTS = process.env.QD_SHOT_DIR || path.join(ROOT, 'docs/release-readiness/screens');
const SCALE = Number(process.env.QD_SHOT_SCALE || 1);
const RULES = { candidate: 'emulator/firestore.rules', production: 'emulator/production.firestore.rules.snapshot' };
let env, server, browser, M;
const cost = [];   // rows for read-cost.md
const shots = [];

async function useRules(name) {
  if (env) await env.cleanup();
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(ROOT, RULES[name]), 'utf8'), host: '127.0.0.1', port: 8080 } });
}
async function authCall(method, url, body) {
  const res = await fetch(AUTH + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}

// Read counter (installed before the page's scripts): per collection, queries (get calls) and documents.
const COUNT = () => {
  window.__qdReads = {};
  const bump = (name, s) => { const R = window.__qdReads; const r = R[name] = R[name] || { gets: 0, docs: 0, billed: 0 }; r.gets++; const n = typeof s.size === 'number' ? s.size : 1; r.docs += n; r.billed += Math.max(1, n); };
  const wrap = (o, name) => new Proxy(o, { get(t, p) {
    const v = t[p];
    if (['where', 'orderBy', 'limit', 'doc'].includes(p)) return (...a) => wrap(v.apply(t, a), name);
    if (p === 'collection') return (...a) => wrap(v.apply(t, a), name + '/' + a[0]);
    if (p === 'get') return async (...a) => { const s = await v.apply(t, a); bump(name, s); return s; };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  let real = null;
  Object.defineProperty(window, 'qdDb', { configurable: true, get: () => real, set: v => { real = v ? new Proxy(v, { get(t, p) { if (p === 'collection') return n => wrap(t.collection(n), n); const x = t[p]; return typeof x === 'function' ? x.bind(t) : x; } }) : v; } });
};
// Simulated failures for one page (wrap the adapters as soon as the page defines them).
const FAIL = kind => {
  const hook = (name, fn) => { let v; Object.defineProperty(window, name, { configurable: true, get: () => v, set: x => { v = x ? fn(x) : x; } }); };
  if (kind === 'plans') hook('WeeklyPlanData', x => Object.assign({}, x, { loadPlans: async () => ({ overrides: {}, error: { code: 'unavailable', message: 'simulated read error' }, queries: 1, docs: 0 }) }));
  if (kind === 'scrap') hook('ScrapDataAdapter', x => Object.assign({}, x, { getScrapData: async () => ({ records: [], error: { code: 'unavailable', message: 'simulated read error' } }) }));
};

async function newPage(width = 1440, opts = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: SCALE, acceptDownloads: true });
  await context.addInitScript(COUNT);
  if (opts.fail) await context.addInitScript(FAIL, opts.fail);
  await context.route('**/*', route => {
    const url = route.request().url();
    const m = url.match(/gstatic\.com\/firebasejs\/10\.13\.0\/(firebase-[a-z-]+\.js)/);
    if (m) return route.fulfill({ path: path.join(SDK, m[1]), contentType: 'application/javascript' });
    if (/chart\.umd(\.min)?\.js/.test(url)) return route.fulfill({ path: CHART, contentType: 'application/javascript' });
    if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1:8080') || url.startsWith(AUTH)) return route.continue();
    return route.fulfill({ status: 200, body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/permission|PERMISSION_DENIED|Failed to load resource|simulated|could not be read/i.test(m.text())) errors.push(m.text()); });
  return { page, context, errors };
}
async function shot(page, name, selector) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name + '.png');
  // hide the emulator test-mode banner (fixed position: it would cover content in a full-page image)
  await page.addStyleTag({ content: '#qdAuthEmu{display:none!important}' }).catch(() => {});
  if (selector) await (await page.$(selector)).screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  shots.push(name);
}
const q = () => `qdEmulator=1&qdCloseFrom=${M.closeFrom}`;
async function signIn(page, code) {
  await page.click('#qdAuthOpen'); await page.fill('#qdAuthCode', code); await page.fill('#qdAuthPassword', PASSWORD);
  await page.click('#qdAuthSubmit');
  await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
  await page.waitForFunction(() => !window.QDAuth.getState().checking, null, { timeout: 15000 });
}
// Dashboard helpers
async function dashOpen(page, extra = '') {
  await page.goto(`${BASE}/index.html?${q()}${extra}`);
  await dashSettled(page);
}
async function dashSettled(page, ym) {
  await page.waitForFunction(y => window.__qdPlanCard && window.__qdPlanCard.month && (!y || window.__qdPlanCard.ym === y)
    && !/Loading/.test(document.getElementById('attentionSummary').textContent), ym || null, { timeout: 30000 });
  await page.waitForTimeout(400);
}
async function dashRange(page, from, to) {
  await page.evaluate(() => { window.__qdPlanCard = null; });
  await page.evaluate(([f, t]) => { const a = document.getElementById('dateFrom'), z = document.getElementById('dateTo'); z.value = t; a.value = f; z.dispatchEvent(new Event('change')); }, [from, to]);
  await dashSettled(page, to.slice(0, 7));
}
const resetReads = page => page.evaluate(() => { window.__qdReads = {}; });
const reads = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__qdReads)));
const sum = r => Object.values(r).reduce((a, x) => ({ gets: a.gets + x.gets, docs: a.docs + x.docs, billed: a.billed + (x.billed || 0) }), { gets: 0, docs: 0, billed: 0 });
function record(screen, action, r, note = '') { cost.push({ screen, action, r, note }); }
// Weekly plan helpers
async function planOpen(page, ym, extra = '') {
  await page.goto(`${BASE}/weekly-plan.html?${q()}&ym=${ym}${extra}`);
  await planSettled(page, ym);
}
async function planSettled(page, ym) {
  await page.waitForFunction(y => window.__qdWeeklyPlan && window.__qdWeeklyPlan.month && window.__qdWeeklyPlan.month.ym === y && document.getElementById('wpWeeksTable'), ym, { timeout: 30000 });
  await page.waitForTimeout(300);
}
const weekRow = (page, w) => page.evaluate(k => {
  const tr = document.querySelector(`#wpWeeksTable tr[data-week="${k}"]`);
  return { budget: tr.querySelector('[data-dim="budget"]').dataset.status, daily: tr.querySelector('[data-dim="daily"]').dataset.status, data: tr.querySelector('[data-dim="data"]').dataset.status, status: tr.querySelector('[data-dim="budget"]').dataset.status, source: tr.querySelector('[data-source]').dataset.source, text: tr.textContent.replace(/\s+/g, ' ').trim() };
}, w);

before(async () => {
  await useRules('candidate');
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  browser = await chromium.launch();
  await env.clearFirestore();
  await authCall('DELETE', `/emulator/v1/projects/${PROJECT}/accounts`);
  for (const c of ['ADMIN1', 'LEADA', 'VIEW1']) await authCall('POST', `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { email: E(c), password: PASSWORD });
  M = await seedRelease(env);
});
after(async () => {
  if (cost.length) {
    const cell = (r, c) => r[c] ? `${r[c].gets} / ${r[c].docs}` : '–';
    const commit = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) { return '?'; } })();
    const dirty = (() => { try { return require('child_process').execSync('git status --porcelain -- js css *.html', { cwd: ROOT }).toString().trim() ? ' + uncommitted changes' : ''; } catch (e) { return ''; } })();
    const cols = ['scrapLogs', 'prodV2_actualLogs', 'scrapCloseSummary', 'scrapWeeklyPlans', 'improvements', 'targetMaster'];
    const md = ['# Firestore Read Cost (generated)', '',
      `Generated by \`tests/e2e/release-readiness.e2e.test.js\` (Firebase Emulator, seeded month ${M.ym}, Shift Close from ${M.closeFrom}).`,
      `Code: commit \`${commit}\`${dirty}.`,
      'Each cell: **queries / documents returned**, counted in the browser on every Firestore `get()` (a query = its documents, a document get = 1).',
      '**Billed (est.)** = what Firestore would bill: each document returned, at least 1 per query (an empty query is billed 1 read), 1 per document get (also when it does not exist).',
      'Limitation: the emulator has no billing, so billed reads are an estimate from the same counts; the Firebase Console (Usage) is the only source of actual billed reads. Query count is never used as reads.',
      'Counts are for the action alone (counter reset before it). Columns not shown were not read.', '',
      `| Screen | Action | ${cols.join(' | ')} | other | Total queries / docs | Billed (est.) | Note |`, `|---|---|${cols.map(() => '---').join('|')}|---|---|---|---|`,
      ...cost.map(x => {
        const other = Object.keys(x.r).filter(k => !cols.includes(k));
        const t = sum(x.r);
        return `| ${x.screen} | ${x.action} | ${cols.map(c => cell(x.r, c)).join(' | ')} | ${other.map(k => `${k} ${x.r[k].gets}/${x.r[k].docs}`).join(', ') || '–'} | **${t.gets} / ${t.docs}** | **${t.billed}** | ${x.note} |`;
      })].join('\n');
    fs.mkdirSync(path.join(ROOT, 'docs/release-readiness/generated'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs/release-readiness/generated/read-cost.md'), md + '\n');
  }
  if (browser) await browser.close();
  if (server) server.kill();
  if (env) await env.cleanup();
});

describe('1. Dashboard V5 with the Scrap Budget card', () => {
  for (const width of [1440, 1024, 820, 390]) {
    it(`${width} px: sections in order, no horizontal scroll, card not dominant`, async () => {
      const { page, context, errors } = await newPage(width);
      await dashOpen(page);
      await dashRange(page, M.d(1), M.d(M.nDays));
      const lay = await page.evaluate(() => {
        const y = id => { const e = document.getElementById(id); return e ? e.getBoundingClientRect().top + scrollY : null; };
        const card = document.getElementById('planCard').getBoundingClientRect();
        return { kpi: y('kpiSection'), card: y('planCard'), trend: y('scrapTrendCard'), top: y('topDefectsCard'), door: y('doorLineCard'),
          attn: y('attentionSummary'), pareto: y('paretoCard'), cardH: Math.round(card.height), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
          page: document.documentElement.scrollHeight };
      });
      assert.ok(lay.kpi < lay.card && lay.card < lay.trend && lay.trend < lay.attn && lay.attn < lay.pareto, JSON.stringify(lay));
      assert.ok(lay.sw <= lay.cw + 1, `horizontal scroll ${JSON.stringify(lay)}`);
      // limits: 280 px from 820 px up (D1 adds a chip row: budget · daily limit · data), 560 px on a phone
      assert.ok(lay.cardH <= (width >= 820 ? 280 : 560), `card height ${lay.cardH}px at ${width}px`);
      assert.ok(lay.cardH / lay.page < 0.16, `card is ${Math.round(lay.cardH / lay.page * 100)}% of the page`);
      await shot(page, `dashboard-${width}`);
      if (width === 1440 || width === 390) await shot(page, `dashboard-card-${width}`, '#planCard');
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
});

describe('1b. Dashboard: a period without any data shows no leftover legend', () => {
  it('month range (legend with Over / Within) → a day with no production and no scrap: empty legend and note', async () => {
    const { page, context } = await newPage();
    await dashOpen(page);
    await dashRange(page, M.d(1), M.d(M.nDays));
    assert.match(await page.textContent('#trendLegend'), /Over target/);
    await dashRange(page, M.d(11), M.d(11));   // seeded: no production, no scrap log
    assert.match(await page.textContent('#scrapTrendCard'), /No production or scrap data in this period/);
    assert.equal((await page.textContent('#trendLegend')).trim(), '', 'no leftover legend');
    assert.equal((await page.textContent('#trendNote')).trim(), '');
    await context.close();
  });
});

describe('2. weekly-plan.html — every important state', () => {
  it('month summary + weeks table: Over plan, Within plan (final), Not final; plan sources', async () => {
    const { page, context, errors } = await newPage();
    await planOpen(page, M.ym, '&week=W4');
    const w2 = await weekRow(page, 'W2'); assert.equal(w2.budget, 'OVER_PLAN'); assert.equal(w2.daily, 'BREACHED'); assert.equal(w2.source, 'OVERRIDE'); assert.match(w2.text, /\d+ over/);
    const w4 = await weekRow(page, 'W4'); assert.equal(w4.budget, 'WITHIN_PLAN'); assert.equal(w4.daily, 'BREACHED'); assert.equal(w4.data, 'FINAL'); assert.equal(w4.source, 'ADMIN_DEFAULT'); assert.match(w4.text, /Within plan(?! · so far)/); assert.match(w4.text, /Daily limit breached · 1 day >50/); assert.match(w4.text, /7\/7 days final/);
    const w1 = await weekRow(page, 'W1'); assert.equal(w1.data, 'NOT_FINAL'); assert.match(w1.text, /so far/); assert.equal(w1.source, 'DEFAULT'); assert.match(w1.text, /Default · not set/);
    assert.match(await page.textContent('#wpMonth'), /Monthly budget · default/);
    assert.match(await page.textContent('#wpMonth'), /2 of 5 weeks set by an Admin, 3 default \(not set\)/);
    const fit = await page.$eval('#wpWeeks .wp-scroll', e => e.scrollWidth - e.clientWidth);
    assert.ok(fit <= 1, `weeks table fits at 1440 px without its own scrollbar (${fit}px)`);
    await shot(page, 'weekly-plan-full-1440');
    await shot(page, 'weekly-plan-month-summary', '#wpMonth');
    await shot(page, 'weekly-plan-weeks-table', '#wpWeeks');
    await shot(page, 'weekly-plan-days-W4-final-over50', '#wpWeekDetail');
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('daily breakdown: Final, Final · no production, Pending close, Conflict, No data (not 0); Line × Shift', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W5');
    const states = await page.$$eval('#wpDaysTable tbody tr', trs => Object.fromEntries(trs.map(tr => [tr.dataset.date, tr.querySelector('[data-status]').dataset.status])));
    const want = { PENDING: 'PENDING', CONFLICT: 'CONFLICT', NO_PRODUCTION: 'FINAL', NO_DATA: 'NO_DATA', FINAL: 'FINAL' };
    for (const [date, kind] of Object.entries(M.dayKinds)) if (states[date]) assert.equal(states[date], want[kind] || 'FINAL', date + ' ' + kind);
    const noData = Object.keys(M.dayKinds).find(k => M.dayKinds[k] === 'NO_DATA');
    assert.equal(await page.textContent(`#wpDaysTable tr[data-date="${noData}"] td:nth-child(2)`), '—');
    // Line × Shift adds up to the Door A+B+C total
    const ls = await page.$$eval('.wp-ls', ts => ts.map(t => ({ rows: [...t.querySelectorAll('tbody tr')].map(r => Number(r.lastElementChild.textContent.replace(/,/g, ''))), total: Number(t.querySelector('tfoot tr').lastElementChild.textContent.replace(/,/g, '')) })));
    for (const t of ls) assert.equal(t.rows.reduce((a, b) => a + b, 0), t.total);
    await shot(page, 'weekly-plan-days-W5-states', '#wpWeekDetail');
    await context.close();
  });

  it('Improve Top 5: one row per defect, Door A/B/C and sub-causes inside', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W2');
    await page.click('#wpImprove [data-scope="month"]');
    const names = await page.$$eval('#wpDefects .wp-defect', li => li.map(x => x.dataset.defect));
    assert.ok(names.length > 0 && names.length <= 5); assert.equal(new Set(names).size, names.length);
    await page.$eval('#wpDefects .wp-causes', d => { d.open = true; });
    await shot(page, 'weekly-plan-improve-top5', '#wpImprove');
    await context.close();
  });

  it('Admin edit / override dialog with history; review note (Admin)', async () => {
    const { page, context, errors } = await newPage();
    await planOpen(page, M.ym, '&week=W2');
    await signIn(page, 'ADMIN1');
    await page.waitForSelector('[data-edit="W2"]', { timeout: 15000 });
    await page.waitForFunction(() => /jig check/.test((document.getElementById('wpReviewText') || {}).value || ''), null, { timeout: 15000 });
    await shot(page, 'weekly-plan-review-note-admin', '#wpReview');
    await page.click('[data-edit="W2"]');
    await page.waitForFunction(() => /Stricter target/.test(document.getElementById('wpEditHistory').textContent), null, { timeout: 15000 });
    // history time is Thailand time (server timestamp shown in Asia/Bangkok), whatever the device clock is
    const hist = await page.textContent('#wpEditHistory');
    assert.match(hist, /\(TH\)/);
    const th = new Date(Date.now() + 7 * 3600000);
    assert.match(hist, new RegExp(`${String(th.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][th.getUTCMonth()]} ${th.getUTCFullYear()}`));
    await page.fill('#wpEditInput', '400'); await page.fill('#wpEditReason', 'try');
    await page.click('#wpEditSave');
    assert.match(await page.textContent('#wpEditMsg'), /from 0 to 350/);
    await shot(page, 'weekly-plan-admin-edit-dialog', '#wpEditDialog');
    assert.deepEqual(errors, []);
    await context.close();
  });

  it('Leader and Viewer: read-only (no Edit), see the review note', async () => {
    for (const code of ['LEADA', 'VIEW1']) {
      const { page, context } = await newPage();
      await planOpen(page, M.ym, '&week=W2');
      await signIn(page, code);
      await page.waitForFunction(() => /jig check/.test(document.getElementById('wpReview').textContent), null, { timeout: 15000 });
      assert.equal(await page.$('[data-edit]'), null);
      await context.close();
    }
  });

  it('current month "so far" and the previous-month goal: Provisional (previous month not final)', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.curYm);
    assert.match(await page.textContent('#wpMonth'), /so far/);
    await page.click('#wpGoal summary');
    await page.waitForSelector('#wpGoalStatus', { timeout: 15000 });
    assert.equal(await page.getAttribute('#wpGoalStatus', 'data-status'), 'PROVISIONAL');
    assert.match(await page.textContent('#wpGoalBody'), /provisional/);
    await shot(page, 'weekly-plan-current-month-so-far', '#wpMonth');
    await shot(page, 'weekly-plan-goal-provisional', '#wpGoal');
    await context.close();
  });

  it('No data month (no scrap log at all) and a future month (Not started)', async () => {
    const { page, context } = await newPage();
    const [y, m] = M.ym.split('-').map(Number);
    const old = `${m <= 2 ? y - 1 : y}-${String(((m - 3 + 12) % 12) + 1).padStart(2, '0')}`;
    await planOpen(page, old);
    const mo = await page.evaluate(() => ({ actual: window.__qdWeeklyPlan.month.actual, noLog: window.__qdWeeklyPlan.month.noLog }));
    assert.equal(mo.noLog, true);
    assert.match(await page.textContent('#wpWeeksTable tbody'), /No log/);
    await shot(page, 'weekly-plan-no-data-month', '#wpWeeks');
    const [cy, cm] = M.curYm.split('-').map(Number);
    const future = `${cm === 12 ? cy + 1 : cy}-${String(cm === 12 ? 1 : cm + 1).padStart(2, '0')}`;
    await page.fill('#wpMonthInput', future); await page.dispatchEvent('#wpMonthInput', 'change');
    await planSettled(page, future);
    assert.equal(await page.getAttribute('#wpMonth [data-dim="budget"]', 'data-status'), 'NOT_STARTED');
    await shot(page, 'weekly-plan-future-not-started', '#wpMonth');
    await context.close();
  });

  for (const width of [1024, 820, 390]) {
    it(`${width} px (tablet / phone): full page, no horizontal scroll`, async () => {
      const { page, context } = await newPage(width);
      await planOpen(page, M.ym, '&week=W5');
      const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(w <= 1);
      await shot(page, `weekly-plan-full-${width}`);
      await context.close();
    });
  }
});

describe('2b. D1: Budget status · Daily compliance · Data completeness (page, card, CSV)', () => {
  it('a week with a day over 50 inside its budget: "Within plan" + "Daily limit breached"; same wording on the card and in the CSV; not final = "so far"', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W4');
    const chips = sel => page.$$eval(sel, cs => cs.map(c => `${c.dataset.dim}:${c.dataset.status}:${c.textContent.trim()}`));
    const w4 = await chips('#wpWeekDetail .wp-d1 .wp-chip');
    assert.deepEqual(w4, ['budget:WITHIN_PLAN:Within plan', 'daily:BREACHED:Daily limit breached · 1 day >50', 'data:FINAL:Final']);
    const month = await chips('#wpMonth .wp-d1 .wp-chip');
    assert.ok(month[0].startsWith('budget:') && /so far|Over plan/.test(month[0]), 'month not final: never shown as confirmed — ' + month[0]);
    assert.equal(month[2], 'data:NOT_FINAL:Not final');
    await shot(page, 'd1-week-within-plan-daily-breached', '#wpWeekDetail .wp-section-head');
    // CSV: the same three results, same wording, and the "so far" note
    const csv = await page.evaluate(() => window.__qdWeeklyPlanCsv());
    assert.match(csv[1], /NOT final.*not confirmed/);
    assert.deepEqual(csv[3].split(',').slice(9), ['Budget status', 'Daily compliance', 'Days over limit', 'Data completeness', 'Final days / elapsed']);
    const row = k => csv.find(l => l.startsWith(k + ','));
    assert.match(row('W4'), /,Within plan,Daily limit breached · 1 day >50,1,Final,7\/7$/);
    assert.match(row('W1'), /,Within plan · so far,/);
    assert.match(row('Month'), /,Not final,/);
    const dl = page.waitForEvent('download');
    await page.click('#wpCsv');
    assert.equal((await dl).suggestedFilename(), `weekly-plan_${M.ym}.csv`);
    // the Dashboard card shows the same three results with the same wording for the same month
    const d = await newPage();
    await dashOpen(d.page); await dashRange(d.page, M.d(1), M.d(M.nDays));
    const card = await d.page.$$eval('#planCard [data-k="month"] .v5-budget-d1 .wp-chip[data-dim]', cs => cs.map(c => `${c.dataset.dim}:${c.dataset.status}:${c.textContent.trim()}`));
    assert.deepEqual(card, month, 'card = page');
    await shot(d.page, 'd1-dashboard-card', '#planCard');
    await d.context.close();
    await context.close();
  });
});

describe('3. Default plan is never shown as a confirmed plan', () => {
  it('scrap read error: no figures (Read error), never 0', async () => {
    const { page, context } = await newPage(1440, { fail: 'scrap' });
    await planOpen(page, M.ym);
    const m = await page.evaluate(() => ({ actual: window.__qdWeeklyPlan.month.actual, status: window.__qdWeeklyPlan.month.budgetStatus }));
    assert.deepEqual(m, { actual: null, status: 'READ_ERROR' });
    assert.match(await page.textContent('#connectionBanner'), /never shown as 0/);
    await shot(page, 'state-scrap-read-error', '#wpMonth');
    await context.close();
  });
  it('plans read error (not permission): default, "unconfirmed", banner says read error', async () => {
    const { page, context } = await newPage(1440, { fail: 'plans' });
    await planOpen(page, M.ym);
    for (const k of ['W1', 'W2', 'W4']) assert.equal((await weekRow(page, k)).source, 'UNAVAILABLE');
    assert.match(await page.textContent('#connectionBanner'), /could not be read \(read error\).*NOT a confirmed plan/);
    assert.doesNotMatch(await page.textContent('#wpWeeks'), /Set by Admin|Default · confirmed/);
    await shot(page, 'state-plans-read-error', 'main');
    await context.close();
  });
  it('production rules deny scrapWeeklyPlans: default, "unconfirmed", banner says access denied (page and card)', async () => {
    await useRules('production');
    try {
      const { page, context } = await newPage();
      await page.goto(`${BASE}/weekly-plan.html?qdEmulator=1&qdAuthMode=off&ym=${M.ym}`);
      await planSettled(page, M.ym);
      for (const k of ['W1', 'W2', 'W4']) assert.equal((await weekRow(page, k)).source, 'UNAVAILABLE');
      assert.match(await page.textContent('#connectionBanner'), /access denied by the Firestore rules.*NOT a confirmed plan/);
      assert.equal(await page.evaluate(() => window.__qdWeeklyPlan.month.budget), 50 * M.nDays, 'W2 override cannot be read: default budget');
      await shot(page, 'state-plans-denied-production-rules', 'main');
      const d = await newPage();
      await d.page.goto(`${BASE}/index.html?qdEmulator=1&qdAuthMode=off`);
      await dashSettled(d.page);
      await dashRange(d.page, M.d(1), M.d(M.nDays));
      assert.equal(await d.page.getAttribute('#planCard [data-k="month"] [data-source]', 'data-source'), 'UNAVAILABLE');
      assert.match(await d.page.textContent('#planCard'), /access denied/);
      await shot(d.page, 'state-card-plans-denied', '#planCard');
      await d.context.close();
      await context.close();
    } finally { await useRules('candidate'); }
  });
  it('a week without a plan document is "Default · not set" (distinct from a read error)', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym);
    assert.equal((await weekRow(page, 'W1')).source, 'DEFAULT');
    assert.equal(await page.textContent('#connectionBanner').then(t => /could not|denied/.test(t)), false);
    await context.close();
  });
});

describe('4. Firestore read cost', () => {
  it('Dashboard: open, 1 / 7 / 30 / 31 days, filters, Refresh, back to a range, reopen', async () => {
    const { page, context } = await newPage();
    await dashOpen(page);
    record('Dashboard', `open (default: today ${M.today})`, await reads(page), 'first load incl. Attention / improvements');
    const ranges = [['1 day', M.d(M.nDays), M.d(M.nDays)], ['7 days', M.d(M.nDays - 6), M.d(M.nDays)], ['30 days', M.d(M.nDays - 29), M.d(M.nDays)], [`${M.nDays} days (whole month)`, M.d(1), M.d(M.nDays)]];
    const by = {};
    for (const [label, f, t] of ranges) {
      await resetReads(page);
      await dashRange(page, f, t);
      const r = await reads(page); by[label] = r;
      const card = await page.evaluate(() => window.__qdPlanCard.extraScrapQuery);
      record('Dashboard', `range ${label} (${f} → ${t})`, r, card ? `card read the missing days ${card[0]} → ${card[1]} (1 query)` : 'card: no extra scrap query');
    }
    assert.equal(by['1 day'].scrapLogs.gets, 2, 'range + existing look-back only');
    assert.equal(by['7 days'].scrapLogs.gets, 2, 'range + the missing days (1 query)');
    assert.equal(by[`${M.nDays} days (whole month)`].scrapLogs.gets, 1, 'the range covers the month: no extra query');
    // plans: read once per month for the whole session
    assert.equal(by['1 day'].scrapWeeklyPlans.gets, 1);
    for (const k of ['7 days', '30 days', `${M.nDays} days (whole month)`]) assert.ok(!by[k].scrapWeeklyPlans, k + ': plans not read again');
    await resetReads(page);
    await dashRange(page, M.d(M.nDays - 6), M.d(M.nDays));   // after the month range: the card's own reads are kept
    const back = await reads(page);
    record('Dashboard', 'back to 7 days', back, 'card: missing days and plans kept for the session');
    assert.equal(back.scrapLogs.gets, 1, 'gap query not repeated');
    await dashRange(page, M.d(1), M.d(M.nDays));
    const kpis = () => page.evaluate(() => ['kpiScrap', 'kpiScrapRate', 'kpiStatus', 'kpiTargetCounts', 'trendTotal'].map(id => document.getElementById(id).textContent.replace(/\s+/g, ' ').trim()).join(' | '));
    for (const [label, sel] of [['Shift = Day', '#shiftFilter [data-shift="DAY"]'], ['Line = Door A', '#lineFilter [data-line="A"]']]) {
      await resetReads(page);
      const before = await page.textContent('#lastUpdated');
      await page.evaluate(() => { window.__qdPlanCard = null; });
      await page.click(sel);
      await dashSettled(page, M.ym);
      const r = await reads(page), shown = await kpis();
      record('Dashboard', `filter ${label} (month range)`, r, 'filter click re-uses the loaded data (same reads would be made)');
      assert.equal(sum(r).gets, 0, 'a filter change on daily-rule dates reads nothing');
      assert.equal(await page.textContent('#lastUpdated'), before, '"Last refreshed" keeps the time of the actual read');
      // the same view after a real read shows exactly the same numbers
      await page.evaluate(() => { window.__qdPlanCard = null; });
      await page.click('#refreshBtn'); await dashSettled(page, M.ym);
      assert.equal(await kpis(), shown, label + ': re-used data = freshly read data');
    }
    await page.click('#shiftFilter [data-shift="all"]'); await page.click('#lineFilter [data-line="all"]'); await dashSettled(page, M.ym);
    // before the daily rule (per-shift target) the Shift filter changes what is read: read again
    const pre = ['2026-09-20', '2026-09-28'];
    await dashRange(page, pre[0], pre[1]);
    await resetReads(page);
    await page.evaluate(() => { window.__qdPlanCard = null; });
    await page.click('#shiftFilter [data-shift="DAY"]'); await dashSettled(page, '2026-09');
    const legacy = await reads(page);
    record('Dashboard', `filter Shift = Day on ${pre[0]} → ${pre[1]} (before the daily rule)`, legacy, 'per-shift dates: different reads are needed, so it reads (as before)');
    assert.ok(legacy.prodV2_actualLogs && legacy.prodV2_actualLogs.gets > 0);
    await page.click('#shiftFilter [data-shift="all"]'); await dashSettled(page, '2026-09');
    await resetReads(page);
    await page.evaluate(() => { window.__qdPlanCard = null; });
    await dashRange(page, M.d(M.nDays - 6), M.d(M.nDays));
    await resetReads(page);
    await page.evaluate(() => { window.__qdPlanCard = null; });
    await page.click('#refreshBtn');
    await dashSettled(page, M.ym);
    const ref = await reads(page);
    record('Dashboard', 'Refresh (7 days)', ref, 'Refresh reads everything fresh, card included');
    assert.equal(ref.scrapWeeklyPlans.gets, 1); assert.equal(ref.scrapLogs.gets, 2);
    await context.close();
    const again = await newPage();
    await dashOpen(again.page);
    record('Dashboard', 'reopen the page', await reads(again.page), 'a new page load reads again (no offline cache in use)');
    await again.context.close();
    // Shift Close in use for the whole month: the close summary is read once per range
    const sc = await newPage();
    await dashOpen(sc.page);
    await resetReads(sc.page);
    await dashRange(sc.page, M.d(M.nDays), M.d(M.nDays));
    const one = await reads(sc.page);
    record('Dashboard', `1 day, Shift Close in use from ${M.closeFrom}`, one, 'summary: the day itself + the month dates the range does not cover');
    assert.ok(one.scrapCloseSummary.gets <= 2 && one.scrapCloseSummary.docs <= M.nDays + 1);
    await sc.context.close();
  });

  it('weekly-plan.html: open, other month, back, Reload, previous-month goal (open twice)', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym);
    const open = await reads(page);
    record('Weekly Plan', `open ${M.ym}`, open, 'scrap 1 query, plans 1, close summary ≤ 1, no production');
    assert.equal(open.scrapLogs.gets, 1); assert.equal(open.scrapWeeklyPlans.gets, 1); assert.ok(!open.prodV2_actualLogs);
    await resetReads(page);
    await page.click('#wpNext'); await planSettled(page, M.curYm);
    record('Weekly Plan', `next month ${M.curYm}`, await reads(page));
    await resetReads(page);
    await page.click('#wpPrev'); await planSettled(page, M.ym);
    const back = await reads(page);
    record('Weekly Plan', `back to ${M.ym}`, back, 'kept for the page session: nothing read');
    assert.equal(sum(back).gets, 0);
    await resetReads(page);
    await page.evaluate(() => { window.__qdWeeklyPlan.month = null; });
    await page.click('#wpReload'); await planSettled(page, M.ym);
    const rel = await reads(page);
    record('Weekly Plan', 'Reload', rel, 'Reload reads the month fresh');
    assert.equal(rel.scrapLogs.gets, 1);
    await page.click('#wpNext'); await planSettled(page, M.curYm);
    await resetReads(page);
    await page.click('#wpGoal summary'); await page.waitForSelector('#wpGoalStatus', { timeout: 15000 });
    const goal = await reads(page);
    record('Weekly Plan', `open the reduction goal (${M.curYm} vs ${M.ym})`, goal, 'previous month: 1 scrap query + close summary');
    assert.equal(goal.scrapLogs.gets, 1);
    await page.click('#wpGoal summary'); await resetReads(page);
    await page.click('#wpGoal summary'); await page.waitForSelector('#wpGoalStatus', { timeout: 15000 });
    const goal2 = await reads(page);
    record('Weekly Plan', 'open the goal again', goal2, 'kept: nothing read');
    assert.equal(sum(goal2).gets, 0);
    await context.close();
  });
});

describe('5. Freshness: re-used data never hides a save or an import for long', () => {
  // A save / import made elsewhere (here: written straight into the emulator, as another tab or the
  // Excel import would) must show with Refresh at once, and with any action after QD_VIEW_CACHE_MINUTES.
  const addLog = (id, qty) => env.withSecurityRulesDisabled(async ctx => {
    const { doc, setDoc } = require('firebase/firestore');
    await setDoc(doc(ctx.firestore(), 'scrapLogs', id), { date: M.d(5), shift: 'DAY', line: 'A', model: 'M', defectType: 'Burr', rootCause: '', scrapQty: qty, remark: '', createdAt: 1 });
  });
  const total = page => page.evaluate(() => Number(document.getElementById('kpiScrap').textContent.replace(/[^\d]/g, '')));
  const cardActual = page => page.evaluate(() => window.__qdPlanCard.month.actual);
  const ageBy = (page, minutes) => page.evaluate(m => { const real = Date.now.bind(Date); const off = m * 60000 + (window.__qdClockOff || 0); window.__qdClockOff = off; Date.now = () => real() + off; }, minutes);

  it('Dashboard: filter keeps the loaded data and its time; Refresh reads the new log; after 5 minutes a filter reads fresh', async () => {
    const { page, context } = await newPage();
    await dashOpen(page);
    await dashRange(page, M.d(1), M.d(M.nDays));
    const t0 = await total(page), c0 = await cardActual(page), stamp0 = await page.textContent('#lastUpdated');
    await addLog('fresh1', 7);
    // filter changes: same (loaded) numbers and the same "Last refreshed" — nothing claims to be newer than it is
    await page.click('#lineFilter [data-line="A"]'); await page.waitForTimeout(800);
    await page.click('#lineFilter [data-line="all"]'); await page.waitForTimeout(800);
    assert.equal(await total(page), t0); assert.equal(await page.textContent('#lastUpdated'), stamp0);
    // Refresh: really reads again — the new log is in the KPI and in the card; the time changes
    await page.evaluate(() => { window.__qdPlanCard = null; });
    await page.waitForTimeout(1100);
    await page.click('#refreshBtn'); await dashSettled(page, M.ym);
    assert.equal(await total(page), t0 + 7, 'Refresh shows the new log');
    assert.equal(await cardActual(page), c0 + 7, 'the card too');
    assert.notEqual(await page.textContent('#lastUpdated'), stamp0);
    // older than QD_VIEW_CACHE_MINUTES: a plain filter change reads fresh
    await addLog('fresh2', 3);
    await ageBy(page, 6);
    await resetReads(page);
    await page.evaluate(() => { window.__qdPlanCard = null; });
    await page.click('#shiftFilter [data-shift="DAY"]'); await dashSettled(page, M.ym);
    await page.click('#shiftFilter [data-shift="all"]'); await page.waitForTimeout(800);
    assert.ok((await reads(page)).scrapLogs.gets >= 1, 'read again after 5 minutes');
    assert.equal(await total(page), t0 + 10);
    await context.close();
    // opening the page again (e.g. back from Scrap Entry after a save) always reads fresh
    const again = await newPage();
    await dashOpen(again.page); await dashRange(again.page, M.d(1), M.d(M.nDays));
    assert.equal(await total(again.page), t0 + 10);
    await again.context.close();
  });

  it('Weekly Plan: back to a month re-uses data (≤ 5 min); Reload and older data read the new log', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym);
    const a0 = await page.evaluate(() => window.__qdWeeklyPlan.month.actual);
    await addLog('fresh3', 4);
    await page.click('#wpNext'); await planSettled(page, M.curYm);
    await page.click('#wpPrev'); await planSettled(page, M.ym);
    assert.equal(await page.evaluate(() => window.__qdWeeklyPlan.month.actual), a0, 're-used (within 5 minutes)');
    await page.evaluate(() => { window.__qdWeeklyPlan.month = null; });
    await page.click('#wpReload'); await planSettled(page, M.ym);
    assert.equal(await page.evaluate(() => window.__qdWeeklyPlan.month.actual), a0 + 4, 'Reload reads the new log');
    await addLog('fresh4', 2);
    await ageBy(page, 6);
    await page.click('#wpNext'); await planSettled(page, M.curYm);
    await page.click('#wpPrev'); await planSettled(page, M.ym);
    assert.equal(await page.evaluate(() => window.__qdWeeklyPlan.month.actual), a0 + 6, 'older than 5 minutes: read again');
    await context.close();
  });
});

describe('6. Same tab, other tab, back / forward, stale hint', () => {
  const addLog = (id, qty) => env.withSecurityRulesDisabled(async ctx => {
    const { doc, setDoc } = require('firebase/firestore');
    await setDoc(doc(ctx.firestore(), 'scrapLogs', id), { date: M.d(6), shift: 'NIGHT', line: 'B', model: 'M', defectType: 'Burr', rootCause: '', scrapQty: qty, remark: '', createdAt: 1 });
  });
  const total = page => page.evaluate(() => Number(document.getElementById('kpiScrap').textContent.replace(/[^\d]/g, '')));

  it('same tab: Dashboard → Scrap Entry (save / import) → Back: the Dashboard shows the new data, never the old page', async () => {
    const { page, context } = await newPage();
    await dashOpen(page);
    await dashRange(page, M.d(1), M.d(M.nDays));
    const t0 = await total(page);
    await page.goto(`${BASE}/scrap-entry.html?${q()}`);
    await addLog('tab1', 5);                                   // the save / import made on Scrap Entry
    await page.goBack();
    await page.waitForTimeout(500);   // a page restored from the back/forward cache reloads itself here
    await page.waitForFunction(() => window.qdDb && document.getElementById('dateTo'), null, { timeout: 15000 });
    const persisted = await page.evaluate(() => performance.getEntriesByType('navigation')[0].type).catch(() => 'reloading');
    await dashSettled(page);
    await dashRange(page, M.d(1), M.d(M.nDays));
    assert.equal(await total(page), t0 + 5, `fresh after Back (navigation: ${persisted})`);
    await context.close();
  });

  it('other tab: data older than 5 minutes is marked with "press Refresh" / "press Reload"; Refresh / Reload clears it', async () => {
    const { page, context } = await newPage();
    await dashOpen(page);
    await dashRange(page, M.d(1), M.d(M.nDays));
    assert.equal(await page.isVisible('#dataStaleHint'), false);
    await page.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 6 * 60000; window.dispatchEvent(new Event('focus')); });
    assert.equal(await page.isVisible('#dataStaleHint'), true);
    assert.match(await page.textContent('#dataStaleHint'), /older than 5 min — press Refresh/);
    await page.evaluate(() => { window.__qdPlanCard = null; });
    await page.click('#refreshBtn'); await dashSettled(page, M.ym);
    assert.equal(await page.isVisible('#dataStaleHint'), false, 'Refresh clears the hint');
    const w = await newPage();
    await planOpen(w.page, M.ym);
    assert.match(await w.page.textContent('#wpLoadedAt'), /^Loaded \d\d:\d\d \(TH\)$/);
    await w.page.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 6 * 60000; window.dispatchEvent(new Event('focus')); });
    assert.match(await w.page.textContent('#wpLoadedAt'), /older than 5 min — press Reload/);
    await w.page.evaluate(() => { window.__qdWeeklyPlan.month = null; });
    await w.page.click('#wpReload'); await planSettled(w.page, M.ym);
    assert.doesNotMatch(await w.page.textContent('#wpLoadedAt'), /older/);
    await shot(w.page, 'state-weekly-plan-loaded-at', '.wp-toolbar');
    await w.context.close();
    await context.close();
  });

  it('sign-out clears private data: Weekly Plan history and review note disappear (page reloads); account switch in another tab too', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W2');
    await signIn(page, 'ADMIN1');
    await page.waitForFunction(() => /jig check/.test((document.getElementById('wpReviewText') || {}).value || ''), null, { timeout: 15000 });
    await page.click('[data-edit="W2"]');
    await page.waitForFunction(() => /Stricter target/.test(document.getElementById('wpEditHistory').textContent), null, { timeout: 15000 });
    await page.evaluate(() => document.getElementById('wpEditDialog').close());
    // sign out in the same tab → the page reloads → nothing private left
    const nav = page.waitForNavigation({ timeout: 15000 });
    await page.click('#qdAuthSignOut');
    await nav;
    await planSettled(page, M.ym);
    await page.waitForSelector('#qdAuthOpen', { timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText + document.getElementById('wpEditHistory').innerHTML);
    assert.doesNotMatch(text, /jig check|Stricter target|admin1@prodv2/, 'no private data after sign-out');
    // two tabs of the same browser: signing out in tab B reloads tab A, which showed private data
    await signIn(page, 'ADMIN1');
    await page.waitForFunction(() => /jig check/.test((document.getElementById('wpReviewText') || {}).value || ''), null, { timeout: 15000 });
    const b = await context.newPage();
    await b.goto(`${BASE}/weekly-plan.html?${q()}&ym=${M.ym}`);
    await b.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
    const navA = page.waitForNavigation({ timeout: 20000 });
    await b.click('#qdAuthSignOut');
    await navA;
    await planSettled(page, M.ym);
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /jig check/, 'the other tab was cleared too');
    await context.close();
  });

  it('account switch: Admin → Viewer shows Viewer rights only (no Edit), no Admin-only data kept', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W2');
    await signIn(page, 'ADMIN1');
    await page.waitForSelector('[data-edit="W2"]', { timeout: 15000 });
    const nav = page.waitForNavigation({ timeout: 15000 });
    await page.click('#qdAuthSignOut'); await nav;
    await planSettled(page, M.ym);
    await signIn(page, 'VIEW1');
    await page.waitForFunction(() => /jig check/.test(document.getElementById('wpReview').textContent), null, { timeout: 15000 });
    assert.equal(await page.$('[data-edit]'), null);
    assert.equal(await page.$('#wpReviewSave'), null, 'viewer cannot edit the note');
    await context.close();
  });
});

describe('7. Final privacy and legend checks', () => {
  // Everything the browser keeps for this site: localStorage, sessionStorage, Cache Storage and the
  // IndexedDB databases (Firebase Auth keeps its session in "firebaseLocalStorageDb").
  const storage = page => page.evaluate(async () => {
    const idb = {};
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    for (const d of dbs) {
      idb[d.name] = await new Promise(res => {
        const rq = indexedDB.open(d.name);
        rq.onerror = () => res('(cannot open)');
        rq.onsuccess = () => {
          const db = rq.result, out = [];
          const stores = [...db.objectStoreNames];
          if (!stores.length) { db.close(); return res(out); }
          const tx = db.transaction(stores, 'readonly'); let left = stores.length;
          stores.forEach(n => { const g = tx.objectStore(n).getAll(); g.onsuccess = () => { out.push(...g.result); if (--left === 0) { db.close(); res(out); } }; g.onerror = () => { if (--left === 0) { db.close(); res(out); } }; });
        };
      });
    }
    return {
      local: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
      session: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])),
      caches: typeof caches !== 'undefined' ? await caches.keys() : [],
      idb
    };
  });
  const PRIVATE = /jig check|Stricter target|Line B trial run|KP00\d\d|Planned stop/;

  it('browser storage: no private data stored by the app; the auth session is gone after sign-out', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W2');
    await signIn(page, 'ADMIN1');
    await page.waitForFunction(() => /jig check/.test((document.getElementById('wpReviewText') || {}).value || ''), null, { timeout: 15000 });
    await page.click('[data-edit="W2"]');
    await page.waitForFunction(() => /Stricter target/.test(document.getElementById('wpEditHistory').textContent), null, { timeout: 15000 });
    const signed = await storage(page);
    const text = JSON.stringify(signed);
    assert.doesNotMatch(text, PRIVATE, 'no review note / history / employee code in any browser storage');
    assert.deepEqual(signed.caches, [], 'no Cache Storage');
    assert.deepEqual(Object.keys(signed.session), [], 'no sessionStorage');
    assert.ok(Object.keys(signed.local).every(k => !/qd|scrap|plan|review/i.test(k)), 'no app data in localStorage: ' + Object.keys(signed.local));
    assert.match(JSON.stringify(signed.idb.firebaseLocalStorageDb || []), /admin1@prodv2\.local/, 'signed in: Firebase Auth keeps its session (expected)');
    await page.evaluate(() => document.getElementById('wpEditDialog').close());
    const nav = page.waitForNavigation({ timeout: 15000 });
    await page.click('#qdAuthSignOut'); await nav;
    await planSettled(page, M.ym);
    const out = await storage(page);
    assert.doesNotMatch(JSON.stringify(out), /admin1@prodv2\.local/, 'after sign-out: no auth session left');
    assert.doesNotMatch(JSON.stringify(out), PRIVATE);
    console.log('  storage after sign-out:', JSON.stringify({ local: Object.keys(out.local), session: Object.keys(out.session), caches: out.caches, idb: Object.fromEntries(Object.entries(out.idb).map(([k, v]) => [k, Array.isArray(v) ? v.length + ' entries' : v])) }));
    await context.close();
  });

  it('Back / Forward after signing out on another page shows no private data from the previous session', async () => {
    const { page, context } = await newPage();
    await planOpen(page, M.ym, '&week=W2');
    await signIn(page, 'ADMIN1');
    await page.waitForFunction(() => /jig check/.test((document.getElementById('wpReviewText') || {}).value || ''), null, { timeout: 15000 });
    await page.goto(`${BASE}/scrap-entry.html?${q()}`);
    await page.waitForSelector('#qdAuthSignOut', { timeout: 15000 });
    const nav = page.waitForNavigation({ timeout: 15000 });
    await page.click('#qdAuthSignOut'); await nav;
    await page.waitForSelector('#qdAuthOpen', { timeout: 15000 });
    await page.goBack();
    await page.waitForTimeout(800);
    await planSettled(page, M.ym);
    await page.waitForSelector('#qdAuthOpen', { timeout: 15000 });
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), PRIVATE, 'Back: nothing from the signed-in session');
    await page.goForward();
    await page.waitForSelector('#qdAuthOpen', { timeout: 15000 });
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), PRIVATE, 'Forward: still signed out');
    await context.close();
  });

  it('trend legend always matches the data shown: dates, Line and Shift changes, No data', async () => {
    const { page, context } = await newPage();
    await dashOpen(page);
    const legend = () => page.evaluate(() => [...document.querySelectorAll('#trendLegend .v5-trend-li')].map(e => e.textContent.trim()));
    const within = Object.keys(M.dayKinds).find(k => M.dayKinds[k] === 'FINAL'), over = Object.keys(M.dayKinds).find(k => M.dayKinds[k] === 'OVER');
    await dashRange(page, M.d(1), M.d(M.nDays));
    let l = await legend();
    assert.ok(l.includes('Within target') && l.includes('Over target'), JSON.stringify(l));
    await dashRange(page, within, within);
    l = await legend();
    assert.ok(l.includes('Within target') && !l.includes('Over target'), 'a WITHIN day: ' + JSON.stringify(l));
    await dashRange(page, over, over);
    l = await legend();
    assert.ok(l.includes('Over target') && !l.includes('Within target'), 'an OVER day: ' + JSON.stringify(l));
    await page.click('#lineFilter [data-line="A"]'); await page.waitForTimeout(900);
    l = await legend();
    assert.ok(l.some(x => /Scrap Qty · Door A · Day\+Night/.test(x)) && !l.includes('Over target'), 'Line A: ' + JSON.stringify(l));
    await page.click('#shiftFilter [data-shift="NIGHT"]'); await page.waitForTimeout(900);
    l = await legend();
    assert.ok(l.some(x => /Scrap Qty · Door A · Night/.test(x)), 'Line A, Night: ' + JSON.stringify(l));
    await page.click('#lineFilter [data-line="all"]'); await page.click('#shiftFilter [data-shift="all"]'); await page.waitForTimeout(900);
    l = await legend();
    assert.ok(l.includes('Over target') && !l.some(x => /Scrap Qty ·/.test(x)), 'back to all: ' + JSON.stringify(l));
    await dashRange(page, M.d(11), M.d(11));
    assert.deepEqual(await legend(), [], 'No data: no legend');
    await context.close();
  });
});

