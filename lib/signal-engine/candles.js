/**
 * Candle-pattern detector — Riley Coleman price-action signals, PURE over bars.
 *
 * Ported from `detect_candle_patterns(ticker, direction)` in
 * src/trading_agents/agents.py (lines 2722-3029). Unlike the Python original —
 * which fetched its own 1-min + 15-min bars from Alpaca internally — this is a
 * PURE function: pass in a chronological (oldest→newest) array of OHLCV bars as
 * produced by market-data-yahoo.js and it returns the detected pattern. No I/O,
 * no external deps.
 *
 * Riley's hierarchy (highest→lowest conviction), each Grade A unless noted:
 *   1. Failed Breakout — #1 pattern, major trend shift
 *   2. Bait Candle    — massive fast candle that gets fully recovered
 *   3. Head & Shoulders — micro reversal, neckline break
 *   4. Double Top/Bottom (Grade B) — conservative reversal
 *   5. Unhealthy/Exhaustive move (Grade B) — parabolic, fades
 *   6. Break & Retest (Grade B) — stair-step continuation
 *
 * He does NOT use hammers/dojis/engulfing as primary signals — context and
 * sequence over single-candle shapes. (The self-test below still feeds a doji
 * and an engulfing set to prove the detector no-ops / fires sanely on them.)
 *
 * Interface:
 *   detectCandlePatterns(bars, direction)
 *     -> { pattern: string|null, patterns: string[], strength: number(0..100),
 *          confirms: boolean, note: string, bias, riley_grade, all_patterns }
 *   where `direction` is 'BULLISH' | 'BEARISH' and `confirms` = whether the
 *   best pattern's bias matches `direction`.
 *
 * NOTE ON FIDELITY: the Python #6 (Break & Retest) compared the current 1-min
 * bars against a *separate* 15-min bar series for prior resistance. This pure
 * function only receives one `bars` array, so #6 derives prior resistance from
 * an earlier slice of the SAME series (h[-20:-10] max) instead of a coarser
 * timeframe. Every other pattern's thresholds/body-wick ratios/strength weights
 * are preserved exactly.
 */

"use strict";

// ── helpers ──────────────────────────────────────────────────────────────────
// _safe_max / _safe_min: like Python's — return null (not throw/NaN) on empty.
function safeMax(seq) {
  return seq && seq.length ? Math.max.apply(null, seq) : null;
}
function safeMin(seq) {
  return seq && seq.length ? Math.min.apply(null, seq) : null;
}
// Python negative-index slice h[a:b] with a,b possibly negative. Mirrors
// Python semantics closely enough for the fixed slices used below.
function pySlice(arr, start, end) {
  const n = arr.length;
  let s = start === undefined || start === null ? 0 : start;
  let e = end === undefined || end === null ? n : end;
  if (s < 0) s += n;
  if (e < 0) e += n;
  s = Math.max(0, Math.min(n, s));
  e = Math.max(0, Math.min(n, e));
  return e > s ? arr.slice(s, e) : [];
}
// Python negative index arr[i] (i<0 counts from the end).
function at(arr, i) {
  return i < 0 ? arr[arr.length + i] : arr[i];
}

const INSUFFICIENT = Object.freeze({
  pattern: null, patterns: [], strength: 0, confirms: false, note: "insufficient bars",
});

/**
 * detectCandlePatterns(bars, direction)
 * @param {Array<{timestamp:*,open:number,high:number,low:number,close:number,volume:number}>} bars
 *        chronological, oldest→newest.
 * @param {'BULLISH'|'BEARISH'} direction
 * @returns {{pattern:string|null,patterns:string[],strength:number,confirms:boolean,note:string,
 *            bias?:string,riley_grade?:string,all_patterns?:string[]}}
 */
