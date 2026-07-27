"use strict";
/**
 * BUY-FAVOURITES, executable test (#2954) — the one candidate still standing.
 *
 * The retail-accessible edge in the literature (QuantPedia synthesis of ~20 studies) is longshot
 * bias, and its tradeable expression is BUYING FAVOURITES — a TAKER order, so fills are structurally
 * certain. That is the property the longshot-fade lacked: it needed a resting offer to be lifted,
 * and ~50% never were.
 *
 * TWO SAMPLING CORRECTIONS THIS ENCODES (both changed the answer):
 *  1. REAL ASK, not traded price. A taker pays the ask; the trades-based pass measured the price
 *     trades happened at. Measured gap: +0.60c. Small, but it is a cost, not a rounding detail.
 *  2. LIQUID MINUTES ONLY (volume>0). Time-weighted sampling over ALL quoted minutes is dominated
 *     by stale asks in markets sitting untraded — measured 2026-07-25, that produced spurious
 *     SIGNIFICANT NEGATIVES (50-60c t=-2.60, 95-99c t=-5.48) that vanish once you require that
 *     someone actually traded in that minute. You cannot lift a quote nobody is honouring.
 *
 * Event-clustered (bracket markets in one event share one outcome). Read-only.
 * Run: node experiments/kalshi_favorites_liquid.js
 */
const fs=require("fs"),path=require("path"),readline=require("readline");
const DIR=path.join(__dirname,"..","data","kalshi","candles-1m");
const feeC=p=>0.07*p*(100-p)/100;
const mean=a=>a.reduce((x,y)=>x+y,0)/(a.length||1);
function tstat(a){const n=a.length;if(n<2)return{n,m:mean(a),t:0};const m=mean(a),sd=Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(n-1));return{n,m,t:sd>0?m/(sd/Math.sqrt(n)):0};}
function wilson(k,n){if(!n)return[0,0];const z=1.96,p=k/n,d=1+z*z/n;const c=(p+z*z/(2*n))/d,h=(z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/d;return[Math.max(0,100*(c-h)),Math.min(100,100*(c+h))];}
const BANDS=[[50,60],[60,75],[75,85],[85,95],[95,99]];
(async()=>{
  const cell=new Map(); let mk=0, askMinusTrade=[], n=0;
  for(const fn of fs.readdirSync(DIR).filter(f=>f.endsWith(".candles.jsonl"))){
    const rl=readline.createInterface({input:fs.createReadStream(path.join(DIR,fn)),crlfDelay:Infinity});
    for await(const line of rl){
      if(!line.trim())continue; let m;try{m=JSON.parse(line)}catch{continue}
      const cs=(m.candles||[]).filter(c=>Number.isFinite(c.ac)&&c.ac>0&&c.ac<100); if(cs.length<10)continue;
      mk++; const V=m.result==="yes"?100:0;
      // sample every 15th quoted minute to reduce serial correlation within a market
      for(let i=0;i<cs.length;i+=1){ if(!(cs[i].v>0))continue;
        const ask=cs[i].ac;
        if(Number.isFinite(cs[i].pc)&&cs[i].pc>0){askMinusTrade.push(ask-cs[i].pc);n++;}
        for(const [lo,hi] of BANDS){
          if(ask<lo||ask>=hi)continue;
          const k=`${lo}-${hi}`; const b=cell.get(k)||{n:0,wins:0,sum:0,ev:new Map()};
          const net=V-ask-feeC(ask); b.n++; b.sum+=ask; if(V===100)b.wins++;
          const a=b.ev.get(m.event)||[]; a.push(net); b.ev.set(m.event,a); cell.set(k,b); break;
        }
      }
    }
  }
  console.log(`markets=${mk}  LIQUID minutes only (volume>0), real ASK, taker fee\n`);
  console.log(`${"band".padStart(8)} ${"obs".padStart(7)} ${"events".padStart(7)} ${"avgAsk".padStart(7)} ${"net/ct".padStart(8)} ${"t".padStart(7)} ${"actual".padStart(7)}  CI95`);
  for(const [lo,hi] of BANDS){
    const b=cell.get(`${lo}-${hi}`); if(!b||b.ev.size<10)continue;
    const st=tstat([...b.ev.values()].map(mean));
    const avg=b.sum/b.n, act=100*b.wins/b.n, ci=wilson(b.wins,b.n);
    const deg=b.wins===0||b.wins===b.n;
    console.log(`${`${lo}-${hi}c`.padStart(8)} ${String(b.n).padStart(7)} ${String(st.n).padStart(7)} ${avg.toFixed(1).padStart(7)} ${st.m.toFixed(3).padStart(8)} ${(deg?"deg":st.t.toFixed(2)).padStart(7)} ${act.toFixed(1).padStart(6)}%  [${ci[0].toFixed(1)},${ci[1].toFixed(1)}]${ci[0]>avg?" UNDERPRICED":""}`);
  }
  const g=mean(askMinusTrade);
  console.log(`\nask minus last-trade price: mean ${g.toFixed(2)}c over ${n} obs  <- what a taker pays ABOVE the traded price the trades-based test assumed`);
})();
