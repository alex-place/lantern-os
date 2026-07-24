/**
 * Market-structure signal engine (ported from trading_agents/agents.py).
 *
 * Two PURE functions over bar arrays — no data fetching, no I/O:
 *
 *  - checkMarketStructureShift(bars, direction)
 *      1-min structure-shift detector (Riley's Stage-2 entry signal). Looks for a
 *      strong candle breaking the most recent minor swing level in the requested
 *      direction (higher-highs/higher-lows confirm BULLISH; lower-highs/lower-lows
 *      confirm BEARISH), plus partial / drift / exhaustion fallbacks.
 *
 *  - scoreCounterDirection(sr, counterDir, opts)
 *      Quick 0-100 confidence for a counter-trend setup from already-computed
 *      zone / RSI / multi-timeframe context (no bars needed).
 *
 * The Python original fetched 1-min bars inside check_market_structure_shift();
 * here the caller supplies them so the math is testable and side-effect free.
 * Pivot windows, thresholds and scoring constants are preserved verbatim.
 */

"use strict";

// ── helpers ────────────────────────────────────────────────────────────────
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function max(arr) { return arr.reduce((m, v) => (v > m ? v : m), -Infinity); }
function min(arr) { return arr.reduce((m, v) => (v < m ? v : m), Infinity); }

/**
 * Detect a market-structure shift confirming (or rejecting) `direction`.
 *
 * @param {Array<{open:number,high:number,low:number,close:number}>} bars
 *        Chronological (oldest→newest) OHLC(V) bars. >=10 needed to score.
 * @param {'BULLISH'|'BEARISH'} direction  The direction we're trying to confirm.
 * @returns {{shift:'CONFIRM'|'REJECT'|'NEUTRAL', structure:string,
 *            strength:number, note:string, structureShifted:boolean,
 *            shiftType:string, exhaustive:boolean, entryCandle:(string|null),
 *            confidence:number, approach:string, swingBreak:boolean,
 *            candleConfirms:boolean}}
 *   `strength` == `confidence` (0..100), surfaced under the required key name.
 */
