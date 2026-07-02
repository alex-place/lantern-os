"use strict";

/**
 * Σ₀ position sizing + risk gates — the Act stage of the Convergence Core for a
 * weather Task. NOT a new subsystem: it turns the weather-edge model's band-robust
 * fair value (kalshi-weather-edge) into a *sized* order proposal, guarded by explicit
 * pre-trade gates. Pure + deterministic + no network.
 *
 * Design cross-checked against the open-source field review (2026-07): the one thing
 * the credible bots share is ASK-BASED fractional Kelly behind a small gate stack
 * (OctagonAI's 5-gate engine, Viprasol's risk manager, ryanfrigo's quarter-Kelly). The
 * one thing they all get wrong is computing edge/size against a mid or model price
 * instead of the price you actually pay. We size against the real ask, net of fees.
 *
 * KELLY (binary contract, payout $1): buy the favoured side at ask price p (dollars),
 * model win probability q. The growth-optimal fraction of bankroll is
 *     f* = (q − p) / (1 − p)          [YES-style; symmetric for the NO side]
 * We use HALF-Kelly (0.5·f*) — the standard variance/false-model haircut — and cap it.
 * Because q here is the fee-adjusted win prob and p is the executable ask, f* already
 * reflects the true edge; a positive f* is exactly "+EV after the price you pay".
 */

const { feeFraction } = require("./kalshi-fees");

// ── tunables (env-overridable; conservative by default) ───────────────────────
const KELLY_FRACTION = num(process.env.KALSHI_KELLY_FRACTION, 0.5);   // half-Kelly
const BANKROLL_CENTS = num(process.env.KALSHI_BANKROLL_CENTS, 10000); // $100 paper default
const MAX_BANKROLL_FRAC = num(process.env.KALSHI_MAX_BANKROLL_FRAC, 0.10); // ≤10% per position
const MAX_CONTRACTS = num(process.env.KALSHI_MAX_CONTRACTS, 25);      // hard cap / position
const LIQUIDITY_TAKE_FRAC = 0.25;   // never size past 25% of resting size on our side
const MIN_PRICE_C = 5, MAX_PRICE_C = 95;   // degenerate-price band guard
const MAX_SPREAD_C = 3;             // wider than this = can't enter cleanly
const MIN_VOLUME = 500;            // 24h contracts; thin books get no size
const MAX_CONCENTRATION = 3;        // ≤3 open positions in the same settlement group
const MAX_DRAWDOWN_FRAC = 0.20;     // halt new entries past 20% session drawdown

function num(v, d) { const f = parseFloat(v); return Number.isFinite(f) ? f : d; }

/**
 * kellyFraction — ask-based fractional Kelly for a binary contract.
 * @param {number} winProb  model P(favoured side wins), 0..1
 * @param {number} askCents entry ask you actually pay, 1..99
 * @returns {{ raw:number, fractional:number, feeAdjWinProb:number }}
 */
function kellyFraction(winProb, askCents) {
  const p = Math.min(0.99, Math.max(0.01, askCents / 100));
  const q = Math.min(1, Math.max(0, winProb));
  // fold the entry fee into the win prob: a win must also cover the fee it cost.
  const qNet = Math.max(0, q - feeFraction(askCents));
  const raw = (qNet - p) / (1 - p);            // growth-optimal fraction (can be ≤0)
  const fractional = Math.max(0, raw) * KELLY_FRACTION;
  return { raw, fractional, feeAdjWinProb: qNet };
}

/**
 * evaluateGates — the 5 pre-trade gates. Every gate must pass for `ok:true`.
 * Order matters only for the human-readable `blockedBy`; all are evaluated.
 *
 * @param {object} a
 *   winProb      model P(win) for the favoured side (0..1)
 *   askCents     executable ask (1..99)
 *   worstCaseNetC band-robust worst-case net edge in cents (from robustEdgeReport)
 *   spreadCents  favoured-side bid/ask spread
 *   volume       24h traded contracts (liquidity proxy)
 *   openInGroup  # positions already open in this settlement group
 *   drawdownFrac current session drawdown as a positive fraction (0..1)
 */
