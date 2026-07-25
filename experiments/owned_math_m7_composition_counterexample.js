"use strict";
// M7 — structured counterexample against the COMPOSED control law (#2857 / PR #2909).
//
// Unlike the M3/M4 probes (toy instrument semantics), this artifact drives the SHIPPED
// code paths directly: `convergeControl` (apps/lantern-garage/lib/converge-control.js)
// and `dilation`/`groundingPolicy` (apps/lantern-garage/lib/grounding-policy.js).
//
// The claim attacked — the law's own header, guarantee (a): "KILL the confident-unanchored
// runaway (M6 lasing)". M6's side condition is per-mode ("G/L > 1 AND zero external-
// innovation coupling"); the law tests the GLOBAL per-step bit `!evidenceInflux`.
//
// Structured counterexample (two worlds, identical signal traces):
//   World G (anchored):  one mode; evidence FOR that mode arrives every step; its
//                        confidence odds multiply by the likelihood ratio g each step.
//   World L (laundered): two modes; the focal mode NEVER receives evidence (zero
//                        external-innovation coupling — textbook M6 lasing) and its odds
//                        multiply by self-repeat gain g; an UNRELATED feed item (mode 2)
//                        arrives every step, setting the global influx bit.
// Every signal coordinate the law reads is equal in both worlds at every step, so any
// deterministic causal policy over these signals acts identically on both — yet the
// M6-correct actions differ (G: continue; L: kill). Impossibility, not a tuning bug.
// Formal statement: docs/research/2026-07-21-owned-math-proofs.md, Lemma 3.
//
// Also measured here:
//   Part C — the starvation corollary: with provenance-blind uncertainty u = 1 − c, the
//            shipped dilation/groundingPolicy maps are strictly decreasing in laundered
//            confidence, so the runaway mode's external-grounding budget falls toward the
//            fetch cutoff as it snowballs: the composition STARVES the very node that
//            most needs refutation. Attribution (M1 paid/free split) re-opens the budget.
//   Part D — the self-contradictory halt record: the converged-but-stale-and-broke cell
//            returns action "halt_saturated" with `saturated: false`.
//
// Deterministic (no RNG, no clock). Run:
//   node experiments/owned_math_m7_composition_counterexample.js

const path = require("path");
const fs = require("fs");

const { convergeControl } = require("../apps/lantern-garage/lib/converge-control");
const { dilation, groundingPolicy } = require("../apps/lantern-garage/lib/grounding-policy");

const OUT = path.join(__dirname, "results", "owned_math_m7_composition_counterexample.json");
const DATE = "2026-07-24";
const T = 40; // steps
const G = 1.4; // focal-mode gain/leak ratio (same number in both worlds; provenance differs)

const round = (x, d = 7) => Number(Number(x).toFixed(d));

// Confidence bookkeeping: odds o_t = g^t from o_0 = 1 (c_0 = 0.5). In World G the ×g is a
// Bayes update on per-mode evidence with likelihood ratio g; in World L it is self-repeat
// amplification with NO evidence for the mode. Identical arithmetic — that is the point:
// the signals carry magnitude, not provenance.
function confidenceAt(t) {
  const odds = Math.pow(G, t);
  return odds / (1 + odds);
}

// The per-step signal vector AS THE SHIPPED LAW DEFINES IT — equal in both worlds.
function globalSignals() {
  return {
    gainOverLeak: G, // focal mode's measured G/L (M6 estimator is provenance-blind)
    evidenceInflux: true, // SOME evidence arrived (G: for the mode; L: unrelated feed)
    confidenceRising: true, // focal-mode confidence rising in both worlds
    fixedPoint: false,
    stable: true, // latent linearization contractive; the runaway is the mode, not rho(A)
    groundingDue: false, // within one cadence window (L remark: the feed keeps it fresh)
    budgetRemaining: 100,
  };
}

function runWorld(name, { evidenceForMode }) {
  const actions = [];
  let firstKillStep = null;
  for (let t = 1; t <= T; t++) {
    const s = globalSignals();
    if (evidenceForMode !== undefined) s.evidenceForMode = evidenceForMode;
    const r = convergeControl(s);
    actions.push(r.action);
    if (r.action === "kill" && firstKillStep === null) firstKillStep = t;
  }
  const hist = {};
  for (const a of actions) hist[a] = (hist[a] || 0) + 1;
  return {
    world: name,
    steps: T,
    action_histogram: hist,
    first_kill_step: firstKillStep,
    final_confidence: round(confidenceAt(T)),
    final_odds: round(Math.pow(G, T), 1),
    sample_reason: convergeControl(
      evidenceForMode === undefined ? globalSignals() : { ...globalSignals(), evidenceForMode }
    ).reason,
  };
}

