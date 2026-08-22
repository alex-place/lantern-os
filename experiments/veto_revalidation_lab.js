/**
 * veto_revalidation_lab.js — do the entry vetoes still earn their place under
 * the Monday exits? (operator 2026-08-22: "look for deeper flaws")
 *
 * Two live gates throttle IBS entries:
 *   falling_knife — MACD histogram negative AND deepening at the fire. Its
 *       justification (auto-trader ~L1836) replayed 565 fires with a SAME-DAY
 *       CLOSE exit: vetoed -0.038%/trade, allowed +0.041%. That exit is the
 *       early-exit regime #3419 showed has no edge — a washout that accelerates
 *       into the close often bounces the NEXT session, which that replay could
 *       not see. The gate blocked 176 scan-skips in two weeks.
 *   sup_entry — "only enter AT a support zone" (SPY QQQ GLD SMH TLT + inverses),
 *       validated for the zone-entry strategy (#3165), never under IBS mode.
 *       81 scan-skips in two weeks.
 *
 * PART A — LIVE COUNTERFACTUAL. Every distinct vetoed fire (symbol × session ×
 *   reason) since 8/10 in the stable ledger, entered at the close of the 15m
 *   bar containing the first skip, exited by the Monday rules on 15m bars
 *   (3% stop, +1% floor, IBS ≥ 0.6 bounce, 5-session timeout, costs charged).
 *   Compared with: the ledger's REAL entries in the same window (their booked
 *   pnl_pct), and the analog's own touch entries on the same 15m data.
 *
 * PART B — THE KNIFE RULE ON THE ANALOG. MACD(12,26,9) on hourly closes (and
 *   daily closes for the 26y surfaces); veto an entry when hist < 0 and
 *   hist < prev hist. With vs without, four surfaces, Monday exits. Also the
 *   INVERSE rule (enter ONLY on knives) to see which side the edge sits on.
 *
 * Usage: node experiments/veto_revalidation_lab.js [--ledger path] [--since 2026-08-10]
 */
"use strict";

const https = require("https");
const fs = require("fs");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, knife: "off" };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on("error", reject);
    rq.setTimeout(30000, () => { rq.destroy(); reject(new Error("timeout")); });
  });
}
const ET_DAY = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const ET_HM = (ms) => {
  const s = new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
};
async function chart(sym, interval, fromSec) {
  const p2 = Math.floor(Date.now() / 1000);
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&period1=${fromSec}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no chart data for " + sym);
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}
function annotate(bars, intraday, barMin) {
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = intraday ? ET_DAY(b.t) : new Date(b.t).toISOString().slice(0, 10);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; }
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = intraday ? ET_HM(b.t + barMin * 60 * 1000) : 960;
    b.isLast = intraday ? (i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d) : true;
  }
  // MACD(12,26,9) histogram on closes + "deepening" flag, per bar (the live knife predicate)
  const ema = (n) => { const k = 2 / (n + 1); let e = null; return bars.map((b) => (e = e == null ? b.c : b.c * k + e * (1 - k))); };
  const e12 = ema(12), e26 = ema(26);
  const macd = bars.map((_, i) => e12[i] - e26[i]);
  const k9 = 2 / 10; let sig = null;
  for (let i = 0; i < bars.length; i++) {
    sig = sig == null ? macd[i] : macd[i] * k9 + sig * (1 - k9);
    const hist = macd[i] - sig;
    bars[i].hist = hist;
    bars[i].knife = i >= 35 && hist < 0 && hist < bars[i - 1].hist;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);

