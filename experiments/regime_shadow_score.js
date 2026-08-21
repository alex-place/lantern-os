/**
 * regime_shadow_score.js — grade the regime shadow's forward journal (#3389).
 *
 * Joins data/lantern-garage/trading/regime-shadow.jsonl against realized SPY:
 *   open  reads predict that day's open→close
 *   close reads predict the next session's close→close
 *
 * Per provider (claude vs local Σ₀), per read:
 *   - regime hit-rate against a ±0.15% band (trend_up / trend_down / chop)
 *   - posture P&L: long=+r, flat=0, inverse=−r — vs the always-long baseline
 *   - Spearman rho(signed conviction, realized) — the calibration number that
 *     killed the per-signal analyst (rho ≈ 0.007) and must clear ~|0.4| at
 *     small n to mean anything
 *
 * Run it any time; it scores whatever the journal holds and says plainly when
 * n is too small to decide (it will be, for the first ~2 weeks).
 *
 *   node experiments/regime_shadow_score.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const LOG = process.env.TRADER_REGIME_LOG
  || path.join(__dirname, "..", "data", "lantern-garage", "trading", "regime-shadow.jsonl");
const BAND = 0.0015;   // ±0.15%: inside = chop was right

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on("error", reject);
    rq.setTimeout(20000, () => { rq.destroy(); reject(new Error("timeout")); });
  });
}

(async () => {
  let rows;
  try {
    rows = fs.readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter((r) => r && r.date && r.read && r.provider);
  } catch (_e) { console.log("no journal at " + LOG + " — enable TRADER_REGIME_SHADOW=1 and let it run."); return; }
  const usable = rows.filter((r) => !r.degraded && r.posture);
  console.log(`journal: ${rows.length} rows (${usable.length} non-degraded) at ${LOG}`);

  // realized SPY, daily
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - 200 * 86400;
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&period1=${p1}&period2=${p2}`);
  const rr = j.chart.result[0];
  const days = [];
  for (let i = 0; i < rr.timestamp.length; i++) {
    const q = rr.indicators.quote[0];
    if (q.close[i] == null) continue;
    days.push({ d: new Date(rr.timestamp[i] * 1000).toISOString().slice(0, 10), o: q.open[i], c: q.close[i] });
  }
  const idx = new Map(days.map((x, i) => [x.d, i]));

  const realized = (r) => {
    const i = idx.get(r.date);
    if (i == null) return null;
    if (r.read === "open") return days[i].c / days[i].o - 1;                       // that day, open→close
    return i + 1 < days.length ? days[i + 1].c / days[i].c - 1 : null;             // next session close→close
  };

  const grade = (rs) => {
    const scored = rs.map((r) => ({ ...r, r: realized(r) })).filter((x) => x.r != null);
    if (!scored.length) return null;
    const hit = scored.filter((x) =>
      (x.regime === "trend_up" && x.r > BAND) ||
      (x.regime === "trend_down" && x.r < -BAND) ||
      (x.regime === "chop" && Math.abs(x.r) <= BAND)).length;
    const pos = scored.reduce((t, x) => t + (x.posture === "long" ? x.r : x.posture === "inverse" ? -x.r : 0), 0);
    const base = scored.reduce((t, x) => t + x.r, 0);
    // rho(signed conviction, realized)
    const sc = scored.map((x) => ({ v: (x.posture === "inverse" ? -1 : x.posture === "flat" ? 0 : 1) * (x.conviction ?? 50), r: x.r }));
    const rank = (a, f) => { const s = [...a].sort((p, q) => f(p) - f(q)); const m = new Map(); s.forEach((v, i) => m.set(v, i + 1)); return m; };
    let rho = null;
    if (sc.length >= 5) {
      const r1 = rank(sc, (x) => x.v), r2 = rank(sc, (x) => x.r);
      let d2 = 0; for (const x of sc) d2 += Math.pow(r1.get(x) - r2.get(x), 2);
      rho = 1 - (6 * d2) / (sc.length * (sc.length * sc.length - 1));
    }
    return { n: scored.length, hitRate: hit / scored.length, postureRet: pos, baselineRet: base, rho };
  };

  console.log("\nprovider  read     n   regime-hit   posture-return   always-long   rho(conv, realized)");
  for (const provider of ["claude", "local"]) {
    for (const read of ["open", "close"]) {
      const g = grade(usable.filter((r) => r.provider === provider && r.read === read));
      if (!g) { console.log(`${provider.padEnd(8)} ${read.padEnd(6)}   —`); continue; }
      console.log(`${provider.padEnd(8)} ${read.padEnd(6)} ${String(g.n).padStart(3)}   ${(g.hitRate * 100).toFixed(0).padStart(7)}%   ${(g.postureRet * 100).toFixed(2).padStart(12)}%   ${(g.baselineRet * 100).toFixed(2).padStart(9)}%   ${g.rho == null ? "        n<5" : g.rho.toFixed(3).padStart(10)}`);
    }
  }
  console.log("\nDECISION BAR: nothing is wired to the engine unless a provider beats always-long");
  console.log("AND shows |rho| that survives n≥20 — the same bar the per-signal analyst failed.");
})();
