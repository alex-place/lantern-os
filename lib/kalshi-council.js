"use strict";

/**
 * Kalshi arm of the Σ₀ trader council (Converge stage) — the read/grade side for the
 * swipe terminal's paper + replay decks.
 *
 * This is deliberately thin: it REUSES the shared, domain-agnostic pieces rather than
 * forking a second council —
 *   - fee-aware EV / break-even math : ./kalshi-fees
 *   - Brier/ECE/skill + per-signal realized-edge + maturity : ./sigma0-trader-council
 *     (its `council(file)` already takes a path, so a Kalshi-scoped view is one call)
 *
 * The historical training pass (experiments/kalshi_council_train.py) writes
 * data/kalshi/council-outcomes.jsonl + strategy-search-report.json + the replay
 * artefacts; this module serves them and appends new graded outcomes as the user swipes.
 *
 * NOTHING here can place a real order — it only reads history and writes paper outcomes.
 */

const fs = require("fs");
const path = require("path");
const fees = require("./kalshi-fees");
const { council } = require("./sigma0-trader-council");

const KALSHI_DIR = path.resolve(__dirname, "..", "data", "kalshi");
const OUTCOMES = path.join(KALSHI_DIR, "council-outcomes.jsonl");
const REPLAY_OUTCOMES = path.join(KALSHI_DIR, "replay-outcomes.json");
const REPLAY_DECK = path.join(KALSHI_DIR, "replay-deck.json");
const REPORT = path.join(KALSHI_DIR, "strategy-search-report.json");

// Model conviction: pull the market price toward the certified endpoint. Mirrors
// LAMBDA in experiments/kalshi_council_train.py so replay grading is consistent with
// the historical training rows.
const LAMBDA = 0.30;

function pWinModel(priceCents) {
  const p = Math.min(99, Math.max(1, Number(priceCents) || 50)) / 100;
  return Math.max(0.05, Math.min(0.95, p + LAMBDA * (1 - p)));
}

function _readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** Council snapshot over the Kalshi outcomes + the honest after-fee search verdict. */
function snapshot() {
  const c = council(OUTCOMES); // REUSE shared grader (Brier/ECE/skill + per-signal edge)
  const report = _readJson(REPORT, null);
  return {
    ...c,
    verdict: (report && report.verdict) ||
      "no strategy-search report yet — run experiments/kalshi_council_train.py",
    best_config: (report && report.best) || null,
    sweep: (report && report.sweep) || null,
    report_generated_at: (report && report.generated_at) || null,
    live_paused: true, // live trading remains halted regardless of council maturity
    source: "kalshi-backtest + paper/replay",
  };
}

/**
 * Build swipeable replay cards from recorded history with honest fee-aware EV.
 * The real outcome is NOT included — the server grades blind on swipe (replayGrade).
 */
function buildReplayCards(limit = 20, offset = 0) {
  const pool = _readJson(REPLAY_DECK, []);
  const slice = pool.slice(offset, offset + limit);
  return slice.map((m, i) => {
    const favYes = (m.yesPct ?? 50) >= 50;
    const favAsk = favYes ? m.yesAsk : m.noAsk;
    if (favAsk == null) return null;
    const pWin = pWinModel(favAsk);
    const ev = fees.netEvCents(favAsk, pWin);
    return {
      kind: "signal",
      mode: "replay",
      ticker: m.ticker,
      title: m.title,
      favSide: favYes ? "yes" : "no",
      favLabel: favYes ? "YES" : "NO",
      favAsk,
      yesPct: m.yesPct,
      conviction: favYes ? m.yesPct : (100 - (m.yesPct ?? 50)),
      minsToClose: m.minsToClose,
      marketFound: true,
      stateLabel: ev > 0 ? "CONFIDENT" : "DETERMINED",
      reason: `Replay · ${m.title} · honest EV ${ev > 0 ? "+" : ""}${ev}¢ after fee — graded vs the real outcome`,
      sigma0: {
        score: ev, end_state: favYes ? "YES" : "NO", p_win: pWin,
        loss_odds: Math.round((1 - pWin) * 100) / 100, ev_cents: ev,
        reward_cents: 100 - favAsk, confidence: pWin,
        verdict: ev > 0 ? "STRONG" : "SKIP_NEG_EV",
      },
      entryCents: favAsk,
      _replayIdx: offset + i,
    };
  }).filter(Boolean);
}

/** Append a graded ConvergenceRecord to the Kalshi council store. */
function appendOutcome(row) {
  fs.mkdirSync(KALSHI_DIR, { recursive: true });
  fs.appendFileSync(OUTCOMES, JSON.stringify(row) + "\n");
}