/** Monday-rule exit walk from a given entry bar index on one symbol's bars. */
function walkExit(bars, iEntry, entryPx, o, intraday) {
  let stopPx = entryPx * (1 - o.stopPct), peak = entryPx;
  for (let j = iEntry + 1; j < bars.length; j++) {
    const b = bars[j];
    const legs = b.c >= b.o ? ["L", "H", "C"] : ["H", "L", "C"];
    for (const leg of legs) {
      if (leg === "H") { peak = Math.max(peak, b.h); if (b.h >= entryPx * (1 + o.be)) stopPx = Math.max(stopPx, entryPx * (1 + o.lock)); continue; }
      const px = leg === "L" ? b.l : b.c;
      if (px <= stopPx) return { ret: (leg === "L" ? Math.min(stopPx, b.o) : stopPx) * (1 - SLIP) / entryPx - 1, reason: stopPx >= entryPx ? "be_stop" : "stop", bars: j - iEntry };
      const g = (peak / entryPx - 1) * 100;
      if (g >= o.trail.arm) { const lvl = peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) return { ret: (leg === "L" ? Math.min(lvl, b.o) : lvl) * (1 - SLIP) / entryPx - 1, reason: "trail", bars: j - iEntry }; }
    }
    const v = intraday ? rIbs(b) : dIbs(b);
    if (v >= o.exitIbs) return { ret: b.c * (1 - SLIP) / entryPx - 1, reason: "bounce", bars: j - iEntry };
    if (b.si >= bars[iEntry].si + o.timeoutS && (intraday ? b.isLast : true)) return { ret: b.c / entryPx - 1, reason: "timeout", bars: j - iEntry };
  }
  return { ret: bars[bars.length - 1].c / entryPx - 1, reason: "open", bars: bars.length - 1 - iEntry };
}

function simulate(barsBySym, syms, cfg, intraday) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  for (const t of timeline) {
    const d = ET_DAY(t);
    for (const [sym, pos] of [...open]) {
      const b = idx[sym].get(t);
      if (!b || b.t <= pos.entryT) continue;
      const legs = b.c >= b.o ? ["L", "H", "C"] : ["H", "L", "C"];
      let exitPx = null, reason = null;
      for (const leg of legs) {
        if (leg === "H") {
          pos.peak = Math.max(pos.peak, b.h);
          if (o.be != null && b.h >= pos.entry * (1 + o.be)) { const want = pos.entry * (1 + o.lock); if (pos.stopPx < want) pos.stopPx = want; }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        if (px <= pos.stopPx) { reason = pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = fill(pos.stopPx); break; }
        if (o.trail) {
          const g = (pos.peak / pos.entry - 1) * 100;
          if (g >= o.trail.arm) { const lvl = pos.peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; } }
        }
      }
      const ibsV = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (ibsV >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason, knife: pos.knife });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (open.size < o.maxConc) {
      const cands = [];
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
        if (v > thr) continue;
        if (o.knife === "veto" && b.knife) continue;
        if (o.knife === "only" && !b.knife) continue;
        cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        const size = equity * o.sizeFrac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx, knife: !!c.b.knife });
      }
    }
    curve.push({ t, d, equity });
  }
  return { curve, trades };
}
function score(curve, from, to) {
  const seg = curve.filter((p) => p.d >= from && p.d < to);
  if (seg.length < 10) return null;
  const tot = seg[seg.length - 1].equity / seg[0].equity - 1;
  let peak = -Infinity, dd = 0;
  const byMonth = new Map();
  for (const p of seg) { peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1); const m = p.d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, {}); byMonth.get(m).last = p.equity; }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) { const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last; const r = byMonth.get(ms[i]).last / start - 1; if (r < worst) worst = r; if (r < 0) neg++; }
  return { tot, dd, worst, neg, months: ms.length };
}
const pct = (x, w = 6) => (x * 100).toFixed(1).padStart(w) + "%";
const ratio = (s) => (s && s.dd < 0 ? (s.tot / -s.dd).toFixed(2).padStart(5) : "  n/a");
const verdict = (base, v) => { if (!base || !v) return "n/a"; const lb = (v.worst >= base.worst) + (v.dd >= base.dd) + (v.neg <= base.neg); const keeps = base.tot >= 0 ? v.tot >= base.tot * 0.9 : v.tot >= base.tot; return `${lb}/3 loss better, total ${keeps ? "kept" : "SACRIFICED"}${lb >= 2 && keeps ? "  << PASS" : ""}`; };
const stat = (tr) => { if (!tr.length) return "n=0"; const w = tr.filter((x) => x.ret > 0).length; return `n=${String(tr.length).padStart(4)} WR ${(w / tr.length * 100).toFixed(0).padStart(3)}% avg ${(tr.reduce((a, x) => a + x.ret, 0) / tr.length * 100).toFixed(2).padStart(6)}%`; };

