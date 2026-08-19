/**
 * Support/Resistance zone engine — the "Riley Coleman" Stage-1 detector,
 * ported from trading_agents/agents.py (find_sr_zones ~2253 + the
 * break-and-retest tracker _riley_update_broken_zones_and_retests ~2130).
 *
 * ONE PURE function over bars — no data fetching, no I/O. The Python original
 * fetched 15-min bars from Alpaca inside find_sr_zones(); here the CALLER
 * supplies them (as produced by lib/market-data-yahoo.js getBars(t,'15m')), so
 * the math is testable and side-effect free.
 *
 *   findSrZones(ticker, price, bars, opts?) -> {
 *     support, resistance, mid, type, strength, touches, zones,
 *     broken_retest, trend, volatility, note, ...extras
 *   }
 *
 * Break-and-retest state is kept module-scoped (Maps keyed by ticker), mirroring
 * the Python module globals `_broken_zones` / `_broken_zones_last_bar` and the
 * `_watch_mode` hand-off. A SUPPORT that a 15-min candle closes below is "broken
 * down"; a RESISTANCE closed above is "broken up". A retest (price back within
 * ~0.5% of, or inside, a broken zone after first moving >=0.3% beyond it) arms a
 * watch in the OPPOSITE direction (broken support retest = SHORT, broken
 * resistance retest = LONG).
 *
 * Clustering tolerance (0.5%), min-touches, strength scoring, recency
 * multipliers and the zone top/bottom band math are preserved verbatim from the
 * Python. Fidelity notes on the two intentionally-dropped fetch paths
 * (pre-market extended-hours bars + `_premarket_zones` injection) are at the
 * bottom of this file.
 */

"use strict";

// ── module-scoped break-and-retest state (mirrors Python module globals) ─────
// _brokenZones:        Map<ticker, Array<brokenZoneRecord>>
// _brokenZonesLastBar: Map<ticker, string>  — last 15-min candle already processed
// _watchMode:          Map<ticker, watchRecord>  — armed opposite-direction watch
const _brokenZones = new Map();
const _brokenZonesLastBar = new Map();
const _watchMode = new Map();
const WATCH_MODE_MAX_TICKERS = 2;

// ── helpers ──────────────────────────────────────────────────────────────────
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function maxOf(arr) { return arr.reduce((m, v) => (v > m ? v : m), -Infinity); }
function minOf(arr) { return arr.reduce((m, v) => (v < m ? v : m), Infinity); }
function round(v, d = 4) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

