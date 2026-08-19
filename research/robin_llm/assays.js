"use strict";
// The assay registry -- the executable half of the pipeline.
//
// THIS IS THE PIECE THAT KEEPS THE LOOP HONEST. Robin proposes an in vitro model and a human
// pipettes it. We have no pipette: a proposed LLM-design change is only an experiment if some
// harness in this repo can actually apply it and report a number. So a candidate is admitted
// only when it maps to (assay, knob, value) where `knob` is in that assay's `knobs` list.
// Anything else is recorded as UNRUNNABLE and reported as such -- never quietly counted as a
// result. (Robin hit the same wall and swapped photoreceptor outer segments for pHrodo beads
// "due to availability"; the difference is that here the swap is machine-checked.)
//
// Each assay declares:
//   cmd/args      how to run it (argv, no shell -- see lib/safe-exec.js reasoning)
//   knobs         the parameters a candidate may set, with their type and range
//   result        the JSON file it writes
//   metric        (result) -> number, HIGHER IS BETTER. One number is what BTL and the
//                 interpretation stage compare; the whole result JSON is kept as evidence.
//   noise         (result) -> the smallest metric delta that means anything, computed FROM THE
//                 RUN'S OWN COUNTS (a 2-standard-error band on the statistic, not a guess). A
//                 candidate inside this band is reported WITHIN NOISE, never IMPROVED. Without
//                 it the loop manufactures discoveries out of seed variation -- the first live
//                 round called +0.001 on a proportion with SE 0.010 an improvement.
//   control       (result) -> boolean, TRUE means the run's own null control held. A candidate
//                 that improves the metric while breaking the control is a REGRESSION, not a
//                 discovery. This is the check Robin's pipeline does not have.
//   requires      environment preconditions ("server", "providers"); unmet -> assay unavailable

const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const EC = path.join("research", "epistemic_controller");

// The design knobs of the epistemic controller, read from EC_* by controller.py. These are the
// real dials on the machine under test -- a candidate that sets one of these is a genuine design
// experiment; a candidate that asks for anything else is UNRUNNABLE and reported as such.
const CONTROLLER_KNOBS = {
  window:         { type: "int",   min: 10,   max: 120,  default: 30,   what: "residual window length" },
  mse_k:          { type: "float", min: 1.2,  max: 10,   default: 3.0,  what: "how far MSE must exceed baseline to enter SUSPECT" },
  alpha:          { type: "float", min: 0.001, max: 0.2, default: 0.05, what: "structure-test significance" },
  hold:           { type: "int",   min: 1,    max: 8,    default: 2,    what: "structured windows required before BOUNDARY" },
  budget:         { type: "float", min: 3,    max: 40,   default: 10.0, what: "measurement budget per episode" },
  retract_below:  { type: "float", min: 0.5,  max: 0.999, default: 0.94, what: "explained-variance bar below which a BOUNDARY is retracted" },
  cost_exponent:  { type: "float", min: 0,    max: 2,    default: 1.0,  what: "utility = explained / cost^e" },
  hold_steps:     { type: "int",   min: 0,    max: 200,  default: 40,   what: "steps an expansion is held as a hypothesis" },
};

// Two standard errors on a proportion p estimated from n observations. Used wherever the metric
// IS a proportion; the same arithmetic a Dunnett test would start from, kept explicit because a
// pipeline that cannot say "this delta is noise" will always find something.
function propBand(p, n) {
  if (!n || n <= 0) return Infinity;
  const q = Math.min(Math.max(p, 0), 1);
  return 2 * Math.sqrt(Math.max(q * (1 - q), 1e-6) / n);
}