function checkMarketStructureShift(bars, direction) {
  const dir = String(direction || "").toUpperCase();
  const empty = {
    shift: "NEUTRAL", structure: "NONE", strength: 0, note: "insufficient bars",
    structureShifted: false, shiftType: "NONE", exhaustive: false,
    entryCandle: null, confidence: 0, approach: "NONE",
    swingBreak: false, candleConfirms: false,
  };

  // Graceful handling of short/empty input (Python: len < 10 → early return).
  if (!Array.isArray(bars) || bars.length < 10) return empty;

  const opens = bars.map((b) => num(b && b.open));
  const closes = bars.map((b) => num(b && b.close));
  const highs = bars.map((b) => num(b && b.high));
  const lows = bars.map((b) => num(b && b.low));

  // ── recent 1-min swing points — last 20 bars ──────────────────────────────
  const recentH = highs.slice(-20);
  const recentL = lows.slice(-20);
  // recent_c / recent_o are unused in the Python beyond the slice; omitted.

  // Swing high = local peak higher than the 2 prior bars and >= the next bar.
  // Swing low  = local trough lower than the 2 prior bars and <= the next bar.
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < recentH.length - 1; i++) {
    if (recentH[i] > recentH[i - 1] && recentH[i] > recentH[i - 2] &&
        recentH[i] >= recentH[i + 1]) {
      swingHighs.push([i, recentH[i]]);
    }
    if (recentL[i] < recentL[i - 1] && recentL[i] < recentL[i - 2] &&
        recentL[i] <= recentL[i + 1]) {
      swingLows.push([i, recentL[i]]);
    }
  }

  // Most recent swing points (fallback to windowed extreme, skipping last 3 bars).
  const lastSwingHigh = swingHighs.length
    ? swingHighs[swingHighs.length - 1][1] : max(recentH.slice(0, -3));
  const lastSwingLow = swingLows.length
    ? swingLows[swingLows.length - 1][1] : min(recentL.slice(0, -3));

  // ── prior approach trend (into the zone) ──────────────────────────────────
  const firstHalfH = recentH.slice(0, 10);
  const firstHalfL = recentL.slice(0, 10);
  const secondHalfH = recentH.slice(10);
  const secondHalfL = recentL.slice(10);

  const bullishApproach =
    firstHalfH[firstHalfH.length - 1] > firstHalfH[0] &&
    firstHalfL[firstHalfL.length - 1] > firstHalfL[0];
  const bearishApproach =
    firstHalfL[firstHalfL.length - 1] < firstHalfL[0] &&
    firstHalfH[firstHalfH.length - 1] < firstHalfH[0];

  // ── core: has a strong candle broken the recent swing? ────────────────────
  const n = closes.length;
  const lastBody = Math.abs(closes[n - 1] - opens[n - 1]);
  let bodySum = 0;
  for (let i = n - 10; i < n; i++) bodySum += Math.abs(closes[i] - opens[i]);
  const avgBody = bodySum / 10;
  const strongCandle = lastBody > avgBody * 1.1;
  const bearishCandle = closes[n - 1] < opens[n - 1];
  const bullishCandle = closes[n - 1] > opens[n - 1];

  let swingBreak = false;
  let structureShifted = false;
  let shiftType = "NONE";
  let entryCandle = null;

  if (dir === "BEARISH") {
    const lowerHigh = secondHalfH.length > 0 && max(secondHalfH) < max(firstHalfH);
    if (bearishCandle && strongCandle && closes[n - 1] < lastSwingLow) {
      swingBreak = true;
      structureShifted = true;
      shiftType = "BEARISH_SWING_BREAK";
      entryCandle = "STRONG_BEARISH";
    } else if (lowerHigh && bearishCandle && strongCandle) {
      shiftType = "PARTIAL_BEARISH";
      entryCandle = "STRONG_BEARISH";
    } else if (lowerHigh) {
      shiftType = "PARTIAL_BEARISH";
    }
  } else if (dir === "BULLISH") {
    const higherLow = secondHalfL.length > 0 && min(secondHalfL) > min(firstHalfL);
    if (bullishCandle && strongCandle && closes[n - 1] > lastSwingHigh) {
      swingBreak = true;
      structureShifted = true;
      shiftType = "BULLISH_SWING_BREAK";
      entryCandle = "STRONG_BULLISH";
    } else if (higherLow && bullishCandle && strongCandle) {
      shiftType = "PARTIAL_BULLISH";
      entryCandle = "STRONG_BULLISH";
    } else if (higherLow) {
      shiftType = "PARTIAL_BULLISH";
    }
  }

  // No clear directional approach — check simple 3-bar drift.
  if (shiftType === "NONE") {
    if (dir === "BEARISH" && closes[n - 1] < closes[n - 2] && closes[n - 2] < closes[n - 3]) {
      structureShifted = true;
      shiftType = "BEARISH_DRIFT";
    } else if (dir === "BULLISH" && closes[n - 1] > closes[n - 2] && closes[n - 2] > closes[n - 3]) {
      structureShifted = true;
      shiftType = "BULLISH_DRIFT";
    }
  }

  // ── exhaustive/parabolic move detection ───────────────────────────────────
  const last5Moves = [];
  for (let i = n - 5; i < n; i++) last5Moves.push(Math.abs(closes[i] - closes[i - 1]));
  const avgMove = last5Moves.reduce((a, b) => a + b, 0) / last5Moves.length;
  const exhaustive = last5Moves[last5Moves.length - 1] > avgMove * 2.5;

  // ── confidence score (0..100) ─────────────────────────────────────────────
  let confidence = 0;
  if (swingBreak) confidence += 50;          // swing level broken by strong candle
  else if (structureShifted) confidence += 30;
  if (exhaustive) confidence += 20;
  if (entryCandle) confidence += 20;
  if ((dir === "BEARISH" && bullishApproach) ||
      (dir === "BULLISH" && bearishApproach)) {
    confidence += 10;                        // correct approach direction
  }

  const candleConfirms = Boolean(entryCandle && (
    (dir === "BEARISH" && entryCandle === "STRONG_BEARISH") ||
    (dir === "BULLISH" && entryCandle === "STRONG_BULLISH")
  ));

  const approach = bullishApproach ? "BULLISH" : bearishApproach ? "BEARISH" : "NONE";

  // ── map to the required {shift} verdict ───────────────────────────────────
  // A confirmed structure shift in the requested direction → CONFIRM. An
  // exhaustive/parabolic move (reversal risk against the entry) with no shift →
  // REJECT. Otherwise NEUTRAL. This is the port's interpretation layer; the raw
  // Python fields (shiftType, confidence, …) are preserved above it verbatim.
  let shift = "NEUTRAL";
  if (structureShifted && (shiftType.endsWith("SWING_BREAK") ||
      shiftType.startsWith(dir === "BEARISH" ? "BEARISH" : "BULLISH"))) {
    shift = "CONFIRM";
  } else if (exhaustive && !structureShifted) {
    shift = "REJECT";
  }

  return {
    shift,
    structure: shiftType,
    strength: confidence,
    note: `${shiftType} | swingBreak=${swingBreak} exhaustive=${exhaustive} ` +
          `candle=${entryCandle || "none"} approach=${approach} conf=${confidence}/100`,
    // ── faithful Python return fields (superset) ──
    structureShifted,
    shiftType,
    exhaustive,
    entryCandle,
    confidence,
    approach,
    swingBreak,
    candleConfirms,
  };
}