// Convert a bar timestamp (ISO string, epoch ms/sec, or Date) to a UTC-based
// "YYYY-MM-DD" day key. The Python bucketed bars by America/New_York calendar
// date; Yahoo 15-min timestamps are ISO-UTC, so we bucket by the timestamp's day
// directly (see fidelity note #1). Bad/absent timestamps fall back to index-0's
// day so a whole run never mis-tiers into "older".
function dayKey(ts) {
  try {
    let d;
    if (ts instanceof Date) d = ts;
    else if (typeof ts === "number") d = new Date(ts < 1e12 ? ts * 1000 : ts);
    else d = new Date(String(ts));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch (_e) {
    return null;
  }
}

// Whole-day gap between two day-key strings (a - b), in integer days.
function dayDiff(aKey, bKey) {
  const a = Date.parse(aKey + "T00:00:00Z");
  const b = Date.parse(bKey + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((a - b) / 86400000);
}

// Empty / neutral result — Python returned zeroed "NONE" zones on short bars.
function neutralResult(note) {
  return {
    support: null, resistance: null, mid: null, type: "NEUTRAL",
    strength: 0, touches: 0, zones: [],
    broken_retest: null, trend: "NEUTRAL", volatility: "NORMAL",
    note: note || "insufficient bars",
    // extras (parity with the Python return contract)
    in_zone: false, zone_type: "NONE", zone_strength: 0,
    nearest_zone: null, dist_to_nearest: 99,
    unhealthy_approach: false, approach_desc: "",
  };
}

/**
 * Riley break-and-retest detection — runs once per fresh 15-min candle.
 * Faithful port of _riley_update_broken_zones_and_retests. Mutates the module
 * Maps and returns the freshly-detected retest (if any) for surfacing.
 *
 * @returns {null | {direction:'LONG'|'SHORT', zone_level:number, note:string}}
 */
function updateBrokenZonesAndRetests(ticker, price, goodZones, times, closes) {
  try {
    if (!times || !times.length || !closes || !closes.length) return null;
    const lastBarT = String(times[times.length - 1]);
    if (_brokenZonesLastBar.get(ticker) === lastBarT) {
      // Already processed this 15-min candle — but still surface any zone that
      // is currently in a retest window so the card stays live across scans.
      return currentRetest(ticker, price);
    }
    _brokenZonesLastBar.set(ticker, lastBarT);

    const lastClose = closes[closes.length - 1];
    if (!_brokenZones.has(ticker)) _brokenZones.set(ticker, []);
    const brokenList = _brokenZones.get(ticker);

    // ── New breaks: a 15-min candle closes beyond a zone's range ─────────────
    for (const z of goodZones) {
      // Only track fresh (today/recent/weekly) + strong (>=70) real S/R zones.
      const rec = z.recency;
      if (!(rec === "today" || rec === "recent" || rec === "weekly")
          || num(z.strength) < 70
          || !(z.type === "SUPPORT" || z.type === "RESISTANCE")) {
        continue;
      }
      const zoneLevel = z.mid, zoneTop = z.top, zoneBottom = z.bottom;
      if (!(zoneLevel > 0)) continue;
      const already = brokenList.some(
        (b) => Math.abs(b.zone_level - zoneLevel) / zoneLevel < 0.001
          && b.zone_type === z.type
      );
      if (already) continue;

      // Distance filter — a zone broken far from price is no longer actionable.
      if (Math.abs(price - zoneLevel) / price > 0.05) continue;

      if (z.type === "SUPPORT" && lastClose < zoneBottom) {
        brokenList.push({
          ticker,
          zone_level: zoneLevel, zone_top: zoneTop, zone_bottom: zoneBottom,
          zone_type: "SUPPORT", direction_broken: "DOWN",
          time_broken: new Date().toISOString(),
          max_excursion_pct: Math.abs(price - zoneLevel) / zoneLevel * 100,
          retested: false,
        });
      } else if (z.type === "RESISTANCE" && lastClose > zoneTop) {
        brokenList.push({
          ticker,
          zone_level: zoneLevel, zone_top: zoneTop, zone_bottom: zoneBottom,
          zone_type: "RESISTANCE", direction_broken: "UP",
          time_broken: new Date().toISOString(),
          max_excursion_pct: Math.abs(price - zoneLevel) / zoneLevel * 100,
          retested: false,
        });
      }
    }

    // Keep only the 3 most recently broken zones per ticker.
    if (brokenList.length > 3) {
      brokenList.sort((a, b) => (a.time_broken < b.time_broken ? 1 : -1));
      brokenList.length = 3;
    }

    // ── Track excursion + detect retest on already-broken zones ──────────────
    let freshRetest = null;
    for (const b of brokenList) {
      if (b.retested || b.zone_level <= 0) continue;
      const zoneLevel = b.zone_level;
      const distPct = Math.abs(price - zoneLevel) / zoneLevel * 100;

      // Only accumulate excursion while price is still on the broken side.
      const beyond = b.direction_broken === "DOWN"
        ? price < zoneLevel : price > zoneLevel;
      if (beyond) b.max_excursion_pct = Math.max(b.max_excursion_pct, distPct);

      const inZoneRange = price >= b.zone_bottom && price <= b.zone_top;
      const nearLevel = distPct <= 0.5;
      if (b.max_excursion_pct >= 0.3 && (inZoneRange || nearLevel)) {
        b.retested = true;
        const watchSide = b.zone_type === "SUPPORT" ? "SHORT" : "LONG";
        const fromSide = b.zone_type === "SUPPORT" ? "below" : "above";
        if (!_watchMode.has(ticker) && _watchMode.size < WATCH_MODE_MAX_TICKERS) {
          _watchMode.set(ticker, {
            ticker, side: watchSide, zone_level: zoneLevel,
            zone_strength: 70, confidence: 70,
            time_entered: new Date().toISOString(),
            candles_checked: 0, trigger_level: null, retest: true,
          });
        }
        if (!freshRetest) {
          freshRetest = {
            direction: watchSide, zone_level: round(zoneLevel, 4),
            note: `broken ${b.zone_type} retesting from ${fromSide} — watching for ${watchSide}`,
          };
        }
      }
    }
    return freshRetest;
  } catch (_e) {
    return null;
  }
}

// Report a still-live retest for a ticker whose current candle was already
// processed (so a re-scan within the same 15-min bar keeps surfacing it).
function currentRetest(ticker, price) {
  const brokenList = _brokenZones.get(ticker) || [];
  for (const b of brokenList) {
    if (!b.retested || !(b.zone_level > 0)) continue;
    const distPct = Math.abs(price - b.zone_level) / b.zone_level * 100;
    const inZoneRange = price >= b.zone_bottom && price <= b.zone_top;
    if (inZoneRange || distPct <= 0.5) {
      const watchSide = b.zone_type === "SUPPORT" ? "SHORT" : "LONG";
      const fromSide = b.zone_type === "SUPPORT" ? "below" : "above";
      return {
        direction: watchSide, zone_level: round(b.zone_level, 4),
        note: `broken ${b.zone_type} retesting from ${fromSide} — watching for ${watchSide}`,
      };
    }
  }
  return null;
}

/**
 * Stage 1 — identify high-probability S/R ZONES on the 15-min chart.
 *
 * @param {string} ticker
 * @param {number} price  current price
 * @param {Array<{timestamp:*,open:number,high:number,low:number,close:number,volume:number}>} bars
 *        chronological (oldest→newest) 15-min bars
 * @param {{premarketZones?:Array}} [opts]  optional caller-supplied premarket
 *        priority zones (mirrors the Python `_premarket_zones` injection; empty
 *        by default — see fidelity note #2).
 * @returns {object} see module header.
 */
function findSrZones(ticker, price, bars, opts = {}) {
  // ── ADAPTIVE CLUSTERING TOLERANCE (operator design 2026-08-05) ─────────────
  // The 0.5%% clustering constant means opposite things on different tickers: on
  // GLD (daily range ~1.1%%) it merges half a day's range into one zone; on a 5%%
  // -range instrument it shatters real structure into fragments. Scale it by the
  // instrument's own recent true range so zone GRANULARITY adapts to how the
  // symbol actually moves — a structural property that persists, unlike a fitted
  // constant. opts.clusterAtrMult (or ZONE_CLUSTER_ATR_MULT) sets the multiple;
  // 0 keeps the legacy fixed 0.5%%. Clamped to [0.15%%, 2%%] so a volatility spike
  // can never collapse every level into one zone or fragment them into noise.
  // PER-SYMBOL DEFAULTS (measured, not fitted). GLD is the most range-bound
  // instrument in the book and asked for tighter/local zone structure in TWO
  // independent tests: it preferred a 40-bar lookback (0.70R vs 0.60R, held out
  // of sample) and 1.0xATR clustering (PF 2.88 vs 2.68, +155.7R vs +141.4R,
  // RR 1:1.82, higher win rate). Every other symbol tested preferred the legacy
  // fixed 0.5%%, so this is a specific finding about GLD, NOT a general law —
  // portfolio-wide the adaptive versions LOST (+463.8R vs +491.2R legacy).
  // ZONE_CLUSTER_ATR_BY_SYMBOL overrides; ZONE_CLUSTER_ATR_MULT forces globally.
  const SYMBOL_CLUSTER_ATR = (() => {
    const m = { GLD: 1.0 };
    try {
      for (const part of String(process.env.ZONE_CLUSTER_ATR_BY_SYMBOL || '').split(',')) {
        const [sym, v] = part.split(':');
        const f = parseFloat(v);
        if (sym && Number.isFinite(f)) m[sym.trim().toUpperCase()] = f;
      }
    } catch (_e) { /* malformed override -> defaults */ }
    return m;
  })();
  const _symMult = SYMBOL_CLUSTER_ATR[String(ticker || '').toUpperCase()];
  const _clusterMult = Number(opts.clusterAtrMult ?? process.env.ZONE_CLUSTER_ATR_MULT ?? _symMult ?? 0);
  let _clusterTol = 0.005;
  if (_clusterMult > 0 && Array.isArray(bars) && bars.length >= 15 && price > 0) {
    const _rec = bars.slice(-15);
    let _sum = 0, _cnt = 0;
    for (let k = 1; k < _rec.length; k++) {
      const h = Number(_rec[k].high), l = Number(_rec[k].low), pc = Number(_rec[k - 1].close);
      if (!(h > 0) || !(l > 0) || !(pc > 0)) continue;
      _sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); _cnt++;
    }
    if (_cnt) {
      const _atrPct = (_sum / _cnt) / price;          // fractional ATR
      _clusterTol = Math.min(0.02, Math.max(0.0015, _atrPct * _clusterMult));
    }
  }

  try {
    if (!Array.isArray(bars) || bars.length < 20) return neutralResult("insufficient bars");
    if (!price || price <= 0) return neutralResult("invalid price");

    const highs = bars.map((b) => num(b && b.high));
    const lows = bars.map((b) => num(b && b.low));
    const closes = bars.map((b) => num(b && b.close));
    const opens = bars.map((b) => num(b && b.open));
    const times = bars.map((b) => (b && b.timestamp != null ? b.timestamp : null));

    // ── Split bars into recency tiers (by bar-timestamp day) ─────────────────
    const keys = times.map((t) => dayKey(t));
    // "today" = the most recent day present in the bars (robust to which day it
    // actually is — matches the Python intent of "today's" intraday levels).
    let todayKey = null;
    for (let i = keys.length - 1; i >= 0; i--) { if (keys[i]) { todayKey = keys[i]; break; } }
    if (!todayKey) todayKey = dayKey(new Date());

    const todayIdxs = [];
    const recentIdxs = [];
    const olderIdxs = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] || todayKey;
      const gap = dayDiff(todayKey, k); // 0 = today, positive = older
      if (gap === 0) todayIdxs.push(i);
      else if (gap >= 0 && gap <= 2) recentIdxs.push(i);
      else olderIdxs.push(i);
    }

    // ── Key levels from today ────────────────────────────────────────────────
    const todayZones = [];
    if (todayIdxs.length) {
      const dayOpen = opens[todayIdxs[0]];
      const dayHigh = maxOf(todayIdxs.map((i) => highs[i]));
      const dayLow = minOf(todayIdxs.map((i) => lows[i]));
      todayZones.push({ type: "TODAY_OPEN", price: dayOpen, strength: 75, recency: "today" });
      if (Math.abs(dayHigh - price) / price > 0.002) {
        todayZones.push({ type: "TODAY_HIGH", price: dayHigh, strength: 70, recency: "today" });
      }
      if (Math.abs(dayLow - price) / price > 0.002) {
        todayZones.push({ type: "TODAY_LOW", price: dayLow, strength: 70, recency: "today" });
      }
    }
    // (Pre-market extended-hours high/low levels — fidelity note #2 — omitted:
    //  the Python fetched a separate extended-hours bar set from Alpaca.)

    // ── Weekly levels (last 5 days present in the supplied bars) ─────────────
    const weeklyZones = [];
    const weekIdxs = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] || todayKey;
      if (dayDiff(todayKey, k) <= 5) weekIdxs.push(i);
    }
    if (weekIdxs.length) {
      const wh = weekIdxs.map((i) => highs[i]).filter((v) => Number.isFinite(v));
      const wl = weekIdxs.map((i) => lows[i]).filter((v) => Number.isFinite(v));
      if (wh.length && wl.length) {
        const weekHigh = maxOf(wh);
        const weekLow = minOf(wl);
        const weekOpen = weekIdxs[0] < opens.length ? opens[weekIdxs[0]] : weekHigh;
        weeklyZones.push(
          { type: "WEEK_HIGH", price: weekHigh, strength: 75, recency: "weekly" },
          { type: "WEEK_LOW", price: weekLow, strength: 75, recency: "weekly" },
          { type: "WEEK_OPEN", price: weekOpen, strength: 70, recency: "weekly" },
        );
      }
    }

    // ── Swing high/low detection (recency-weighted lookbacks) ────────────────
    function findSwings(idxs, lookback) {
      const sHighs = [];
      const sLows = [];
      const nIdx = idxs.length;
      if (nIdx < lookback * 2 + 1) return [sHighs, sLows];
      for (let pos = 0; pos < nIdx; pos++) {
        if (pos < lookback || pos >= nIdx - lookback) continue;
        const i = idxs[pos];
        const windowH = [];
        const windowL = [];
        for (let k = -lookback; k <= lookback; k++) {
          windowH.push(highs[idxs[pos + k]]);
          windowL.push(lows[idxs[pos + k]]);
        }
        const whMax = maxOf(windowH);
        const wlMin = minOf(windowL);
        if (highs[i] === whMax) {
          sHighs.push({ price: highs[i], body: Math.max(opens[i], closes[i]), idx: i });
        }
        if (lows[i] === wlMin) {
          sLows.push({ price: lows[i], body: Math.min(opens[i], closes[i]), idx: i });
        }
      }
      return [sHighs, sLows];
    }

    const [todaySh, todaySl] = findSwings(todayIdxs, 2);
    const [recentSh, recentSl] = findSwings(recentIdxs, 3);
    const [olderSh, olderSl] = findSwings(olderIdxs, 4);

    function recencyStrength(base, recency) {
      if (recency === "today") return Math.min(100, base * 1.4);
      if (recency === "recent") return Math.min(100, base * 1.2);
      return base; // "older" and anything else
    }

    // ── Cluster zones (within 0.5% = same zone) ──────────────────────────────
    // Top boundary = extreme of WICKS; bottom boundary = MEAT of candle bodies.
    function clusterToZones(swingPts, zoneType, recency, baseStrength) {
      if (!swingPts || !swingPts.length) return [];
      const sorted = swingPts.slice().sort((a, b) => a.price - b.price);

      const clusters = [];
      let current = [sorted[0]];
      for (let n = 1; n < sorted.length; n++) {
        const pt = sorted[n];
        const ref = current[0].price;
        if (ref <= 0) { clusters.push(current); current = [pt]; continue; }
        if (Math.abs(pt.price - ref) / ref < _clusterTol) current.push(pt);
        else { clusters.push(current); current = [pt]; }
      }
      clusters.push(current);

      const zones = [];
      for (const cluster of clusters) {
        if (!cluster.length) continue;
        const touches = cluster.length;
        const wickExtreme = cluster.reduce((s, p) => s + p.price, 0) / touches;
        const bodyMeat = cluster.reduce((s, p) => s + p.body, 0) / touches;

        let strongMove = false;
        const lastIdx = cluster.reduce((m, p) => (p.idx > m ? p.idx : m), -Infinity);
        if (lastIdx >= 0 && lastIdx < closes.length - 3 && closes[lastIdx] !== 0) {
          const move = Math.abs(closes[lastIdx + 2] - closes[lastIdx]) / closes[lastIdx] * 100;
          strongMove = move > 0.25;
        }

        const strength = recencyStrength(
          Math.min(100, touches * 25 + (strongMove ? 20 : 0) + baseStrength),
          recency
        );

        let top;
        let bot;
        if (zoneType === "RESISTANCE") { top = wickExtreme; bot = bodyMeat; }
        else { top = bodyMeat; bot = wickExtreme; }
        const hi = Math.max(top, bot);
        const lo = Math.min(top, bot);
        if (hi <= 0 || lo <= 0) continue;

        zones.push({
          type: zoneType,
          top: round(hi, 4), bottom: round(lo, 4), mid: round((hi + lo) / 2, 4),
          touches, strong_move: strongMove,
          strength: Math.round(strength), recency,
        });
      }
      return zones;
    }

    let zones = [];

    // Caller-supplied premarket-priority zones (Python read `_premarket_zones`;
    // here the caller may pass them, else none — fidelity note #2).
    const premarketZones = Array.isArray(opts.premarketZones) ? opts.premarketZones : [];
    for (const z of premarketZones) zones.push(z);

    zones = zones.concat(
      clusterToZones(todaySh, "RESISTANCE", "today", 50),
      clusterToZones(todaySl, "SUPPORT", "today", 50),
      clusterToZones(recentSh, "RESISTANCE", "recent", 40),
      clusterToZones(recentSl, "SUPPORT", "recent", 40),
      clusterToZones(olderSh, "RESISTANCE", "older", 30),
      clusterToZones(olderSl, "SUPPORT", "older", 30),
    );

    // Add today/weekly key levels as thin zones.
    for (const lvl of todayZones.concat(weeklyZones)) {
      const p = lvl.price;
      let zoneTypeKey;
      if (lvl.type.indexOf("HIGH") !== -1) zoneTypeKey = "RESISTANCE";
      else if (lvl.type.indexOf("LOW") !== -1) zoneTypeKey = "SUPPORT";
      else zoneTypeKey = p > price ? "RESISTANCE" : "SUPPORT";
      zones.push({
        type: zoneTypeKey,
        top: round(p * 1.001, 4), bottom: round(p * 0.999, 4), mid: round(p, 4),
        touches: 2, strong_move: false, strength: lvl.strength, recency: lvl.recency,
      });
    }

    // ── Psychological round levels ($50 grid within 4% of price) ─────────────
    const base = Math.round(price / 50) * 50;
    for (let mult = -8; mult <= 8; mult++) {
      const lvl = base + mult * 50;
      const rel = Math.abs(lvl - price) / price;
      if (rel > 0 && rel < 0.04) {
        zones.push({
          type: "PSYCHOLOGICAL",
          top: round(lvl * 1.001, 4), bottom: round(lvl * 0.999, 4), mid: round(lvl, 4),
          touches: 1, strong_move: false, strength: 40, recency: "structural",
        });
      }
    }

    // ── Approach health (parabolic / accelerating = high-prob reversal) ──────
    let unhealthyApproach = false;
    let approachDesc = "";
    if (closes.length >= 10) {
      const n = closes.length;
      const recentMoves = [];
      for (let i = n - 5; i < n; i++) recentMoves.push(Math.abs(closes[i] - closes[i - 1]));
      const priorMoves = [];
      for (let i = n - 10; i < n - 5; i++) priorMoves.push(Math.abs(closes[i] - closes[i - 1]));
      const avgRecent = recentMoves.reduce((s, v) => s + v, 0) / recentMoves.length;
      const avgPrior = priorMoves.reduce((s, v) => s + v, 0) / priorMoves.length;
      if (avgPrior > 0 && avgRecent > avgPrior * 2.0) {
        unhealthyApproach = true;
        approachDesc = `parabolic (${(avgRecent / avgPrior).toFixed(1)}x faster than prior)`;
      } else {
        const allDown = closes[n - 1] < closes[n - 2] && closes[n - 2] < closes[n - 3];
        const allUp = closes[n - 1] > closes[n - 2] && closes[n - 2] > closes[n - 3];
        if (allDown || allUp) {
          const bodies = [];
          for (let i = n - 3; i < n; i++) bodies.push(Math.abs(closes[i] - opens[i]));
          if (bodies[bodies.length - 1] > bodies[0] * 1.5) {
            unhealthyApproach = true;
            approachDesc = "accelerating stair-step (unhealthy)";
          }
        }
      }
    }

    // ── Find current zone ────────────────────────────────────────────────────
    let inZone = false;
    let zoneType = "NONE";
    let zoneStrength = 0;
    let nearestZone = null;
    let minDist = Infinity;

    const priorityZones = zones.filter((z) => z.recency === "premarket_priority");
    const searchOrder = priorityZones.length ? priorityZones : zones;
    for (const z of searchOrder) {
      const dist = Math.abs(price - z.mid) / price * 100;
      if (price >= z.bottom && price <= z.top) {
        inZone = true; zoneType = z.type; zoneStrength = z.strength; nearestZone = z;
        break;
      }
      if (dist < minDist) { minDist = dist; nearestZone = z; }
    }
    if (priorityZones.length && !inZone) {
      for (const z of zones) {
        if (z.recency === "premarket_priority") continue;
        if (price >= z.bottom && price <= z.top) {
          inZone = true; zoneType = z.type; zoneStrength = z.strength; nearestZone = z;
          break;
        }
      }
    }

    // Keep quality zones only — 2+ touches OR today/weekly/premarket/psych.
    let goodZones = zones.filter((z) =>
      z.touches >= 2
      || z.recency === "today" || z.recency === "weekly" || z.recency === "premarket_priority"
      || z.type === "PSYCHOLOGICAL"
    );
    goodZones.sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price));

    // ── Classify EXTREME vs MINOR ────────────────────────────────────────────
    for (const z of goodZones) {
      const touches = num(z.touches);
      const recency = z.recency || "older";
      const strength = num(z.strength);
      const isExtreme = (
        (z.type || "").indexOf("HIGH") !== -1 ||
        (z.type || "").indexOf("LOW") !== -1 ||
        recency === "today" || recency === "weekly" || recency === "premarket_priority" ||
        touches >= 3 ||
        strength >= 70
      );
      z.tier = isExtreme ? "EXTREME" : "MINOR";
    }

    // Sort: premarket-priority first, then extremes, then by distance.
    goodZones.sort((a, b) => {
      const ra = a.recency === "premarket_priority" ? 0 : (a.tier === "EXTREME" ? 1 : 2);
      const rb = b.recency === "premarket_priority" ? 0 : (b.tier === "EXTREME" ? 1 : 2);
      if (ra !== rb) return ra - rb;
      return Math.abs(a.mid - price) - Math.abs(b.mid - price);
    });

    // Break-and-retest — runs once per fresh 15-min candle.
    const brokenRetest = updateBrokenZonesAndRetests(ticker, price, goodZones, times, closes);

    const safeDist = minDist < 1e9 ? round(minDist, 3) : 99;

    // ── Derive the flat interface fields from the zone set ───────────────────
    goodZones = goodZones.slice(0, 12);

    // Nearest SUPPORT below / RESISTANCE above (for the support/resistance pair).
    let support = null;
    let resistance = null;
    let supDist = Infinity;
    let resDist = Infinity;
    for (const z of goodZones) {
      if (z.type === "SUPPORT" && z.mid <= price) {
        const d = price - z.mid;
        if (d < supDist) { supDist = d; support = z.mid; }
      } else if (z.type === "RESISTANCE" && z.mid >= price) {
        const d = z.mid - price;
        if (d < resDist) { resDist = d; resistance = z.mid; }
      }
    }
    // Fallback: if none strictly on the right side, take nearest of each type.
    if (support === null) {
      const s = goodZones.filter((z) => z.type === "SUPPORT")
        .sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price))[0];
      if (s) support = s.mid;
    }
    if (resistance === null) {
      const r = goodZones.filter((z) => z.type === "RESISTANCE")
        .sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price))[0];
      if (r) resistance = r.mid;
    }

    // Trend: consecutive higher-highs+higher-lows / lower-highs+lower-lows on the
    // last 4 fifteen-min bars (matches _riley_detect_stair_step_trend intent).
    let trend = "NEUTRAL";
    if (highs.length >= 4) {
      const n = highs.length;
      const up = highs[n - 1] > highs[n - 2] && highs[n - 2] > highs[n - 3]
        && lows[n - 1] > lows[n - 2] && lows[n - 2] > lows[n - 3];
      const down = highs[n - 1] < highs[n - 2] && highs[n - 2] < highs[n - 3]
        && lows[n - 1] < lows[n - 2] && lows[n - 2] < lows[n - 3];
      trend = up ? "UP" : down ? "DOWN" : "NEUTRAL";
    }

    // Volatility: recent 15-bar avg true-ish range vs price (LOW/NORMAL/HIGH).
    let volatility = "NORMAL";
    {
      const w = Math.min(15, bars.length);
      let sumRange = 0;
      for (let i = bars.length - w; i < bars.length; i++) sumRange += (highs[i] - lows[i]);
      const avgRangePct = (sumRange / w) / price * 100;
      if (avgRangePct < 0.3) volatility = "LOW";
      else if (avgRangePct > 1.2) volatility = "HIGH";
    }

    const outType = inZone
      ? (zoneType === "SUPPORT" || zoneType === "RESISTANCE" ? zoneType : "NEUTRAL")
      : (nearestZone && (nearestZone.type === "SUPPORT" || nearestZone.type === "RESISTANCE")
        ? nearestZone.type : "NEUTRAL");

    const note = goodZones.length
      ? `${goodZones.length} zones | in_zone:${inZone} (${zoneType}) | `
        + (nearestZone
          ? `nearest ${nearestZone.mid} (${nearestZone.type} ${nearestZone.recency || ""} `
            + `tier=${nearestZone.tier || "?"}) strength ${nearestZone.strength} dist ${safeDist}%`
          : "no zones")
      : "no quality zones found";

    return {
      // ── required flat interface ──
      support, resistance,
      mid: nearestZone ? nearestZone.mid : null,
      type: outType,
      strength: nearestZone ? num(nearestZone.strength) : 0,
      touches: nearestZone ? num(nearestZone.touches) : 0,
      zones: goodZones.map((z) => ({
        level: z.mid, top: z.top, bottom: z.bottom, type: z.type,
        strength: z.strength, touches: z.touches,
      })),
      broken_retest: brokenRetest,
      trend, volatility, note,
      // ── extras (parity with the Python return contract) ──
      in_zone: inZone, zone_type: zoneType, zone_strength: zoneStrength,
      nearest_zone: nearestZone, dist_to_nearest: safeDist,
      unhealthy_approach: unhealthyApproach, approach_desc: approachDesc,
    };
  } catch (e) {
    return neutralResult("error: " + (e && e.message ? e.message : String(e)));
  }
}