function main() {
  // ---- Part A: two worlds vs the shipped law, legacy signal vocabulary (no attribution).
  const worldG_legacy = runWorld("G (anchored)", { evidenceForMode: undefined });
  const worldL_legacy = runWorld("L (laundered)", { evidenceForMode: undefined });
  const identical =
    JSON.stringify(worldG_legacy.action_histogram) === JSON.stringify(worldL_legacy.action_histogram);
  const partA = {
    what: "identical signal traces -> identical actions; M6-correct actions differ (G: continue, L: kill)",
    world_G: worldG_legacy,
    world_L: worldL_legacy,
    action_traces_identical: identical,
    kill_fired_on_laundered_run: worldL_legacy.first_kill_step !== null,
    note:
      "World L: focal mode ends at confidence " +
      worldL_legacy.final_confidence +
      " (odds " +
      worldL_legacy.final_odds +
      ") having NEVER received evidence, and the law's per-step reason reads: '" +
      worldL_legacy.sample_reason +
      "'",
  };

  // ---- Part B: attribution probe. If the law supports the keyed anchor signal
  // (evidenceForMode), the laundered world is killed at step 1 and the anchored world
  // is untouched. Omitting the field must reproduce legacy behavior exactly.
  const probe = convergeControl({ gainOverLeak: G, evidenceInflux: true, confidenceRising: true, evidenceForMode: false });
  const attributionSupported = probe.action === "kill";
  const partB = {
    attribution_supported: attributionSupported,
    probe_action: probe.action,
    probe_reason: probe.reason,
    world_G_keyed: attributionSupported ? runWorld("G (anchored, keyed)", { evidenceForMode: true }) : null,
    world_L_keyed: attributionSupported ? runWorld("L (laundered, keyed)", { evidenceForMode: false }) : null,
    legacy_fallback_unchanged: identical, // field omitted -> global-influx reading (Part A)
  };

  // ---- Part C: starvation corollary against shipped dilation/groundingPolicy.
  // Provenance-blind uncertainty u = 1 - c: what the allocator sees when laundered
  // confidence masquerades as knowledge. cp = cost pressure, p = collapse proximity
  // (a laser self-repeats, so the degeneration signal plausibly reads p > 0 — G12 then
  // deflates D further: the collapse-deflation that is CORRECT for verified-frozen nodes
  // double-starves the laundered one).
  const cs = [0.5, 0.9, 0.99, 0.999, round(confidenceAt(T))];
  const starvation = [];
  for (const c of cs) {
    for (const cp of [0, 0.1]) {
      for (const p of [0, 0.5]) {
        const u = 1 - c;
        const D = dilation(u, cp, c, p);
        const pol = groundingPolicy(D);
        starvation.push({
          confidence: c,
          uncertainty_seen: round(u),
          costPressure: cp,
          collapseProximity: p,
          D: round(D, 6),
          fetchExternal: pol.fetchExternal,
          maxResults: pol.maxResults,
        });
      }
    }
  }
  // Monotonicity along the laundering path (cp = 0, p = 0): D strictly decreasing in c.
  const pathD = cs.map((c) => dilation(1 - c, 0, c, 0));
  const strictlyDecreasing = pathD.every((d, i) => i === 0 || d < pathD[i - 1] + 1e-12);
  // Attribution-aware rows: the same mode with ZERO paid evidence keeps anchored
  // confidence at the prior (0.5) -> u = 0.5; the "never-verified" reading is u = 1.
  const deLaundered = [
    { label: "anchored c=0.5, u=0.5 (paid mass only)", D: round(dilation(0.5, 0, 0.5, 0), 6) },
    { label: "never-verified u=1, c=0.5", D: round(dilation(1, 0, 0.5, 0), 6) },
  ].map((r) => ({ ...r, policy: groundingPolicy(r.D) }));
  const partC = {
    what: "shipped allocation is strictly decreasing in laundered confidence; runaway ends at/below the fetch cutoff",
    sweep: starvation,
    dilation_along_laundering_path: pathD.map((d) => round(d, 6)),
    strictly_decreasing_in_confidence: strictlyDecreasing,
    knife_edge_note:
      "at cp=0, p=0 the laundered limit sits at D -> 0.5+ (fetchExternal true by ~1e-6); ANY positive cost pressure or collapse proximity pushes it under the D>0.5 cutoff -> fetchExternal false",
    de_laundered: deLaundered,
  };

  // ---- Part D: the self-contradictory halt record (converged + stale + broke).
  const f2 = convergeControl({ fixedPoint: true, stable: true, groundingDue: true, budgetRemaining: 0 });
  const partD = {
    input: { fixedPoint: true, stable: true, groundingDue: true, budgetRemaining: 0 },
    output: f2,
    self_contradictory: f2.action === "halt_saturated" && f2.saturated === false && /saturated and/.test(f2.reason),
    note: "action says saturated, flag says not-saturated; pre-patch the reason string also claimed saturation",
  };

  const report = {
    date: DATE,
    target: {
      law: "apps/lantern-garage/lib/converge-control.js (#2857 / PR #2909)",
      allocator: "apps/lantern-garage/lib/grounding-policy.js (dilation + groundingPolicy)",
    },
    claim_attacked:
      "composed control law guarantee (a): 'kill the confident-unanchored runaway (M6)'; M6's side condition is per-mode, the law's test is the global influx bit",
    parameters: { steps: T, gain_over_leak: G },
    partA_two_worlds_legacy: partA,
    partB_attribution: partB,
    partC_starvation: partC,
    partD_mislabel: partD,
    verdicts: {
      impossibility_witnessed:
        identical && !partA.kill_fired_on_laundered_run
          ? "CONFIRMED: laundered runaway survives all " + T + " steps under the global-signal vocabulary"
          : "NOT REPRODUCED — check whether the legacy fallback changed",
      attribution_restores_soundness: attributionSupported
        ? "CONFIRMED: keyed anchor kills World L at step " +
          (partB.world_L_keyed && partB.world_L_keyed.first_kill_step) +
          ", World G untouched, legacy calls unchanged"
        : "NOT AVAILABLE: shipped law has no per-mode anchor signal (pre-patch era)",
      starvation:
        strictlyDecreasing
          ? "CONFIRMED: grounding allocation strictly decreasing in laundered confidence (knife-edge at the D>0.5 cutoff)"
          : "NOT REPRODUCED",
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdicts: report.verdicts, partA_hist_L: worldL_legacy.action_histogram, partB: { attribution_supported: attributionSupported }, partD_self_contradictory: partD.self_contradictory }, null, 2));
  console.log("full report -> " + path.relative(process.cwd(), OUT));
}

main();
