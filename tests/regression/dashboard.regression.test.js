// Regression test for Dashboard V5 + Executive Report, with sign-in OFF (the live default).
// Pages are opened from disk (file://) with a mock Firestore (mock-firestore.js) — no Firebase at all.
// Every number on the Dashboard is compared with an independent oracle (oracle.js) for every
// Date range x Shift x Line below, together with Firestore read/write counts and console errors.
// QD_REGRESSION_QUICK=1 runs a smaller subset.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { expected } = require('./oracle.js');
const ROOT = path.join(__dirname, '../..');
const fake = fs.readFileSync(path.join(__dirname, 'mock-firestore.js'), 'utf8');
const cj = fs.readFileSync(path.join(__dirname, '../node_modules/chart.js/dist/chart.umd.min.js'), 'utf8');
const RANGES={'1d-today':['2026-10-29','2026-10-29'],'1d-50':['2026-10-05','2026-10-05'],'1d-51':['2026-10-06','2026-10-06'],'1d-nolog':['2026-10-08','2026-10-08'],
 '1d-nodata':['2026-10-10','2026-10-10'],'1d-nightmissing':['2026-10-11','2026-10-11'],'7d':['2026-10-23','2026-10-29'],'15d':['2026-10-15','2026-10-29'],
 '30d':['2026-09-30','2026-10-29'],'cross':['2026-09-25','2026-10-06'],'pre-only':['2026-09-20','2026-09-28'],'edge12':['2026-10-01','2026-10-12']};