/**
 * Score a counter-trend setup 0..100 from already-computed context.
 * Faithful port of _score_counter_direction(sr, counter_dir, rsi, mtf).
 *
 * @param {object} sr  Support/resistance snapshot. Recognized keys:
 *   - in_zone {boolean}          — is price currently inside a zone
 *   - zone_type {string}         — 'SUPPORT' | 'RESISTANCE' | 'NONE' (only used when in_zone)
 *   - nearest_zone {{type:string}} — nearest zone descriptor; .type read
 *   - zone_strength {number}     — 0..100 strength of the current zone
 *   - dist_to_nearest {number}   — % distance to nearest zone (default 99)
 * @param {'BULLISH'|'BEARISH'} counterDir  The counter direction being scored.
 * @param {object} [opts]  Extra already-fetched context:
 *   - rsi {number}   — current RSI (default 50; neutral)
 *   - mtf {object}   — multi-timeframe bias, e.g. {m15:'BULLISH', m5:'NEUTRAL'} (optional)
 * @returns {number} score clamped to 0..100.
 *
 * NOTE: the Python returned (score, reasonString); this port returns the score
 * only, matching the required numeric signature. The reason string is still
 * assembled internally (parity with the original branch logic) but not exported.
 */
function scoreCounterDirection(sr, counterDir, opts = {}) {
  const s = sr || {};
  const rsi = num(opts.rsi, 50);
  const mtf = opts.mtf || null;
  const dir = String(counterDir || "").toUpperCase();

  let score = 45; // neutral starting point (slightly below threshold)
  const reasons = [];

  const zoneType = s.in_zone ? (s.zone_type != null ? s.zone_type : "NONE") : "NONE";
  const nearest = ((s.nearest_zone || {}).type) != null ? (s.nearest_zone || {}).type : "NONE";
  const zoneStr = num(s.zone_strength, 0) || 0;
  const dist = num(s.dist_to_nearest, 99);

  if (dir === "BEARISH") {
    // Short setup best at resistance.
    if (zoneType === "RESISTANCE") {
      score += 15 + Math.min(Math.floor(zoneStr / 10), 10);
      reasons.push(`at resistance (str=${zoneStr})`);
    } else if (zoneType === "SUPPORT") {
      score -= 15;
      reasons.push("at support — risky for short");
    } else if (nearest === "RESISTANCE" && dist < 2.0) {
      score += 8;
      reasons.push(`near resistance (${dist.toFixed(1)}% away)`);
    }
    if (rsi > 65) { score += 10; reasons.push(`RSI overbought (${rsi.toFixed(0)})`); }
    else if (rsi < 35) { score -= 15; reasons.push(`RSI oversold (${rsi.toFixed(0)}) — risky short`); }
  } else { // BULLISH
    if (zoneType === "SUPPORT") {
      score += 15 + Math.min(Math.floor(zoneStr / 10), 10);
      reasons.push(`at support (str=${zoneStr})`);
    } else if (zoneType === "RESISTANCE") {
      score -= 15;
      reasons.push("at resistance — risky for long");
    } else if (nearest === "SUPPORT" && dist < 2.0) {
      score += 8;
      reasons.push(`near support (${dist.toFixed(1)}% away)`);
    }
    if (rsi < 35) { score += 10; reasons.push(`RSI oversold (${rsi.toFixed(0)})`); }
    else if (rsi > 65) { score -= 15; reasons.push(`RSI overbought (${rsi.toFixed(0)}) — risky long`); }
  }

  // MTF alignment for counter direction.
  if (mtf) {
    const m15 = mtf.m15 != null ? mtf.m15 : "NEUTRAL";
    const m5 = mtf.m5 != null ? mtf.m5 : "NEUTRAL";
    if (m15 === dir) { score += 8; reasons.push(`15min aligned (${m15})`); }
    else if (m15 && m15 !== "NEUTRAL" && m15 !== dir) { score -= 10; reasons.push(`15min against (${m15})`); }
    if (m5 === dir) { score += 5; }
  }

  score = Math.max(0, Math.min(100, score));
  return score;
}

