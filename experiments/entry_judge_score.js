/**
 * entry_judge_score.js — grade the entry judge's forward journal (#3390).
 *
 * Joins data/.../entry-judge.jsonl against the trade ledger and the 5m bar
 * corpus. Three questions, per provider:
 *
 *   1. SEPARATION — do approved entries out-earn rejected ones? (Both were
 *      actually taken; the judge is shadow.) The per-signal analyst failed
 *      exactly this at rho 0.007 — that is the bar.
 *   2. REDIRECT VALUE — for each redirect_inverse verdict, price the
 *      counterfactual from the INVERSE WRAPPER'S OWN BARS over the identical
 *      window (entry time → the long's actual exit time, or session close if
 *      it carried), equal notional. Sum vs what the long actually made.
 *   3. CALIBRATION — rho(signed conviction, realized long P&L%), where sign is
 *      +1 approve, 0 reject, −1 redirect.
 *
 * Decidability is stated honestly: n<20 judged entries prints a warning, and
 * nothing here wires anything — a passing judge earns a live-veto PROPOSAL,
 * which then faces its own gate.
 *
 *   node experiments/entry_judge_score.js
 *   LANTERN_ROOT=C:/dev/lantern-os-stable node experiments/entry_judge_score.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.env.LANTERN_ROOT || path.join(__dirname, "..");
const JUDGE_LOG = process.env.TRADER_JUDGE_LOG
  || path.join(ROOT, "data", "lantern-garage", "trading", "entry-judge.jsonl");
const LEDGER = process.env.TRADER_TRADES_LOG
  || path.join(ROOT, "data", "lantern-garage", "trading", "autopilot-trades.jsonl");
const BARS = path.join(ROOT, "data", "lantern-garage", "trading", "bars");

const eD = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function loadJsonl(p) {
  try {
    return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  } catch (_e) { return []; }
}

const _bars = {};
function bars5(sym) {
  if (_bars[sym]) return _bars[sym];
  try {
    _bars[sym] = loadJsonl(path.join(BARS, sym + "-5m.jsonl"))
      .map((b) => ({ t: Date.parse(b.t || b.ts), c: +b.c }))
      .filter((b) => Number.isFinite(b.t) && b.c > 0).sort((a, b) => a.t - b.t);
  } catch (_e) { _bars[sym] = []; }
  return _bars[sym];
}
function priceAt(sym, ms) {
  const bs = bars5(sym);
  let last = null;
  for (const b of bs) { if (b.t > ms) break; last = b; }
  return last ? last.c : null;
}

(async () => {
  const judged = loadJsonl(JUDGE_LOG).filter((r) => !r.degraded && r.verdict && r.symbol);
  const ledger = loadJsonl(LEDGER);
  console.log(`judge journal: ${judged.length} non-degraded verdicts at ${JUDGE_LOG}`);
  if (!judged.length) { console.log("nothing to score yet — enable TRADER_ENTRY_JUDGE=1 and let entries accumulate."); return; }

  // Pair each judged entry to its ledger entry + eventual exit (same symbol,
  // entry within 3 minutes of the verdict, first exit after it).
  const entries = ledger.filter((r) => r.event === "entry");
  const exits = ledger.filter((r) => r.event === "exit" && Number.isFinite(Number(r.pnl)));
  const scored = [];
  for (const j of judged) {
    const jt = Date.parse(j.ts);
    const en = entries.find((e) => e.symbol === j.symbol && Math.abs(Date.parse(e.ts) - jt) < 180e3);
    if (!en) continue;
    const ex = exits.find((x) => x.symbol === j.symbol && Date.parse(x.ts) > Date.parse(en.ts));
    const exitTs = ex ? Date.parse(ex.ts) : null;
    const longPct = ex && en.entry > 0 ? ((ex.exit - en.entry) / en.entry) * 100 : null;
    // redirect counterfactual: the inverse wrapper over the same window
    let invPct = null;
    if (j.inverse && exitTs) {
      const p0 = priceAt(j.inverse, jt);
      const p1 = priceAt(j.inverse, exitTs);
      if (p0 && p1) invPct = ((p1 - p0) / p0) * 100;
    }
    scored.push({ ...j, longPct, invPct, resolved: longPct != null });
  }
  const resolved = scored.filter((s) => s.resolved);
  console.log(`paired to ledger: ${scored.length} | with resolved outcomes: ${resolved.length}`);
  if (resolved.length < 20) {
    console.log(`\n⚠ n=${resolved.length} < 20 — NOT decidable yet. Numbers below are progress, not verdicts.`);
  }

  const mean = (a, f) => (a.length ? a.reduce((t, x) => t + f(x), 0) / a.length : null);
  const fpc = (v) => (v == null ? "      —" : ((v >= 0 ? "+" : "") + v.toFixed(2) + "%").padStart(8));
  for (const provider of ["claude", "local"]) {
    const mine = resolved.filter((r) => r.provider === provider);
    if (!mine.length) { console.log(`\n${provider}: no resolved verdicts yet`); continue; }
    const ap = mine.filter((r) => r.verdict === "approve");
    const rj = mine.filter((r) => r.verdict === "reject");
    const rd = mine.filter((r) => r.verdict === "redirect_inverse");
    console.log(`\n═══ ${provider} ═══`);
    console.log(`  approve  n=${ap.length}  avg long outcome ${fpc(mean(ap, (x) => x.longPct))}`);
    console.log(`  reject   n=${rj.length}  avg long outcome ${fpc(mean(rj, (x) => x.longPct))}   (separation needs approve > reject)`);
    const rdc = rd.filter((x) => x.invPct != null);
    console.log(`  redirect n=${rd.length}  long made ${fpc(mean(rd, (x) => x.longPct))}  the inverse would have made ${fpc(mean(rdc, (x) => x.invPct))}  (n_cf=${rdc.length})`);
    // calibration
    const sc = mine.filter((x) => x.conviction != null).map((x) => ({
      v: (x.verdict === "approve" ? 1 : x.verdict === "reject" ? 0 : -1) * x.conviction, r: x.longPct }));
    if (sc.length >= 5) {
      const rank = (a, f) => { const s = [...a].sort((p, q) => f(p) - f(q)); const m = new Map(); s.forEach((v, i) => m.set(v, i + 1)); return m; };
      const r1 = rank(sc, (x) => x.v), r2 = rank(sc, (x) => x.r);
      let d2 = 0; for (const x of sc) d2 += Math.pow(r1.get(x) - r2.get(x), 2);
      const rho = 1 - (6 * d2) / (sc.length * (sc.length * sc.length - 1));
      console.log(`  rho(signed conviction, long outcome) = ${rho.toFixed(3)}  (the analyst died at 0.007)`);
    }
  }
  console.log("\nDECISION BAR: live veto is proposed only if approve>reject separation AND redirect");
  console.log("counterfactuals beat the longs they replace, at n≥20 resolved — then it faces its own gate.");
})();