function evaluateGates(a) {
  const {
    winProb, askCents, worstCaseNetC = null,
    spreadCents = null, volume = null, openInGroup = 0, drawdownFrac = 0,
  } = a;
  const k = kellyFraction(winProb, askCents);
  const gates = [];
  const gate = (name, pass, detail) => { gates.push({ name, pass, detail }); return pass; };

  // 1. EDGE — positive fractional Kelly AND (if provided) a positive band-robust edge.
  const edgeOk = gate("edge",
    k.fractional > 0 && (worstCaseNetC == null || worstCaseNetC > 0),
    `f*=${k.raw.toFixed(3)} half=${k.fractional.toFixed(3)}` +
      (worstCaseNetC == null ? "" : ` worstNet=${worstCaseNetC}¢`));

  // 2. PRICE BAND — no degenerate 0–5¢ / 95–100¢ contracts (fee + settlement noise).
  const priceOk = gate("price_band",
    askCents >= MIN_PRICE_C && askCents <= MAX_PRICE_C,
    `${askCents}¢ in [${MIN_PRICE_C},${MAX_PRICE_C}]`);

  // 3. LIQUIDITY — tight spread + real volume, else you can't enter/exit without slippage.
  const liqOk = gate("liquidity",
    (spreadCents == null || spreadCents <= MAX_SPREAD_C) &&
    (volume == null || volume >= MIN_VOLUME),
    `spread=${spreadCents ?? "?"}¢≤${MAX_SPREAD_C} vol=${volume ?? "?"}≥${MIN_VOLUME}`);

  // 4. CONCENTRATION — cap correlated exposure in one settlement group (same NWS day).
  const concOk = gate("concentration",
    openInGroup < MAX_CONCENTRATION,
    `${openInGroup}/${MAX_CONCENTRATION} open in group`);

  // 5. DRAWDOWN — circuit breaker: stand down after a bad session.
  const ddOk = gate("drawdown",
    drawdownFrac < MAX_DRAWDOWN_FRAC,
    `${(drawdownFrac * 100).toFixed(1)}% < ${(MAX_DRAWDOWN_FRAC * 100)}%`);

  const ok = edgeOk && priceOk && liqOk && concOk && ddOk;
  const blockedBy = gates.filter((g) => !g.pass).map((g) => g.name);
  return { ok, gates, blockedBy, kelly: k };
}

/**
 * sizePosition — contracts to buy after gates + Kelly + caps + liquidity haircut.
 * Returns 0 contracts (with reason) when any gate fails.
 */
function sizePosition(a) {
  const g = evaluateGates(a);
  const askCents = a.askCents;
  if (!g.ok) {
    return { contracts: 0, stakeCents: 0, gatesOk: false, blockedBy: g.blockedBy, ...sizingMeta(g, a, 0) };
  }
  const bankroll = num(a.bankrollCents, BANKROLL_CENTS);
  const stakeByKelly = g.kelly.fractional * bankroll;              // cents Kelly wants to risk
  const stakeCap = MAX_BANKROLL_FRAC * bankroll;                   // hard bankroll cap
  const stake = Math.min(stakeByKelly, stakeCap);
  let contracts = Math.floor(stake / askCents);                   // each contract costs askCents
  // liquidity haircut: don't take more than a slice of the resting size, if known.
  if (Number.isFinite(a.restingSize) && a.restingSize > 0) {
    contracts = Math.min(contracts, Math.floor(a.restingSize * LIQUIDITY_TAKE_FRAC));
  }
  contracts = Math.max(0, Math.min(contracts, MAX_CONTRACTS));
  const stakeCents = contracts * askCents;
  return { contracts, stakeCents, gatesOk: true, blockedBy: [], ...sizingMeta(g, a, contracts) };
}

function sizingMeta(g, a, contracts) {
  return {
    kellyRaw: Math.round(g.kelly.raw * 1000) / 1000,
    kellyFraction: Math.round(g.kelly.fractional * 1000) / 1000,
    feeAdjWinProb: Math.round(g.kelly.feeAdjWinProb * 1000) / 1000,
    bankrollCents: num(a.bankrollCents, BANKROLL_CENTS),
    maxBankrollFrac: MAX_BANKROLL_FRAC,
    gates: g.gates,
    contracts,
  };
}