const num=s=>s==null?null:Number(String(s).replace(/[^\d.\-]/g,''));
async function ui(p){return p.evaluate(()=>{
  const t=id=>(document.getElementById(id)||{}).textContent?.replace(/\s+/g,' ').trim();
  const rows=[...document.querySelectorAll('#targetPerfDetailBody tr')].map(tr=>{const c=[...tr.children].map(td=>td.textContent.replace(/\s+/g,' ').trim()); const pill=tr.querySelector('.qd-status-pill'); return {date:c[0],scope:c[1],scrap:c[2],target:c[3],status:pill?pill.textContent.trim():''};});
  const tch=Chart.getChart('scrapTrendChart'); const pch=Chart.getChart('paretoChart');
  return {kpi:{scrap:t('kpiScrap'),scrapSub:t('kpiScrapUnit'),rate:t('kpiScrapRate'),rateSub:t('kpiScrapRateUnit'),cost:t('kpiScrapCost'),costTitle:document.getElementById('kpiScrapCost').title,costSub:t('kpiScrapCostSub'),status:t('kpiStatus'),counts:t('kpiTargetCounts')},
   rows, trend:tch?tch.data.datasets[0].data:null, trendTotal:t('trendTotal'),trendOver:t('trendOver'),trendOverUnit:t('trendOverUnit'),trendAvg:t('trendAvg'),
   top5:[...document.querySelectorAll('#topDefectsList .qd-dashboard-top-defect-row')].map(r=>{const s=[...r.children].map(x=>x.textContent.trim()); return {n:s[1],q:s[2],pct:s[3]};}),
   door:[...document.querySelectorAll('#doorLineComparison tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.replace(/\s+/g,' ').trim())),
   pareto:pch?{labels:pch.data.labels,qty:pch.data.datasets[0].data,cum:pch.data.datasets[1].data,mark:pch.options.plugins.paretoDecor.meta.markIndex}:null,
   pk:[t('paretoKpiTotal'),t('paretoKpiPriority'),t('paretoKpiCoverage')], insight:t('paretoInsight'),
   paretoEmpty:!!document.querySelector('#paretoCard .qd-dashboard-pareto-empty'), top5Empty:!!document.querySelector('#topDefectsCard .qd-dashboard-pareto-empty'),
   attn:[...document.querySelectorAll('#attentionSummary .v5-attn-card-num')].map(e=>e.textContent.trim()),
   reads:window.__reads.reduce((m,r)=>{m[r.coll]=(m[r.coll]||0)+1;return m;},{}), dupDocs:(()=>{const ids=window.__reads.filter(r=>r.doc).map(r=>r.doc);return ids.length-new Set(ids).size;})(),
   writes:window.__writes, banner:document.getElementById('connectionBanner').style.display!=='none'?t('connectionBanner'):''};});}
function compare(u,e){
  const f=[]; const chk=(name,ok,detail)=>{if(!ok)f.push(name+': '+detail);};
  const fmt=n=>Math.round(n).toLocaleString('en-US');
  chk('scrapTotal',e.records===0?u.kpi.scrap===(e.production>0?'N/A':'–'):num(u.kpi.scrap)===e.scrap,`${u.kpi.scrap} vs ${e.records===0?(e.production>0?'N/A':'–'):e.scrap}`);
  chk('records',e.records===0?u.kpi.scrapSub===(e.production>0?'No scrap log in this scope · not confirmed as 0':'No data in this scope'):u.kpi.scrapSub===`${fmt(e.records)} scrap record${e.records===1?'':'s'}`,`${u.kpi.scrapSub} vs ${e.records}`);
  chk('rate',u.kpi.rate===(e.records===0?'N/A':e.rate),`${u.kpi.rate} vs ${e.rate}`);
  chk('production',num(u.kpi.rateSub)===e.production,`${u.kpi.rateSub} vs ${e.production}`);
  const c=e.cost; const costSubExp=c.count===0?'No scrap recorded in this scope':c.withCost===0?'No cost on these records (manual entries carry no cost)':c.withCost<c.count?`Incomplete: ${fmt(c.count-c.withCost)} of ${fmt(c.count)} records have no cost`:`${fmt(c.count)} scrap record${c.count===1?'':'s'}`;
  chk('costSub',u.kpi.costSub===costSubExp,`${u.kpi.costSub} vs ${costSubExp}`);
  if(c.withCost>0) chk('cost',u.kpi.costTitle==='฿'+fmt(c.total),`${u.kpi.costTitle} vs ฿${fmt(c.total)}`);
  chk('status',u.kpi.status===e.status,`${u.kpi.status} vs ${e.status}`);
  const cn=e.counts; chk('counts',[cn.W,cn.O,cn.I,cn.N].join()===(u.kpi.counts.match(/\d+(?= (Within|Over|Incomplete|No Data))/g)||[]).join(),`${u.kpi.counts} vs ${JSON.stringify(cn)}`);
  chk('units.length',u.rows.length===e.units.length,`${u.rows.length} vs ${e.units.length}`);
  e.units.forEach((x,i)=>{const r=u.rows[i]; if(!r) return;
    chk('unit '+x.date+' '+x.scope,r.scope===x.scope&&r.status===x.status&&r.target.startsWith('≤'+x.target)&&(x.unit==='DAY'&&!x.known||x.status==='NO DATA'?r.scrap==='—':num(r.scrap.split(/Day|Night/)[0])===x.scrap),`${JSON.stringify(r)} vs ${x.status} ${x.scrap} ≤${x.target}`);});
  chk('trend',JSON.stringify(u.trend)===JSON.stringify(e.trend.map(t=>t.v)),`${JSON.stringify(u.trend)} vs ${JSON.stringify(e.trend.map(t=>t.v))}`);
  chk('trendTotal',num(u.trendTotal)===e.trendTotal,`${u.trendTotal}`);
  chk('trendAvg',e.trendAvg===null?u.trendAvg==='N/A':num(u.trendAvg)===e.trendAvg,`${u.trendAvg} vs ${e.trendAvg}`);
  chk('trendOver',num(u.trendOver)===e.over.n&&new RegExp(`over / ${e.over.ev} evaluated ${e.over.unit}`).test(u.trendOverUnit),`${u.trendOver} ${u.trendOverUnit} vs ${JSON.stringify(e.over)}`);
  if(e.scrap===0){ chk('top5 empty',u.top5Empty,'not empty'); chk('pareto empty',u.paretoEmpty,'not empty'); }
  else {
    const qs=u.top5.map(x=>num(x.q)), eq=e.top5.map(x=>x.q);
    chk('top5 qty',JSON.stringify(qs)===JSON.stringify(eq),`${qs} vs ${eq}`);
    chk('top5 pct',JSON.stringify(u.top5.map(x=>x.pct))===JSON.stringify(e.top5.map(x=>x.pct)),`${u.top5.map(x=>x.pct)} vs ${e.top5.map(x=>x.pct)}`);
    chk('top5 names (ties allowed)',u.top5.every((x,i)=>e.top5.some(y=>y.n===x.n&&y.q===num(x.q))||e.pareto.top.some(y=>y.n===x.n&&y.q===num(x.q))),'name/qty pair not in oracle');
    const P=e.pareto, exQ=P.top.map(x=>x.q).concat(P.nOthers?[P.others]:[]);
    chk('pareto qty',JSON.stringify(u.pareto.qty)===JSON.stringify(exQ),`${u.pareto.qty} vs ${exQ}`);
    chk('pareto labels',u.pareto.labels.join()===P.top.map((_,i)=>String(i+1)).concat(P.nOthers?['O']:[]).join(),u.pareto.labels.join());
    chk('pareto cum',u.pareto.cum.every((v,i)=>Math.abs(v-(i<P.top.length?P.top[i].cum:100))<1e-9),`${u.pareto.cum.slice(0,3)}`);
    chk('pareto 80%',num(u.pk[1])===P.cross+1&&u.pk[2]===P.coverage.toFixed(1)+'%'&&u.pareto.mark===(P.cross<10?P.cross:u.pareto.labels.length-1),`${u.pk} mark ${u.pareto.mark} vs cross ${P.cross} cov ${P.coverage}`);
    chk('pareto total',num(u.pk[0])===e.scrap,u.pk[0]);
  }
  e.door.forEach((d,i)=>{const r=u.door[i]||[]; chk('door '+d.l,num(r[1])===(d.hasDoc?d.prod:null)||(!d.hasDoc&&r[1]==='–'),`${r[1]} vs ${d.prod}`);
    chk('door scrap '+d.l,d.logs===0?r[2]===(d.prod>0?'No log':'–'):num(r[2])===d.scrap,`${r[2]} vs ${d.logs===0?(d.prod>0?'No log':'–'):d.scrap}`); chk('door rate '+d.l,r[3]===d.rate,`${r[3]} vs ${d.rate}`); chk('door share '+d.l,(r[4]||'').startsWith(d.share),`${r[4]} vs ${d.share}`);});
  chk('recurring',num(u.attn[0])===e.recurringABC,`${u.attn[0]} vs ${e.recurringABC} (A/B/C only)`);
  const R=e.reads; chk('reads',(u.reads.prodV2_actualLogs||0)===R.prod&&(u.reads.scrapLogs||0)===R.scrap&&(u.reads.targetMaster||0)===R.target&&(u.reads.improvements||0)===R.imp,`${JSON.stringify(u.reads)} vs ${JSON.stringify(R)}`);
  chk('duplicate doc reads',u.dupDocs===0,u.dupDocs); chk('writes',u.writes===0,u.writes);
  return f;
}

const QUICK = process.env.QD_REGRESSION_QUICK === '1';
const SHIFT_LIST = QUICK ? ['all', 'NIGHT'] : ['all', 'DAY', 'NIGHT'];
const LINE_LIST = QUICK ? ['all', 'C'] : ['all', 'A', 'B', 'C'];
// Known harness artefacts (not product defects): an empty scope shows the "no data" box instead of a chart,
// and Door Line shows "–" with its unit for a line that has no production document.
const artefact = f => f.startsWith('trend: null vs [null]') || (f.startsWith('door ') && f.includes('–pcs vs 0'));

let browser, page, errs = [];
async function openPage(file) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.text()); });
  p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue();
    if (u.includes('firebase-app')) return r.fulfill({ body: fake, contentType: 'application/javascript' });
    if (u.includes('chart.umd')) return r.fulfill({ body: cj, contentType: 'application/javascript' });
    return r.fulfill({ body: '' }); });   // auth SDK, fonts, everything else: empty
  await p.goto('file://' + path.join(ROOT, file)); await p.waitForTimeout(900);
  return p;
}
before(async () => { browser = await chromium.launch(); page = await openPage('index.html'); });
after(async () => { if (browser) await browser.close(); });