module.exports = { findSrZones, _brokenZones, _brokenZonesLastBar, _watchMode };

/*
 * FIDELITY NOTES
 * --------------
 * 1. Recency tiering by day.  The Python bucketed bars by their America/New_York
 *    *calendar* date (pytz), and defined "today" as the wall-clock ET date.
 *    Yahoo 15-min bars carry ISO-UTC timestamps and the caller has no ET tz here,
 *    so we bucket by the bar timestamp's UTC day and treat the most-recent day
 *    PRESENT in the bars as "today". For RTH US-equity bars this matches the
 *    Python for all but the ~4 UTC-evening hours where the UTC day has already
 *    rolled; the tier weighting still holds because it keys off the newest day in
 *    the data, not the machine clock.
 * 2. Two Alpaca-only fetch paths are intentionally dropped (this module is pure
 *    over the supplied bars): (a) the separate extended-hours pre-market
 *    high/low fetch inside the today-zones block, and (b) the `_premarket_zones`
 *    global injection + its `premarket_priority` recency. Both were populated by
 *    out-of-band Alpaca calls that don't exist on the Yahoo path. A caller CAN
 *    still supply premarket-priority zones via opts.premarketZones (recency
 *    "premarket_priority") and the priority-search / sort logic honours them
 *    exactly as the Python did.
 * 3. Logging (log_agent / log.warning) is dropped — replaced by the returned
 *    `note` string. The `_watch_mode` hand-off is preserved as a module Map with
 *    identical arming semantics (WATCH_MODE_MAX_TICKERS = 2, side/level/retest).
 * 4. Clustering tolerance (<0.5%), min-touches, strength formula
 *    (touches*25 + strongMove*20 + baseStrength, capped 100), recency multipliers
 *    (today 1.4 / recent 1.2 / older 1.0), swing lookbacks (2/3/4), the zone
 *    top=wick/bottom=body (RESISTANCE) vs top=body/bottom=wick (SUPPORT) band
 *    math, psychological $50 grid, and the parabolic/stair-step approach test are
 *    all preserved verbatim.
 * 5. `trend` and `volatility` are new derived summary fields required by the JS
 *    interface (the Python find_sr_zones returned neither directly). `trend`
 *    reuses the stair-step definition from _riley_detect_stair_step_trend;
 *    `volatility` is a simple avg-range/price bucketing.
 */

