// convergence-ev.js — Σ₀ expected-value decision layer over Riley's signals.
//
// Node port of src/trading_agents/convergence_ev.py (dependency-free). Riley's
// WAIT/GOOD/PERFECT tiers and "extreme-zones-only" gates exist to manage HUMAN
// error — they keep a discretionary trader from overtrading and from acting on
// partial confirmation. Keystone doesn't need that crutch: it weighs every piece
// of evidence at once and acts on EXPECTED VALUE.
//
// This turns a candidate trade into a Convergence Record (one of the four core
// objects): hypothesis + evidence + confidence + result. Riley's detectors (zone,
// 1-min structure shift, candle pattern, trend) stay — but as WEIGHTED EVIDENCE,
// not pass/fail gates. The decision is:
//
//     p_win   = base_rate + Σ wᵢ·(signalᵢ − 0.5)        // transparent linear model
//     EV (R)  = p_win·target_R − (1 − p_win)·1R          // risk one R to make target_R
//     ENTER   iff EV ≥ EV_MIN and p_win ≥ P_MIN          // no discretionary tiers
//
// Every record carries `why` (the evidence that moved it) so the call is auditable
// — the External-Reality Rule: [claim, evidence, confidence, source]. Pure +
// dependency-free so it unit-tests without Alpaca or the rest of the engine.

// Evidence weights. Each signal is normalised to [0,1] where 0.5 = neutral; the
// weight is how many probability-points a fully-confirming signal (1.0) adds.
// Tunable via the engine; they need not sum to 1 (p_win is clamped).
const WEIGHTS = {
  grok: 0.09, // Grok analyst directional conviction (council member)
  claude: 0.09, // Claude decision conviction (council member, was a gate)
  zone: 0.14, // at a real S/R zone, scaled by strength/touches
  structure: 0.16, // 1-min structure shift confirmed (the key Riley trigger)
  pattern: 0.12, // A/B/C candle pattern grade
  trend: 0.1, // higher-tf trend agrees with the trade direction
  news: 0.1, // ticker news sentiment agrees with direction
  volume: 0.07, // volume spike confirms the move (Tier-1)
  momentum: 0.1, // MACD histogram + price-vs-MA agree with direction (Tier-1)
  earnings: 0.11, // last reported EPS surprise vs consensus agrees with direction (Tier-2)
  sector: 0.08, // ticker's sector ETF trend agrees with direction (Tier-2)
  backtest: 0.0, // folded into base_rate instead (see below)
};

const EV_MIN = 0.15; // require ≥ +0.15R edge after costs to act
const P_MIN = 0.45; // and at least a 45% hit-rate, so a huge target can't carry junk
const P_CLAMP = [0.05, 0.95];

