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
 * v2 rows (prompt_v 2, 2026-10-01: the open read and the 10:35 mid read see the
 * scan's universe, the indices' tape, headlines and their own track record):
 *   - mid reads are scored from SPY at the read (spy_at_read) to that day's close
 *   - day-type hit rate against the scenario-map rule on SPY's 5m session
 *     (RALLY / DROP / V_UP / FADE / MIXED / NARROW)
 *   - PICKS: each pick from its read-time price to that day's close, against the
 *     equal-weight average of every name in the universe over the same window
 *     (universe_px), and the names it said to AVOID over the same window
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
    if (r.read === "mid") return r.spy_at_read > 0 ? days[i].c / r.spy_at_read - 1 : null;   // the read → that day's close
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
    // "open*" = open reads journaled before 2026-10-01 (no gap_source): they were told a wrong gap,
    // minus the previous session's open-to-close move (lib/regime-shadow.js todayOpen). Reported apart, never pooled.
    for (const read of ["open", "open*", "mid", "close"]) {
      const pick = read === "open*" ? (r) => r.read === "open" && !r.gap_source
        : read === "open" ? (r) => r.read === "open" && !!r.gap_source : (r) => r.read === read;
      const g = grade(usable.filter((r) => r.provider === provider && pick(r)));
      if (!g) { console.log(`${provider.padEnd(8)} ${read.padEnd(6)}   —`); continue; }
      console.log(`${provider.padEnd(8)} ${read.padEnd(6)} ${String(g.n).padStart(3)}   ${(g.hitRate * 100).toFixed(0).padStart(7)}%   ${(g.postureRet * 100).toFixed(2).padStart(12)}%   ${(g.baselineRet * 100).toFixed(2).padStart(9)}%   ${g.rho == null ? "        n<5" : g.rho.toFixed(3).padStart(10)}`);
    }
  }
  await scoreV2(usable, fetchJson, days);
  console.log("\nDECISION BAR: nothing is wired to the engine unless a provider beats always-long");
  console.log("AND shows |rho| that survives n≥20 — the same bar the per-signal analyst failed.");
})();

