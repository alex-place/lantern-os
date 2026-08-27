/**
 * reversal_60d_lab.js — the operator's reversal-confirmation rules on a sample big
 * enough to judge them (2026-08-27).
 *
 * recycle_1m_lab.js found that waiting for a turn collapses the average loss
 * (-1.62% -> -0.15%) and lifts payoff from 0.28 to 3.15, which is week 1's profile.
 * But it did so on SEVEN sessions and NINE trades — the payoff was computed on two or
 * three losers and is not distinguishable from luck.
 *
 * This re-runs the same rules over 60 days of 5-minute bars: ~8x the sessions and
 * enough trades to say whether the effect survives.
 *
 * FIDELITY NOTE: confirmation is evaluated on 5-minute bars here, not 1-minute, so
 * "one up tick" is a 5-minute bar closing higher rather than a 1-minute one. That is a
 * SLOWER, coarser confirmation than the live engine's 60s scan would apply, so these
 * numbers describe the direction of the effect rather than the exact live setting.
 *
 * Usage: node experiments/reversal_60d_lab.js
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL", "TNA", "SPXL", "TQQQ", "UPRO"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const WEIGHTS = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on("error", reject); rq.setTimeout(30000, () => { rq.destroy(); reject(new Error("timeout")); });
  });
}
const CACHE = require("path").join(require("os").tmpdir(), "rev60cache");
async function bars1m(sym) {   // 5-minute bars over 60 days
  const fsc = require("fs");
  try { fsc.mkdirSync(CACHE, { recursive: true }); } catch (_e) {}
  const cf = require("path").join(CACHE, sym + ".json");
  try { const st = fsc.statSync(cf); if (Date.now() - st.mtimeMs < 6 * 3600e3) return annotateBars(JSON.parse(fsc.readFileSync(cf, "utf8"))); } catch (_e) {}
  const out = annotateBars(await _fetchBars(sym));
  try { fsc.writeFileSync(cf, JSON.stringify(out)); } catch (_e) {}
  return out;
}
async function _fetchBars(sym) {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=60d`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no data " + sym);
  const ts = r.timestamp || [], q = r.indicators.quote[0], out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: ts[i] * 1000, c: q.close[i], h: q.high[i], l: q.low[i] });
  }
  return out;
}
// PRECOMPUTE the ET day/minute per bar. Calling toLocaleString inside the day/symbol
// filters cost ~11M timezone conversions per variant and dominated the whole run.
function annotateBars(list) {
  for (const b of list) { b.d = DAY(b.t); b.m = MIN(b.t); }
  return list;
}
const ET = (ms) => new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" }));
const DAY = (ms) => { const d = ET(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const MIN = (ms) => { const d = ET(ms); return d.getHours() * 60 + d.getMinutes(); };

/** One run. cfg: {reentry, lossCut} — everything else is the armed stack. */
function simulate(data, cfg) {
  const CAD = 60, PHASE = 0, WIN = 3;
  const THR = 0.30, MORNING = 0.12, EXIT_IBS = 0.60;
  const STOP = cfg.stop == null ? 3.0 : cfg.stop;   // the operator's question: -3% is out of proportion to a ~1% winner
  const BE_ARM = 1.0, STEP = 0.5, COOLDOWN = 45, MATURITY = 30, MAXC = 5, FRAC = 0.12;

  // every (day, minute) in order
  const days = [...new Set(Object.values(data).flat().map((b) => b.d))].sort();
  let equity = 1;
  const trades = [];
  const curve = [];

  for (const day of days) {
    const idx = {}, run = {};
    for (const s of SYMS) {
      const bs = (data[s] || []).filter((b) => b.d === day && b.m >= 570 && b.m <= 960);
      if (bs.length > 12) { idx[s] = new Map(bs.map((b) => [b.m, b])); run[s] = { hi: -Infinity, lo: Infinity }; }
    }
    const live = Object.keys(idx);
    if (!live.length) continue;

    const open = new Map();          // sym -> position
    const exitedToday = new Set();   // sym -> eligible for the re-entry exemption
    const lastExitMin = new Map();   // sym -> minute of last exit (cooldown)
    let cadenceSpent = null;         // boundary whose decision was used

    for (let m = 570; m <= 960; m += 5) {
      // advance session ranges
      for (const s of live) {
        const b = idx[s].get(m);
        if (b) {
          run[s].hi = Math.max(run[s].hi, b.h); run[s].lo = Math.min(run[s].lo, b.l);
          (run[s].hist = run[s].hist || []).push(b);
          if (run[s].hist.length > 30) run[s].hist.shift();
          run[s].sessLo = Math.min(run[s].sessLo == null ? b.l : run[s].sessLo, b.l);
          if (b.l <= run[s].sessLo) run[s].loMin = m;         // when the session low was last set
        }
      }

      // ---- exits first
      for (const [s, pos] of [...open]) {
        const b = idx[s].get(m); if (!b) continue;
        const gain = (b.c / pos.entry - 1) * 100;
        pos.mae = Math.min(pos.mae, (b.l / pos.entry - 1) * 100);   // worst excursion while held
        pos.peak = Math.max(pos.peak, b.c);
        let exit = null, why = null;
        if (b.l <= pos.stopPx) { exit = pos.stopPx; why = "stop"; }
        else if (pos.floorPx != null && b.c <= pos.floorPx) { exit = b.c; why = "floor"; }
        else if (cfg.lossCut > 0 && gain <= -cfg.lossCut) { exit = b.c; why = "loss_cut"; }
        else if (m - pos.entryMin >= MATURITY) {
          const r = run[s]; const ibs = r.hi > r.lo ? (b.c - r.lo) / (r.hi - r.lo) : 0.5;
          if (ibs >= EXIT_IBS) { exit = b.c; why = "bounce"; }
        }
        if (exit == null && m === 960) { exit = b.c; why = "close"; }
        // ratchet the floor upward as the gain steps
        if (exit == null && gain >= BE_ARM) {
          const steps = Math.floor(gain / STEP);
          const lvl = pos.entry * (1 + (steps * STEP - STEP) / 100);
          pos.floorPx = pos.floorPx == null ? lvl : Math.max(pos.floorPx, lvl);
        }
        if (exit != null) {
          const px = exit * (1 - SLIP);
          const ret = px / pos.entry - 1;
          equity += pos.notional * ret;
          trades.push({ day, sym: s, ret, why, mins: m - pos.entryMin, reentry: !!pos.reentry, mae: pos.mae });
          open.delete(s); exitedToday.add(s); lastExitMin.set(s, m);
        }
      }

      // ---- entries
      const since = ((m - PHASE) % CAD + CAD) % CAD;
      const boundary = m - since;
      const inWindow = since < WIN;
      const barSpent = cadenceSpent === boundary;

      const cands = [];
      for (const s of live) {
        if (open.has(s)) continue;
        const b = idx[s].get(m); if (!b) continue;
        const r = run[s]; if (!(r.hi > r.lo)) continue;
        const ibs = (b.c - r.lo) / (r.hi - r.lo);
        const thr = (m < 660 ? MORNING : THR) * (cfg.ibsScale == null ? 1 : cfg.ibsScale);
        if (ibs > thr) continue;
        // ---- REVERSAL CONFIRMATION (operator, 2026-08-27): "it needs an actual sign of
        // the reversal — hitting a low and starting to go up QUICKLY. Bumps happen and
        // they look different: different candle size, repeating pattern, not low enough."
        const H = r.hist || [];
        if (cfg.turn && H.length >= 3) {
          const [p2, p1, cur] = H.slice(-3);
          if (cfg.turn === "up1" && !(cur.c > p1.c)) continue;                 // one green tick
          if (cfg.turn === "up2" && !(cur.c > p1.c && p1.c >= p2.c)) continue; // two, no new low between
          if (cfg.turn === "fast") {
            // "up QUICKLY": the turn bar's body must beat the recent average bar range —
            // a bump drifts up inside the noise, a reversal moves faster than it.
            const rng = H.slice(-20).map((x) => x.h - x.l).filter((x) => x > 0);
            const avg = rng.length ? rng.reduce((a, x) => a + x, 0) / rng.length : 0;
            const body = cur.c - Math.min(cur.l, p1.c);
            if (!(cur.c > p1.c && avg > 0 && body >= avg)) continue;
          }
          if (cfg.turn === "off_low") {
            // "not low enough": only take it once price has actually LEFT the session low,
            // so a still-falling knife never qualifies.
            if (!(cur.c > p1.c && r.loMin != null && m - r.loMin >= 2)) continue;
          }
        }
        const cd = lastExitMin.get(s); if (cd != null && m - cd < COOLDOWN) continue;
        const exempt = cfg.reentry && exitedToday.has(s);
        if (!exempt && (barSpent || !inWindow)) continue;      // the cadence gate
        cands.push({ s, ibs, w: WEIGHTS[s] || 1, b, exempt });
      }
      cands.sort((a, z) => (z.w - a.w) || (a.ibs - z.ibs));    // slot order: expectancy
      for (const c of cands) {
        if (open.size >= MAXC) break;
        const px = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.s, { entry: px, entryMin: m, peak: px, mae: 0, notional: equity * FRAC,
          stopPx: px * (1 - STOP / 100), floorPx: null, reentry: c.exempt });
        if (!c.exempt) cadenceSpent = boundary;                // a recycle never spends the bar
      }
      curve.push(equity);
    }
  }
  return { trades, equity, curve };
}