module.exports = { checkMarketStructureShift, scoreCounterDirection };

// ── self-test ────────────────────────────────────────────────────────────────
if (require.main === module) {
  // Build synthetic OHLC series (oldest→newest).
  const mkBars = (closes) => closes.map((c, i) => {
    const prev = i > 0 ? closes[i - 1] : c;
    const up = c >= prev;
    const o = prev;
    return {
      timestamp: 1_700_000_000 + i * 60,
      open: o,
      high: Math.max(o, c) + 0.2,
      low: Math.min(o, c) - 0.2,
      close: c,
      volume: 1000 + i,
    };
  });

  // Clean uptrend: steady higher-highs / higher-lows, strong final green candle.
  const upCloses = [];
  for (let i = 0; i < 24; i++) upCloses.push(100 + i * 0.5);
  upCloses[upCloses.length - 1] = upCloses[upCloses.length - 2] + 3; // strong breakout candle
  const upBars = mkBars(upCloses);

  // Clean downtrend: steady lower-highs / lower-lows, strong final red candle.
  const downCloses = [];
  for (let i = 0; i < 24; i++) downCloses.push(120 - i * 0.5);
  downCloses[downCloses.length - 1] = downCloses[downCloses.length - 2] - 3; // strong breakdown candle
  const downBars = mkBars(downCloses);

  // Choppy: oscillating, no persistent structure.
  const chopCloses = [];
  for (let i = 0; i < 24; i++) chopCloses.push(110 + (i % 2 === 0 ? 0.4 : -0.4));
  const chopBars = mkBars(chopCloses);

  const show = (label, bars, direction) => {
    const r = checkMarketStructureShift(bars, direction);
    console.log(`\n[${label}]  dir=${direction}`);
    console.log(`  shift=${r.shift}  structure=${r.structure}  strength=${r.strength}`);
    console.log(`  swingBreak=${r.swingBreak}  exhaustive=${r.exhaustive}  ` +
      `entryCandle=${r.entryCandle}  approach=${r.approach}  candleConfirms=${r.candleConfirms}`);
    console.log(`  note: ${r.note}`);
  };

  console.log("=== checkMarketStructureShift ===");
  show("uptrend / BULLISH", upBars, "BULLISH");
  show("uptrend / BEARISH (counter)", upBars, "BEARISH");
  show("downtrend / BEARISH", downBars, "BEARISH");
  show("downtrend / BULLISH (counter)", downBars, "BULLISH");
  show("choppy / BULLISH", chopBars, "BULLISH");
  show("choppy / BEARISH", chopBars, "BEARISH");

  // Short/empty guards.
  console.log("\n[guard: empty]", JSON.stringify(checkMarketStructureShift([], "BULLISH").shift));
  console.log("[guard: 3 bars]", JSON.stringify(checkMarketStructureShift(upBars.slice(0, 3), "BULLISH").shift));

  console.log("\n=== scoreCounterDirection ===");
  const srAtResistance = {
    in_zone: true, zone_type: "RESISTANCE", zone_strength: 60,
    nearest_zone: { type: "RESISTANCE" }, dist_to_nearest: 0.3,
  };
  const srAtSupport = {
    in_zone: true, zone_type: "SUPPORT", zone_strength: 40,
    nearest_zone: { type: "SUPPORT" }, dist_to_nearest: 0.5,
  };
  const srNone = { in_zone: false, nearest_zone: { type: "NONE" }, dist_to_nearest: 99 };

  console.log("  BEARISH @ resistance, RSI 72, m15 aligned:",
    scoreCounterDirection(srAtResistance, "BEARISH", { rsi: 72, mtf: { m15: "BEARISH", m5: "BEARISH" } }));
  console.log("  BEARISH @ support (risky), RSI 30:",
    scoreCounterDirection(srAtSupport, "BEARISH", { rsi: 30 }));
  console.log("  BULLISH @ support, RSI 28, m15 aligned:",
    scoreCounterDirection(srAtSupport, "BULLISH", { rsi: 28, mtf: { m15: "BULLISH", m5: "NEUTRAL" } }));
  console.log("  BULLISH no zone, RSI 50, no mtf:",
    scoreCounterDirection(srNone, "BULLISH", { rsi: 50 }));
  console.log("  BULLISH no opts (defaults):",
    scoreCounterDirection(srNone, "BULLISH"));

  console.log("\nself-test complete.");
}
