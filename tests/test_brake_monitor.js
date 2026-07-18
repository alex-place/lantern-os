// brake-monitor — offline unit tests (no network, no server, no timers).
// Exercises the pure compute surface of apps/lantern-garage/lib/brake-monitor.js:
// the ADR-0028 brake-to-cash gross formula (vol targeting × 6-mo trend gate ×
// drawdown taper, clamped [0, 2×]), the vol blend, the paper-book accounting
// (funding/cash carry signs), and state persistence round-trip via a temp file.
//
// Run: node tests/test_brake_monitor.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point persistence at a temp file BEFORE requiring the module (path is read
// per-call, but keeping it first makes the isolation obvious).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brake-monitor-test-"));
process.env.BRAKE_MONITOR_STATE_FILE = path.join(tmpDir, "brake-monitor.json");

const bm = require("../apps/lantern-garage/lib/brake-monitor");

let failures = 0;
function check(name, fn) {
  const done = (e) => {
    if (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
    else console.log("  ok  -", name);
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(() => done(), done);
    done();
  } catch (e) { done(e); }
  return Promise.resolve();
}
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

async function main() {
  console.log("brake-monitor offline tests\n");

  // ── computeGross: the ADR-0028 brake-to-cash formula ───────────────────────
  await check("calm regime → full 2.0× (vol cap not binding)", () => {
    const g = bm.computeGross({ vol: 0.10, trendOk: true, drawdown: 0 });
    assert.strictEqual(g.gross, 2.0);
    assert.strictEqual(g.volCap, 2.0); // min(2, 0.35/0.10)=2 after clamp
    assert.strictEqual(g.ddCap, null);
  });

  await check("vol spike shrinks gross: vol 0.70 → 0.5×", () => {
    const g = bm.computeGross({ vol: 0.70, trendOk: true, drawdown: 0 });
    approx(g.gross, 0.5);
  });

  await check("vol targeting is uncapped below 1×: vol 0.50 → 0.7×", () => {
    approx(bm.computeGross({ vol: 0.50, trendOk: true, drawdown: 0 }).gross, 0.7);
  });

  await check("vol at target → exactly 1.0×", () => {
    approx(bm.computeGross({ vol: bm.VOL_TARGET, trendOk: true, drawdown: 0 }).gross, 1.0);
  });

  await check("trend down → cash floor (0), even in a calm regime", () => {
    const g = bm.computeGross({ vol: 0.08, trendOk: false, drawdown: 0 });
    assert.strictEqual(g.gross, bm.MIN_GROSS);
    assert.strictEqual(g.gross, 0);
  });

  await check("drawdown at the brake threshold (-30%) does not yet taper", () => {
    assert.strictEqual(bm.computeGross({ vol: 0.10, trendOk: true, drawdown: -0.30 }).gross, 2.0);
  });

  await check("drawdown taper math: dd -45% → cap 0.5×; dd -60% → cash; dd -90% → cash", () => {
    // over = min(1, (|dd|-0.30)/0.30): linear 1× → 0× between -30% and -60%.
    const g45 = bm.computeGross({ vol: 0.10, trendOk: true, drawdown: -0.45 });
    approx(g45.gross, 0.5);
    approx(g45.ddCap, 0.5);
    assert.strictEqual(bm.computeGross({ vol: 0.10, trendOk: true, drawdown: -0.60 }).gross, 0);
    assert.strictEqual(bm.computeGross({ vol: 0.10, trendOk: true, drawdown: -0.90 }).gross, 0);
  });

  await check("gross is always clamped to [0, 2]", () => {
    const lo = bm.computeGross({ vol: 99, trendOk: false, drawdown: -0.99 });
    const hi = bm.computeGross({ vol: 1e-9, trendOk: true, drawdown: 0 });
    assert.ok(lo.gross >= 0 && hi.gross <= 2, `${lo.gross} / ${hi.gross}`);
    assert.strictEqual(hi.gross, 2);
  });

  // ── blendVol: conservative ratchet ─────────────────────────────────────────
  await check("blend: intraday spike TIGHTENS (RMS above daily leg)", () => {
    const v = bm.blendVol(0.20, 0.60);
    approx(v, Math.sqrt(0.5 * 0.04 + 0.5 * 0.36)); // ≈ 0.447 > 0.20
    assert.ok(v > 0.20);
  });

  await check("blend: flat ticks can NOT release below the daily leg", () => {
    assert.strictEqual(bm.blendVol(0.30, 0.05), 0.30); // max() floor holds
  });

  await check("blend degrades honestly when a leg is missing", () => {
    assert.strictEqual(bm.blendVol(null, 0.25), 0.25);
    assert.strictEqual(bm.blendVol(0.18, null), 0.18);
    assert.strictEqual(bm.blendVol(null, null), null);
  });

  // ── annualizedDailyVol ─────────────────────────────────────────────────────
  await check("daily vol: alternating ±1% over 20d annualizes as stdev×√252", () => {
    const rets = Array.from({ length: 40 }, (_, i) => (i % 2 ? -0.01 : 0.01));
    // independent expected value over the LAST 20 returns
    const tail = rets.slice(-20);
    const m = tail.reduce((s, x) => s + x, 0) / 20;
    const sd = Math.sqrt(tail.reduce((s, x) => s + (x - m) ** 2, 0) / 19);
    approx(bm.annualizedDailyVol(rets), sd * Math.sqrt(252), 1e-12);
  });

  await check("daily vol: too little history → null (warming, not fake zero)", () => {
    assert.strictEqual(bm.annualizedDailyVol([0.01, -0.01]), null);
  });

  // ── intradayVolFromTicks ───────────────────────────────────────────────────
  const mkSnaps = (n, dtMs, movePct) => {
    const snaps = [];
    let a = 100, b = 200;
    for (let i = 0; i < n; i++) {
      snaps.push({ t: 1_700_000_000_000 + i * dtMs, prices: { SPY: a, QQQ: b } });
      const dir = i % 2 ? 1 : -1;
      a *= 1 + dir * movePct; b *= 1 + dir * movePct;
    }
    return snaps;
  };

  await check("intraday vol: annualizes per-tick stdev by trading-time √(year/dt)", () => {
    const dt = 60_000;
    const snaps = mkSnaps(101, dt, 0.001);
    const v = bm.intradayVolFromTicks(snaps);
    assert.ok(v != null && v > 0);
    // independent expectation: portfolio tick returns are ±~0.1% alternating
    const rets = [];
    for (let i = 1; i < snaps.length; i++) {
      const r1 = snaps[i].prices.SPY / snaps[i - 1].prices.SPY - 1;
      const r2 = snaps[i].prices.QQQ / snaps[i - 1].prices.QQQ - 1;
      rets.push((r1 + r2) / 2);
    }
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
    approx(v, sd * Math.sqrt((252 * 6.5 * 3600 * 1000) / dt), 1e-9);
  });

  await check("intraday vol: under 31 snapshots → null (warming)", () => {
    assert.strictEqual(bm.intradayVolFromTicks(mkSnaps(10, 60_000, 0.001)), null);
  });

  await check("intraday vol: a restart/overnight gap pair is skipped, not annualized", () => {
    const snaps = mkSnaps(101, 60_000, 0.001);
    // widen one gap to 12h — the pair across it must be dropped
    for (let i = 50; i < snaps.length; i++) snaps[i] = { ...snaps[i], t: snaps[i].t + 12 * 3600 * 1000 };
    const v = bm.intradayVolFromTicks(snaps);
    const vNoGap = bm.intradayVolFromTicks(mkSnaps(101, 60_000, 0.001));
    assert.ok(v != null && Math.abs(v - vNoGap) / vNoGap < 0.05, `${v} vs ${vNoGap}`);
  });

  // ── trendSignal ────────────────────────────────────────────────────────────
  const flatThen = (n, endFactor) =>
    Array.from({ length: n }, (_, i) => 100 * (1 + (endFactor - 1) * (i / (n - 1))));

  await check("trend: rising 6-mo closes → ok:true with the mean total return", () => {
    const t = bm.trendSignal({ SPY: flatThen(bm.TREND_DAYS + 1, 1.10), QQQ: flatThen(bm.TREND_DAYS + 1, 1.30) });
    assert.strictEqual(t.ok, true);
    approx(t.value, 0.20, 1e-9); // mean of +10% and +30%
    assert.strictEqual(t.symbolsUsed, 2);
  });

  await check("trend: falling closes → ok:false (down → cash)", () => {
    const t = bm.trendSignal({ SPY: flatThen(bm.TREND_DAYS + 1, 0.85) });
    assert.strictEqual(t.ok, false);
    assert.ok(t.value < 0);
  });

  await check("trend: insufficient history → null (warming, not a fake up)", () => {
    assert.strictEqual(bm.trendSignal({ SPY: flatThen(30, 1.5) }), null);
  });

  // ── applyPaperMark: paper-book accounting ──────────────────────────────────
  const DAY = 24 * 3600 * 1000;

  await check("levered book PAYS funding: gross 2 carry is negative at (T-bill+150bp)", () => {
    const book = { equity: 25000, peak: 25000, gross: 2 };
    const { portR, carry } = bm.applyPaperMark(book, { avgSymReturn: 0.01, dtMs: DAY, rf: 0.03, spread: 0.015 });
    approx(portR, 0.02);                       // symbol returns × previous gross
    approx(carry, -(1) * 0.045 / 365, 1e-12);  // borrowed fraction (gross-1)=1
    approx(book.equity, 25000 * (1 + 0.02 - 0.045 / 365), 1e-6);
    approx(book.peak, book.equity, 1e-9);      // peak follows a new high
  });

  await check("de-risked book EARNS cash yield: gross 0.5 carry is positive at T-bill", () => {
    const book = { equity: 25000, peak: 25000, gross: 0.5 };
    const { carry } = bm.applyPaperMark(book, { avgSymReturn: 0, dtMs: DAY, rf: 0.03, spread: 0.015 });
    approx(carry, 0.5 * 0.03 / 365, 1e-12);
    assert.ok(book.equity > 25000);
  });

  await check("fully invested unlevered book: gross 1 → zero carry", () => {
    const book = { equity: 25000, peak: 25000, gross: 1 };
    const { carry } = bm.applyPaperMark(book, { avgSymReturn: 0, dtMs: DAY });
    assert.strictEqual(carry, 0);
    approx(book.equity, 25000);
  });

  await check("full cash book: gross 0 ignores market moves, earns full T-bill", () => {
    const book = { equity: 25000, peak: 25000, gross: 0 };
    const { portR, carry } = bm.applyPaperMark(book, { avgSymReturn: -0.05, dtMs: DAY, rf: 0.03 });
    approx(portR, 0);                          // 0 × anything (allows JS -0)
    approx(carry, 0.03 / 365, 1e-12);
  });

  await check("drawdown bookkeeping: peak holds on a loss; equity floors at 0", () => {
    const book = { equity: 25000, peak: 25000, gross: 2 };
    bm.applyPaperMark(book, { avgSymReturn: -0.10, dtMs: DAY });
    assert.ok(book.equity < 25000 && book.peak === 25000);
    const dd = book.equity / book.peak - 1;
    assert.ok(dd < -0.19 && dd > -0.21, `dd ${dd}`); // 2× a −10% move ≈ −20%
    const ruin = { equity: 100, peak: 25000, gross: 2 };
    bm.applyPaperMark(ruin, { avgSymReturn: -0.60, dtMs: DAY });
    assert.strictEqual(ruin.equity, 0);
  });

  // ── describeAction ─────────────────────────────────────────────────────────
  await check("action strings name the binding brake", () => {
    assert.strictEqual(bm.describeAction({ warming: false, gross: 2.0, trendOk: true, ddActive: false, volCap: 2.0 }), "holding 2.0×");
    assert.strictEqual(bm.describeAction({ warming: false, gross: 1.4, trendOk: true, ddActive: false, volCap: 1.4 }), "vol brake → 1.4×");
    assert.strictEqual(bm.describeAction({ warming: false, gross: 0, trendOk: false, ddActive: false, volCap: 2.0 }), "trend down → cash");
    assert.strictEqual(bm.describeAction({ warming: false, gross: 0.5, trendOk: true, ddActive: true, volCap: 2.0 }), "drawdown taper → 0.5×");
    assert.ok(/warming up/.test(bm.describeAction({ warming: true })));
  });

  // ── persistence round-trip (temp dir via BRAKE_MONITOR_STATE_FILE) ─────────
  await check("stateFilePath honors BRAKE_MONITOR_STATE_FILE", () => {
    assert.strictEqual(bm.stateFilePath(), process.env.BRAKE_MONITOR_STATE_FILE);
  });

  await check("state persists and restores across a simulated restart", async () => {
    const history = [{ ts: "2026-07-17T14:00:00.000Z", from: 2.0, to: 1.4, action: "vol brake → 1.4×" }];
    bm.restoreState({
      equity: 31337.5, peak: 32000.25, gross: 1.25,
      lastPrices: { SPY: 545.12, QQQ: 470.34 },
      lastMarkTs: 1_800_000_000_000,
      grossHistory: history,
    });
    await bm.saveStateNow();
    assert.ok(fs.existsSync(bm.stateFilePath()), "state file written");
    // wipe in-memory state, then resume from disk (the restart path)
    bm.restoreState({ equity: bm.START_EQUITY, peak: bm.START_EQUITY, gross: 0, lastPrices: {}, lastMarkTs: 0, grossHistory: [] });
    const loaded = await bm.loadStateFromDisk();
    assert.strictEqual(loaded, true);
    const s = bm.serializeState();
    approx(s.equity, 31337.5);
    approx(s.peak, 32000.25);
    approx(s.gross, 1.25);
    approx(s.lastPrices.SPY, 545.12);
    assert.strictEqual(s.lastMarkTs, 1_800_000_000_000);
    assert.deepStrictEqual(s.grossHistory, history);
  });

  await check("restore rejects garbage instead of corrupting the book", () => {
    const before = bm.serializeState();
    bm.restoreState({ equity: -5, peak: "x", gross: 99, lastMarkTs: "nope" });
    const after = bm.serializeState();
    approx(after.equity, before.equity);       // negative equity refused
    approx(after.peak, before.peak);           // non-numeric refused
    assert.ok(after.gross <= bm.MAX_GROSS);    // gross clamped to [0, 2]
    assert.strictEqual(after.lastMarkTs, before.lastMarkTs);
  });

  // ── config sanity: this IS the ADR-0028 champion spec ──────────────────────
  await check("champion config matches the ADR (0.35 target, 30% brake, cash floor 0, 2× cap)", () => {
    assert.strictEqual(bm.VOL_TARGET, 0.35);
    assert.strictEqual(bm.DD_BRAKE, 0.30);
    assert.strictEqual(bm.MIN_GROSS, 0);
    assert.strictEqual(bm.MAX_GROSS, 2.0);
    assert.strictEqual(bm.TREND_DAYS, 126);
    assert.deepStrictEqual(bm.UNIVERSE, ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]);
  });

  // cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall brake-monitor tests passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