const ASSAYS = {
  "controller-discovery": {
    what: "Validated regularities discovered per unit of experiment, over a sequence of hidden "
        + "rules. The closest thing we have to a discovery-rate benchmark for a reasoning loop.",
    cmd: "python",
    args: (p) => [path.join(EC, "run_discovery_benchmark.py"), String(p.seeds || 60)],
    knobs: { seeds: { type: "int", min: 10, max: 300, default: 60, what: "seeds per arm" }, ...CONTROLLER_KNOBS },
    env: (p) => envFor(p, ["window", "mse_k", "alpha", "hold", "budget", "retract_below", "cost_exponent", "hold_steps"]),
    result: path.join(EC, "results", "discovery_benchmark.json"),
    metric: (r) => r.summary["one-shot"].per_experiment,
    // discoveries/experiments: a rate whose numerator is a count of Bernoulli successes over
    // `possible` chances. Band from the discovery proportion, rescaled into per-experiment units.
    noise: (r) => {
      const a = r.summary["one-shot"];
      return propBand(a.discoveries / a.possible, a.possible) * (a.possible / a.experiments);
    },
    control: (r) => Object.values(r.null || {}).every((a) => a.discoveries === 0),
    control_what: "null world (drift, no hidden rule) yields zero discoveries in every arm",
    seconds: 200,
    requires: [],
  },
  "controller-two-explanations": {
    what: "Truth versus a cheaper proxy that fits the same data. Measures whether the selection "
        + "policy can be fooled by a plausible cheap explanation -- the LLM-design analogue of "
        + "preferring a shortcut feature.",
    cmd: "python",
    args: (p) => [path.join(EC, "run_world_h.py"), String(p.seeds || 200)],
    knobs: { seeds: { type: "int", min: 20, max: 400, default: 200, what: "seeds per arm" }, ...CONTROLLER_KNOBS },
    env: (p) => envFor(p, ["window", "mse_k", "alpha", "hold", "budget", "retract_below", "cost_exponent", "hold_steps"]),
    result: path.join(EC, "results", "world_h.json"),
    metric: (r) => r.arms.hold.truth_rate_among_two,
    noise: (r) => propBand(r.arms.hold.truth_rate_among_two, r.arms.hold.chose_true + r.arms.hold.chose_proxy),
    control: (r) => r.gates.hold.H4_pass === true,
    control_what: "H4: the original hidden-variable world does not regress",
    seconds: 120,
    requires: [],
  },
  "controller-self-diagnosis": {
    what: "Can the machine diagnose a defect in its own experiment-selection policy, and stay "
        + "silent when its failures have another cause? Two false-firing controls.",
    cmd: "python",
    args: (p) => [path.join(EC, "run_world_s.py"), String(p.seeds || 100)],
    knobs: { seeds: { type: "int", min: 20, max: 200, default: 100, what: "seeds per arm" }, ...CONTROLLER_KNOBS },
    env: (p) => envFor(p, ["window", "mse_k", "alpha", "hold", "budget", "retract_below", "cost_exponent", "hold_steps"]),
    result: path.join(EC, "results", "world_s.json"),
    metric: (r) => -r.H.self.exp_per_disc_late,          // fewer experiments per discovery is better
    // a ratio of two counts; propagate the discovery-proportion band into the ratio
    noise: (r) => {
      const v = r.H.self.validated_late, n = r.n_seeds * 3;
      return r.H.self.exp_per_disc_late * (propBand(v, n) / Math.max(v, 1e-6));
    },
    control: (r) => r.gates.S3_diagnosis_specific.PASS === true,
    control_what: "S3: the self-diagnosis does not fire in either control world",
    seconds: 600,
    requires: [],
  },
  "humaneval-chat": {
    what: "Real HumanEval driven through the product chat surface -- the only assay here that "
        + "measures an actual language model rather than a deterministic stand-in.",
    cmd: "python",
    args: (p) => {
      const a = [path.join("scripts", "eval_humaneval_chat.py"), "--limit", String(p.limit || 20)];
      if (p.provider) a.push("--provider", String(p.provider));
      if (p.route_intent) a.push("--route-intent", String(p.route_intent));
      if (p.agent) a.push("--agent", String(p.agent));
      return a;
    },
    knobs: {
      limit: { type: "int", min: 5, max: 164, default: 20, what: "problems to run" },
      provider: { type: "str", default: "", what: "which provider answers (ollama, anthropic, ...)" },
      route_intent: { type: "str", default: "", what: "chat route intent, e.g. coding_change" },
      agent: { type: "str", default: "", what: "assistant id" },
    },
    env: () => ({}),
    stdout_json: true,                                  // the harness prints its summary as the last JSON line
    metric: (r) => r["pass@1"],
    noise: (r) => propBand(r["pass@1"], r.n),
    control: () => true,
    control_what: "NONE. This assay has no null control; a result from it is weaker evidence "
                + "than one from the controller assays, and the report says so.",
    seconds: 900,
    requires: ["server", "providers"],
  },
};

// Knobs that are not command-line arguments are passed as environment variables, which is how
// the python harnesses already read overrides. Only declared knobs are forwarded.
function envFor(params, names) {
  const env = {};
  for (const n of names) {
    if (params[n] !== undefined && params[n] !== "") env[`EC_${n.toUpperCase()}`] = String(params[n]);
  }
  return env;
}

function list(available = {}) {
  return Object.entries(ASSAYS).map(([name, a]) => ({
    name, what: a.what, seconds: a.seconds, requires: a.requires,
    knobs: Object.keys(a.knobs),
    available: a.requires.every((r) => available[r]),
  }));
}

// A candidate is runnable iff its assay exists and every parameter it sets is a declared knob
// within range. Returns {ok, reason}.
function validate(candidate) {
  const a = ASSAYS[candidate.assay];
  if (!a) return { ok: false, reason: `unknown assay ${JSON.stringify(candidate.assay)}` };
  for (const [k, v] of Object.entries(candidate.params || {})) {
    const spec = a.knobs[k];
    if (!spec) return { ok: false, reason: `${candidate.assay} has no knob ${JSON.stringify(k)}` };
    if (spec.type === "int" || spec.type === "float") {
      const num = Number(v);
      if (!Number.isFinite(num)) return { ok: false, reason: `${k}=${v} is not a number` };
      if (spec.min !== undefined && num < spec.min) return { ok: false, reason: `${k}=${v} below min ${spec.min}` };
      if (spec.max !== undefined && num > spec.max) return { ok: false, reason: `${k}=${v} above max ${spec.max}` };
    }
  }
  return { ok: true, reason: "" };
}

module.exports = { ASSAYS, CONTROLLER_KNOBS, list, validate, ROOT };