/**
 * Grade a swiped replay card against the recorded outcome and append a council row.
 * Verify → Converge: this is what makes the swipe a real loop step.
 */
function gradeReplay({ ticker, side, entryCents }) {
  const outcomes = _readJson(REPLAY_OUTCOMES, {});
  const truth = outcomes[ticker];
  if (!truth) return { error: "unknown replay ticker", ticker };
  const entry = Math.min(99, Math.max(1, Number(entryCents) || 50));
  const sideYes = side === "yes";
  const won = (sideYes && truth.outcome === 1) || (!sideYes && truth.outcome === 0);
  const fee = fees.takerFeeCents(entry);
  const net = (won ? (100 - entry) : -entry) - fee;
  const conf = Math.round(pWinModel(entry) * 1000) / 1000;
  const outcome = won ? 1 : 0;
  const row = {
    record_id: `kalshi-replay-${ticker}-${Date.now()}`,
    ticker, side,
    confidence: conf,
    passed: won,
    outcome,
    brier_score: Math.round((conf - outcome) ** 2 * 10000) / 10000,
    pnl_pct: Math.round((net / entry) * 10000) / 100,
    pnl_cents_after_fee: net,
    signals: { convergence: Math.round(entry) / 100 },
    source: "kalshi-replay",
    conviction_recorded: true,
    graded_at: new Date().toISOString(),
  };
  appendOutcome(row);
  return {
    ok: true, won, net_cents: net, fee_cents: fee,
    outcome: truth.outcome, finalYesMid: truth.finalYesMid, row,
  };
}

// ── grounded picks: Verify→Converge on resolution ──────────────────────────────
// Grade a resolved grounded paper pick into the council. `confidence` is the grounded
// model's probability for the TAKEN side; `won` is whether that side resolved correct.
// Tagged source:"kalshi-grounded" so the council can show whether grounding is
// calibrated and net-positive after fees — the honest profitability measurement.
function gradeGrounded({ ticker, side, entryCents, confidence, won, recordId }) {
  const entry = Math.min(99, Math.max(1, Number(entryCents) || 50));
  const fee = fees.takerFeeCents(entry);
  const net = (won ? (100 - entry) : -entry) - fee;
  const conf = Math.round(Math.max(0, Math.min(1, Number(confidence) || 0.5)) * 1000) / 1000;
  const outcome = won ? 1 : 0;
  const row = {
    record_id: recordId || `kalshi-grounded-${ticker}-${Date.now()}`,
    ticker, side,
    confidence: conf,
    passed: !!won,
    outcome,
    brier_score: Math.round((conf - outcome) ** 2 * 10000) / 10000,
    pnl_pct: Math.round((net / entry) * 10000) / 100,
    pnl_cents_after_fee: net,
    signals: { grounded: conf },
    source: "kalshi-grounded",
    conviction_recorded: true,
    graded_at: new Date().toISOString(),
  };
  appendOutcome(row);
  return { ok: true, won, net_cents: net, row };
}

/**
 * groundedSync — find open grounded paper picks whose market has RESOLVED and grade
 * them into the council, then close the paper position. Forward-running: returns
 * {graded, pending} so it can be polled. Pure of any order placement.
 */
async function groundedSync() {
  const paperLedger = require("./kalshi-paper-ledger");
  const kapi = require("./kalshi-api");
  const open = paperLedger.getOpen().filter((p) => p.source === "kalshi-grounded");
  let graded = 0, pending = 0;
  const already = new Set();
  if (fs.existsSync(OUTCOMES)) {
    for (const l of fs.readFileSync(OUTCOMES, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { already.add(JSON.parse(l).record_id); } catch { /* skip */ }
    }
  }
  for (const p of open) {
    const recordId = `kalshi-grounded-${p.id}`;
    if (already.has(recordId)) continue;
    try {
      const r = await kapi.getMarket(p.ticker);
      const m = r && r.data && r.data.market;
      const result = m && (m.result || "").toLowerCase(); // "yes" | "no" | ""
      if (!result || (result !== "yes" && result !== "no")) { pending++; continue; }
      const yesWon = result === "yes";
      const won = (p.side === "yes" && yesWon) || (p.side === "no" && !yesWon);
      gradeGrounded({ ticker: p.ticker, side: p.side, entryCents: p.limitCents, confidence: p.grounded_confidence, won, recordId });
      paperLedger.closePosition(p.id, { exitTag: "RESOLVED", exitPriceCents: yesWon ? 100 : 0 });
      graded++;
    } catch { pending++; }
  }
  return { graded, pending, openGrounded: open.length };
}

module.exports = {
  snapshot, buildReplayCards, gradeReplay, gradeGrounded, groundedSync, appendOutcome, pWinModel,
  OUTCOMES_PATH: OUTCOMES,
};