// ── self-test ─────────────────────────────────────────────────────────────────
function selfTest() {
  const fails = [];
  // +EV NO fade: model win 0.92 at 40¢ ask → strong positive Kelly, sized > 0.
  const k1 = kellyFraction(0.92, 40);
  if (!(k1.raw > 0.8)) fails.push(`kelly hot-fade raw=${k1.raw.toFixed(3)} not >0.8`);
  const s1 = sizePosition({ winProb: 0.92, askCents: 40, worstCaseNetC: 20, spreadCents: 2, volume: 2000, bankrollCents: 10000 });
  if (!(s1.gatesOk && s1.contracts > 0)) fails.push(`hot-fade not sized: ${JSON.stringify({ ok: s1.gatesOk, c: s1.contracts })}`);
  // bankroll cap must bind: 10% of $100 / 40¢ = 25 contracts max by cap, then MAX_CONTRACTS.
  if (s1.stakeCents > 0.10 * 10000 + 1e-9) fails.push(`bankroll cap breached: stake=${s1.stakeCents}¢`);

  // No edge: model win 0.50 at 55¢ → negative Kelly → gate blocks, 0 contracts.
  const s2 = sizePosition({ winProb: 0.50, askCents: 55, worstCaseNetC: -3, spreadCents: 2, volume: 2000 });
  if (s2.contracts !== 0 || !s2.blockedBy.includes("edge")) fails.push(`no-edge should block on edge: ${JSON.stringify(s2.blockedBy)}`);

  // Wide spread blocks liquidity gate even with edge.
  const s3 = sizePosition({ winProb: 0.90, askCents: 40, worstCaseNetC: 18, spreadCents: 7, volume: 2000 });
  if (!s3.blockedBy.includes("liquidity")) fails.push(`wide spread should block liquidity: ${JSON.stringify(s3.blockedBy)}`);

  // Thin volume blocks liquidity gate.
  const s4 = sizePosition({ winProb: 0.90, askCents: 40, worstCaseNetC: 18, spreadCents: 2, volume: 50 });
  if (!s4.blockedBy.includes("liquidity")) fails.push(`thin volume should block liquidity: ${JSON.stringify(s4.blockedBy)}`);

  // Concentration + drawdown breakers.
  const s5 = sizePosition({ winProb: 0.90, askCents: 40, worstCaseNetC: 18, spreadCents: 2, volume: 2000, openInGroup: 3 });
  if (!s5.blockedBy.includes("concentration")) fails.push(`concentration breaker failed: ${JSON.stringify(s5.blockedBy)}`);
  const s6 = sizePosition({ winProb: 0.90, askCents: 40, worstCaseNetC: 18, spreadCents: 2, volume: 2000, drawdownFrac: 0.25 });
  if (!s6.blockedBy.includes("drawdown")) fails.push(`drawdown breaker failed: ${JSON.stringify(s6.blockedBy)}`);

  // Degenerate price band (2¢) blocks.
  const s7 = sizePosition({ winProb: 0.99, askCents: 2, worstCaseNetC: 5, spreadCents: 1, volume: 2000 });
  if (!s7.blockedBy.includes("price_band")) fails.push(`price band should block 2¢: ${JSON.stringify(s7.blockedBy)}`);

  // Liquidity haircut caps contracts to 25% of resting size.
  const s8 = sizePosition({ winProb: 0.92, askCents: 40, worstCaseNetC: 20, spreadCents: 2, volume: 2000, restingSize: 8, bankrollCents: 100000 });
  if (s8.contracts > 2) fails.push(`liquidity haircut not applied: contracts=${s8.contracts} (resting 8 → ≤2)`);

  return { ok: fails.length === 0, fails };
}

module.exports = {
  kellyFraction, evaluateGates, sizePosition, selfTest,
  KELLY_FRACTION, MAX_BANKROLL_FRAC, MAX_CONTRACTS,
};

if (require.main === module) {
  const r = selfTest();
  process.stdout.write(`Σ₀ kalshi-kelly self-test: ${r.ok ? "PASS" : "FAIL"}\n`);
  if (!r.ok) { for (const f of r.fails) process.stdout.write("  - " + f + "\n"); process.exit(1); }
}
