// Independent oracle: reads the SAME mock dataset through its Firestore-like API and
// computes what the Dashboard should show, using the rules from the test brief.
const fs=require('fs'), vm=require('vm');
const win={}; vm.runInNewContext(fs.readFileSync(__dirname+'/mock-firestore.js','utf8'),{window:win,Date,Math,Array,Set,Map,String,Number,JSON,Promise,Error,Object});
const db=win.firebase.firestore();
const LINES=['A','B','C'], SHIFTS=['DAY','NIGHT'], CUT='2026-10-01', DAILY=50;
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*864e5).toISOString().slice(0,10);
const range=(f,t)=>{const o=[];for(let d=f;d<=t;d=addDays(d,1))o.push(d);return o;};
async function load(from,to){
  const prod=[]; for(const d of range(from,to)) for(const l of LINES) for(const s of SHIFTS){
    const snap=await db.collection('prodV2_actualLogs').doc(`actual_${d}_${l}_${s}`).get();
    if(snap.exists){const v=Object.values(snap.data().actualByCell).reduce((a,b)=>a+b,0); prod.push({date:d,line:l,shift:s,qty:v});}
  }
  const sc=[]; (await db.collection('scrapLogs').where('date','>=',from).where('date','<=',to).get()).forEach(x=>sc.push(x.data()));
  return {prod,sc};
}
const legacyTarget=(shift,d)=>shift==='DAY'&&d>='2026-09-27'?25:30;   // from the mock targetMaster history
function units(dates,prod,sc,activeShifts){
  const out=[];
  for(const d of dates){
    const P=s=>prod.some(r=>r.date===d&&r.shift===s&&LINES.includes(r.line));
    const S=s=>sc.filter(r=>r.date===d&&r.shift===s&&LINES.includes(r.line));
    if(d>=CUT){
      const logs=[...S('DAY'),...S('NIGHT')], total=logs.reduce((a,r)=>a+r.scrapQty,0);
      const hasD=P('DAY'),hasN=P('NIGHT');
      let st; if(total>DAILY) st='OVER TARGET'; else if(!hasD&&!hasN&&logs.length===0) st='NO DATA'; else if(!hasD||!hasN||logs.length===0) st='INCOMPLETE'; else st='WITHIN TARGET';
      out.push({date:d,unit:'DAY',scope:'Day + Night',scrap:total,known:logs.length>0,target:DAILY,status:st});
    } else for(const s of activeShifts){
      const tq=legacyTarget(s,d), total=S(s).reduce((a,r)=>a+r.scrapQty,0);
      out.push({date:d,unit:'SHIFT',scope:s==='DAY'?'Day':'Night',scrap:total,target:tq,status:!P(s)?'NO DATA':total>tq?'OVER TARGET':'WITHIN TARGET'});
    }
  }
  return out;
}
const combine=u=>u.some(x=>x.status==='OVER TARGET')?'OVER TARGET':u.some(x=>x.status==='INCOMPLETE')?'INCOMPLETE':u.some(x=>x.status==='WITHIN TARGET')?'WITHIN TARGET':'NO DATA';
function recurring(records){const g=new Map(); records.forEach(r=>{const k=`${r.line}|${r.model}|${r.defectType}`; if(!g.has(k))g.set(k,new Set()); g.get(k).add(r.date);}); return [...g].filter(([,s])=>s.size>=3).map(([k])=>k);}
async function expected(from,to,shift,line){
  const dates=range(from,to), act=shift==='all'?SHIFTS:[shift], lines=line==='all'?LINES:[line];
  const {prod,sc}=await load(from,to);
  const inShift=r=>act.includes(r.shift);
  const scope=sc.filter(r=>inShift(r)&&lines.includes(r.line)), pscope=prod.filter(r=>inShift(r)&&lines.includes(r.line));
  const scrap=scope.reduce((a,r)=>a+r.scrapQty,0), production=pscope.reduce((a,r)=>a+r.qty,0);
  const withCost=scope.filter(r=>r.scrapCost!==null&&r.scrapCost!==undefined);
  const cost=withCost.reduce((a,r)=>a+r.scrapCost,0);
  const U=units(dates,prod,sc,act);
  // defects (Top 5 / Pareto) — scope only
  const byD=new Map(); scope.forEach(r=>byD.set(r.defectType,(byD.get(r.defectType)||0)+r.scrapQty));
  const defects=[...byD].map(([n,q])=>({n,q})).sort((a,b)=>b.q-a.q);
  let run=0; defects.forEach(d=>{run+=d.q; d.cum=scrap?run/scrap*100:0;});
  const cross=defects.findIndex(d=>d.cum>=80);
  // door lines: all lines, shift-filtered
  const door=LINES.map(l=>{const p=prod.filter(r=>inShift(r)&&r.line===l), s=sc.filter(r=>inShift(r)&&r.line===l); return {l,prod:p.reduce((a,r)=>a+r.qty,0),hasDoc:p.length>0,scrap:s.reduce((a,r)=>a+r.scrapQty,0),logs:s.length};});
  const doorTot=door.reduce((a,x)=>a+x.scrap,0);
  // trend per date (scope)
  const trend=dates.map(d=>{const s=scope.filter(r=>r.date===d).reduce((a,r)=>a+r.scrapQty,0), p=pscope.filter(r=>r.date===d).reduce((a,r)=>a+r.qty,0);
    const logs=scope.filter(r=>r.date===d).length;   // no log in scope = unknown (logs are never 0)
    return {d,v:logs===0?null:s};});
  const dayU=U.filter(u=>u.unit==='DAY'), shU=U.filter(u=>u.unit==='SHIFT');
  const cnt=(L,st)=>L.filter(u=>u.status===st).length;
  const logged=trend.filter(t=>t.v>0).length;
  // attention: multi-day uses the range, single day uses a 30-day lookback; definition = all loaded scrap records
  let recRecords=sc; if(from===to){ const lb=await load(addDays(to,-29),to); recRecords=lb.sc; }
  const recAll=recurring(recRecords), recABC=recurring(recRecords.filter(r=>LINES.includes(r.line)));
  return {dates:dates.length,scrap,records:scope.length,production,rate:production?(scrap/production*100).toFixed(2)+'%':'N/A',
    cost:{count:scope.length,withCost:withCost.length,total:cost},
    units:U,status:combine(U),
    counts:{W:cnt(U,'WITHIN TARGET'),O:cnt(U,'OVER TARGET'),I:cnt(U,'INCOMPLETE'),N:cnt(U,'NO DATA')},
    top5:defects.slice(0,5).map(d=>({n:d.n,q:d.q,pct:(d.q/scrap*100).toFixed(0)+'%'})),
    pareto:{top:defects.slice(0,10).map(d=>({n:d.n,q:d.q,cum:d.cum})),others:defects.slice(10).reduce((a,d)=>a+d.q,0),nOthers:Math.max(0,defects.length-10),cross,coverage:cross>=0?defects[cross].cum:null,types:defects.length},
    door:door.map(x=>({...x,rate:x.prod&&x.logs?(x.scrap/x.prod*100).toFixed(2)+'%':'N/A',share:doorTot&&x.logs?(x.scrap/doorTot*100).toFixed(0)+'%':'–'})),
    trend,trendTotal:scrap,trendAvg:logged?Math.round(scrap/logged):null,
    over:dayU.length?{n:cnt(dayU,'OVER TARGET'),ev:cnt(dayU,'OVER TARGET')+cnt(dayU,'WITHIN TARGET'),inc:cnt(dayU,'INCOMPLETE'),nd:cnt(dayU,'NO DATA'),unit:'day'}:{n:cnt(shU,'OVER TARGET'),ev:cnt(shU,'OVER TARGET')+cnt(shU,'WITHIN TARGET'),unit:'shift'},
    recurring:recAll.length,recurringABC:recABC.length,recurringNonABC:recAll.filter(k=>!LINES.includes(k.split('|')[0])),
    reads:{prod:dates.reduce((a,d)=>a+3*(d>=CUT?2:act.length),0),scrap:from===to?2:1,target:dates.some(d=>d<CUT)?act.length:0,imp:1}};
}
module.exports={expected,range};
