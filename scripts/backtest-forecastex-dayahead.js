"use strict";

/**
 * Retrospective DAY-AHEAD backtest of the KLGA weather oracle vs ForecastEx's public UHLGA
 * board history (#2217, forward-verification step 2 of docs/research/2026-07-10-forecastex-
 * uhlga-settlement-and-klga-fit.md §5).
 *
 * THE TRAP THIS AVOIDS: the venue publishes EOD closes, and a same-day close already knows
 * the outcome. So every contract date D here is scored with (a) the prices file from D-1
 * (EOD closes the evening BEFORE the day being predicted) and (b) the NBS MOS run from D-1
 * (lead 1) — the information actually available the night before. Settlement truth comes
 * from the venue's OWN published settlement flips (clean-flip = exact high; unclean days
 * still grade any bucket the bounds decide, and are never guessed).
 *
 * Per day it scores:
 *   1. RPS/PIT of the KLGA calibratedDistribution vs the settled high — against the
 *      MARKET's own day-ahead distribution on the SAME ladder (the baseline an information
 *      edge must beat) and a flat climatology baseline (kalshi-weather-verify scores).
 *   2. A fixed 70..110 °F integer-grid RPS/PIT (validate-weather-oracle-fit forwardProbs)
 *      so the number is directly comparable to the fit's OOS gate (0.0356 fitted / 0.0508
 *      default, lead 0-7 mix).
 *   3. Hypothetical P&L of every robustEdgeReport actionable card, filled at the D-1 EOD
 *      close, net of the flat 1¢ ForecastEx fee (forecastex-fees).
 *
 * Fill assumption (stated, not hidden): cards trade AT the EOD close print with no spread,
 * slippage, or size limit. EOD closes are the only public prices; live quotes need the EC
 * entitlement (#2216). This overstates fillable P&L — treat positives with suspicion,
 * negatives as decisive.
 *
 * Network: forecastex.com (daily CSVs) + mesonet.agron.iastate.edu (NBS MOS). Run on a box
 * with egress — same note as fit-weather-oracle-params.js. Everything testable is pure and
 * lives in lib/forecastex-dayahead.js.
 *
 * Run:
 *   node scripts/backtest-forecastex-dayahead.js \
 *     --from 2026-02-03 --to 2026-07-09 \
 *     --out data/eval/forecastex-klga-dayahead-backtest.jsonl \
 *     --summary data/eval/forecastex-klga-dayahead-backtest-summary.json
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const board = require("../apps/lantern-garage/lib/forecastex-board");
const dayahead = require("../apps/lantern-garage/lib/forecastex-dayahead");
const verify = require("../apps/lantern-garage/lib/kalshi-weather-verify");
const { loadVenueParams, NYC_LGA } = require("../apps/lantern-garage/lib/forecastex-weather");
const { makeFlatFee, DEFAULT_FEE_CENTS } = require("../apps/lantern-garage/lib/forecastex-fees");
const { parseCsv, mosForecastHighs } = require("../apps/lantern-garage/lib/kalshi-mos");
const { makeNormalFor } = require("./fit-weather-oracle-params");
const { forwardProbs } = require("./validate-weather-oracle-fit");

const PRODUCT = NYC_LGA.product; // UHLGA

// ── date helpers (UTC-based calendar walking; contract dates are plain calendar days) ──
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseIso = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`bad date: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
};
const addDays = (iso, n) => { const d = parseIso(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
const yyyymmdd = (iso) => iso.replace(/-/g, "");
/** ISO date -> the un-zero-padded local-day key kalshi-mos.localDayOf produces ("2026-7-9"). */
const mosKey = (iso) => { const d = parseIso(iso); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; };

function* eachDay(fromIso, toIso) {
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) yield d;
}