function _clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// round-half-away-from-zero to n decimals, matching Python's round() closely
// enough for these magnitudes (values here are well away from .5 tie edges).
function _round(x, n) {
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

// Coerce to finite number or return null (mirrors Python float() raising, which
// callers catch as the neutral/skip path).
function _num(x) {
  if (x === null || x === undefined || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

const EDGE_SENS = 5.0; // conviction sensitivity: full ±0.5× swing over p_win 0.40↔0.60

// Edge-proportional risk sizing — a bounded, risk-NEUTRAL conviction scaler on the
// flat-$ risk. Lean in on high-conviction setups, lean out on marginal ones — but
// centred on 1.0 so it does not net-inflate risk. Sizing is driven by the calibrated
// hit-rate p_win (target_r already governs the ENTER/SKIP decision in the EV gate):
//
//     mult = clamp(1.0 + EDGE_SENS · (p_win − 0.5), 0.5, 1.5)
//
// So p_win 0.50 → 1.0× (neutral), 0.60 → 1.5× (cap), 0.40 → 0.5× (floor). Pure
// (no I/O). Returns 1.0 on bad inputs; `targetR` is a validity guard only
// (≤0 or non-numeric → neutral 1.0).
function edgeRiskMultiplier(pWin, targetR = null) {
  const p = _num(pWin);
  if (p === null) return 1.0;
  if (targetR !== null && targetR !== undefined) {
    const tr = _num(targetR);
    if (tr === null || tr <= 0) return 1.0;
  }
  if (!(p > 0.0 && p < 1.0)) return 1.0;
  const mult = 1.0 + EDGE_SENS * (p - 0.5);
  return _clamp(_round(mult, 3), 0.5, 1.5);
}

function _gradeToSignal(grade) {
  const key = String(grade == null ? "" : grade).toUpperCase();
  return { A: 1.0, B: 0.75, C: 0.6 }[key] ?? 0.5;
}

// ── Closed learning loop: adapt WEIGHTS from realized per-signal edge ───────────
// The council (sigma0-trader-council.js) already measures, for each signal, the
// win-rate when it fired "strong" (>0.55) vs "weak" — lift = strong − weak. A
// positive lift means the signal genuinely predicted wins and deserves more weight;
// ~0/negative means noise. These pure functions turn that lift into a BOUNDED
// re-weighting so the engine can close the loop on its own outcomes — never trusted
// until the sample is mature, never moved more than ±50%.

const ADAPT_MIN_ROWS = 20; // need this many graded rows before adapting at all
const ADAPT_MIN_BUCKET = 5; // and this many in BOTH strong/weak buckets per signal
const ADAPT_GAIN = 2.0; // weight × (1 + GAIN·lift), so lift ±0.25 → ×1.5 / ×0.5
const ADAPT_BOUND = [0.5, 1.5];

// Realized per-signal edge from graded convergence rows (pure).
// Each row: {signals: {name: 0..1, ...}, outcome: bool | passed: bool, ...}.
// A signal counts "strong" when its value > 0.55. Returns
// {name: {strong_n, strong_wr, weak_n, weak_wr, lift}}; lift is null until both
// buckets have ≥1 sample.
function perSignalLift(rows) {
  const acc = {};
  for (const r0 of rows || []) {
    const r = r0 || {};
    const sig = r.signals;
    if (!sig || typeof sig !== "object" || Array.isArray(sig)) continue;
    const win = r.outcome || r.passed ? 1 : 0;
    for (const [k, v] of Object.entries(sig)) {
      const a = (acc[k] = acc[k] || { sN: 0, sW: 0, wN: 0, wW: 0 });
      const nv = _num(v);
      if (nv === null) continue;
      const strong = nv > 0.55;
      if (strong) {
        a.sN += 1;
        a.sW += win;
      } else {
        a.wN += 1;
        a.wW += win;
      }
    }
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) {
    const sw = a.sN ? a.sW / a.sN : null;
    const ww = a.wN ? a.wW / a.wN : null;
    out[k] = {
      strong_n: a.sN,
      strong_wr: sw,
      weak_n: a.wN,
      weak_wr: ww,
      lift: sw !== null && ww !== null ? sw - ww : null,
    };
  }
  return out;
}

// Return WEIGHTS re-scaled by realized per-signal lift (pure).
// Conservative: returns `base` UNCHANGED unless there are ≥minRows graded rows
// carrying a signals vector; and per signal, only adjusts when BOTH strong/weak
// buckets have ≥minBucket samples (else that weight is left at base). Each weight
// moves by clamp(1 + gain·lift, ...bound) — capped at ±50% so one noisy streak
// can't hand a signal the whole book.
function adaptWeights(
  rows,
  base = null,
  minRows = ADAPT_MIN_ROWS,
  minBucket = ADAPT_MIN_BUCKET,
  gain = ADAPT_GAIN,
  bound = ADAPT_BOUND,
) {
  const b = Object.assign({}, base || WEIGHTS);
  const graded = (rows || []).filter((r0) => {
    const s = (r0 || {}).signals;
    return s && typeof s === "object" && !Array.isArray(s);
  });
  if (graded.length < minRows) return b;
  const edge = perSignalLift(graded);
  const out = Object.assign({}, b);
  for (const [k, w] of Object.entries(b)) {
    const e = edge[k];
    if (!e || e.lift === null) continue;
    if (e.strong_n < minBucket || e.weak_n < minBucket) continue;
    const factor = _clamp(1.0 + gain * e.lift, bound[0], bound[1]);
    out[k] = _round(w * factor, 4);
  }
  return out;
}

// Score one candidate trade. `ev` (all optional, neutral defaults):
//   direction:         "BULLISH" | "BEARISH"
//   grok_conf:         0..100   Grok analyst directional confidence
//   claude_conf:       0..100   Claude decision conviction (neutral 50 pre-Claude)
//   llm_conf:          0..100   DEPRECATED alias → grok_conf (back-compat)
//   in_zone:           bool
//   zone_strength:     0..100
//   zone_touches:      int
//   structure_shifted: bool
//   structure_conf:    0..100
//   pattern_grade:     "A"|"B"|"C"|null
//   trend_aligned:     bool     higher-tf trend matches direction
//   trend_conflicts:   bool     higher-tf trend OPPOSES direction (counter-trend)
//   news_sentiment:    -1..1    +ve = bullish news (signed to direction below)
//   backtest_winrate:  0..1     historical hit-rate of this setup (base rate)
//   target_r:          float    reward/risk multiple (tp% / |stop%|)
//
// Returns: {p_win, ev_r, target_r, decision: "ENTER"|"SKIP", signals, why, record}
function scoreConvergence(ev, weights = null) {
  ev = ev || {};
  const direction = String(ev.direction == null ? "NEUTRAL" : ev.direction).toUpperCase();
  const target_r = _num(ev.target_r) || 2.0;

  // ── Normalise each piece of evidence to [0,1] (0.5 = neutral) ──────────────
  // Grok and Claude are now SEPARATE council members, each graded on realized
  // edge. `llm_conf` stays a back-compat alias for grok_conf; claude defaults to
  // neutral (50) so the cheap pre-Claude screen runs Grok-only without penalty.
  const grokRaw = ev.grok_conf !== undefined ? ev.grok_conf : ev.llm_conf !== undefined ? ev.llm_conf : 50;
  const grok = _clamp((_num(grokRaw) ?? 50) / 100.0, 0.0, 1.0);
  const claude = _clamp((_num(ev.claude_conf !== undefined ? ev.claude_conf : 50) ?? 50) / 100.0, 0.0, 1.0);

  let zone;
  if (ev.in_zone) {
    const strength = _clamp((_num(ev.zone_strength ?? 50) ?? 50) / 100.0, 0.0, 1.0);
    const touches = Math.trunc(_num(ev.zone_touches ?? 0) ?? 0);
    const touchBonus = Math.min(0.15, 0.05 * Math.max(0, touches - 1));
    zone = _clamp(0.5 + 0.5 * strength + touchBonus, 0.0, 1.0);
  } else {
    zone = 0.4; // not at a level — mild negative, not disqualifying
  }

  let structure;
  if (ev.structure_shifted) {
    structure = _clamp(0.6 + 0.4 * ((_num(ev.structure_conf ?? 60) ?? 60) / 100.0), 0.0, 1.0);
  } else {
    structure = 0.45;
  }

  const pattern = _gradeToSignal(ev.pattern_grade);

  let trend;
  if (ev.trend_conflicts) {
    trend = 0.2; // fighting the higher-tf trend
  } else if (ev.trend_aligned) {
    trend = 0.85;
  } else {
    trend = 0.5;
  }

  // News sentiment is signed to the trade direction: bullish news helps a long,
  // hurts a short. Magnitude in [0,1] from |sentiment|.
  const raw_news = _clamp(_num(ev.news_sentiment ?? 0.0) ?? 0.0, -1.0, 1.0);
  const signed = direction === "BULLISH" ? raw_news : direction === "BEARISH" ? -raw_news : 0.0;
  const news = _clamp(0.5 + 0.5 * signed, 0.0, 1.0);

  // Volume confirmation (framework Step 4): a spike behind the move is conviction,
  // thin volume is weak. Non-directional — it strengthens or softens the setup.
  const vr = _num(ev.volume_ratio);
  const volume = vr == null ? 0.5 : _clamp(0.5 + 0.35 * Math.tanh(vr - 1), 0.15, 0.9);

  // Momentum confirmation (Step 5): MACD histogram + price-vs-MA, each signed to
  // the trade direction. Agreement lifts, disagreement cuts.
  const dirSign = direction === "BULLISH" ? 1 : direction === "BEARISH" ? -1 : 0;
  const agree = (v) => (dirSign === 0 || !v ? 0 : Math.sign(v) === dirSign ? 1 : -1);
  const momentum = _clamp(0.5 + 0.22 * agree(_num(ev.macd_hist)) + 0.16 * agree(_num(ev.ma_signal)), 0.1, 0.9);

  // Earnings surprise (framework Step 3 — the beat/miss vs consensus, "more
  // important than the headline"). Signed % → signal via tanh (±15% saturates).
  const surp = _num(ev.earnings_surprise);
  const surpSigned = surp == null ? 0 : (direction === "BULLISH" ? surp : direction === "BEARISH" ? -surp : 0);
  const earnings = surp == null ? 0.5 : _clamp(0.5 + 0.5 * Math.tanh(surpSigned / 15), 0.05, 0.95);

  // Sector strength (framework Step 5): the ticker's SPDR-sector trend, signed to
  // the trade direction — a long in a leading sector confirms, a lagging one cuts.
  // `sector_trend` is a fraction (e.g. +0.03 = sector +3%); ±4% saturates.
  const sct = _num(ev.sector_trend);
  const sctSigned = sct == null ? 0 : (direction === "BULLISH" ? sct : direction === "BEARISH" ? -sct : 0);
  const sector = sct == null ? 0.5 : _clamp(0.5 + 0.5 * Math.tanh(sctSigned / 0.04), 0.1, 0.9);

  const signals = { grok, claude, zone, structure, pattern, trend, news, volume, momentum, earnings, sector };

  // ── p_win = base_rate + Σ wᵢ·(signalᵢ − 0.5) ──────────────────────────────
  // `weights` lets the caller pass realized-edge-adapted weights (adaptWeights);
  // defaults to the static base so the pure/unit-test path is unchanged.
  const W = weights && typeof weights === "object" && Object.keys(weights).length ? weights : WEIGHTS;
  const base_rate = _clamp(_num(ev.backtest_winrate ?? 0.5) ?? 0.5, 0.2, 0.8);
  let p = base_rate;
  for (const [k, s] of Object.entries(signals)) {
    p += (W[k] || 0.0) * (s - 0.5) * 2.0; // ×2 → a full signal moves ~1·weight
  }
  const p_win = _clamp(p, P_CLAMP[0], P_CLAMP[1]);

  const ev_r = p_win * target_r - (1.0 - p_win) * 1.0;

  // External-Reality Rule: nothing is accepted without evidence. A bare +EV from
  // an optimistic reward:risk is NOT enough — require at least ONE grounding
  // signal (a real level, a structure shift, a pattern, trend agreement, or a
  // meaningful news lean). This replaces Riley's WAIT/PERFECT discipline tiers
  // with a single evidence floor, not a checklist.
  const has_evidence =
    !!ev.in_zone ||
    !!ev.structure_shifted ||
    _gradeToSignal(ev.pattern_grade) > 0.5 ||
    !!ev.trend_aligned ||
    Math.abs(raw_news) >= 0.2;
  const decision = has_evidence && ev_r >= EV_MIN && p_win >= P_MIN ? "ENTER" : "SKIP";

  // ── Evidence string: the signals that pulled the decision, strongest first ──
  const contrib = Object.entries(signals)
    .map(([k, s]) => [k, (W[k] || 0.0) * (s - 0.5)])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const label = {
    grok: "Grok conviction",
    claude: "Claude conviction",
    zone: "zone",
    structure: "1-min structure",
    volume: "volume",
    momentum: "momentum (MACD/MA)",
    earnings: "earnings surprise",
    sector: "sector strength",
    pattern: "pattern",
    trend: "trend",
    news: "news",
  };
  const why = [];
  for (const [k, c] of contrib) {
    if (Math.abs(c) < 0.005) continue;
    why.push((c > 0 ? "+" : "-") + label[k]);
  }

  const record = {
    type: "convergence_record",
    hypothesis: { direction, target_r: _round(target_r, 2) },
    evidence: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, _round(v, 3)])),
    confidence: { p_win: _round(p_win, 4), base_rate: _round(base_rate, 3) },
    ev_r: _round(ev_r, 3),
    decision,
    result: null, // filled on close (Verify/Converge)
    source: "convergence_ev",
  };

  return {
    p_win: _round(p_win, 4),
    ev_r: _round(ev_r, 4),
    target_r: _round(target_r, 3),
    decision,
    signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, _round(v, 3)])),
    why: why.slice(0, 4),
    record,
  };
}