/** v2: day types and picks (prompt_v 2 rows only). */
async function scoreV2(usable, fetchJson, spyDays) {
  const v2 = usable.filter((r) => r.prompt_v === 2 && (r.read === "open" || r.read === "mid"));
  if (!v2.length) { console.log("\nv2 (picks, day type): no rows yet"); return; }
  // the realized day type of each date from SPY's 5m session (Yahoo keeps ~60 days of 5m)
  const dayType = new Map();
  try {
    const j = await fetchJson("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=5m&range=60d");
    const r = j.chart.result[0], q = r.indicators.quote[0];
    const et = (t) => { const d = new Date(t * 1000); const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }); const [md, hm] = s.split(", "); const [mo, da, yr] = md.split("/"); const [h, m] = hm.split(":"); return { day: yr + "-" + mo.padStart(2, "0") + "-" + da.padStart(2, "0"), min: (Number(h) % 24) * 60 + Number(m) }; };
    const sessions = new Map();
    r.timestamp.forEach((t, i) => { if (q.close[i] == null || q.high[i] == null || q.low[i] == null) return; const e = et(t); if (e.min < 570 || e.min >= 960) return; if (!sessions.has(e.day)) sessions.set(e.day, []); sessions.get(e.day).push({ min: e.min, h: q.high[i], l: q.low[i], c: q.close[i] }); });
    const idx = new Map(spyDays.map((x, i) => [x.d, i]));
    for (const [d, bars] of sessions) {
      const i = idx.get(d); if (i == null || i < 61 || bars.length < 60) continue;
      const a = []; for (let k = i - 60; k < i; k++) a.push(Math.abs(spyDays[k].c / spyDays[k - 1].c - 1)); a.sort((x, y) => x - y);
      const mad = (a[29] + a[30]) / 2;
      let hi = -Infinity, lo = Infinity, hiMin = 0, loMin = 0;
      for (const b of bars) { if (b.h > hi) { hi = b.h; hiMin = b.min; } if (b.l < lo) { lo = b.l; loMin = b.min; } }
      const close = bars[bars.length - 1].c, range = (hi - lo) / lo, cl = (close - lo) / (hi - lo);
      dayType.set(d, range < mad ? "NARROW" : cl >= 0.75 && loMin < 660 ? "RALLY" : cl <= 0.25 && hiMin < 660 ? "DROP"
        : cl >= 0.6 && loMin >= 660 ? "V_UP" : cl <= 0.4 && hiMin >= 660 ? "FADE" : "MIXED");
    }
  } catch (_e) { /* day types unavailable: reported as such */ }
  // every symbol's daily closes, once
  const syms = new Set();
  for (const r of v2) { for (const p of r.picks || []) syms.add(p.symbol); for (const k of Object.keys(r.universe_px || {})) syms.add(k); }
  const closes = new Map();
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 120 * 86400;
  for (const sym of syms) {
    try {
      const j = await fetchJson("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?interval=1d&period1=" + p1 + "&period2=" + p2);
      const r = j.chart.result[0], q = r.indicators.quote[0], m = new Map();
      r.timestamp.forEach((t, i) => { if (q.close[i] != null) m.set(new Date(t * 1000).toISOString().slice(0, 10), q.close[i]); });
      closes.set(sym, m);
    } catch (_e) { closes.set(sym, new Map()); }
  }
  const retOf = (sym, date, px) => { const c = closes.get(sym) && closes.get(sym).get(date); return c && px > 0 ? c / px - 1 : null; };
  console.log("\nv2 — picks against the universe (read-time price to that day's close), day type vs the scenario rule");
  console.log("provider  read   reads  day-type hit   picks  pick mean   universe mean   pick - universe   reads beating it   avoid mean   rule-BULLISH mean");
  for (const provider of ["claude", "local"]) for (const read of ["open", "mid"]) {
    const rows = v2.filter((r) => r.provider === provider && r.read === read);
    if (!rows.length) { console.log(provider.padEnd(9) + " " + read.padEnd(6) + "    —"); continue; }
    const typed = rows.filter((r) => r.day_type && dayType.has(r.date));
    const dtHit = typed.length ? typed.filter((r) => r.day_type === dayType.get(r.date)).length / typed.length : null;
    let nP = 0, sumP = 0, sumU = 0, nU = 0, beat = 0, withPicks = 0, nA = 0, sumA = 0, nR = 0, sumR = 0;
    for (const r of rows) {
      const uni = Object.entries(r.universe_px || {}).map(([k, px]) => retOf(k, r.date, px)).filter((x) => x != null);
      const um = uni.length ? uni.reduce((a, b) => a + b, 0) / uni.length : null;
      const pr = (r.picks || []).map((p) => retOf(p.symbol, r.date, p.px)).filter((x) => x != null);
      const ar = (r.avoid || []).map((sym) => retOf(sym, r.date, (r.universe_px || {})[sym])).filter((x) => x != null);
      for (const x of ar) { nA++; sumA += x; }
      const rr = (r.rule_bullish || []).map((sym) => retOf(sym, r.date, (r.universe_px || {})[sym])).filter((x) => x != null);
      for (const x of rr) { nR++; sumR += x; }
      if (um != null) { nU++; sumU += um; }
      if (pr.length && um != null) { withPicks++; const pm = pr.reduce((a, b) => a + b, 0) / pr.length; if (pm > um) beat++; for (const x of pr) { nP++; sumP += x; } }
    }
    const pct = (x) => (x == null || !Number.isFinite(x) ? "  -" : (100 * x).toFixed(2) + "%");
    console.log(provider.padEnd(9) + " " + read.padEnd(6) + String(rows.length).padStart(5) + "   " + (dtHit == null ? "    -" : (100 * dtHit).toFixed(0).padStart(5) + "%") + " (" + typed.length + ")"
      + String(nP).padStart(7) + "   " + pct(nP ? sumP / nP : null).padStart(8) + "   " + pct(nU ? sumU / nU : null).padStart(12) + "   " + pct(nP && nU ? sumP / nP - sumU / nU : null).padStart(14)
      + "   " + (withPicks ? beat + " of " + withPicks : "-").padStart(15) + "   " + pct(nA ? sumA / nA : null).padStart(9) + "   " + pct(nR ? sumR / nR : null).padStart(9) + " (" + nR + ")");
  }
  console.log("(a pick is a name the model said to hold from the read to 15:50; scored to the daily close. The bar for any wiring:");
  console.log(" picks beat the universe in most reads AND by more than costs, over at least 20 reads — and the same for the rules' own entries.)");
}
