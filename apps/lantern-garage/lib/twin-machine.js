"use strict";

/**
 * twin-machine.js — the twin machine as a pure, testable core (docs/TWIN-MACHINE-DESIGN.md).
 *
 * One machine, two faces, one owned:
 *   A — the Answerer. Gets the current question right. The rented frontier.
 *   B — the Asker.    Predicts where A is wrong; picks what to probe next; owns the halt.
 *
 * THE ONE RULE, enforced here in code and not left to convention:
 *
 *     B can stop A.  A cannot stop B.  Reality overrides B.
 *
 * A's answer reaches the caller ONLY through B's gate. There is no code path by which A's
 * output bypasses B, and no input by which A can change B's verdict — A's answer is an
 * argument to B, never the other way round. When reality arrives (a test runs, a bet settles,
 * a source is checked) it overrules B in either direction and is recorded against B's
 * prediction, which is how B is graded.
 *
 * WHAT THIS MODULE IS NOT. It is not two chatbots talking, not a debate, not a vote. B does
 * not argue with A; B predicts A's failure and either lets the answer through, halts it, or
 * pins it. The value is in the disagreement and in the pin list, not in a consensus.
 *
 * PURE BY DESIGN. A and B are injected async functions, so the contract is exercised with no
 * network and no model. `twin.run()` is the machine; `twin.bind()` attaches real models. The
 * only side effect is the optional journal append, which is best-effort and never throws.
 *
 * B'S CONTRACT.  b(question, answer, ctx) -> { pWrong, reason, canResolve, probe }
 *   pWrong      in [0,1]: B's calibrated probability that A's answer is wrong. Not prose.
 *   canResolve  boolean:  can ANY action B knows of settle this? If false and pWrong is not
 *               low, the question becomes a PIN — seen, not reachable.
 *   probe       optional: what B wants to investigate next. B chooses; A does not vote.
 *
 * THE VERDICTS, and they are the whole state machine:
 *   pass    B's pWrong < stop     -> A's answer goes through, stamped with B's pWrong.
 *   halt    B's pWrong >= stop and B can resolve it -> A is stopped; caller escalates/probes.
 *   pin     B's pWrong >= stop and NOTHING can resolve it -> surfaced as a boundary pin.
 *           This is the product. A Deep Thought machine's most valuable output is its pins.
 *
 * B'S FRESHNESS LAW. B is the internal signal for A, and the repo measured that an internal
 * signal cannot replace fresh data in the selection role. So on a cadence B does not control
 * (every `freshnessEvery` runs), B is forced to probe something it currently rates as
 * UNINTERESTING — the lowest-pWrong item in its own history — or its question space ratchets
 * closed the way a reused held-out set does. That forced probe is marked so the grade is honest.
 *
 * INDEPENDENCE IS TESTED, NOT MEASURED. `perturbationTest()` is the §9 discipline: hold the
 * verdicts fixed, vary a hidden input, watch whether the outcome moves. A second B that moves in
 * no direction the first does not is an echo, not a twin. Correlation of agreement is NOT what
 * this checks, on purpose — the §9 failure was a direction no signal was sensitive to.
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  stop: 0.5,              // B's pWrong at or above which A is stopped. Pre-registered, not tuned.
  freshnessEvery: 10,     // every Nth run B is forced to probe something it rates boring
  journal: null,          // path for the append-only run journal; null = no disk
};

function _c01(x) {
  x = Number(x);
  return x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0.5;
}

/** Build a machine. `a` and `b` are injected; nothing here knows what they are. */
function create({ a, b, ...opts } = {}) {
  if (typeof a !== "function" || typeof b !== "function") {
    throw new Error("twin.create: both a(question, ctx) and b(question, answer, ctx) are required");
  }
  const cfg = { ...DEFAULTS, ...opts };
  const state = {
    runs: 0,
    history: [],            // every run's B-verdict, for the freshness law + grading
    pins: [],               // the boundary — questions seen but unreachable
    graded: [],             // (B prediction, reality) pairs — how B is scored
  };

  function _journal(row) {
    if (!cfg.journal) return;
    try {
      fs.mkdirSync(path.dirname(cfg.journal), { recursive: true });
      fs.appendFileSync(cfg.journal, JSON.stringify(row) + "\n");
    } catch (_e) { /* best-effort — the journal must never break a run */ }
  }

  /**
   * One turn of the machine. Returns the verdict envelope. A's answer is present in the
   * envelope ONLY when B passed it — the one-way stop is structural, not a flag the caller
   * is trusted to honour.
   */
  async function run(question, ctx = {}) {
    state.runs += 1;
    const id = `twin_${state.runs}_${Date.now().toString(36)}`;

    // ── forced freshness probe: B looks where it does not want to look ──────────────────
    let forcedProbe = null;
    if (cfg.freshnessEvery > 0 && state.runs % cfg.freshnessEvery === 0 && state.history.length) {
      const boring = [...state.history].sort((x, y) => x.pWrong - y.pWrong)[0];
      forcedProbe = { question: boring.question, priorPWrong: boring.pWrong, forced: true };
    }

    // ── A answers. A never sees B, and A's output is an ARGUMENT to B, never a verdict. ──
    let answer;
    try {
      answer = await a(question, ctx);
    } catch (e) {
      // A failing is not a verdict either — B still decides what to tell the caller.
      answer = { text: null, error: String(e && e.message || e) };
    }

    // ── B judges. B's inputs are the question, A's answer, and context. Nothing A can put
    //    in its answer changes B's contract: B returns a number, and the gate reads the number.
    let verdict;
    try {
      verdict = await b(question, answer, ctx);
    } catch (e) {
      // B failing closed: if the auditor cannot run, nothing passes. Fail-closed, never open.
      verdict = { pWrong: 1, reason: `B unavailable: ${String(e && e.message || e)}`, canResolve: true };
    }
    const pWrong = _c01(verdict && verdict.pWrong);
    const canResolve = verdict && verdict.canResolve !== false;
    const reason = (verdict && verdict.reason) || null;
    const probe = (verdict && verdict.probe) || null;

    let kind;
    if (pWrong < cfg.stop) kind = "pass";
    else if (canResolve) kind = "halt";
    else kind = "pin";

    const row = { id, question, pWrong, reason, kind, probe, forcedProbe, ts: new Date().toISOString() };
    state.history.push({ id, question, pWrong, kind });
    if (kind === "pin") state.pins.push({ id, question, pWrong, reason, ts: row.ts });
    _journal(row);

    // The envelope. Note what is and is not in it:
    //   - A's answer is included ONLY on pass. On halt/pin the caller gets B's reason and
    //     B's probe, not A's text. That is the one-way stop, as code.
    //   - B's verdict is ALWAYS included. A cannot suppress it.
    return {
      id, question, kind,
      answer: kind === "pass" ? answer : null,
      b: { pWrong, reason, canResolve, probe },
      forcedProbe,
      // What the caller should do next. B chose it; A did not vote.
      next: kind === "pass" ? null
        : kind === "halt" ? { action: "escalate_or_probe", probe: probe || { question } }
          : { action: "pin", why: "no known action resolves this; it is a boundary, not a failure" },
    };
  }

  /**
   * Reality arrives. Grade B's prediction against it. This is the ONLY thing that overrides
   * B, and it overrides in both directions: a passed answer that reality says was wrong counts
   * against B exactly as much as a halted answer that reality says was right.
   *
   * @param {string} id        the run id
   * @param {boolean} wasWrong  what reality said about A's answer
   */
  function grade(id, wasWrong) {
    const h = state.history.find((x) => x.id === id);
    if (!h) return null;
    const predictedWrong = h.pWrong >= cfg.stop;
    const g = {
      id, question: h.question, pWrong: h.pWrong, kind: h.kind,
      reality: wasWrong ? "wrong" : "right",
      bWasRight: predictedWrong === !!wasWrong,
      // The two failure modes, named, because they cost different things:
      //   missed  — B passed an answer reality says was wrong (the dangerous one)
      //   overHalt — B stopped an answer reality says was right (the expensive one)
      failure: (!predictedWrong && wasWrong) ? "missed" : (predictedWrong && !wasWrong) ? "overHalt" : null,
      ts: new Date().toISOString(),
    };
    state.graded.push(g);
    // A pinned question that reality resolved is no longer a pin — reality reached it.
    if (h.kind === "pin") state.pins = state.pins.filter((p) => p.id !== id);
    _journal({ grade: g });
    return g;
  }

  /** B's report card: calibration, the two failure modes, and the boundary. */
  function report() {
    const g = state.graded;
    const n = g.length;
    const missed = g.filter((x) => x.failure === "missed").length;
    const overHalt = g.filter((x) => x.failure === "overHalt").length;
    // Brier score of B's pWrong against reality — lower is better; 0.25 is "always say 0.5".
    const brier = n ? g.reduce((s, x) => s + (x.pWrong - (x.reality === "wrong" ? 1 : 0)) ** 2, 0) / n : null;
    return {
      runs: state.runs,
      graded: n,
      bAccuracy: n ? g.filter((x) => x.bWasRight).length / n : null,
      brier: brier === null ? null : Math.round(brier * 1000) / 1000,
      missed, overHalt,
      pins: state.pins.length,
      pinList: state.pins.map((p) => ({ question: p.question, pWrong: p.pWrong, reason: p.reason })),
      verdicts: {
        pass: state.history.filter((x) => x.kind === "pass").length,
        halt: state.history.filter((x) => x.kind === "halt").length,
        pin: state.history.filter((x) => x.kind === "pin").length,
      },
    };
  }

  return { run, grade, report, cfg, _state: state };
}

