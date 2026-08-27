/**
 * turn_consolidation_lab.js — the trader has THREE turn-detectors. Keep which?
 *
 * The gate audit (both boxes, in-session, since 2026-08-18) found 443 blocked entry
 * decisions, 23% of them refused by two or more gates at once, and the single most
 * common co-occurrence was:
 *
 *     31x  "awaiting 2 consecutive bullish scans"  +  "falling_knife"
 *
 * Those are the same idea implemented twice — one waits for the READ to persist, the
 * other waits for MOMENTUM to stop cratering. Both are waiting for a turn. T2, the
 * reversal confirmation that measured best on 60 sessions (+3.94% on a -0.73% drawdown
 * vs baseline's +4.08% on -2.77%), is a THIRD implementation of the same intuition, and
 * it was tested stacked on top of the other two rather than against them.
 *
 * "awaiting 2 consecutive bullish scans" appears in four of the eight most common
 * co-occurrence pairs. So this lab asks the operator's question directly: does T2 work
 * better REPLACING those two than stacking on them?
 *
 *   NONE        no turn detection at all                       (floor for comparison)
 *   LIVE        persistence + falling_knife                    (what the engine runs)
 *   STACKED     persistence + falling_knife + T2               (what was tested before)
 *   T2 ONLY     T2 replaces both                               (the proposal)
 *   PERSIST     persistence alone
 *   KNIFE       falling_knife alone
 *
 * Split by market scenario AND by instrument class, because the coverage lab showed the
 * long book supplies the down/flat signals (1,330 confirmed on down days) and the
 * inverse book supplies the up-day ones (448 vs the longs' 97) — the two are
 * complementary, so a rule can help one class and hurt the other.
 *
 * LIMITS: 60 sessions of 5-minute bars, one regime, and this harness is a
 * reconstruction of the engine rather than the engine — its baseline reports +4% where
 * the live book is down. Fit for RANKING variants, not for predicting live P&L.
 *
 * SUPERSEDED — READ THIS BEFORE THE NUMBERS BELOW (2026-08-27).
 * This lab concluded that persistence + falling_knife are destructive together
 * (ret/DD 0.95, worse than either alone) and that T2 should replace them. A replay
 * through the REAL runAutoTrade (experiments/replay_auto_trader.js, same 60 sessions
 * and symbols) reversed every part of that:
 *
 *              this lab (reconstruction)      replay (real engine)
 *   LIVE            +3.38%   ret/DD 0.95           -0.25%   best of the four
 *   PERSIST         +7.62%   ret/DD 2.69           -0.73%
 *   KNIFE           +7.83%   ret/DD 2.19           -0.21%
 *   NONE           +11.43%   ret/DD 4.13           -1.35%   WORST of the four
 *
 * The cause: this harness models ~6 gates and the engine runs ~20. Removing a turn
 * filter here yields more clean trades; in the engine it yields more trades that the
 * remaining gates handle worse. NONE looked twice as good as anything else here and is
 * last on the real path — and that row was carrying the whole argument.
 *
 * Kept as the record of a rejected finding and of how the rejection was found. Do not
 * quote its rankings.
 *
 * Usage: node experiments/turn_consolidation_lab.js
 */
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const LONGS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL", "TNA", "SPXL", "TQQQ", "UPRO"];
const INV = ["SQQQ", "SOXS", "SPXS", "TZA"];
const SYMS = [...LONGS, ...INV];
const IS_INV = new Set(INV);
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const WEIGHTS = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };
const CACHE = path.join(process.env.TEMP || "/tmp", "rev60cache");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on("error", reject); rq.setTimeout(30000, () => { rq.destroy(); reject(new Error("timeout")); });
  });
}
async function bars(sym) {
  const cf = path.join(CACHE, sym + ".json");
  try { const st = fs.statSync(cf); if (Date.now() - st.mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(cf, "utf8")); } catch (_e) {}
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=60d`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no data " + sym);
  const ts = r.timestamp || [], q = r.indicators.quote[0], out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: ts[i] * 1000, c: q.close[i], h: q.high[i], l: q.low[i] });
  }
  fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(out));
  return out;
}
const ET = (ms) => new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" }));
const DAY = (ms) => { const d = ET(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const MIN = (ms) => { const d = ET(ms); return d.getHours() * 60 + d.getMinutes(); };

// THE ENGINE'S OWN KNIFE, NOT A MODEL OF IT (2026-08-27).
// A first pass computed MACD from SESSION-ONLY closes, reset each morning, and
// concluded falling_knife was the most expensive rule in the entry path. That was
// wrong: auto-trader feeds knifeReading from `getBarsMulti(syms, momentumTf)` where
// momentumTf defaults to 5m and TF['5m'] carries range '1mo' — about 1,600 bars of
// CONTINUOUS multi-day history. A month-long MACD and a session-local one are
// different indicators, and the session-local version is noisiest exactly at the open
// where most entries fire. The rule also arrives with its own prior validation in the
// source (565 first-IBS fires, 29 sessions, 35 symbols: vetoed -0.038%/trade vs allowed
// +0.041%), which a reconstruction has no standing to overturn.
// So: import the real predicate and feed it the real shape.
const { knifeReading } = require("../apps/lantern-garage/lib/auto-trader");

function simulate(data, cfg) {
  const CAD = 60, PHASE = 0, WIN = 3;
  const THR = 0.30, MORNING = 0.12, EXIT_IBS = 0.60;
  const STOP = 3.0, BE_ARM = 1.0, STEP = 0.5, COOLDOWN = 45, MATURITY = 30, MAXC = 5, FRAC = 0.12;
  const days = [...new Set(Object.values(data).flat().map((b) => b.d))].sort();
  let equity = 1;
  const trades = [], curve = [];

  for (const day of days) {
    const idx = {}, run = {};
    for (const s of SYMS) {
      const bs = (data[s] || []).filter((b) => b.d === day && b.m >= 570 && b.m <= 960);
      if (bs.length < 12) continue;
      idx[s] = new Map(bs.map((b) => [b.m, b]));
      run[s] = { hi: -Infinity, lo: Infinity, seq: 0, hist: [] };
    }
    const live = Object.keys(idx);
    if (!live.length) continue;
    const open = new Map(), lastExitMin = new Map();
    let cadenceSpent = null;

    for (let m = 570; m <= 960; m += 5) {
      for (const s of live) {
        const b = idx[s].get(m); if (!b) continue;
        run[s].hi = Math.max(run[s].hi, b.h); run[s].lo = Math.min(run[s].lo, b.l);
        run[s].hist.push(b); if (run[s].hist.length > 4) run[s].hist.shift();
      }
      for (const [s, pos] of [...open]) {
        const b = idx[s].get(m); if (!b) continue;
        const gain = (b.c / pos.entry - 1) * 100;
        pos.mae = Math.min(pos.mae, (b.l / pos.entry - 1) * 100);
        let exit = null, why = null;
        if (b.l <= pos.stopPx) { exit = pos.stopPx; why = "stop"; }
        else if (pos.floorPx != null && b.c <= pos.floorPx) { exit = b.c; why = "floor"; }
        else if (m - pos.entryMin >= MATURITY) {
          const r = run[s], ibs = r.hi > r.lo ? (b.c - r.lo) / (r.hi - r.lo) : 0.5;
          if (ibs >= EXIT_IBS) { exit = b.c; why = "bounce"; }
        }
        if (exit == null && m >= 960) { exit = b.c; why = "close"; }
        if (exit == null && gain >= BE_ARM) {
          const steps = Math.floor(gain / STEP), lvl = pos.entry * (1 + (steps * STEP - STEP) / 100);
          pos.floorPx = pos.floorPx == null ? lvl : Math.max(pos.floorPx, lvl);
        }
        if (exit != null) {
          const px = exit * (1 - SLIP), ret = px / pos.entry - 1;
          equity += pos.notional * ret;
          trades.push({ day, sym: s, ret, why, mae: pos.mae, inv: IS_INV.has(s) });
          open.delete(s); lastExitMin.set(s, m);
        }
      }
      const since = ((m - PHASE) % CAD + CAD) % CAD, boundary = m - since;
      const gateOpen = since < WIN && cadenceSpent !== boundary;
      const cands = [];
      for (const s of live) {
        if (open.has(s)) continue;
        const b = idx[s].get(m); if (!b) continue;
        const r = run[s]; if (!(r.hi > r.lo)) continue;
        const ibs = (b.c - r.lo) / (r.hi - r.lo);
        const thr = m < 660 ? MORNING : THR;
        // persistence counter tracks CONSECUTIVE qualifying reads, like the engine's
        // "awaiting 2 consecutive bullish scans"
        if (ibs <= thr) r.seq++; else r.seq = 0;
        if (ibs > thr) continue;
        if (!gateOpen) continue;
        const cd = lastExitMin.get(s); if (cd != null && m - cd < COOLDOWN) continue;
        if (cfg.persist && r.seq < 2) continue;                                  // "awaiting 2 consecutive bullish scans"
        if (cfg.knife) {
          // the engine's predicate, on the continuous series available AT this bar
          const series = (data[s] || []);
          const upto = series.slice(Math.max(0, b._i - 400), b._i + 1).map((x) => x.c).filter((x) => x > 0);
          const kr = knifeReading(upto);
          if (kr && kr.fires) continue;
        }
        if (cfg.t2) {                                                             // T2 reversal confirmation
          const H = r.hist; if (H.length < 3) continue;
          const [p2, p1, cur] = H.slice(-3);
          if (!(cur.c > p1.c && p1.c >= p2.c)) continue;
        }
        cands.push({ s, ibs, w: WEIGHTS[s] || 1, b });
      }
      cands.sort((a, z) => (z.w - a.w) || (a.ibs - z.ibs));
      for (const c of cands) {
        if (open.size >= MAXC) break;
        const px = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.s, { entry: px, entryMin: m, mae: 0, notional: equity * FRAC, stopPx: px * (1 - STOP / 100), floorPx: null });
        cadenceSpent = boundary;
      }
      curve.push(equity);
    }
  }
  return { trades, equity, curve };
}

(async () => {
  const data = {};
  for (const s of SYMS) { const a = await bars(s); a.forEach((b, i) => { b.d = DAY(b.t); b.m = MIN(b.t); b._i = i; }); data[s] = a; }
  const spyDay = new Map();
  for (const b of data.SPY) if (b.m >= 570 && b.m <= 960) { const e = spyDay.get(b.d) || { o: b.c }; e.c = b.c; spyDay.set(b.d, e); }
  const regime = (d) => { const e = spyDay.get(d); if (!e) return null; const r = (e.c / e.o - 1) * 100; return r <= -0.3 ? "down" : r >= 0.3 ? "up" : "flat"; };
  const days = [...new Set(Object.values(data).flat().map((b) => b.d))].sort();

  const VARIANTS = [
    ["NONE     no turn rule", { }],
    ["LIVE     persist + knife", { persist: true, knife: true }],
    ["STACKED  persist+knife+T2", { persist: true, knife: true, t2: true }],
    ["T2 ONLY  replaces both", { t2: true }],
    ["PERSIST  alone", { persist: true }],
    ["KNIFE    alone", { knife: true }],
  ];
  const pct = (v, w = 9) => ((v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%").padStart(w);
  console.log(`TURN-DETECTOR CONSOLIDATION — ${days.length} sessions, ${SYMS.length} symbols (${LONGS.length} long / ${INV.length} inverse)\n`);
  console.log(`  ${"variant".padEnd(26)}${"return".padStart(9)}${"maxDD".padStart(9)}${"ret/DD".padStart(8)}${"trades".padStart(8)}${"WR".padStart(6)}${"avg loss".padStart(10)}${"win MAE".padStart(10)}`);
  const runs = [];
  for (const [name, cfg] of VARIANTS) {
    const r = simulate(data, cfg), tr = r.trades;
    if (!tr.length) { console.log(`  ${name.padEnd(26)}   no trades`); continue; }
    let peak = 1, dd = 0;
    for (const e of r.curve) { peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); }
    const w = tr.filter((t) => t.ret > 0), l = tr.filter((t) => t.ret < 0);
    const avg = (a) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length : 0);
    const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    runs.push({ name, cfg, r, tr, ret: r.equity - 1, dd });
    console.log(`  ${name.padEnd(26)}${pct(r.equity - 1)}${pct(dd)}${(dd < 0 ? ((r.equity - 1) / -dd).toFixed(2) : "-").padStart(8)}`
      + `${String(tr.length).padStart(8)}${((w.length / tr.length * 100).toFixed(0) + "%").padStart(6)}${pct(avg(l), 10)}${(med(w.map((t) => t.mae)).toFixed(2) + "%").padStart(10)}`);
  }

  console.log("\nBY SCENARIO — mean %/trade (n)");
  console.log(`  ${"variant".padEnd(26)}${"SPY down".padStart(16)}${"SPY flat".padStart(16)}${"SPY up".padStart(16)}`);
  for (const x of runs) {
    const cells = ["down", "flat", "up"].map((g) => {
      const a = x.tr.filter((t) => regime(t.day) === g);
      if (!a.length) return "      -       ".padStart(16);
      const m = a.reduce((s, t) => s + t.ret, 0) / a.length * 100;
      return `${(m >= 0 ? "+" : "") + m.toFixed(3)}% (${a.length})`.padStart(16);
    });
    console.log(`  ${x.name.padEnd(26)}${cells.join("")}`);
  }

  console.log("\nBY INSTRUMENT CLASS — mean %/trade (n)");
  console.log(`  ${"variant".padEnd(26)}${"LONGS".padStart(18)}${"INVERSES".padStart(18)}`);
  for (const x of runs) {
    const cell = (inv) => {
      const a = x.tr.filter((t) => t.inv === inv);
      if (!a.length) return "       -        ".padStart(18);
      const m = a.reduce((s, t) => s + t.ret, 0) / a.length * 100;
      return `${(m >= 0 ? "+" : "") + m.toFixed(3)}% (${a.length})`.padStart(18);
    };
    console.log(`  ${x.name.padEnd(26)}${cell(false)}${cell(true)}`);
  }
})().catch((e) => { console.error("turn_consolidation_lab failed:", e.message); process.exit(1); });
