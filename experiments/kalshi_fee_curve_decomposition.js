"use strict";
/**
 * WHY the edge lives at the price extremes: Kalshi's fee CURVE (#2954 supporting analysis).
 *
 * THE STRUCTURAL ARGUMENT. A serious critique (datagolf, "The Favourite-Longshot Bias is not a
 * bias") shows FLB in BOOKMAKER markets is mechanical, not behavioural: bookmakers allocate roughly
 * EQUAL ABSOLUTE margin (~0.8-1% per side) across all odds (Pinnacle, 27,150 matches 2012-2020),
 * which produces declining returns at long odds with every participant rational — and leaves ALL
 * bets negative-EV, favourites merely less negative. On that account it is not exploitable.
 *
 * That critique does NOT transfer to Kalshi, for a structural reason this script tests:
 *   - Kalshi is an EXCHANGE, not a bookmaker: no house sets one-sided odds with an embedded margin.
 *   - Its fee is 7*P*(1-P)/100 cents — a CONVEX curve MINIMISED at the price extremes (0.43c in
 *     90-97c) and MAXIMISED mid-book (1.74c in 45-55c): a 4x difference.
 * So a small gross edge can survive net at the extremes while being eaten alive mid-book. The CEPR
 * study of 300k+ Kalshi contracts reports precisely the exchange-specific outcome the bookmaker
 * model does not predict: high-price contracts yield "small POSITIVE returns" NET of fees.
 *
 * This decomposes our own measured edge into GROSS / FEE / NET per band to see whether the fee
 * curve explains where it survives. Liquid minutes only, real ask, event-clustered.
 *
 * CAUTION applied to our own result: 8 bands are tested here. A single band at t=2.29 does NOT
 * clear the Harvey-Liu |t|>3 bar for a new factor claim under multiple testing. Read the tails
 * (both significant, opposite signs, as theory predicts) rather than any one cell.
 *
 * Read-only. Run: node experiments/kalshi_fee_curve_decomposition.js
 */
const fs=require("fs"),path=require("path"),readline=require("readline");
const DIR=path.join(__dirname,"..","data","kalshi","candles-1m");
const feeC=p=>0.07*p*(100-p)/100;
const mean=a=>a.reduce((x,y)=>x+y,0)/(a.length||1);
function tstat(a){const n=a.length;if(n<2)return{n,m:mean(a),t:0};const m=mean(a),sd=Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(n-1));return{n,m,t:sd>0?m/(sd/Math.sqrt(n)):0};}
const BANDS=[[5,15],[15,30],[30,45],[45,55],[55,70],[70,80],[80,90],[90,97]];
(async()=>{
  const cell=new Map();
  for(const fn of fs.readdirSync(DIR).filter(f=>f.endsWith(".candles.jsonl"))){
    const rl=readline.createInterface({input:fs.createReadStream(path.join(DIR,fn)),crlfDelay:Infinity});
    for await(const line of rl){ if(!line.trim())continue; let m;try{m=JSON.parse(line)}catch{continue}
      const cs=(m.candles||[]).filter(c=>Number.isFinite(c.ac)&&c.ac>0&&c.ac<100&&c.v>0); if(cs.length<5)continue;
      const V=m.result==="yes"?100:0;
      for(const c of cs){ const ask=c.ac;
        for(const[lo,hi] of BANDS){ if(ask<lo||ask>=hi)continue;
          const k=`${lo}-${hi}`; const b=cell.get(k)||{n:0,sumFee:0,evG:new Map(),evN:new Map()};
          const gross=V-ask, net=gross-feeC(ask);
          b.n++; b.sumFee+=feeC(ask);
          (b.evG.get(m.event)||b.evG.set(m.event,[]).get(m.event)).push(gross);
          (b.evN.get(m.event)||b.evN.set(m.event,[]).get(m.event)).push(net);
          cell.set(k,b); break; } } }
  }
  console.log("Does Kalshi's fee CURVE explain where the edge survives?");
  console.log("fee = 7*P*(1-P)/100 -> smallest at the extremes, largest mid-book\n");
  console.log(`${"band".padStart(8)} ${"events".padStart(7)} ${"GROSS".padStart(8)} ${"fee".padStart(6)} ${"NET".padStart(8)} ${"t(net)".padStart(7)}`);
  for(const[lo,hi] of BANDS){ const b=cell.get(`${lo}-${hi}`); if(!b||b.evN.size<10)continue;
    const g=tstat([...b.evG.values()].map(mean)), n=tstat([...b.evN.values()].map(mean));
    console.log(`${`${lo}-${hi}c`.padStart(8)} ${String(n.n).padStart(7)} ${g.m.toFixed(2).padStart(8)} ${(b.sumFee/b.n).toFixed(2).padStart(6)} ${n.m.toFixed(2).padStart(8)} ${n.t.toFixed(2).padStart(7)}`);
  }
})();