function detectCandlePatterns(bars, direction) {
  // Empty-bars guard (Python required >= 10 non-empty 1-min bars).
  if (!Array.isArray(bars) || bars.length < 10) return { ...INSUFFICIENT };

  const o = bars.map((b) => +b.open);
  const h = bars.map((b) => +b.high);
  const l = bars.map((b) => +b.low);
  const c = bars.map((b) => +b.close);
  const v = bars.map((b) => (b.volume != null ? +b.volume : 1));

  // Python's secondary guard (needs >= 2 of each + non-empty volume).
  if (h.length < 2 || l.length < 2 || c.length < 2 || o.length < 2 || !v.length) {
    return { ...INSUFFICIENT };
  }

  // ── Average candle metrics for context (lookback clamped to list length) ──
  const navgRange = Math.min(15, h.length, l.length);
  const navgBody = Math.min(15, c.length, o.length);
  const navgVol = Math.min(10, v.length);
  let sumRange = 0, sumBody = 0, sumVol = 0;
  for (let i = -navgRange; i < 0; i++) sumRange += at(h, i) - at(l, i);
  for (let i = -navgBody; i < 0; i++) sumBody += Math.abs(at(c, i) - at(o, i));
  for (let i = -navgVol; i < 0; i++) sumVol += at(v, i);
  const avgRange = sumRange / navgRange;
  const avgBody = sumBody / navgBody; // eslint-disable-line no-unused-vars
  const avgVol = sumVol / navgVol;    // eslint-disable-line no-unused-vars

  const patterns = [];
  const last = (arr) => arr[arr.length - 1]; // arr[-1]

  // ── 1. FAILED BREAKOUT (Riley's #1 pattern) ────────────────────────────────
  const recentHigh = safeMax(pySlice(h, -15, -1));
  const recentLow = safeMin(pySlice(l, -15, -1));
  const maxH5 = safeMax(pySlice(h, -5));
  const minL5 = safeMin(pySlice(l, -5));

  // Bearish failed breakout: broke above recent high, now reversing back.
  if (
    recentHigh !== null && recentLow !== null && maxH5 !== null &&
    maxH5 > recentHigh &&
    last(c) < recentHigh &&
    last(c) < last(o) &&
    last(h) - last(l) > avgRange * 0.8 &&
    maxH5 - recentLow !== 0
  ) {
    const trapSize = ((maxH5 - recentHigh) / recentHigh) * 100;
    const recovery = ((maxH5 - last(c)) / (maxH5 - recentLow)) * 100;
    const strength = Math.min(100, Math.trunc(75 + recovery * 0.25));
    patterns.push({
      pattern: "FAILED_BREAKOUT_BEARISH",
      strength,
      bias: "BEARISH",
      riley_grade: "A",
      description:
        `Failed breakout: broke $${recentHigh.toFixed(2)} by ` +
        `${trapSize.toFixed(2)}%, now reversing — TRAP`,
    });
  }

  // Bullish failed breakout: broke below recent low, now reversing up.
  if (
    recentLow !== null && minL5 !== null &&
    minL5 < recentLow &&
    last(c) > recentLow &&
    last(c) > last(o) &&
    last(h) - last(l) > avgRange * 0.8
  ) {
    const trapSize = ((recentLow - minL5) / recentLow) * 100;
    const strength = Math.min(100, Math.trunc(75 + trapSize * 5));
    patterns.push({
      pattern: "FAILED_BREAKOUT_BULLISH",
      strength,
      bias: "BULLISH",
      riley_grade: "A",
      description:
        `Failed breakdown: broke $${recentLow.toFixed(2)} by ` +
        `${trapSize.toFixed(2)}%, now recovering — TRAP`,
    });
  }

  // ── 2. BAIT CANDLE ─────────────────────────────────────────────────────────
  // Massive fast candle that gets FULLY recovered → reversal signal.
  for (let i = -6; i < -1; i++) {
    const baitRange = at(h, i) - at(l, i);
    const baitBearish = at(c, i) < at(o, i);
    const baitBullish = at(c, i) > at(o, i);

    if (baitRange < avgRange * 2.0) continue; // must be a 2x+ candle

    // Bearish bait: big red candle, then price recovers ABOVE its open.
    if (baitBearish) {
      const recoveryHigh = safeMax(pySlice(h, i + 1)); // h[i+1:]
      if (recoveryHigh !== null && recoveryHigh >= at(o, i)) {
        const strength = Math.min(100, Math.trunc(70 + (baitRange / avgRange - 2) * 10));
        patterns.push({
          pattern: "BAIT_CANDLE_BULLISH",
          strength,
          bias: "BULLISH",
          riley_grade: "A",
          description:
            `Bait candle: ${(baitRange / avgRange).toFixed(1)}x avg ` +
            `bearish candle fully recovered — fake move`,
        });
        break;
      }
    }

    // Bullish bait: big green candle, then price drops BELOW its open.
    if (baitBullish) {
      const recoveryLow = safeMin(pySlice(l, i + 1)); // l[i+1:]
      if (recoveryLow !== null && recoveryLow <= at(o, i)) {
        const strength = Math.min(100, Math.trunc(70 + (baitRange / avgRange - 2) * 10));
        patterns.push({
          pattern: "BAIT_CANDLE_BEARISH",
          strength,
          bias: "BEARISH",
          riley_grade: "A",
          description:
            `Bait candle: ${(baitRange / avgRange).toFixed(1)}x avg ` +
            `bullish candle fully recovered — fake move`,
        });
        break;
      }
    }
  }

  // ── 3. HEAD AND SHOULDERS (micro, on 1-min) ────────────────────────────────
  // Three peaks: left shoulder < head > right shoulder (right = lower high).
  if (h.length >= 20) {
    const peaks = []; // [idx(neg), high]
    const top = Math.min(20, h.length) - 2;
    for (let i = 2; i < top; i++) {
      const idx = -i;
      if (
        at(h, idx) > at(h, idx - 1) && at(h, idx) > at(h, idx - 2) &&
        at(h, idx) > at(h, idx + 1) && at(h, idx) > at(h, idx + 2)
      ) {
        peaks.push([idx, at(h, idx)]);
      }
    }

    if (peaks.length >= 3) {
      const p1 = peaks[peaks.length - 3];
      const p2 = peaks[peaks.length - 2];
      const p3 = peaks[peaks.length - 1];
      const headH = p2[1];
      const lsH = p1[1];
      const rsH = p3[1];
      if (
        headH > lsH && headH > rsH &&
        rsH < lsH * 1.02 &&
        last(c) < Math.min(at(l, p1[0]), at(l, p3[0]))
      ) {
        const strength = Math.min(100, Math.trunc(70 + (1 - rsH / headH) * 100));
        patterns.push({
          pattern: "HEAD_AND_SHOULDERS",
          strength,
          bias: "BEARISH",
          riley_grade: "A",
          description:
            `H&S: head $${headH.toFixed(2)} > LS $${lsH.toFixed(2)} > RS $${rsH.toFixed(2)} ` +
            `— neckline broken`,
        });
      }
    }
  }

  // ── 4. DOUBLE TOP / DOUBLE BOTTOM ──────────────────────────────────────────
  const windowN = Math.min(25, h.length);
  const halfN = Math.trunc(windowN / 2); // Python window//2 (floor)
  const top1 = safeMax(pySlice(h, -windowN, -halfN));
  const top2 = safeMax(pySlice(h, -halfN));
  const bot1 = safeMin(pySlice(l, -windowN, -halfN));
  const bot2 = safeMin(pySlice(l, -halfN));
  const tol = avgRange * 3; // tolerance = 3x avg range

  // Double top: two similar highs, now pulling back.
  if (
    top1 !== null && top2 !== null && recentLow !== null &&
    Math.abs(top1 - top2) <= tol &&
    top1 > recentLow + avgRange * 5 &&
    last(c) < Math.min(top1, top2) * 0.995 &&
    last(c) < last(o)
  ) {
    const strength = Math.trunc(65 + Math.max(0, 1 - Math.abs(top1 - top2) / avgRange) * 20);
    patterns.push({
      pattern: "DOUBLE_TOP",
      strength: Math.min(85, strength),
      bias: "BEARISH",
      riley_grade: "B",
      description:
        `Double top: $${top1.toFixed(2)} and $${top2.toFixed(2)} ` +
        `(${Math.abs(top1 - top2).toFixed(2)} apart) — second test failing`,
    });
  }

  // Double bottom: two similar lows, now recovering.
  if (
    bot1 !== null && bot2 !== null &&
    Math.abs(bot1 - bot2) <= tol &&
    last(c) > Math.max(bot1, bot2) * 1.005 &&
    last(c) > last(o)
  ) {
    const strength = Math.trunc(65 + Math.max(0, 1 - Math.abs(bot1 - bot2) / avgRange) * 20);
    patterns.push({
      pattern: "DOUBLE_BOTTOM",
      strength: Math.min(85, strength),
      bias: "BULLISH",
      riley_grade: "B",
      description:
        `Double bottom: $${bot1.toFixed(2)} and $${bot2.toFixed(2)} — second test holding`,
    });
  }

  // ── 5. UNHEALTHY/EXHAUSTIVE MOVE ───────────────────────────────────────────
  // Parabolic move — too fast, likely to snap back. Riley FADES these.
  const last5Ranges = [];
  const last5Bodies = [];
  for (let i = -5; i < 0; i++) {
    last5Ranges.push(at(h, i) - at(l, i));
    last5Bodies.push(Math.abs(at(c, i) - at(o, i)));
  }
  const priorRangeAvg = last5Ranges.slice(0, -1).reduce((s, x) => s + x, 0) / 4;
  const acceleration = last5Ranges[last5Ranges.length - 1] / Math.max(priorRangeAvg, 0.001);
  const allDown4 = [-4, -3, -2, -1].every((i) => at(c, i) < at(o, i));
  const allUp4 = [-4, -3, -2, -1].every((i) => at(c, i) > at(o, i));
  const allSameDir = allDown4 || allUp4;
  const shrinkingBody = last5Bodies[last5Bodies.length - 1] < last5Bodies[last5Bodies.length - 2] * 0.6;

  if (acceleration > 2.5 || (allSameDir && shrinkingBody)) {
    // Parabolic bearish move — potential exhaustion LONG.
    if (allDown4) {
      const strength = Math.min(100, Math.trunc(55 + acceleration * 10));
      patterns.push({
        pattern: "EXHAUSTIVE_DROP",
        strength: Math.min(75, strength),
        bias: "BULLISH",
        riley_grade: "B",
        description:
          `Exhaustive drop: ${acceleration.toFixed(1)}x acceleration, ` +
          `${shrinkingBody ? "shrinking bodies" : "parabolic"} — snap-back likely`,
      });
    } else if (allUp4) {
      // Parabolic bullish move — potential exhaustion SHORT.
      const strength = Math.min(100, Math.trunc(55 + acceleration * 10));
      patterns.push({
        pattern: "EXHAUSTIVE_SPIKE",
        strength: Math.min(75, strength),
        bias: "BEARISH",
        riley_grade: "B",
        description: `Exhaustive spike: ${acceleration.toFixed(1)}x acceleration — snap-back likely`,
      });
    }
  }

  // ── 6. BREAK AND RETEST (stair-step continuation) ──────────────────────────
  // Prior resistance broken, now retesting as support. The Python used a
  // separate 15-min series; here we derive prior resistance from an earlier
  // slice of the same bars (h[-20:-10]) — see NOTE at top of file.
  if (h.length >= 20) {
    const prevResistance = safeMax(pySlice(h, -20, -10));
    const currMaxH10 = safeMax(pySlice(h, -10));
    const currPrice = last(c);
    if (
      prevResistance !== null && currMaxH10 !== null &&
      currPrice > prevResistance * 0.998 &&
      currPrice < prevResistance * 1.015 &&
      currMaxH10 > prevResistance &&
      last(c) > last(o)
    ) {
      patterns.push({
        pattern: "BREAK_AND_RETEST_BULLISH",
        strength: 65,
        bias: "BULLISH",
        riley_grade: "B",
        description:
          `Break & retest: previous resistance $${prevResistance.toFixed(2)} ` +
          `now acting as support`,
      });
    }
  }

  if (!patterns.length) {
    return { pattern: null, patterns: [], strength: 0, confirms: false, note: "" };
  }

  // Sort by Riley grade then descending strength.
  const gradeOrder = { A: 0, B: 1, C: 2 };
  patterns.sort((a, b) => {
    const ga = gradeOrder[a.riley_grade] !== undefined ? gradeOrder[a.riley_grade] : 2;
    const gb = gradeOrder[b.riley_grade] !== undefined ? gradeOrder[b.riley_grade] : 2;
    if (ga !== gb) return ga - gb;
    return b.strength - a.strength;
  });
  const best = patterns[0];

  const confirms =
    (best.bias === "BEARISH" && direction === "BEARISH") ||
    (best.bias === "BULLISH" && direction === "BULLISH");

  const all = patterns.map((p) => p.pattern);
  return {
    pattern: best.pattern,
    patterns: all,        // required key: names of all detected patterns
    strength: best.strength,
    confirms,
    note: best.description,
    // extra fields mirroring the Python result (harmless, not required):
    bias: best.bias,
    riley_grade: best.riley_grade,
    all_patterns: all,
  };
}