module.exports = {
  WEIGHTS,
  EV_MIN,
  P_MIN,
  P_CLAMP,
  EDGE_SENS,
  ADAPT_MIN_ROWS,
  ADAPT_MIN_BUCKET,
  ADAPT_GAIN,
  ADAPT_BOUND,
  edgeRiskMultiplier,
  perSignalLift,
  adaptWeights,
  scoreConvergence,
};

// ── Self-test (node lib/signal-engine/convergence-ev.js) ────────────────────────
if (require.main === module) {
  const j = (x) => JSON.stringify(x);

  // High-confidence BULLISH setup: strong Grok+Claude, at a well-touched zone,
  // confirmed 1-min structure shift, A-grade pattern, trend-aligned, bullish news.
  const hi = scoreConvergence({
    direction: "BULLISH",
    grok_conf: 85,
    claude_conf: 80,
    in_zone: true,
    zone_strength: 80,
    zone_touches: 3,
    structure_shifted: true,
    structure_conf: 75,
    pattern_grade: "A",
    trend_aligned: true,
    news_sentiment: 0.6,
    backtest_winrate: 0.55,
    target_r: 3.0,
  });
  console.log("HIGH-confidence signal:");
  console.log("  p_win   =", hi.p_win);
  console.log("  ev_r    =", hi.ev_r);
  console.log("  target_r=", hi.target_r);
  console.log("  decision=", hi.decision);
  console.log("  why     =", j(hi.why));
  console.log("  size×    =", edgeRiskMultiplier(hi.p_win, hi.target_r));
  console.log("  signals =", j(hi.signals));

  // Low-confidence setup: neutral council, not at a level, no structure shift,
  // C pattern, counter-trend, faint news — should SKIP.
  const lo = scoreConvergence({
    direction: "BULLISH",
    grok_conf: 50,
    claude_conf: 50,
    in_zone: false,
    structure_shifted: false,
    pattern_grade: "C",
    trend_conflicts: true,
    news_sentiment: 0.05,
    backtest_winrate: 0.5,
    target_r: 2.0,
  });
  console.log("\nLOW-confidence signal:");
  console.log("  p_win   =", lo.p_win);
  console.log("  ev_r    =", lo.ev_r);
  console.log("  target_r=", lo.target_r);
  console.log("  decision=", lo.decision);
  console.log("  why     =", j(lo.why));
  console.log("  size×    =", edgeRiskMultiplier(lo.p_win, lo.target_r));

  // edge_risk_multiplier reference points from the docstring.
  console.log("\nedgeRiskMultiplier reference:");
  console.log("  p_win 0.50 ->", edgeRiskMultiplier(0.5), "(expect 1.0 neutral)");
  console.log("  p_win 0.60 ->", edgeRiskMultiplier(0.6), "(expect 1.5 cap)");
  console.log("  p_win 0.40 ->", edgeRiskMultiplier(0.4), "(expect 0.5 floor)");
  console.log("  bad input  ->", edgeRiskMultiplier("x"), "(expect 1.0)");
  console.log("  target_r<=0->", edgeRiskMultiplier(0.6, 0), "(expect 1.0 guard)");

  // adaptWeights: too few rows -> unchanged base.
  const few = adaptWeights([{ signals: { zone: 0.9 }, outcome: true }]);
  console.log("\nadaptWeights (1 row, <min) returns base zone weight:", few.zone, "(expect", WEIGHTS.zone + ")");
}
