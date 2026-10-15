(()=>{const $=id=>document.getElementById(id);let S={lines:[],plan:null,actual:null,manual:[],hourly:null,cum:null,keys:[]};
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
function localDate(d=new Date()){const z=n=>String(n).padStart(2,"0");return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`}
function stat(t,c=""){$("dashStatus").textContent=t;$("dashStatus").className="hero-status "+c}
function note(t,c=""){$("dashMessage").textContent=t;$("dashMessage").className="notice info-notice "+c}
async function all(n){let s=await ProdV2DB.collection(n).get();return s.docs.map(d=>({id:d.id,...d.data()}))}
const k=(m,d)=>`${m}|||${d}`;
function splitKey(x){let p=String(x).split("|||");return {model:p[0]||"",door:p[1]||""}}
function mins(t){let [h,m]=String(t||"00:00").split(":").map(Number);return (h||0)*60+(m||0)}
function nowMinutes(){let d=new Date();return d.getHours()*60+d.getMinutes()}
// Blocks are given as local HH:MM with no date, and a Night shift can cross
// midnight — so times must be "unwrapped" into a monotonically increasing
// timeline (each block's start/end pushed +1440 past the previous block's end
// whenever it looks like the clock rolled over) before they can be compared to
// "now" or to each other.
function unwrapBlockTimes(bs){
 let out=[],prevEnd=null;
 bs.forEach(b=>{
  let s=mins(b.start||b.startTime),e=mins(b.end||b.endTime);
  if(prevEnd!=null)while(s<prevEnd)s+=1440;
  if(e<=s)e+=1440;
  out.push({startU:s,endU:e});prevEnd=e;
 });
 return out;
}
// Plan the shift is expected to have produced by "now" — full Adjusted Plan for
// a past date, 0 for a future date, and for today: completed blocks count in
// full, the in-progress block is prorated by elapsed time, future blocks count
// as 0. This is what STATUS should compare Actual against, per Section 33 — not
// the full-shift Adjusted Plan, which overstates how far behind an early shift
// looks (e.g. 08:00–10:00 actual compared against a whole day's 3,150 plan).
function expectedByNow(pb,bs,viewDate){
 let today=localDate();
 if(viewDate<today)return pb.reduce((a,b)=>a+b,0);
 if(viewDate>today)return 0;
 if(!bs.length)return pb.reduce((a,b)=>a+b,0);
 let u=unwrapBlockTimes(bs),now=nowMinutes();
 if(now<u[0].startU)now+=1440;
 let sum=0;
 for(let i=0;i<pb.length;i++){
  let blk=u[i];if(!blk)break;
  if(now>=blk.endU)sum+=pb[i];
  else if(now>blk.startU)sum+=pb[i]*(now-blk.startU)/(blk.endU-blk.startU);
 }
 return sum;
}
function blocks(){
 // Canonical schema written by plan.js snap(): S.plan.blocks[] — each block has
 // {start,end,cells:[{model,door,plan,originalPlan}],total,originalTotal,...}
 return S.plan?.blocks||[];
}
function rowsFromPlan(){
 // Read plan quantities directly from the same field entry.js already reads
 // (S.plan.blocks[bi].cells[].plan) so Dashboard can never diverge from Entry.
 let out={};
 blocks().forEach((b,bi)=>{
  (b.cells||[]).forEach(c=>{
   let kk=k(c.model,c.door);
   (out[kk]??=[])[bi]=Number(c.plan||0);
  });
 });
 return out;
}
function actualRows(){
 let out={},a=S.actual?.actualByCell||{};
 Object.entries(a).forEach(([cell,v])=>{let p=cell.split("|||"),bi=Number(p[0]),kk=k(p[1],p[2]);(out[kk]??=[])[bi]=Number(v||0)});
 return out;
}
function filters(keys){
 let models=[...new Set(keys.map(x=>splitKey(x).model).filter(Boolean))].sort(),doors=[...new Set(keys.map(x=>splitKey(x).door).filter(Boolean))].sort();
 let mv=$("dashModel").value,dv=$("dashDoor").value;
 $("dashModel").innerHTML='<option value="">All Models</option>'+models.map(x=>`<option ${x===mv?"selected":""}>${esc(x)}</option>`).join("");
 $("dashDoor").innerHTML='<option value="">All Doors</option>'+doors.map(x=>`<option ${x===dv?"selected":""}>${esc(x)}</option>`).join("");
}
function selected(keys){let m=$("dashModel").value,d=$("dashDoor").value;return keys.filter(x=>(!m||splitKey(x).model===m)&&(!d||splitKey(x).door===d))}
function autoLoss(){return S.plan?.masterSnapshot?.palletChangeLosses||[]}
function lossRows(){return [...autoLoss().map(x=>({...x,category:x.category||"Pallet Change"})),...S.manual]}
function render(){
 let P=rowsFromPlan();let A=actualRows();let keys=[...new Set([...Object.keys(P),...Object.keys(A)])];S.keys=keys;filters(keys);let use=selected(keys);
 let n=Math.max(0,...use.flatMap(x=>[(P[x]||[]).length,(A[x]||[]).length])), labels=[];
 let bs=blocks();for(let i=0;i<n;i++)labels.push(bs[i]?(bs[i].label||`${bs[i].start||bs[i].startTime||""}–${bs[i].end||bs[i].endTime||""}`):`Block ${i+1}`);
 let pb=Array(n).fill(0),ab=Array(n).fill(0);use.forEach(x=>{for(let i=0;i<n;i++){pb[i]+=Number(P[x]?.[i]||0);
  // นับ Actual เฉพาะ Model/Door ที่ยังอยู่ใน Plan ปัจจุบัน — กัน key เก่าที่
  // ค้างมาจากก่อนเปลี่ยนชื่อ Model ใน Master ไม่ให้บวกเข้าไปในยอดรวมซ้ำซ้อน
  if(P[x])ab[i]+=Number(A[x]?.[i]||0);
 }});
 let plan=pb.reduce((a,b)=>a+b,0),actual=ab.reduce((a,b)=>a+b,0),gap=actual-plan,ach=plan?actual/plan*100:0,loss=lossRows().filter(x=>x.category!=="Material").reduce((s,x)=>s+Number(x.minutes||0),0),material=lossRows().filter(x=>x.category==="Material").reduce((s,x)=>s+Number(x.minutes||0),0);
 let expected=expectedByNow(pb,bs,$("dashDate").value);
 let status=expected>0?(actual>=expected?"ON TARGET":"BEHIND PLAN"):"ON TARGET";
 statusBanner(status,actual,expected);
 achievementBar(plan,actual,ach);
 thisBlockCard(labels,pb,ab,bs,$("dashDate").value,P,A,use);
 $("dashKpis").innerHTML=`<div class="entry-kpi kpi-secondary"><small>ADJUSTED PLAN</small><b>${plan.toLocaleString()}</b></div><div class="entry-kpi kpi-secondary"><small>EXPECTED (NOW)</small><b>${Math.round(expected).toLocaleString()}</b></div><div class="entry-kpi kpi-primary"><small>ACTUAL</small><b>${actual.toLocaleString()}</b></div><div class="entry-kpi"><small>GAP</small><b class="${gap<0?"kpi-bad":"kpi-good"}">${gap>0?"+":""}${gap.toLocaleString()}</b></div><div class="entry-kpi kpi-primary"><small>ACHIEVEMENT</small><b>${ach.toFixed(1)}%</b></div><div class="entry-kpi kpi-secondary"><small>LOSS</small><b>${loss} min</b></div><div class="entry-kpi kpi-secondary"><small>MATERIAL WAITING</small><b>${material} min</b></div>`;
 charts(labels,pb,ab); performance(P,A,use); lossView(); S.hourlyArgs={labels,bs,P,A,use}; hourlySummary(); note(`Dashboard loaded · ${$("dashDate").value} · Line ${$("dashLine").value} / ${$("dashShift").value}`,"plan-ok");
}
function achievementBar(plan,actual,ach){
 let host=$("dashAchievementBar");
 if(!host)return;
 if(!plan){host.innerHTML="";return}
 let pct=Math.min(100,Math.max(0,ach));
 let remaining=Math.max(plan-actual,0);
 let sub=actual>=plan?"Plan achieved":`${remaining.toLocaleString()} pcs remaining to Plan`;
 host.innerHTML=`<div class="dash-ach-head"><span>Achievement</span><b>${ach.toFixed(1)}%</b></div><div class="dash-ach-track"><div class="dash-ach-fill${ach>=100?" full":""}" style="width:${pct}%"></div></div><div class="dash-ach-sub">${sub}</div>`;
}
function hourlySummary(){
 let host=$("dashHourly"),sel=$("dashHourlySelect");
 if(!host||!S.hourlyArgs)return;
 let {labels,bs,P,A,use}=S.hourlyArgs;
 // Populate the block picker (WORK blocks only) — keep whatever was already
 // selected if it's still a valid option after reloading.
 if(sel){
  let keepVal=sel.value;
  let opts=['<option value="ALL">ทุกช่วงเวลา</option>'];
  for(let i=0;i<labels.length;i++)if(bs[i]?.type!=="BREAK")opts.push(`<option value="${i}">${esc(labels[i]||"")}</option>`);
  sel.innerHTML=opts.join("");
  if([...sel.options].some(o=>o.value===keepVal))sel.value=keepVal;
 }
 let want=sel?sel.value:"ALL";
 let n=labels.length,h="";
 for(let i=0;i<n;i++){
  if(bs[i]?.type==="BREAK")continue;
  if(want!=="ALL"&&String(i)!==want)continue;
  let rows=(use||[]).map(x=>{let pv=Number(P[x]?.[i]||0),av=Number(A[x]?.[i]||0);return {x,p:pv,a:av,d:av-pv}}).filter(r=>r.p||r.a);
  if(!rows.length)continue;
  rows.sort((r1,r2)=>r1.d-r2.d);
  let tp=rows.reduce((s,r)=>s+r.p,0),ta=rows.reduce((s,r)=>s+r.a,0),td=ta-tp;
  h+=`<div class="dash-hour-block"><div class="dash-hour-block-title">${esc(labels[i]||"")}</div><div class="table-scroll"><table class="grid mobile-cards"><thead><tr><th>Model</th><th>Door</th><th>Plan</th><th>Actual</th><th>Diff</th></tr></thead><tbody>`;
  rows.forEach(r=>{let q=splitKey(r.x);h+=`<tr><td data-label="Model">${esc(q.model)}</td><td data-label="Door">${esc(q.door)}</td><td data-label="Plan">${r.p}</td><td data-label="Actual"><b>${r.a}</b></td><td data-label="Diff" class="${r.d<0?"kpi-bad":"kpi-good"}">${r.d>0?"+":""}${r.d}</td></tr>`});
  h+=`<tr class="dash-this-block-total"><td colspan="2" data-label="">Total</td><td data-label="Plan">${tp}</td><td data-label="Actual"><b>${ta}</b></td><td data-label="Diff" class="${td<0?"kpi-bad":"kpi-good"}">${td>0?"+":""}${td}</td></tr>`;
  h+=`</tbody></table></div></div>`;
 }
 host.innerHTML=h||'<div class="empty-state">ไม่มีข้อมูล</div>';
}
function statusBanner(status,actual,expected){
 let ok=status==="ON TARGET";
 let host=$("dashStatusBanner");
 if(!host)return;
 host.className="dash-status-banner "+(ok?"kpi-good-bg":"kpi-bad-bg");
 host.innerHTML=`<span class="dash-status-icon">${ok?"🟢":"🔴"}</span><span class="dash-status-text">${status}</span><span class="dash-status-sub">Actual ${actual.toLocaleString()} / Expected (Now) ${Math.round(expected).toLocaleString()}</span>`;
}
function currentBlockIndex(bs,viewDate){
 // "Current block" only makes sense when looking at TODAY — a past/future
 // date has no "now" inside its own timeline.
 if(viewDate!==localDate()||!bs.length)return -1;
 let u=unwrapBlockTimes(bs),now=nowMinutes();
 if(now<u[0].startU)now+=1440;
 for(let i=0;i<u.length;i++)if(now>=u[i].startU&&now<u[i].endU)return i;
 return -1;
}
function thisBlockCard(labels,pb,ab,bs,viewDate,P,A,use){
 let host=$("dashThisBlock"),tableHost=$("dashThisBlockTable");
 if(!host)return;
 let idx=currentBlockIndex(bs,viewDate);
 if(idx<0||bs[idx]?.type==="BREAK"){
  host.innerHTML="";host.style.display="none";
  if(tableHost){tableHost.innerHTML="";tableHost.style.display="none"}
  return;
 }
 let p=Number(pb[idx]||0),a=Number(ab[idx]||0),d=a-p;
 host.style.display="block";
 host.innerHTML=`<div class="dash-this-block-label">THIS BLOCK · ${esc(labels[idx]||"")}</div><div class="dash-this-block-nums"><span>Plan <b>${p}</b></span><span>Actual <b>${a}</b></span><span class="dash-this-block-diff ${d<0?"kpi-bad":"kpi-good"}">Diff <b>${d>0?"+":""}${d}</b></span></div>`;
 if(!tableHost)return;
 // Per-Model/Door breakdown for just this one block — worst Diff first, so
 // whichever model is dragging this hour down shows up right at the top.
 let rows=(use||[]).map(x=>{
  let pv=Number(P[x]?.[idx]||0),av=Number(A[x]?.[idx]||0);
  return {x,p:pv,a:av,d:av-pv};
 }).filter(r=>r.p||r.a);
 if(!rows.length){tableHost.innerHTML="";tableHost.style.display="none";return}
 rows.sort((r1,r2)=>r1.d-r2.d);
 let h=`<div class="table-scroll"><table class="grid mobile-cards"><thead><tr><th>Model</th><th>Door</th><th>Plan</th><th>Actual</th><th>Diff</th></tr></thead><tbody>`;
 rows.forEach(r=>{let q=splitKey(r.x);h+=`<tr><td data-label="Model">${esc(q.model)}</td><td data-label="Door">${esc(q.door)}</td><td data-label="Plan">${r.p}</td><td data-label="Actual"><b>${r.a}</b></td><td data-label="Diff" class="${r.d<0?"kpi-bad":"kpi-good"}">${r.d>0?"+":""}${r.d}</td></tr>`});
 h+=`<tr class="dash-this-block-total"><td colspan="2" data-label="">Total</td><td data-label="Plan">${p}</td><td data-label="Actual"><b>${a}</b></td><td data-label="Diff" class="${d<0?"kpi-bad":"kpi-good"}">${d>0?"+":""}${d}</td></tr>`;
 h+=`</tbody></table></div>`;
 tableHost.style.display="block";
 tableHost.innerHTML=h;
}
let datalabelsRegistered=false;
function ensureDatalabels(){
 if(!datalabelsRegistered&&window.ChartDataLabels){Chart.register(window.ChartDataLabels);datalabelsRegistered=true}
}
function charts(labels,p,a){
 ensureDatalabels();
 if(S.hourly)S.hourly.destroy();if(S.cum)S.cum.destroy();
 const planColor="#64748b",actualColor="#2563eb";
 S.hourly=new Chart($("hourlyChart"),{type:"bar",data:{labels,datasets:[{label:"Adjusted Plan",data:p,backgroundColor:planColor,borderColor:planColor,borderRadius:3},{label:"Actual",data:a,backgroundColor:actualColor,borderColor:actualColor,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true}},plugins:{datalabels:{display:false},tooltip:{mode:"index",intersect:false,callbacks:{
  title:items=>items.length?labels[items[0].dataIndex]:"",
  filter:()=>false,
  afterBody:items=>{
   if(!items.length)return[];
   let i=items[0].dataIndex,pv=Number(p[i]||0),av=Number(a[i]||0),gap=av-pv;
   return [`Plan: ${pv.toLocaleString()}`,`Actual: ${av.toLocaleString()}`,`Gap: ${gap>0?"+":""}${gap.toLocaleString()}`];
  }
 }}}}});
 let cp=[],ca=[],x=0,y=0;p.forEach(v=>cp.push(x+=v));a.forEach(v=>ca.push(y+=v));
 S.cum=new Chart($("cumChart"),{type:"line",data:{labels,datasets:[{label:"Cumulative Plan",data:cp,tension:.25,borderColor:planColor,backgroundColor:planColor,pointRadius:2},{label:"Cumulative Actual",data:ca,tension:.25,borderColor:actualColor,backgroundColor:actualColor,pointRadius:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true}},plugins:{datalabels:{display:false}}}});
}
function statusBadge(gap){
 // Same thresholds as before (gap>=0 / gap>=-20 / gap<-20) — only the
 // presentation changed, from an emoji dot to a labeled subtle badge.
 if(gap>=0)return '<span class="status-badge status-good">ON TARGET</span>';
 if(gap>=-20)return '<span class="status-badge status-watch">WATCH</span>';
 return '<span class="status-badge status-bad">BEHIND PLAN</span>';
}
function achClass(z){return z>=100?"kpi-good":z>=95?"kpi-watch":"kpi-bad"}
function performance(P,A,keys){
 if(!keys.length){$("performanceTable").innerHTML='<div class="empty-state">ไม่มี Model/Door สำหรับตัวกรองนี้</div>';return}
 // Worst-Achievement-first — so the thing most in need of attention is always
 // at the top, instead of a fixed Model order the reader has to scan through.
 let rows=keys.map(x=>{let p=(P[x]||[]).reduce((a,b)=>a+Number(b||0),0),a=(A[x]||[]).reduce((a,b)=>a+Number(b||0),0);return {x,p,a,g:a-p,z:p?a/p*100:0}});
 rows.sort((r1,r2)=>r1.z-r2.z);
 let h='<div class="table-scroll"><table class="grid mobile-cards"><thead><tr><th>Model</th><th>Door</th><th>Plan</th><th>Actual</th><th>Gap</th><th>Ach.</th><th>Status</th></tr></thead><tbody>';
 rows.forEach(r=>{let q=splitKey(r.x);h+=`<tr><td data-label="Model">${esc(q.model)}</td><td data-label="Door">${esc(q.door)}</td><td data-label="Plan">${r.p}</td><td data-label="Actual"><b>${r.a}</b></td><td data-label="Gap" class="${r.g<0?"kpi-bad":"kpi-good"}">${r.g>0?"+":""}${r.g}</td><td data-label="Ach." class="${r.p?achClass(r.z):""}">${r.z.toFixed(1)}%</td><td data-label="Status">${r.p?statusBadge(r.g):"—"}</td></tr>`});
 let tp=rows.reduce((s,r)=>s+r.p,0),ta=rows.reduce((s,r)=>s+r.a,0),tg=ta-tp,tz=tp?ta/tp*100:0;
 h+=`<tr class="dash-this-block-total"><td data-label="">TOTAL</td><td data-label=""></td><td data-label="Plan">${tp}</td><td data-label="Actual"><b>${ta}</b></td><td data-label="Gap" class="${tg<0?"kpi-bad":"kpi-good"}">${tg>0?"+":""}${tg}</td><td data-label="Ach." class="${tp?achClass(tz):""}">${tz.toFixed(1)}%</td><td data-label="Status">${tp?statusBadge(tg):"—"}</td></tr>`;
 h+='</tbody></table></div>';$("performanceTable").innerHTML=h;
}
function lossView(){
 let rows=lossRows(),t={};
 rows.forEach(x=>{let c=x.category||"Other";(t[c]??=[]).push(x)});
 let groups=Object.entries(t).map(([c,items])=>({c,items,total:items.reduce((s,x)=>s+Number(x.minutes||0),0)}));
 groups.sort((a,b)=>b.total-a.total);
 if(!groups.length){$("lossAnalysis").innerHTML='<div class="empty-state">No production loss recorded</div>';return}
 let max=Math.max(...groups.map(g=>g.total),1);
 let h='<div class="loss-pareto">';
 groups.forEach((g,gi)=>{
  let pct=Math.round(g.total/max*100);
  h+=`<div class="loss-pareto-row loss-cat-toggle" data-idx="${gi}">
   <div class="loss-pareto-label">${esc(g.c)}</div>
   <div class="loss-pareto-track"><div class="loss-pareto-fill" style="width:${pct}%"></div></div>
   <div class="loss-pareto-value">${g.total} min</div>
  </div>`;
 });
 h+='</div>';
 groups.forEach((g,gi)=>{
  let items=[...g.items].sort((a,b)=>String(a.start||"").localeCompare(String(b.start||"")));
  h+=`<div class="loss-cat-detail" id="lossCatDetail${gi}" style="display:none">`;
  items.forEach(x=>h+=`<div class="loss-detail-row"><span>${esc(x.start||"")}–${esc(x.end||"")}</span><b>${x.minutes} min</b>${x.remark?`<small>${esc(x.remark)}</small>`:""}</div>`);
  h+=`</div>`;
 });
 $("lossAnalysis").innerHTML=h;
 groups.forEach((g,gi)=>{
  let chip=document.querySelector(`.loss-cat-toggle[data-idx="${gi}"]`),detail=$(`lossCatDetail${gi}`);
  if(!chip||!detail)return;
  chip.onclick=()=>{let open=detail.style.display!=="none";detail.style.display=open?"none":"block";chip.classList.toggle("open",!open)};
 });
}
async function load(){
 let d=$("dashDate").value,l=$("dashLine").value.toUpperCase(),sh=$("dashShift").value;ProdV2Context.set({date:d,lineId:l,shift:sh});stat("Loading...");
 try{
  let [p,a,loss]=await Promise.all([
   ProdV2DB.collection("prodV2_dailyPlans").doc(`plan_${d}_${l}_${sh}`).get(),
   ProdV2DB.collection("prodV2_actualLogs").doc(`actual_${d}_${l}_${sh}`).get(),
   ProdV2DB.collection("prodV2_lossLogs").where("date","==",d).where("lineId","==",l).where("shift","==",sh).get()
  ]);
  S.plan=p.exists?{id:p.id,...p.data()}:null;S.actual=a.exists?{id:a.id,...a.data()}:null;S.manual=loss.docs.map(x=>({id:x.id,...x.data()}));
  if(!S.plan)note("ไม่พบ Saved Daily Plan สำหรับชุดนี้","plan-warn");render();stat("Loaded","ok")
 }catch(e){console.error(e);note(e.message,"plan-warn");stat("Load failed","err")}
}
async function init(){
 $("dashDate").value=localDate();$("dashModel").onchange=render;$("dashDoor").onchange=render;
 // เปลี่ยน Date/Line/Shift แล้วโหลดใหม่ทันที ไม่ต้องกด Load Dashboard เอง —
 // ปุ่มยังอยู่เผื่ออยากรีเฟรชข้อมูลซ้ำที่ตัวกรองเดิม (เช่น มีคนกรอก Actual เพิ่มระหว่างเปิดหน้าไว้)
 $("dashDate").onchange=load;$("dashLine").onchange=load;$("dashShift").onchange=load;
 $("dashHourlyToggle")?.addEventListener("click",()=>{
  let open=$("dashHourly").style.display!=="none";
  $("dashHourly").style.display=open?"none":"block";
  $("dashHourlyToggle").textContent=open?"ดูสรุปรายชั่วโมง":"ซ่อนสรุปรายชั่วโมง";
 });
 $("dashHourlySelect")?.addEventListener("change",hourlySummary);
 try{S.lines=(await all("prodV2_lines")).filter(x=>x.active!==false).sort((a,b)=>(a.order||99)-(b.order||99));$("dashLine").innerHTML=S.lines.map(x=>`<option value="${x.lineId||x.code||x.id}">${esc(x.lineName||x.name||"Line "+(x.lineId||x.code||x.id))}</option>`).join("");let c=ProdV2Context.get();if(c.date)$("dashDate").value=c.date;if(c.lineId&&[...$("dashLine").options].some(o=>o.value===c.lineId))$("dashLine").value=c.lineId;if(c.shift)$("dashShift").value=c.shift;if($("dashDate").value&&$("dashLine").value&&$("dashShift").value)load()}catch(e){note(e.message,"plan-warn")}
}
addEventListener("DOMContentLoaded",init)})();