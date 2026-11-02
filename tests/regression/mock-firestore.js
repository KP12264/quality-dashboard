(function(){
  window.__reads = [];
  function hash(s){let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
  const DEFECTS=['รอยขีดข่วน (Scratch)','บุบ (Dent)','สีไหลย้อย','ช่องว่าง/ระดับไม่เสมอ (Gap / Flush NG)','คลิปหาย','ยับ (Wrinkle)','แตกร้าว','คราบกาวเปื้อนผิวชิ้นงานด้านในประตูฝั่งคนขับ','ฟองอากาศ','สีไม่สม่ำเสมอ','Burr','ขนาดผิดสเปก','รูไม่ตรงตำแหน่ง','Dirt / Dust']; const pick=hh=>Math.min(DEFECTS.length-1,Math.floor(DEFECTS.length*Math.pow((hh%1000)/1000,2.2)));
  const FLAT=new Set(['2026-10-20']);
  const C_GAP=new Set(['2026-10-15','2026-10-16','2026-10-17','2026-10-18','2026-10-19']);   // Door C: production but no scrap log
  const SCRAP_ONLY=new Set(['2026-10-13']);   // scrap logged, no production document
  // Edge-case dates (test fixtures):
  //  NO_DATA   : no production, no scrap            -> NO DATA
  //  NO_SCRAP  : production but no scrap log at all  -> INCOMPLETE ("No log")
  //  NIGHT_GAP : Night production missing            -> INCOMPLETE
  //  EXACT     : day total exactly N pcs (Target 50 / 51 boundary)
  const NO_DATA=new Set(['2026-10-10','2026-10-26']);
  const NO_SCRAP=new Set(['2026-10-08','2026-10-09','2026-10-25']);
  const NIGHT_GAP=new Set(['2026-10-11']);
  const EXACT={'2026-10-05':50,'2026-10-06':51,'2026-10-27':50,'2026-10-28':51};
  window.__fixtures={NO_DATA:[...NO_DATA],NO_SCRAP:[...NO_SCRAP],NIGHT_GAP:[...NIGHT_GAP],EXACT};
  function scrapFor(date){
    const out=[];
    if(NO_DATA.has(date)||NO_SCRAP.has(date)) return out;
    if(FLAT.has(date)){ for(let i=0;i<20;i++) out.push({id:date+'-f'+i,data:{date,shift:i%2?'NIGHT':'DAY',line:'ABC'[i%3],model:'M1',defectType:'Defect '+String(i+1).padStart(2,'0'),scrapQty:3,scrapCost:10}}); return out; }
    if(EXACT[date]!==undefined){ // split N over 6 line/shift records
      let left=EXACT[date]; const parts=[];
      ['A','B','C'].forEach(line=>['DAY','NIGHT'].forEach(shift=>parts.push([line,shift])));
      parts.forEach(([line,shift],i)=>{const q=i===5?left:Math.floor(EXACT[date]/6); left-=q;
        out.push({id:`${date}-${line}-${shift}-x`,data:{date,shift,line,model:'M1',defectType:DEFECTS[i%DEFECTS.length],scrapQty:q,scrapCost:100+i}});});
      return out;
    }
    ['A','B','C'].forEach(line=>['DAY','NIGHT'].forEach(shift=>{
      if(NIGHT_GAP.has(date)&&shift==='NIGHT') return;
      if(C_GAP.has(date)&&line==='C') return;
      const h=hash(date+line+shift); const n=h%4;
      for(let i=0;i<n;i++){const hh=hash(date+line+shift+i);
        out.push({id:`${date}-${line}-${shift}-${i}`,data:{date,shift,line,model:'M'+(hh%3),defectType:DEFECTS[pick(hh)],scrapQty:1+hh%9,scrapCost:(hh%5===0)?null:(50+hh%400)}});}
    }));
    return out;
  }
  function snap(docs){return {size:docs.length,empty:!docs.length,forEach:f=>docs.forEach(d=>f({id:d.id,data:()=>d.data})),docs:docs.map(d=>({id:d.id,data:()=>d.data}))};}
  function query(coll,filters){
    return {
      where(f,op,v){return query(coll,filters.concat([[f,op,v]]));},
      orderBy(){return this;}, limit(){return this;},
      async get(){
        window.__reads.push({coll,filters:JSON.stringify(filters)});
        if(coll==='scrapLogs'&&window.__fail&&window.__fail.scrap) throw new Error('mock scrap failure');
        if(coll==='scrapLogs'){
          const lo=filters.find(f=>f[1]==='>=')[2], hi=filters.find(f=>f[1]==='<=')[2];
          const docs=[]; let d=new Date(lo+'T00:00:00Z'); const end=new Date(hi+'T00:00:00Z');
          while(d<=end){docs.push(...scrapFor(d.toISOString().slice(0,10))); d=new Date(d.getTime()+86400000);}
          ['2026-10-02','2026-10-14','2026-10-27'].forEach((d,i)=>{ if(d>=lo&&d<=hi) docs.push({id:'did'+i,data:{date:d,shift:'DAY',line:'DID',model:'MD',defectType:'บุบ (Dent)',scrapQty:7,scrapCost:99}}); });
          return snap(docs);
        }
        if(coll==='targetMaster'){if(window.__fail&&window.__fail.target) throw new Error('mock targetMaster failure'); const s=filters[0][2]; const rows=[{id:'t'+s+'1',data:{shift:s,targetQty:30,effectiveDate:'2026-01-01',note:''}}]; if(s==='DAY') rows.push({id:'tD2',data:{shift:'DAY',targetQty:25,effectiveDate:'2026-09-27',note:''}}); return snap(rows);}
        if(coll==='improvements'&&window.__impScenario){const mk=(st,n)=>Array.from({length:n},(_,i)=>({id:st+i,data:{problem:st+' case '+i,defectType:'Dent',status:st,createdAt:Date.now()-86400000*i}}));
          const S={none:[],zero:[],mixed:[...mk('Monitoring',2),...mk('Controlled',3)],action:[...mk('Monitoring',1),...mk('Controlled',4),...mk('Not Effective',1),...mk('Recurring',2)]}[window.__impScenario];
          if(window.__impScenario==='error') throw new Error('mock read failure');
          return snap(S);}
        if(coll==='improvements'){return snap([
          {id:'i1',data:{problem:'Scratch on door A',defectType:'Scratch',status:'Open',createdAt:Date.now()-86400000*3}},
          {id:'i2',data:{problem:'Dent',defectType:'Dent',status:'In Progress',createdAt:Date.now()-86400000*9}},
          {id:'i3',data:{problem:'Paint drip',defectType:'Paint drip',status:'Done',createdAt:Date.now()-86400000*20}}]);}
        return snap([]);
      },
      add(){window.__writes++;return Promise.resolve({id:'w'});},
      doc(id){return {id,update(){window.__writes++;return Promise.resolve();},set(){window.__writes++;return Promise.resolve();},delete(){window.__writes++;return Promise.resolve();},async get(){
        window.__reads.push({coll,doc:id});
        const h=hash(id);
        const dm=/(\d{4}-\d{2}-\d{2})/.exec(id); const dd=dm?dm[1]:'';
        if(coll==='prodV2_actualLogs'&&window.__fail&&window.__fail.prodDates&&window.__fail.prodDates.includes(dd)&&/_A_/.test(id)) throw new Error('mock production failure');
        if(coll==='prodV2_actualLogs'&&SCRAP_ONLY.has(dd)) return {exists:false,data:()=>undefined};
        if(coll==='prodV2_actualLogs'&&(NO_DATA.has(dd)||(NIGHT_GAP.has(dd)&&/NIGHT/i.test(id)))) return {exists:false,data:()=>undefined};
        if(coll==='prodV2_actualLogs'&&EXACT[dd]!==undefined) return {exists:true,data:()=>({actualByCell:{'0|||M1|||FR':500}})};
        if(coll==='prodV2_actualLogs'){ if(h%23===0) return {exists:false,data:()=>undefined};
          return {exists:true,data:()=>({actualByCell:{'0|||M1|||FR':300+h%200,'1|||M2|||RR':200+(h>>3)%150}})};}
        return {exists:false,data:()=>undefined};
      }};}
    };
  }
  window.__writes=0;
  window.firebase={initializeApp:()=>({}),firestore:()=>({collection:c=>query(c,[])})};
})();