// ── self-test ────────────────────────────────────────────────────────────────
if (require.main === module) {
  // Synthesize ~120 fifteen-min bars bouncing between support ~98 and
  // resistance ~102, oldest→newest, with plausible ISO timestamps.
  const bars = [];
  const start = Date.UTC(2026, 6, 1, 13, 30, 0); // 09:30 ET-ish
  const SUP = 98;
  const RES = 102;
  for (let i = 0; i < 120; i++) {
    // Oscillate close between support and resistance.
    const phase = (i % 20) / 20; // 0..1 saw
    const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2; // 0..1..0 triangle
    const close = SUP + (RES - SUP) * tri;
    const open = SUP + (RES - SUP) * (((i - 1 + 120) % 20) / 20 < 0.5
      ? (((i - 1 + 120) % 20) / 20) * 2 : (1 - ((i - 1 + 120) % 20) / 20) * 2);
    // Wicks poke slightly past the bands near the turns so swings land on 98/102.
    const high = Math.max(open, close) + (tri > 0.9 ? 0.4 : 0.15);
    const low = Math.min(open, close) - (tri < 0.1 ? 0.4 : 0.15);
    bars.push({
      timestamp: new Date(start + i * 15 * 60 * 1000).toISOString(),
      open: round(open, 4), high: round(high, 4), low: round(low, 4),
      close: round(close, 4), volume: 10000 + i,
    });
  }

  const res = findSrZones("TEST", 100, bars);
  console.log("note:", res.note);
  console.log("type:", res.type, "| trend:", res.trend, "| volatility:", res.volatility);
  console.log("support:", res.support, "| resistance:", res.resistance, "| mid:", res.mid);
  console.log("broken_retest:", JSON.stringify(res.broken_retest));
  console.log("zones (" + res.zones.length + "):");
  for (const z of res.zones) {
    console.log(
      `  ${z.type.padEnd(11)} level=${String(z.level).padStart(8)} `
      + `[${z.bottom} .. ${z.top}] touches=${z.touches} strength=${z.strength}`
    );
  }

  // Assertions: a support near 98 and a resistance near 102 must be present.
  const sup = res.zones.filter((z) => z.type === "SUPPORT")
    .sort((a, b) => Math.abs(a.level - 98) - Math.abs(b.level - 98))[0];
  const resz = res.zones.filter((z) => z.type === "RESISTANCE")
    .sort((a, b) => Math.abs(a.level - 102) - Math.abs(b.level - 102))[0];
  const okSup = sup && Math.abs(sup.level - 98) <= 1.0;
  const okRes = resz && Math.abs(resz.level - 102) <= 1.0;
  console.log("\nSELF-TEST:");
  console.log("  support near 98 :", okSup ? "PASS" : "FAIL", sup ? `(${sup.level})` : "(none)");
  console.log("  resistance near 102:", okRes ? "PASS" : "FAIL", resz ? `(${resz.level})` : "(none)");
  if (!okSup || !okRes) {
    console.error("SELF-TEST FAILED");
    process.exit(1);
  }
  console.log("  ALL PASS");
}