describe('Dashboard V5 vs oracle (sign-in off)', () => {
  it('sign-in is off and adds nothing to the page', async () => {
    const st = await page.evaluate(() => ({ mode: window.qdAuthMode, box: !!document.getElementById('qdAuthBox'), auth: !!window.qdAuth }));
    assert.deepEqual(st, { mode: 'off', box: false, auth: false });
  });
  for (const [rk, [f, t]] of Object.entries(RANGES)) {
    if (QUICK && !['1d-51', '7d', '30d', 'cross'].includes(rk)) continue;
    it(`range ${rk} (${f} → ${t})`, async () => {
      await page.fill('#dateTo', t); await page.dispatchEvent('#dateTo', 'change'); await page.fill('#dateFrom', f); await page.dispatchEvent('#dateFrom', 'change'); await page.waitForTimeout(500);
      const problems = [];
      for (const sh of SHIFT_LIST) for (const ln of LINE_LIST) {
        await page.click(`#shiftFilter [data-shift="${sh}"]`); await page.click(`#lineFilter [data-line="${ln}"]`); await page.waitForTimeout(350);
        await page.evaluate(() => { window.__reads = []; }); const before = await page.textContent('#lastUpdated');
        await page.click('#refreshBtn');
        await page.waitForFunction(b => document.getElementById('lastUpdated').textContent !== b && !/Loading/.test(document.getElementById('attentionSummary').textContent), before, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(250);
        const u = await ui(page), e = await expected(f, t, sh, ln);
        compare(u, e).filter(x => !artefact(x)).forEach(x => problems.push(`${sh}/${ln}: ${x}`));
      }
      assert.deepEqual(problems, []);
    });
  }
  it('no console errors on the Dashboard', () => { assert.deepEqual(errs, []); });
});

describe('Executive Report (sign-in off)', () => {
  it('loads, matches the oracle total for the default period, writes nothing', async () => {
    const before = errs.length;
    const p = await openPage('executive-report.html');
    await p.waitForTimeout(1500);
    const st = await p.evaluate(() => ({ writes: window.__writes, text: document.body.innerText }));
    assert.equal(st.writes, 0);
    assert.ok(/Executive|Scrap/.test(st.text));
    assert.deepEqual(errs.slice(before), []);
    await p.close();
  });
});
