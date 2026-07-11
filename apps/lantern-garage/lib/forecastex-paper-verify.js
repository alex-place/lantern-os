"use strict";

/**
 * ForecastEx UHLGA nightly FORWARD paper-verification (#2217 — step 2 of the "what remains
 * before any UHLGA trade" list in docs/research/2026-07-10-forecastex-uhlga-settlement-and-
 * klga-fit.md §5). Verify-stage extension of the Convergence Core; no orders, no deck.
 *
 * Each night, once the venue's EOD prices file for TODAY exists:
 *   OPEN  — stamp a prediction for TOMORROW (strictly future — a prediction is never
 *           opened for a day whose high may already be realized): today's EOD board →
 *           ladder + asks, tonight's NBS MOS forecast (kalshi-mos, station KLGA), the
 *           KLGA-fitted oracle distribution (NO_CEILING — forecastex-weather), and any
 *           band-robust edge cards net of the flat venue fee. Appended once per contract
 *           date (idempotent by id) to data/kalshi/forecastex-paper.jsonl.
 *   CLOSE — grade every open prediction whose settlement flips have published: venue
 *           settled high (clean flip, or bound-decided buckets), proper scores, and
 *           realized per-card P&L at the stamped day-ahead close.
 *   REPORT— cumulative RPS/PIT/reliability via kalshi-weather-verify (the SAME verifier
 *           that grades the Kalshi ledger, scoped by ticker prefix) + edge P&L, written to
 *           data/kalshi/forecastex-paper-summary.json.
 *
 * CERTIFICATION GATE (External Reality Rule): `certifiedEdge` stays false unless n>=20
 * settled days AND n>=20 settled band-robust cards AND net P&L > 0. This file only
 * REPORTS; flipping forecastex-weather's `certified` flag is a human decision on top of
 * this evidence. A negative result is the expected outcome and is logged as-is.
 *
 * Wiring: opt-in via FORECASTEX_PAPER_VERIFY=1 on the fleet host (server.js market-loops
 * block, PR-watcher precedent — one host, not every dev boot). Also runnable directly:
 *   node apps/lantern-garage/lib/forecastex-paper-verify.js
 */

const fs = require("fs");
const path = require("path");

const board = require("./forecastex-board");
const dayahead = require("./forecastex-dayahead");
const verify = require("./kalshi-weather-verify");
const kalshiMos = require("./kalshi-mos");
const { loadVenueParams, NYC_LGA, makeFlatFee } = require("./forecastex-weather");
const { DEFAULT_FEE_CENTS } = require("./forecastex-fees");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const FILES = {
  ledger: path.join(KALSHI_DIR, "forecastex-paper.jsonl"),
  state: path.join(KALSHI_DIR, "forecastex-paper-state.json"),
  summary: path.join(KALSHI_DIR, "forecastex-paper-summary.json"),
};

const PRODUCT = NYC_LGA.product;           // UHLGA
const RUN_HOUR_LOCAL = 21;                 // ET evening — after the venue's EOD file publishes
const LOOKBACK_DAYS = 3;                   // settle-side catch-up window across missed nights
const MIN_SETTLED_DAYS = verify.MIN_SAMPLES;  // 20 — same bar as the Kalshi distribution verdict
const MIN_SETTLED_CARDS = 20;