// ── network (retrying GET, same shape as validate-weather-oracle-fit) ──────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "keystone-os-forecastex-backtest (github.com/lantern-os)" } }, (res) => {
      const code = res.statusCode;
      if (code !== 200) { res.resume(); const e = new Error(`HTTP ${code}`); e.code = code; return reject(e); }
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => b += c); res.on("end", () => resolve(b));
    });
    req.setTimeout(120000, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await getOnce(url); }
    catch (e) {
      const transient = e.code === 429 || e.code === 503 || /socket hang up|ECONNRESET|timeout/i.test(e.message || "");
      if (transient && i < tries - 1) { await sleep(2500 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ── MOS: one fetch per calendar month, lead-1 forecast per target day ──────────
/** Map(targetIso -> {high, runDay}) using ONLY runs from the day before the target
 *  (lead 1 — the run available when the D-1 EOD board printed). Forecast highs are
 *  rounded, matching what kalshi-mos.getForecastHighs serves the live deck. */
async function fetchMosLead1(fromIso, toIso, { delayMs = 1500 } = {}) {
  const months = new Set();
  for (const d of eachDay(addDays(fromIso, -1), toIso)) months.add(d.slice(0, 7));
  const byRun = new Map();
  for (const ym of [...months].sort()) {
    const sts = `${ym}-01T00:00Z`;
    const [y, m] = ym.split("-").map(Number);
    const ets = `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01T00:00Z`;
    const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${NYC_LGA.station}&model=NBS&sts=${sts}&ets=${ets}&format=csv`;
    process.stdout.write(`[backtest] MOS ${NYC_LGA.station} ${ym}…\n`);
    const csv = await get(url);
    // Merge by run day: an ET run day straddles two UTC month chunks at month boundaries,
    // so take the max-tmp union of the days maps instead of overwriting the earlier chunk.
    for (const [k, v] of mosForecastHighs(parseCsv(csv))) {
      const cur = byRun.get(k);
      if (!cur) { byRun.set(k, v); continue; }
      for (const [dk, rec] of v.days) {
        const c = cur.days.get(dk);
        if (!c || rec.high > c.high) cur.days.set(dk, rec);
      }
    }
    await sleep(delayMs);
  }
  const out = new Map();
  for (const target of eachDay(fromIso, toIso)) {
    const run = byRun.get(mosKey(addDays(target, -1)));
    const rec = run && run.days.get(mosKey(target));
    if (rec) out.set(target, { high: Math.round(rec.high), runDay: addDays(target, -1) });
  }
  return out;
}

// ── ForecastEx: walk the daily files once; keep day-ahead boards + settlements ──
async function fetchBoardsAndSettles(fromIso, toIso, { delayMs = 300 } = {}) {
  const boards = new Map();   // contractDateIso -> {board, boardDate}
  const settles = new Map();  // contractDateIso -> {high, clean, maxYes, minNo} (later files win)
  let files = 0, missing = [];
  for (const fileDate of eachDay(addDays(fromIso, -1), addDays(toIso, 1))) {
    const rows = await board.fetchDailyCsv("prices", yyyymmdd(fileDate));
    await sleep(delayMs);
    if (!rows || !rows.length) { missing.push(fileDate); continue; }
    files++;
    const dayAheadFor = addDays(fileDate, 1);
    const b = board.thresholdBoard(rows, PRODUCT, dayAheadFor);
    if (b.length >= 2 && dayAheadFor >= fromIso && dayAheadFor <= toIso) {
      boards.set(dayAheadFor, { board: b, boardDate: fileDate });
    }
    for (const [date, s] of board.settledHighs(rows, PRODUCT)) {
      const prev = settles.get(date);
      if (!prev || (s.clean && !prev.clean)) settles.set(date, s);
      else if (prev && !prev.clean && !s.clean) {
        // merge partial bounds from multiple files (tighter wins)
        settles.set(date, {
          maxYes: s.maxYes != null && (prev.maxYes == null || s.maxYes > prev.maxYes) ? s.maxYes : prev.maxYes,
          minNo: s.minNo != null && (prev.minNo == null || s.minNo < prev.minNo) ? s.minNo : prev.minNo,
          high: null, clean: false,
        });
      }
    }
  }
  // re-derive clean on merged bounds
  for (const [date, s] of settles) {
    if (!s.clean && s.maxYes != null && s.minNo != null && s.minNo === s.maxYes + 1) {
      settles.set(date, { ...s, high: s.minNo, clean: true });
    }
  }
  return { boards, settles, files, missing };
}

// ── aggregation ────────────────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

async function main() {
  const fromIso = arg("from", "2026-02-03");
  const toIso = arg("to", "2026-07-09");
  const outPath = path.resolve(arg("out", "data/eval/forecastex-klga-dayahead-backtest.jsonl"));
  const sumPath = path.resolve(arg("summary", "data/eval/forecastex-klga-dayahead-backtest-summary.json"));
  const minEdgeCents = Number(arg("min-edge", "5"));
  const flatFeeC = Number(arg("fee-cents", String(DEFAULT_FEE_CENTS)));
  const feeFn = makeFlatFee(flatFeeC);

  const { params, hasFittedCeiling, source } = loadVenueParams();
  if (hasFittedCeiling) throw new Error("KLGA fit unexpectedly carries a ceiling — this backtest assumes NO_CEILING; re-check the params file before trusting results");
  const normalFor = makeNormalFor(NYC_LGA.normals || {}, NYC_LGA.defaultNormal);
  process.stdout.write(`[backtest] ${PRODUCT} day-ahead ${fromIso}..${toIso} · params: ${source} · fee ${flatFeeC}¢ flat · minEdge ${minEdgeCents}¢\n`);

  const [{ boards, settles, files, missing }, mos] = [
    await fetchBoardsAndSettles(fromIso, toIso),
    await fetchMosLead1(fromIso, toIso),
  ];
  process.stdout.write(`[backtest] ${files} price files (missing ${missing.length}), ${boards.size} day-ahead boards, ${settles.size} settled dates, ${mos.size} lead-1 MOS forecasts\n`);

  const rows = [];
  const cover = { days: 0, board: 0, mos: 0, settled: 0, clean: 0, scored: 0 };
  for (const date of eachDay(fromIso, toIso)) {
    cover.days++;
    const b = boards.get(date);
    if (b) cover.board++;
    const f = mos.get(date);
    if (f) cover.mos++;
    if (!b || !f) continue;
    const settle = settles.get(date) || null;
    if (settle) cover.settled++;
    if (settle && settle.clean) cover.clean++;

    const [, mo, dy] = date.split("-").map(Number);
    const pred = dayahead.predictDay({
      board: b.board, forecastHigh: f.high, lead: 1, month: mo, day: dy,
      params, minEdgeCents, feeCents: feeFn,
    });
    if (!pred) continue;

    const row = {
      date, boardDate: b.boardDate, forecastHigh: f.high, mosRunDay: f.runDay, lead: 1,
      board: { n: b.board.length, thrMin: b.board[0].thr, thrMax: b.board[b.board.length - 1].thr },
      ladderK: pred.ladder.length,
      nActionable: pred.actionable.length,
      verdict: pred.verdict,
    };
    if (settle) {
      const g = dayahead.gradeDay(pred, settle, { flatFeeC });
      row.settle = { high: settle.high, clean: settle.clean, maxYes: settle.maxYes, minNo: settle.minNo };
      row.obsIdx = g.obsIdx;
      if (g.scores) {
        cover.scored++;
        row.scores = {
          oracleRPS: r4(g.scores.oracleRPS), oraclePIT: r4(g.scores.oraclePIT),
          marketRPS: r4(g.scores.marketRPS), marketPIT: r4(g.scores.marketPIT),
          climRPS: r4(g.scores.climRPS),
        };
        // fixed-grid score, comparable to the fit's OOS numbers (same 70..110 grid)
        if (settle.clean) {
          const { probs, lo } = forwardProbs(f.high, 1, `${mo}-${dy}`, params, normalFor);
          const obs = Math.max(0, Math.min(probs.length - 1, Math.round(settle.high) - lo));
          row.grid = { rps: r4(verify.rps(probs, obs)), pit: r4(verify.pit(probs, obs)) };
        }
      }
      row.cards = g.cards.map((c) => ({ ...c, ask: r4(c.ask), fair: r4(c.fair) }));
    }
    rows.push(row);
  }

  // ── aggregates ──
  const scored = rows.filter((r) => r.scores);
  const oracleRPS = scored.map((r) => r.scores.oracleRPS);
  const marketRPS = scored.map((r) => r.scores.marketRPS);
  const climRPS = scored.map((r) => r.scores.climRPS);
  const oracleWins = scored.filter((r) => r.scores.oracleRPS < r.scores.marketRPS).length;
  const pitOracle = verify.pitUniformity(scored.map((r) => r.scores.oraclePIT));
  const pitMarket = verify.pitUniformity(scored.map((r) => r.scores.marketPIT));
  const grid = rows.filter((r) => r.grid);
  const gridPit = verify.pitUniformity(grid.map((r) => r.grid.pit));

  const allCards = rows.flatMap((r) => (r.cards || []).map((c) => ({ ...c, date: r.date })));
  const settledCards = allCards.filter((c) => c.pnl_c != null);
  const pendingCards = rows.filter((r) => !r.settle).reduce((s, r) => s + r.nActionable, 0);
  const pnlTotal = settledCards.reduce((s, c) => s + c.pnl_c, 0);
  const hits = settledCards.filter((c) => c.pnl_c > 0).length;
  // Fillable subset: fading a degenerate 0.00/1.00 EOD close isn't executable, so P&L on those
  // cards is an artifact. Report the tradeable-only edge separately — it is the honest number.
  const tradeableCards = settledCards.filter((c) => (c.tradeable != null ? c.tradeable : dayahead.isTradeableAsk(c.ask)));
  const tradeablePnl = tradeableCards.reduce((s, c) => s + c.pnl_c, 0);
  const tradeableHits = tradeableCards.filter((c) => c.pnl_c > 0).length;
  const byMonth = {};
  for (const c of settledCards) {
    const m = c.date.slice(0, 7);
    byMonth[m] = byMonth[m] || { n: 0, pnl_c: 0 };
    byMonth[m].n++; byMonth[m].pnl_c = r1(byMonth[m].pnl_c + c.pnl_c);
  }

  const nScored = scored.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    product: PRODUCT, from: fromIso, to: toIso, lead: 1,
    params: { source, hasFittedCeiling },
    assumptions: {
      fill: "cards fill AT the D-1 EOD close print (no spread/slippage/size) — the only public prices; overstates fillable P&L",
      feeCentsFlat: flatFeeC, minEdgeCents,
      forecast: "NBS MOS run from D-1 only (lead 1), rounded °F — matches the live kalshi-mos serve path",
    },
    coverage: { ...cover, priceFiles: files, priceFilesMissing: missing.length },
    calibration: {
      n: nScored,
      oracle: { meanRPS: r4(mean(oracleRPS)), pitChi2: r4(pitOracle && pitOracle.chi2_reduced), pitHistogram: pitOracle && pitOracle.histogram },
      market: { meanRPS: r4(mean(marketRPS)), pitChi2: r4(pitMarket && pitMarket.chi2_reduced) },
      climatologyMeanRPS: r4(mean(climRPS)),
      oracleBeatsMarketDays: `${oracleWins}/${nScored}`,
      grid70to110: { n: grid.length, meanRPS: r4(mean(grid.map((r) => r.grid.rps))), pitChi2: r4(gridPit && gridPit.chi2_reduced), fitOOSReference: { fitted: 0.0356, default: 0.0508 } },
    },
    edges: {
      daysWithActionable: rows.filter((r) => r.nActionable > 0).length,
      cardsTotal: allCards.length,
      cardsSettled: settledCards.length,
      cardsUndeterminable: allCards.filter((c) => c.pnl_c == null).length,
      cardsAwaitingSettlement: pendingCards,
      hitRate: settledCards.length ? r4(hits / settledCards.length) : null,
      netPnlCents: r1(pnlTotal),
      meanPnlCentsPerCard: settledCards.length ? r1(pnlTotal / settledCards.length) : null,
      // fillable subset (ask not at a degenerate 0/1 close) — the honest, executable edge
      tradeable: {
        cards: tradeableCards.length,
        nonFillableExcluded: settledCards.length - tradeableCards.length,
        hitRate: tradeableCards.length ? r4(tradeableHits / tradeableCards.length) : null,
        netPnlCents: r1(tradeablePnl),
        meanPnlCentsPerCard: tradeableCards.length ? r1(tradeablePnl / tradeableCards.length) : null,
        note: "cards whose day-ahead close sat at 0.00/1.00 are excluded as non-fillable; this is the P&L certification is allowed to trust",
      },
      byMonth,
      cards: settledCards,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`[backtest] wrote ${rows.length} day rows -> ${outPath}\n`);
  process.stdout.write(`[backtest] summary -> ${sumPath}\n${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`[backtest] ERROR: ${e.message}\n${e.stack}\n`); process.exit(1); });
}

module.exports = { fetchMosLead1, fetchBoardsAndSettles, eachDay: (a, b) => [...eachDay(a, b)], addDays, mosKey };
