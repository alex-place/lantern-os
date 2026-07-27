"use strict";
/**
 * BUY-FAVOURITES, STRICTLY BLIND (#2954) — no information that postdates the decision.
 *
 * WHAT A "FAVOURITE" IS: purely the quoted price. On Kalshi price == implied probability, so a
 * favourite is any contract whose ask sits above a threshold. Nothing about the outcome, the event,
 * or any model enters the definition — which is what makes it deterministically identifiable at
 * decision time rather than in hindsight.
 *
 * THE LEAKS THIS FIXES (both present in the first pass, both small, both edge-manufacturing):
 *   L1 the earlier version read each minute's ask CLOSE (`ac`) — unknowable until the minute ends.
 *      Here we decide on the ask OPEN (`ao`): the price actually quoted when the minute begins.
 *   L2 the earlier version required volume>0 in the SAME minute — also only known afterwards.
 *      Here liquidity is judged on the PREVIOUS minute (`v` at i-1), which is knowable.
 *
 * REMAINING, DISCLOSED, NOT FIXABLE IN-SAMPLE:
 *   - Band choice (90-97c) was selected after seeing 8 bands. It is reported here as PRE-REGISTERED
 *     for future data, and the full band grid is printed so nothing hides behind one cell.
 *   - Series survivorship: series that were delisted before collection are absent.
 *   - Settled-only: markets voided/unresolved are absent (they cannot be scored either way).
 *
 * Read-only. Run: node experiments/kalshi_favorites_blind.js
 */
const fs=require("fs"),path=require("path"),readline=require("readline");
const DIR=path.join(__dirname,"..","data","kalshi","candles-1m");
const feeC=p=>0.07*p*(100-p)/100;
const mean=a=>a.reduce((x,y)=>x+y,0)/(a.length||1);
function tstat(a){const n=a.length;if(n<2)return{n,m:mean(a),t:0};const m=mean(a),sd=Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(n-1));return{n,m,t:sd>0?m/(sd/Math.sqrt(n)):0};}
const BANDS=[[5,15],[15,30],[30,45],[45,55],[55,70],[70,80],[80,90],[90,97]];
(async()=>{
  const cell=new Map(); let mk=0, decisions=0;
  for(const fn of fs.readdirSync(DIR).filter(f=>f.endsWith(".candles.jsonl"))){
    const rl=readline.createInterface({input:fs.createReadStream(path.join(DIR,fn)),crlfDelay:Infinity});
    for await(const line of rl){ if(!line.trim())continue; let m;try{m=JSON.parse(line)}catch{continue}
      const cs=m.candles||[]; if(cs.length<5)continue; mk++;
      const V=m.result==="yes"?100:0;
      for(let i=1;i<cs.length;i++){
        const prevVol=cs[i-1].v;                 // L2: liquidity from the PREVIOUS minute
        if(!(prevVol>0))continue;
        const ask=cs[i].ao;                      // L1: the ask quoted at the START of this minute
        if(!Number.isFinite(ask)||ask<=0||ask>=100)continue;
        decisions++;
        for(const[lo,hi] of BANDS){ if(ask<lo||ask>=hi)continue;
          const k=`${lo}-${hi}`; const b=cell.get(k)||{n:0,sumAsk:0,sumFee:0,ev:new Map()};
          const net=V-ask-feeC(ask);
          b.n++; b.sumAsk+=ask; b.sumFee+=feeC(ask);
          if(!b.ev.has(m.event))b.ev.set(m.event,[]);
          b.ev.get(m.event).push(net); cell.set(k,b); break; } }
    }
  }
  console.log(`markets=${mk}  blind decisions=${decisions}  (ask OPEN, prior-minute liquidity)\n`);
  console.log(`${"band".padStart(8)} ${"obs".padStart(7)} ${"events".padStart(7)} ${"avgAsk".padStart(7)} ${"fee".padStart(5)} ${"net/ct".padStart(8)} ${"t".padStart(7)}`);
  const rows=[];
  for(const[lo,hi] of BANDS){ const b=cell.get(`${lo}-${hi}`); if(!b||b.ev.size<10)continue;
    const st=tstat([...b.ev.values()].map(mean));
    rows.push({band:`${lo}-${hi}`,obs:b.n,events:st.n,avg_ask:+(b.sumAsk/b.n).toFixed(2),fee:+(b.sumFee/b.n).toFixed(2),net_c:+st.m.toFixed(3),t:+st.t.toFixed(2)});
    console.log(`${`${lo}-${hi}c`.padStart(8)} ${String(b.n).padStart(7)} ${String(st.n).padStart(7)} ${(b.sumAsk/b.n).toFixed(1).padStart(7)} ${(b.sumFee/b.n).toFixed(2).padStart(5)} ${st.m.toFixed(3).padStart(8)} ${st.t.toFixed(2).padStart(7)}`);
  }
  const fav=rows.find(r=>r.band==="90-97"), lng=rows.find(r=>r.band==="5-15");
  console.log(`\nPRE-REGISTERED for future data: buy when ask in [90,97) on the minute open, prior minute traded.`);
  console.log(`  favourite tail: ${fav?`${fav.net_c>0?"+":""}${fav.net_c}c t=${fav.t} (n=${fav.events} events)`:"n/a"}`);
  console.log(`  longshot tail : ${lng?`${lng.net_c>0?"+":""}${lng.net_c}c t=${lng.t} (n=${lng.events} events)`:"n/a"}`);
  console.log(`  8 bands tested -> Harvey-Liu bar for a NEW factor is |t|>3; ${fav&&Math.abs(fav.t)>3?"CLEARED":"NOT cleared"} by the favourite tail.`);
  fs.mkdirSync(path.join(__dirname,"results"),{recursive:true});
  fs.writeFileSync(path.join(__dirname,"results","kalshi_favorites_blind.json"),JSON.stringify({date:new Date().toISOString().slice(0,10),markets:mk,decisions,leaks_fixed:["ask open not close","prior-minute liquidity"],disclosed_limits:["band chosen post-hoc; pre-registered for future data","series survivorship","settled-only"],rows},null,2));
})();