module.exports = { detectCandlePatterns };

// ── self-test ────────────────────────────────────────────────────────────────
// Run: node lib/signal-engine/candles.js
if (require.main === module) {
  const bar = (o, high, low, cl, vol) => ({
    timestamp: new Date().toISOString(), open: o, high, low, close: cl, volume: vol == null ? 1000 : vol,
  });

  // (1) Clear BULLISH failed-breakdown / bait setup: a long calm base, then one
  // massive red "bait" candle that pokes below the base low and is fully
  // recovered above its open by the final green candle. Should fire a BULLISH
  // pattern (bait/failed-breakdown), confirming a BULLISH direction.
  const bullish = [];
  for (let i = 0; i < 18; i++) bullish.push(bar(100, 100.6, 99.5, 100.1, 1000)); // calm base ~100
  bullish.push(bar(100.1, 100.2, 96.0, 96.2, 5000)); // huge red bait candle, breaks below base low
  bullish.push(bar(96.3, 101.2, 96.2, 101.0, 6000));  // full recovery back above the bait's open, bullish close

  // (2) Doji: tiny bodies, long-ish balanced wicks, no directional sequence.
  // Riley ignores dojis → expect no pattern (pattern:null, note:"").
  const doji = [];
  for (let i = 0; i < 22; i++) doji.push(bar(100.0, 100.4, 99.6, 100.02, 1000));

  // (3) Flat: perfectly identical bars → zero range/body → nothing to detect.
  const flat = [];
  for (let i = 0; i < 20; i++) flat.push(bar(50, 50, 50, 50, 0));

  // (4) Too-short: fewer than 10 bars → insufficient guard.
  const tooShort = [bar(1, 2, 0.5, 1.5), bar(1.5, 2.5, 1, 2)];

  const show = (name, bars, dir) => {
    const r = detectCandlePatterns(bars, dir);
    // eslint-disable-next-line no-console
    console.log(
      `${name.padEnd(12)} dir=${dir}\n  ->`,
      JSON.stringify(
        { pattern: r.pattern, patterns: r.patterns, strength: r.strength, confirms: r.confirms, note: r.note },
        null, 0
      ),
      "\n"
    );
  };

  console.log("=== candles.js self-test ===\n");
  show("bullish", bullish, "BULLISH");
  show("doji", doji, "BULLISH");
  show("flat", flat, "BULLISH");
  show("too-short", tooShort, "BULLISH");
  console.log("done.");
}