/**
 * The §9 discipline as a function: test whether two B's are INDEPENDENT by perturbation, not
 * by correlation. Hold the question and A's answer fixed; vary a hidden context field; see
 * whether each B's pWrong MOVES. A B that moves in no direction the other does not is an echo.
 *
 * @param {function} b1, b2      two B functions
 * @param {object}   fixture     { question, answer }
 * @param {Array}    perturbations  [{ name, ctx }] — hidden variations to apply
 * @returns per-perturbation movement of each B, and whether b2 adds any direction b1 lacks
 */
async function perturbationTest(b1, b2, fixture, perturbations, { minMove = 0.05 } = {}) {
  const base1 = _c01((await b1(fixture.question, fixture.answer, {})).pWrong);
  const base2 = _c01((await b2(fixture.question, fixture.answer, {})).pWrong);
  const rows = [];
  let b2AddsDirection = false;
  for (const p of perturbations) {
    const v1 = _c01((await b1(fixture.question, fixture.answer, p.ctx || {})).pWrong);
    const v2 = _c01((await b2(fixture.question, fixture.answer, p.ctx || {})).pWrong);
    const m1 = Math.abs(v1 - base1), m2 = Math.abs(v2 - base2);
    const b1Moves = m1 >= minMove, b2Moves = m2 >= minMove;
    if (b2Moves && !b1Moves) b2AddsDirection = true;
    rows.push({ perturbation: p.name, b1Move: Math.round(m1 * 1000) / 1000, b2Move: Math.round(m2 * 1000) / 1000, b1Moves, b2Moves });
  }
  return {
    rows,
    b2AddsDirection,
    verdict: b2AddsDirection
      ? "INDEPENDENT in at least one direction — b2 is a twin, not an echo"
      : "ECHO — b2 moves in no direction b1 does not; adding it multiplies the same blind spot",
  };
}

module.exports = { create, perturbationTest, DEFAULTS };
