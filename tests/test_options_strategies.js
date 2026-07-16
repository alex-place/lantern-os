/**
 * Options STRATEGY engine unit tests (#2589): lib/options-strategies.js — the
 * pure, deterministic covered/cash-secured proposal engine behind
 * GET /api/trading/options/strategies and the options_strategy chat tool.
 *
 * Fully offline: chains are FIXTURES in the normalized row shape produced by
 * lib/options-data.js — no network, no Alpha Vantage. Time is injected via
 * { now } so DTE math is deterministic.
 *
 * Covers: covered-call delta path AND no-greeks moneyness fallback,
 * no-qualifying-strike honesty, shares<100 refusal, no-bids refusal, CSP
 * collateral math (incl. can't-secure-one-contract refusal), collar
 * matched-expiry + net cost/credit, spread-cost arithmetic, and the
 * put-call-parity price inference.
 *
 * Run: node tests/test_options_strategies.js
 */

const assert = require("assert");
const path = require("path");

const os = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "options-strategies"));

const NOW = "2026-07-16"; // injected clock: fixture DTEs are exact
const PX = 100;           // fixture underlying price

// ── fixture builders (normalized rows, exactly options-data.js's shape) ──────

function row(type, strike, expiration, bid, ask, extra = {}) {
  return {
    contract: `TST${expiration.replace(/-/g, "").slice(2)}${type === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
    underlying: "TST",
    type, strike, expiration,
    date: "2026-07-15",
    bid, ask,
    last: (bid + ask) / 2,
    mark: (bid + ask) / 2,
    volume: 10,
    open_interest: 100,
    implied_volatility: 0.25,
    ...extra,
  };
}

// Chain WITH greeks. Expirations: 8 DTE (outside 21-60), 36 DTE (inside),
// 155 DTE (outside). Deltas chosen so target 0.30 picks the 105 call and the
// exact-0.25 put is the 95 (for the collar putDelta default).
const EXP_NEAR = "2026-07-24";  //   8 DTE — outside the window
const EXP_MID = "2026-08-21";   //  36 DTE — inside
const EXP_FAR = "2026-12-18";   // 155 DTE — outside

const GREEKS_CHAIN = [
  // near expiration (must be ignored by the 21-60 window)
  row("call", 100, EXP_NEAR, 1.10, 1.30, { delta: 0.51 }),
  row("put", 100, EXP_NEAR, 1.00, 1.20, { delta: -0.49 }),
  // mid expiration — the qualifying window
  row("call", 95, EXP_MID, 6.80, 7.20, { delta: 0.65 }),
  row("call", 100, EXP_MID, 3.60, 4.00, { delta: 0.52 }),
  row("call", 105, EXP_MID, 1.90, 2.10, { delta: 0.31 }), // ← covered-call pick (|0.31−0.30| min)
  row("call", 110, EXP_MID, 0.90, 1.10, { delta: 0.18 }),
  row("call", 115, EXP_MID, 0.35, 0.55, { delta: 0.08 }),
  row("put", 105, EXP_MID, 6.00, 6.40, { delta: -0.62 }),
  row("put", 100, EXP_MID, 3.30, 3.70, { delta: -0.45 }),
  row("put", 95, EXP_MID, 1.20, 1.40, { delta: -0.25 }),  // ← collar put pick (exact 0.25)
  row("put", 90, EXP_MID, 0.60, 0.80, { delta: -0.12 }),
  // far expiration (outside the window)
  row("call", 105, EXP_FAR, 5.90, 6.30, { delta: 0.42 }),
  row("put", 95, EXP_FAR, 4.10, 4.50, { delta: -0.31 }),
];

// Same strikes, NO greeks anywhere → forces the moneyness fallback.
const NO_GREEKS_CHAIN = GREEKS_CHAIN.map((r) => {
  const { delta, gamma, theta, vega, rho, ...rest } = r;
  return rest;
});

// CSP fixture: put targeted at delta 0.30 → 95 put has delta −0.28 (closest).
const CSP_CHAIN = [
  row("put", 100, EXP_MID, 3.30, 3.70, { delta: -0.45 }),
  row("put", 95, EXP_MID, 1.40, 1.60, { delta: -0.28 }), // ← pick; mark 1.50
  row("put", 90, EXP_MID, 0.60, 0.80, { delta: -0.15 }),
];

function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);
}

async function main() {
  // 1) covered call — DELTA path happy case
  {
    const p = os.proposeCoveredCall(GREEKS_CHAIN, { shares: 250, price: PX, now: NOW });
    assert.strictEqual(p.ok, true, `delta-path covered call must propose: ${p.reason}`);
    assert.strictEqual(p.selectionPath, "delta", "greeks present → delta path, and it must say so");
    assert.strictEqual(p.strike, 105, "|0.31−0.30| is the closest delta in the 21-60 DTE window");
    assert.strictEqual(p.expiration, EXP_MID);
    assert.strictEqual(p.dte, 36, "2026-07-16 → 2026-08-21 is exactly 36 days");
    approx(p.premium, 2.0);                 // MARK = (1.90+2.10)/2
    approx(p.premiumPerContract, 200);
    assert.strictEqual(p.contractsWritable, 2, "floor(250/100) = 2 — the 3rd call would be naked");
    assert.strictEqual(p.sharesCovered, 200);
    approx(p.premiumTotal, 400);
    approx(p.premiumYieldAnnualized, (2.0 / PX) * (365 / 36), 1e-6);
    approx(p.breakeven, 98.0);              // 100 − 2.00
    assert.strictEqual(p.assignmentRiskProxy.basis, "delta");
    approx(p.assignmentRiskProxy.value, 0.31, 1e-6);
    assert.ok(/proxy/i.test(p.assignmentRiskProxy.note), "assignment risk must be LABELED a proxy");
    assert.ok(/2511\.02518/.test(p.spreadCostNote), "spread-cost note must cite arXiv:2511.02518");
    assert.ok(/not personalized investment advice/i.test(p.disclaimer), "disclaimer carries the PF tone");
    assert.ok(/never places/i.test(p.disclaimer), "disclaimer says nothing is placed");
    console.log("ok - covered call (delta path): 0.30-target picks the 0.31-delta 105C @36DTE, mark/yield/breakeven/coverage exact");
  }

  // 2) covered call — NO-GREEKS moneyness fallback (must say which path it used)
  {
    const p = os.proposeCoveredCall(NO_GREEKS_CHAIN, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(p.ok, true, `moneyness fallback must propose: ${p.reason}`);
    assert.strictEqual(p.selectionPath, "moneyness", "no greeks → moneyness path, and it must say so");
    assert.strictEqual(p.strike, 105, "105/100 − 1 = 5% OTM, dead center of the 3-7% band");
    assert.ok(/no greeks/i.test(p.selectionNote), "output must explain WHY the fallback was used");
    assert.strictEqual(p.assignmentRiskProxy.basis, "moneyness");
    approx(p.assignmentRiskProxy.value, 0.05, 1e-6);
    assert.strictEqual(p.contractsWritable, 1);
    console.log("ok - covered call (moneyness fallback): greeks absent → ~5% OTM pick, path + reason stated");
  }

  // 3) honesty: no qualifying strike / no bids / shares < 100
  {
    // only-near-and-far chain: nothing inside the 21-60 DTE window
    const outside = GREEKS_CHAIN.filter((r) => r.expiration !== EXP_MID);
    const noStrike = os.proposeCoveredCall(outside, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(noStrike.ok, false);
    assert.ok(/21-60 DTE window/.test(noStrike.reason), `DTE-window refusal names the window (got '${noStrike.reason}')`);

    // bids all zero → nothing sellable
    const noBids = GREEKS_CHAIN.map((r) => ({ ...r, bid: 0 }));
    const nb = os.proposeCoveredCall(noBids, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(nb.ok, false);
    assert.ok(/live bid/.test(nb.reason), "zero-bid chain refused with an honest reason");

    // shares < 100 → naked-call refusal, never a degraded proposal
    const naked = os.proposeCoveredCall(GREEKS_CHAIN, { shares: 99, price: PX, now: NOW });
    assert.strictEqual(naked.ok, false);
    assert.ok(/NAKED/i.test(naked.reason), "sub-100-share request names the naked-call refusal");
    assert.ok(/99/.test(naked.reason), "refusal echoes the share count");

    // no-greeks chain with no strike in the 3-7% band → honest, names the band
    const bandless = NO_GREEKS_CHAIN.filter((r) => r.type !== "call" || r.strike < 103 || r.strike > 107);
    const noBand = os.proposeCoveredCall(bandless, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(noBand.ok, false);
    assert.ok(/3-7%/.test(noBand.reason), "moneyness-band refusal names the band");

    // missing price → refused, never guessed
    const noPx = os.proposeCoveredCall(GREEKS_CHAIN, { shares: 100, now: NOW });
    assert.strictEqual(noPx.ok, false);
    assert.ok(/price/.test(noPx.reason));
    console.log("ok - covered-call honesty: DTE window, zero bids, shares<100 (naked), empty band, missing price all refused with reasons");
  }

  // 4) cash-secured put — collateral math
  {
    const p = os.proposeCashSecuredPut(CSP_CHAIN, { cash: 25000, price: PX, now: NOW });
    assert.strictEqual(p.ok, true, `CSP must propose: ${p.reason}`);
    assert.strictEqual(p.selectionPath, "delta");
    assert.strictEqual(p.strike, 95, "|−0.28| is closest to the 0.30 target");
    approx(p.premium, 1.5);                          // (1.40+1.60)/2
    approx(p.collateralPerContract, 9500);           // 95 × 100
    assert.strictEqual(p.contractsWritable, 2, "floor(25000/9500) = 2 — a 3rd would be under-collateralized");
    approx(p.collateralRequired, 19000);
    approx(p.cashUncommitted, 6000);
    approx(p.breakeven, 93.5);                       // 95 − 1.50
    approx(p.premiumYieldAnnualized, (1.5 / 95) * (365 / 36), 1e-6);
    assert.ok(/collateral/i.test(p.yieldBasis), "CSP yield is on the collateral (strike), and says so");

    // cash that can't secure even one contract → naked-put refusal
    const tooSmall = os.proposeCashSecuredPut(CSP_CHAIN, { cash: 5000, price: PX, now: NOW });
    assert.strictEqual(tooSmall.ok, false);
    assert.ok(/NAKED/i.test(tooSmall.reason), "under-collateralized request names the naked-put refusal");
    assert.ok(/9500/.test(tooSmall.reason), "refusal shows the collateral arithmetic");

    const noCash = os.proposeCashSecuredPut(CSP_CHAIN, { price: PX, now: NOW });
    assert.strictEqual(noCash.ok, false);
    assert.ok(/cash/.test(noCash.reason));
    console.log("ok - cash-secured put: strike×100 collateral, floor(cash/collateral) contracts, under-collateral refused as naked");
  }

  // 5) collar — matched expiry, net cost at marks, floor/ceiling
  {
    const p = os.proposeCollar(GREEKS_CHAIN, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(p.ok, true, `collar must propose: ${p.reason}`);
    assert.strictEqual(p.expiration, EXP_MID, "both legs from one expiration");
    assert.strictEqual(p.put.expiration, p.call.expiration, "matched-expiry is structural, not incidental");
    assert.strictEqual(p.put.strike, 95, "putDelta default 0.25 → the exact −0.25 put");
    assert.strictEqual(p.call.strike, 105, "callDelta default 0.30 → the 0.31 call");
    approx(p.put.premium, 1.3);   // (1.20+1.40)/2
    approx(p.call.premium, 2.0);  // (1.90+2.10)/2
    approx(p.netCost, -0.7);      // put − call = 1.30 − 2.00 → net CREDIT
    assert.strictEqual(p.netDirection, "credit");
    approx(p.netCostPerContract, -70);
    assert.strictEqual(p.floor, 95);
    approx(p.floorPct, -0.05);    // −5% of price
    assert.strictEqual(p.ceiling, 105);
    approx(p.ceilingPct, 0.05);   // +5% of price
    approx(p.maxLossPerShare, 100 - 95 + -0.7);   // 4.30
    approx(p.maxGainPerShare, 105 - 100 - -0.7);  // 5.70
    assert.ok(/trades upside for a floor/i.test(p.tradeoffNote), "the honest collar tradeoff is stated");
    assert.strictEqual(p.contractsWritable, 1);

    // matched-expiry enforcement: puts only exist FAR, calls only MID → no collar
    const split = [
      row("call", 105, EXP_MID, 1.90, 2.10, { delta: 0.31 }),
      row("put", 95, EXP_FAR, 4.10, 4.50, { delta: -0.31 }),
    ];
    const noMatch = os.proposeCollar(split, { shares: 100, price: PX, now: NOW, minDte: 21, maxDte: 200 });
    // widen window so both legs qualify individually — they still never share an expiration
    assert.strictEqual(noMatch.ok, false);
    assert.ok(/matched-expiry/.test(noMatch.reason), `mismatched expirations refused (got '${noMatch.reason}')`);

    const fewShares = os.proposeCollar(GREEKS_CHAIN, { shares: 50, price: PX, now: NOW });
    assert.strictEqual(fewShares.ok, false);
    assert.ok(/NAKED/i.test(fewShares.reason), "collar under 100 shares refused — the call leg would be naked");
    console.log("ok - collar: matched expiry enforced, −0.70 net credit at marks, floor −5% / ceiling +5%, tradeoff stated");
  }

  // 6) spread-cost arithmetic — (ask−bid)/2 per share, ×100 per contract
  {
    const cc = os.proposeCoveredCall(GREEKS_CHAIN, { shares: 100, price: PX, now: NOW });
    approx(cc.spreadCost, (2.10 - 1.90) / 2);        // 0.10/sh on the 105C
    approx(cc.spreadCostPerContract, 10);
    const csp = os.proposeCashSecuredPut(CSP_CHAIN, { cash: 10000, price: PX, now: NOW });
    approx(csp.spreadCost, (1.60 - 1.40) / 2);       // 0.10/sh on the 95P
    const col = os.proposeCollar(GREEKS_CHAIN, { shares: 100, price: PX, now: NOW });
    approx(col.spreadCost, (1.40 - 1.20) / 2 + (2.10 - 1.90) / 2); // both legs: 0.20/sh
    approx(col.spreadCostPerContract, 20);
    console.log("ok - spread cost: half-spread per share and ×100 per contract exact on all three strategies");
  }

  // 7) price inference — put-call parity at the ATM strike
  {
    const inferred = os.inferUnderlyingPrice(GREEKS_CHAIN, { now: NOW });
    assert.ok(inferred, "greeks chain has call+put marks at shared strikes — price must be inferable");
    // Nearest expiration (8 DTE) 100 strike: C 1.20, P 1.10 → 100 + 0.10
    approx(inferred.price, 100.1);
    assert.strictEqual(inferred.strike, 100);
    assert.strictEqual(inferred.expiration, EXP_NEAR);
    assert.ok(/parity/.test(inferred.method));
    assert.strictEqual(os.inferUnderlyingPrice([]), null, "empty chain infers nothing — never invented");
    const callsOnly = GREEKS_CHAIN.filter((r) => r.type === "call");
    assert.strictEqual(os.inferUnderlyingPrice(callsOnly, { now: NOW }), null, "no put legs → no parity → null");
    console.log("ok - price inference: parity at the nearest-expiration ATM strike; refuses when a leg is missing");
  }

  // 8) empty/garbage chains never throw
  {
    for (const junk of [null, undefined, [], {}, "nope"]) {
      const r = os.proposeCoveredCall(junk, { shares: 100, price: PX, now: NOW });
      assert.strictEqual(r.ok, false, `junk chain ${JSON.stringify(junk)} must refuse, not throw`);
    }
    console.log("ok - junk chains: refused with { ok:false, reason }, never a throw");
  }

  // 9) delta SOURCE is stated: provider greeks vs model(bs-from-iv) (Yahoo path)
  {
    // Provider-labeled greeks (Alpaca / Alpha Vantage rows)
    const provChain = GREEKS_CHAIN.map((r) => ("delta" in r ? { ...r, delta_source: "provider" } : r));
    const prov = os.proposeCoveredCall(provChain, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(prov.ok, true);
    assert.strictEqual(prov.selectionPath, "delta");
    assert.strictEqual(prov.deltaSource, "provider", "feed greeks are reported as provider");
    assert.strictEqual(prov.assignmentRiskProxy.deltaSource, "provider");

    // Model-labeled delta (the data layer's BS-from-IV on the keyless Yahoo path)
    const modelChain = GREEKS_CHAIN.map((r) => ("delta" in r ? { ...r, delta_source: "model(bs-from-iv)" } : r));
    const model = os.proposeCoveredCall(modelChain, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(model.ok, true);
    assert.strictEqual(model.selectionPath, "delta", "a model delta still enables the delta path");
    assert.strictEqual(model.deltaSource, "model(bs-from-iv)", "model delta is NEVER passed off as provider data");
    assert.strictEqual(model.assignmentRiskProxy.deltaSource, "model(bs-from-iv)");
    assert.ok(/bs-from-iv/.test(model.assignmentRiskProxy.note), "the proxy note explains the delta is IV-derived");
    assert.strictEqual(model.strike, prov.strike, "same deltas → same strike; only the label differs");

    // Unlabeled legacy rows default to provider (the pre-chain row shape)
    const legacy = os.proposeCoveredCall(GREEKS_CHAIN, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(legacy.deltaSource, "provider");

    // Collar legs carry their per-leg source too
    const col = os.proposeCollar(modelChain, { shares: 100, price: PX, now: NOW });
    assert.strictEqual(col.ok, true);
    assert.strictEqual(col.put.deltaSource, "model(bs-from-iv)");
    assert.strictEqual(col.call.deltaSource, "model(bs-from-iv)");
    console.log("ok - delta source: provider vs model(bs-from-iv) stated on proposals, legs, and the risk proxy");
  }

  console.log("ok - options-strategies: all offline suites passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