// ── date helpers (venue local day, ET; tzOffsetH matches the summer-series registry) ──
const pad = (n) => String(n).padStart(2, "0");
function localParts(now, tzOffsetH = NYC_LGA.tzOffsetH) {
  const d = new Date(now.getTime() + tzOffsetH * 3600 * 1000);
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hour: d.getUTCHours(),
  };
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
const yyyymmdd = (iso) => iso.replace(/-/g, "");
const mmdd = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${m}-${d}`; };
function daysBetween(fromIso, toIso) {
  const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(toIso) - p(fromIso)) / 86400000);
}

// ── ledger I/O ────────────────────────────────────────────────────────────────
function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

// ── cumulative report over the ledger ─────────────────────────────────────────
function buildSummary(rows, { minSettledDays = MIN_SETTLED_DAYS, minSettledCards = MIN_SETTLED_CARDS } = {}) {
  const graded = verify.gradedRecords(rows, { prefix: PRODUCT });
  const dist = verify.buildReport(graded);
  const closes = rows.filter((r) => r && r.event === "close");
  const cards = closes.flatMap((r) => (r.cards || []).filter((c) => c.pnl_c != null));
  // Older ledger rows may predate the `tradeable` flag; fall back to the ask band so the
  // certification gate is degenerate-price-proof regardless of when the row was written.
  const isTradeable = (c) => (c.tradeable != null ? c.tradeable : dayahead.isTradeableAsk(c.ask));
  const tradeable = cards.filter(isTradeable);
  const round1 = (x) => Math.round(x * 10) / 10;
  const netPnlCents = round1(cards.reduce((s, c) => s + c.pnl_c, 0));
  const tradeableNetPnlCents = round1(tradeable.reduce((s, c) => s + c.pnl_c, 0));
  const hits = cards.filter((c) => c.pnl_c > 0).length;
  const tradeableHits = tradeable.filter((c) => c.pnl_c > 0).length;
  const settledDays = closes.length;
  // CERTIFY on the TRADEABLE cards only. Fading a 0.00/1.00 EOD print "wins" on paper but
  // isn't fillable, so a liquidity artifact must never trip certification (#2217 backtest:
  // 92% of raw P&L was such non-fillable prints).
  const certifiedEdge = settledDays >= minSettledDays && tradeable.length >= minSettledCards && tradeableNetPnlCents > 0;
  return {
    updatedAt: new Date().toISOString(),
    product: PRODUCT,
    opens: rows.filter((r) => r && r.event === "open").length,
    settledDays,
    distribution: {
      n: dist.n, active: dist.active, meanRPS: dist.meanRPS,
      climatologyRPS: dist.climatologyRPS, rpsSkill: dist.rpsSkill,
      pitChi2: dist.pit ? dist.pit.chi2_reduced : null, report: dist.report,
    },
    edges: {
      cardsSettled: cards.length, hits,
      hitRate: cards.length ? Math.round((hits / cards.length) * 1000) / 1000 : null,
      netPnlCents,
      // fillable subset — the one certification is allowed to trust
      tradeableCards: tradeable.length, tradeableHits,
      tradeableHitRate: tradeable.length ? Math.round((tradeableHits / tradeable.length) * 1000) / 1000 : null,
      tradeableNetPnlCents,
      nonFillableCards: cards.length - tradeable.length,
    },
    certifiedEdge,
    gate: `certifiedEdge requires >=${minSettledDays} settled days AND >=${minSettledCards} TRADEABLE band-robust cards (ask in (${dayahead.TRADEABLE_ASK_MIN}, ${dayahead.TRADEABLE_ASK_MAX}), i.e. fillable — NOT degenerate 0/1 closes) AND tradeable net P&L > 0; a human flips forecastex-weather certified on top of this evidence`,
  };
}

/**
 * One nightly pass. Everything is injectable for tests; defaults are the live legs.
 * Returns { fileDates, opened, closed, summary, skipped } — `opened` may be empty on a
 * night with no publishable file yet (the hourly scheduler retries until the local day
 * rolls over).
 */
async function runOnce({
  now = new Date(),
  fetchCsv = board.fetchDailyCsv,
  getMos = kalshiMos.getForecastHighs,
  files = FILES,
  lookbackDays = LOOKBACK_DAYS,
  minEdgeCents = 5,
  flatFeeC = DEFAULT_FEE_CENTS,
} = {}) {
  const { iso: today } = localParts(now);
  const skipped = [];

  // 1. Pull the recent daily files (fail-soft; missing dates are normal).
  const filesSeen = [];   // [{fileDate, rows}]
  for (let k = lookbackDays; k >= 0; k--) {
    const fileDate = addDays(today, -k);
    const rows = await fetchCsv("prices", yyyymmdd(fileDate));
    if (rows && rows.length) filesSeen.push({ fileDate, rows });
  }

  const ledger = readJsonl(files.ledger);
  const openByDate = new Map(ledger.filter((r) => r.event === "open").map((r) => [r.date, r]));
  const closedDates = new Set(ledger.filter((r) => r.event === "close").map((r) => r.date));

  // 2. Merge settlement flips across the files seen (later/cleaner wins).
  const settles = new Map();
  for (const { rows } of filesSeen) {
    for (const [date, s] of board.settledHighs(rows, PRODUCT)) {
      const prev = settles.get(date);
      if (!prev || (s.clean && !prev.clean)) settles.set(date, s);
    }
  }

  // 3. OPEN a prediction for each strictly-future contract date a board exists for
  //    (in practice: tomorrow, from today's EOD file).
  const opened = [];
  for (const { fileDate, rows } of filesSeen) {
    const date = addDays(fileDate, 1);
    if (date <= today) continue;                 // never predict a day already underway
    if (openByDate.has(date)) continue;          // idempotent
    const b = board.thresholdBoard(rows, PRODUCT, date);
    if (b.length < 2) { skipped.push(`${date}: board too thin (${b.length})`); continue; }
    const mos = await getMos(PRODUCT);
    const f = mos && mos[mmdd(date)];
    if (!f || f.ymd !== date || !Number.isFinite(f.high)) { skipped.push(`${date}: no MOS forecast`); continue; }
    // f.runtime is kalshi-mos's un-padded local run-day key ("2026-7-9") — normalize to ISO.
    const runIso = f.runtime ? f.runtime.split("-").map((v, i) => (i ? pad(+v) : v)).join("-") : null;
    const lead = runIso ? Math.max(0, daysBetween(runIso, date)) : 1;
    const { params, hasFittedCeiling, source } = loadVenueParams();
    const [, mo, dy] = date.split("-").map(Number);
    const pred = dayahead.predictDay({
      board: b, forecastHigh: f.high, lead, month: mo, day: dy,
      params, minEdgeCents, feeCents: makeFlatFee(flatFeeC),
    });
    if (!pred) { skipped.push(`${date}: prediction unavailable`); continue; }
    const row = {
      event: "open", id: `${PRODUCT}-${date}`, ticker: `${PRODUCT}-${date}`,
      venue: "FORECASTEX", date, boardDate: fileDate,
      forecastHigh: f.high, lead, paramsSource: source, hasFittedCeiling,
      ladder: pred.ladder, dist: pred.dist, ask: pred.ask,
      actionable: pred.actionable, verdict: pred.verdict,
      heldBucket: pred.actionable.length ? pred.actionable[0].bucket : undefined,
      feeCentsFlat: flatFeeC, minEdgeCents,
      openedAt: now.toISOString(),
    };
    appendRow(files.ledger, row);
    openByDate.set(date, row);
    opened.push(date);
  }

  // 4. CLOSE settled predictions (clean flip, or bounds that pin a single ladder bucket).
  const closed = [];
  for (const [date, s] of settles) {
    const open = openByDate.get(date);
    if (!open || closedDates.has(date)) continue;
    const pred = { ladder: open.ladder, dist: open.dist, ask: open.ask, actionable: open.actionable };
    const g = dayahead.gradeDay(pred, s, { flatFeeC: open.feeCentsFlat != null ? open.feeCentsFlat : flatFeeC });
    if (g.obsIdx < 0 && !g.cards.some((c) => c.pnl_c != null)) {
      skipped.push(`${date}: settlement bounds too loose to grade (maxYes=${s.maxYes}, minNo=${s.minNo})`);
      continue;
    }
    appendRow(files.ledger, {
      event: "close", id: open.id, ticker: open.ticker, date,
      settledHigh: s.clean ? s.high : null, clean: s.clean,
      maxYes: s.maxYes, minNo: s.minNo,
      settledBucket: g.obsIdx >= 0 ? g.obsIdx : undefined,
      cards: g.cards, closedAt: now.toISOString(),
    });
    closedDates.add(date);
    closed.push(date);
  }

  // 5. Cumulative honest report.
  const summary = buildSummary(readJsonl(files.ledger));
  fs.mkdirSync(path.dirname(files.summary), { recursive: true });
  fs.writeFileSync(files.summary, JSON.stringify(summary, null, 2) + "\n");

  return { fileDates: filesSeen.map((f) => f.fileDate), opened, closed, summary, skipped };
}

// ── scheduler (hourly tick; runs once per local day after RUN_HOUR_LOCAL) ─────
let _timer = null;
let _lastResult = null;

async function _tick({ now = new Date(), files = FILES } = {}) {
  const { iso: today, hour } = localParts(now);
  const state = readState(files.state);
  if (state.lastOpenDay === today || hour < RUN_HOUR_LOCAL) return null;
  const res = await runOnce({ now, files });
  _lastResult = { at: now.toISOString(), ...res };
  // Advance only when today's EOD file was actually seen — otherwise retry next tick.
  if (res.fileDates.includes(today)) {
    fs.mkdirSync(path.dirname(files.state), { recursive: true });
    fs.writeFileSync(files.state, JSON.stringify({ lastOpenDay: today }, null, 2) + "\n");
  }
  if (res.opened.length || res.closed.length) {
    console.log(`[forecastex-paper] opened ${res.opened.join(",") || "-"} · closed ${res.closed.join(",") || "-"} · ${res.summary.distribution.report}`);
  }
  return res;
}

function start({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (_timer) return _timer;
  const safeTick = () => _tick().catch((e) => console.error("[forecastex-paper] tick failed (non-fatal):", e && e.message));
  _timer = setInterval(safeTick, intervalMs);
  if (_timer.unref) _timer.unref();
  setTimeout(safeTick, 15 * 1000).unref?.(); // catch-up shortly after boot (state-guarded)
  console.log(`[forecastex-paper] nightly forward paper-verification armed (${PRODUCT}, after ${RUN_HOUR_LOCAL}:00 ET)`);
  return _timer;
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

function getStatus({ files = FILES } = {}) {
  const rows = readJsonl(files.ledger);
  return {
    product: PRODUCT,
    state: readState(files.state),
    opens: rows.filter((r) => r.event === "open").length,
    closes: rows.filter((r) => r.event === "close").length,
    lastResult: _lastResult,
  };
}

module.exports = {
  runOnce, buildSummary, start, stop, getStatus, _tick,
  FILES, PRODUCT, RUN_HOUR_LOCAL, MIN_SETTLED_DAYS, MIN_SETTLED_CARDS,
};

if (require.main === module) {
  runOnce().then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  }).catch((e) => { process.stderr.write(`[forecastex-paper] ERROR: ${e.message}\n`); process.exit(1); });
}