(async () => {
  const args = process.argv.slice(2);
  const ledger = args.includes("--ledger") ? args[args.indexOf("--ledger") + 1] : "C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl";
  const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : "2026-08-10";
  const nowSec = Math.floor(Date.now() / 1000);
  const m15 = {}, hourly = {}, daily = {};
  for (const s of SYMS) {
    m15[s] = annotate(await chart(s, "15m", nowSec - 59 * 86400), true, 15);
    hourly[s] = annotate(await chart(s, "1h", nowSec - 720 * 86400), true, 60);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false, 0);
  }

  // ── PART A: the live vetoed fires, replayed under the Monday exits ────────
  console.log("PART A — LIVE VETOED FIRES since " + since + ", replayed on 15m bars with the Monday exits");
  const ET = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const fires = new Map();                       // key sym|date|reason -> first ts
  const realOutcomes = [];
  const pendingEntry = {};
  if (fs.existsSync(ledger)) {
    for (const line of fs.readFileSync(ledger, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (e) { continue; }
      if (!r.ts || ET(r.ts) < since || !SYMS.includes(r.symbol)) continue;
      if (r.event === "skip") {
        const why = String(r.reason || r.why || "");
        const reason = /falling_knife/.test(why) ? "falling_knife" : /sup_entry/.test(why) ? "sup_entry" : null;
        if (!reason) continue;
        const key = `${r.symbol}|${ET(r.ts)}|${reason}`;
        if (!fires.has(key)) fires.set(key, { sym: r.symbol, ts: Date.parse(r.ts), reason });
      } else if (r.event === "entry") pendingEntry[r.symbol] = r;
      else if (r.event === "exit" && typeof r.pnl_pct === "number" && pendingEntry[r.symbol]) { realOutcomes.push({ ret: r.pnl_pct / 100 }); delete pendingEntry[r.symbol]; }
    }
  } else console.log("  (ledger not found)");
  const replayed = { falling_knife: [], sup_entry: [] };
  for (const f of fires.values()) {
    const bars = m15[f.sym];
    const i = bars.findIndex((b) => b.t <= f.ts && f.ts < b.t + 15 * 60 * 1000);
    if (i < 1) continue;
    const entryPx = bars[i].c * (1 + ENTRY_SLIP);
    replayed[f.reason].push({ ...walkExit(bars, i, entryPx, MONDAY, true), sym: f.sym, d: bars[i].d });
  }
  for (const reason of ["falling_knife", "sup_entry"]) {
    const tr = replayed[reason];
    const mix = tr.reduce((a, x) => ((a[x.reason] = (a[x.reason] || 0) + 1), a), {});
    console.log(`  ${reason.padEnd(14)} vetoed fires: ${stat(tr)}   exits ${JSON.stringify(mix)}`);
  }
  console.log(`  real entries (ledger):   ${stat(realOutcomes)}   (booked under the OLD exits — the early signal-exit)`);
  const anal = simulate(m15, SYMS, MONDAY, true).trades.filter((x) => x.d >= since);
  console.log(`  analog touch entries:    ${stat(anal)}   (same 15m data, Monday exits, no vetoes)\n`);

  // ── PART B: the knife rule on the analog ──────────────────────────────────
  console.log("PART B — THE KNIFE RULE ON THE ANALOG (MACD hist < 0 and deepening at the fire)");
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const run = (cfg) => { const h = simulate(hourly, SYMS, cfg, true), d = simulate(daily, SYMS, cfg, false); return { h, d, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)] }; };
  const base = run(MONDAY);
  const kn = base.h.trades.filter((x) => x.knife), nk = base.h.trades.filter((x) => !x.knife);
  console.log(`  baseline (no veto) hourly 2y: knife-at-fire entries ${stat(kn)}   non-knife entries ${stat(nk)}`);
  const knD = base.d.trades.filter((x) => x.knife && x.d >= "2015-01-01"), nkD = base.d.trades.filter((x) => !x.knife && x.d >= "2015-01-01");
  console.log(`  baseline (no veto) daily holdout: knife-at-fire entries ${stat(knD)}   non-knife entries ${stat(nkD)}`);
  for (const [name, cfg] of [["knife VETO (the live rule)", { ...MONDAY, knife: "veto" }], ["knife ONLY (inverse rule)", { ...MONDAY, knife: "only" }]]) {
    const r = run(cfg);
    console.log(`  ${name}`);
    for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}  worstMo ${pct(r.s[i].worst)}   ${verdict(base.s[i], r.s[i])}`);
  }
  console.log("  reference — Monday config, no veto:");
  for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(base.s[i].tot, 7)}  DD ${pct(base.s[i].dd)}  tot÷DD ${ratio(base.s[i])}  worstMo ${pct(base.s[i].worst)}`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