const pct = (v, w = 9) => ((v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%").padStart(w);

(async () => {
  const data = {};
  for (const s of SYMS) { try { data[s] = await bars1m(s); } catch (_e) { /* skip */ } }
  const days = [...new Set(Object.values(data).flat().map((b) => b.d))].sort();
  console.log("RECYCLE + LOSS CUT at 1-MINUTE resolution — the surface where both changes exist\n");
  console.log(`  ${days.length} sessions (${days[0]} .. ${days[days.length - 1]}), ${Object.keys(data).length} symbols`);
  console.log("  SMALL SAMPLE from the current regime — a direction check, not a two-window verdict.\n");

  const VARIANTS = [
    ["baseline, stop -3% (armed)", { reentry: false, lossCut: 0 }],
    ["baseline, stop -1%", { reentry: false, lossCut: 0, stop: 1.0 }],
    ["T2 confirm, stop -3%", { reentry: false, lossCut: 0, turn: "up2" }],
    ["T2 confirm, stop -2%", { reentry: false, lossCut: 0, turn: "up2", stop: 2.0 }],
    ["T2 confirm, stop -1.5%", { reentry: false, lossCut: 0, turn: "up2", stop: 1.5 }],
    ["T2 confirm, stop -1%", { reentry: false, lossCut: 0, turn: "up2", stop: 1.0 }],
    ["T2 confirm, stop -0.75%", { reentry: false, lossCut: 0, turn: "up2", stop: 0.75 }],
    ["T2 + reentry, stop -1%", { reentry: true, lossCut: 0, turn: "up2", stop: 1.0 }],
  ];
  console.log(`  ${"variant".padEnd(24)}${"return".padStart(10)}${"maxDD".padStart(9)}${"trades".padStart(8)}${"recyc".padStart(7)}${"WR".padStart(6)}${"avg loss".padStart(10)}${"payoff".padStart(8)}${"med hold".padStart(10)}${"win MAE".padStart(11)}`);
  for (const [name, cfg] of VARIANTS) {
    if (!cfg) { console.log(`  ${name}`); continue; }
    const r = simulate(data, cfg);
    const tr = r.trades;
    if (!tr.length) { console.log(`  ${name.padEnd(24)} no trades`); continue; }
    let peak = 1, dd = 0;
    for (const e of r.curve) { peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); }
    const w = tr.filter((t) => t.ret > 0), l = tr.filter((t) => t.ret < 0);
    const avg = (a) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length : 0);
    const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    console.log(`  ${name.padEnd(24)}${pct(r.equity - 1, 10)}${pct(dd, 9)}${String(tr.length).padStart(8)}`
      + `${String(tr.filter((t) => t.reentry).length).padStart(7)}`
      + `${(tr.length ? (w.length / tr.length * 100).toFixed(0) : "-").padStart(5)}%`
      + `${pct(avg(l), 10)}`
      + `${(avg(l) !== 0 ? Math.abs(avg(w) / avg(l)).toFixed(2) : "-").padStart(8)}`
      + `${(med(tr.map((t) => t.mins)).toFixed(0) + "m").padStart(10)}`
      + `${(med(w.map((t) => t.mae)).toFixed(2) + "%").padStart(11)}`);
  }

  // ------------------------------------------------------------------------
  // CAN a loss cut work AT ALL? The strategy buys washouts, so a position going
  // underwater before it works is not a defect — it is the trade. The question is
  // whether WINNERS and LOSERS dig to different depths. If their excursions overlap,
  // no threshold separates them and every cut is a coin flip that costs slippage.
  // ------------------------------------------------------------------------
  const base = simulate(data, { reentry: false, lossCut: 0 });
  const w = base.trades.filter((t) => t.ret > 0), l = base.trades.filter((t) => t.ret < 0);
  const q = (a, p) => { if (!a.length) return null; const x = a.slice().sort((m, n) => m - n); return x[Math.min(x.length - 1, Math.floor(x.length * p))]; };
  const f = (v) => (v == null ? "   -    " : ((v >= 0 ? "+" : "") + v.toFixed(2) + "%").padStart(8));
  console.log("");
  console.log("MAE — how deep does a trade dig BEFORE it resolves?");
  console.log(`  ${"group".padEnd(10)}${"n".padStart(5)}   median      p75      p90    worst`);
  for (const [lab, a] of [["WINNERS", w], ["losers", l]]) {
    const m = a.map((t) => t.mae);
    console.log(`  ${lab.padEnd(10)}${String(a.length).padStart(5)}  ${f(q(m, 0.5))}${f(q(m, 0.25))}${f(q(m, 0.10))}${f(m.length ? Math.min(...m) : null)}`);
  }
  console.log("");
  console.log(`  A cut at X% fires on any trade that digs past it — winners included:`);
  console.log(`  ${"cut".padEnd(8)}${"winners killed".padStart(17)}${"losers saved".padStart(15)}   net`);
  for (const c of [0.5, 0.75, 1.0, 1.5, 2.0, 2.5]) {
    const wk = w.filter((t) => t.mae <= -c).length, ls = l.filter((t) => t.mae <= -c).length;
    console.log(`  ${(c.toFixed(2) + "%").padEnd(8)}${(wk + " of " + w.length).padStart(17)}${(ls + " of " + l.length).padStart(15)}   ${ls - wk >= 0 ? "+" : ""}${ls - wk}`);
  }
  const deep = w.filter((t) => t.mae <= -1).length;
  console.log("");
  console.log(`  ${w.length ? (deep / w.length * 100).toFixed(0) : "-"}% of WINNERS dipped past -1% before working.`);

  // ---- DOES IT HOLD ACROSS SCENARIOS? ------------------------------------
  // "once we get good adaptable logic that works in different market scenarios".
  // Split the same runs by what SPY actually did that session — a rule that only
  // works in one tape is a curve fit, however good its headline.
  const spy = data.SPY || [];
  const spyDay = new Map();
  for (const b of spy) { if (b.m >= 570 && b.m <= 960) { const e = spyDay.get(b.d) || { o: b.c, c: b.c }; e.c = b.c; spyDay.set(b.d, e); } }
  const regime = (d) => { const e = spyDay.get(d); if (!e) return null; const r = (e.c / e.o - 1) * 100; return r <= -0.3 ? "down" : r >= 0.3 ? "up" : "flat"; };
  console.log("");
  console.log("BY MARKET SCENARIO — mean %/trade (n)");
  console.log(`  ${"variant".padEnd(28)}${"SPY down".padStart(16)}${"SPY flat".padStart(16)}${"SPY up".padStart(16)}`);
  for (const [name, cfg] of VARIANTS) {
    if (!cfg) continue;
    const tr = simulate(data, cfg).trades;
    const cells = ["down", "flat", "up"].map((g) => {
      const a = tr.filter((t) => regime(t.day) === g);
      if (!a.length) return "     -     ".padStart(16);
      const m = a.reduce((x, t) => x + t.ret, 0) / a.length * 100;
      return `${(m >= 0 ? "+" : "") + m.toFixed(3)}% (${a.length})`.padStart(16);
    });
    console.log(`  ${name.padEnd(28)}${cells.join("")}`);
  }
})().catch((e) => { console.error("reversal_60d_lab failed:", e.message); process.exit(1); });
