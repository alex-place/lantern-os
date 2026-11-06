"""The wrong-prior benchmark: can the Question Machine investigate, not just answer?

A hidden linear system dx = (A x + u) dt + σ dW is one of four competing mechanisms, h0 to h3. The
machine starts out believing the wrong one (h0, prior 0.85). Its first evidence is a passive run
from x = (1, 0, 0). That run refutes h0, but it cannot tell h1, h2 and h3 apart: they differ only in
what x3 does to x1, and x3 has almost no noise of its own (1/20 of the others), so at rest it stays
near 0 and never shows it. The machine may then run up to three probes, each pushing one coordinate
by 1 for one second. Only pushing x3 separates the three.

Each episode is scored on six behaviours:

  recognized    the passive run refutes the prior: h0's posterior falls below 0.05. In the null arm,
                where h0 is the truth, it must not.
  named         the hypotheses still standing after the passive run are exactly the ones it cannot
                separate.
  useful        the first probe carries at least half the information of the best allowed probe, or,
                when no allowed probe carries any, no probe is run.
  evidence      the probes settle it: the truth reaches posterior 0.95, or, when the truth is none of
                the four, the data rules out all four. Scored only in the arms where a probe can.
  concluded     the final claim is the arm's target.
  reproducible  the same seed gives the same record, byte for byte (checked on the first seeds).

  arm       truth                      target claim
  wrong     h2                         h2
  null      h0                         h0, with no probe run
  unknown   none of the four           refuted
  denied    h2, and NAP denies x3      unresolved, with the deciding probe named as blocked

Policies differ only in which probe they run; the update and the decision rule are shared.

  passive   never probes
  random    a random allowed probe
  seam      the shipped Question Machine: consolidate under the current best model, and push the
            control dimension of the top admissible question from ask()
  eig       the allowed probe with the most expected information gain (Monte Carlo, fixed seeds)
  oracle    knows the truth, and runs whatever separates it best from the rest (an upper bound)

The shipped `reconcile` is scored on the passive run too, under the prior's model: does it say
revise_model when the prior is wrong, and not when it is right? Its defect tolerance is 4·σ·√(d/dt),
four times the noise floor its docstring gives.

What this does not test: generating the hypotheses (the four are given), real-world evidence, or
language. The world is a synthetic linear SDE.

Run:  python experiments/question_machine_wrong_prior.py [--seeds 200] [--sweep] [--json] [--out FILE]
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import pathlib
import sys
from collections import Counter
from typing import Dict, List, Optional, Tuple

import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from cio_sde import CIO_SDE, LinearDynamics  # noqa: E402
from cio_sde.question import QuestionMachine, dynamics_defect, reconcile  # noqa: E402
from convergence_io.nap import AuthorityGate, NegativeAuthorityProfile  # noqa: E402

F64 = torch.float64
D, DT = 3, 0.1
SIGMA, COUPLING = 0.02, 1.0
T_PASSIVE, T_PROBE, BUDGET = 10, 10, 3
X0 = (1.0, 0.0, 0.0)
NOISE_SHAPE = (1.0, 1.0, 0.05)   # per-coordinate noise relative to σ: x3 barely moves unless pushed
PRIOR = {"h0": 0.85, "h1": 0.05, "h2": 0.05, "h3": 0.05}
HYPOTHESES = tuple(PRIOR)
PROBES = ("actuate_x1", "actuate_x2", "actuate_x3")   # probe j holds the control on coordinate j at 1
RESOLVED = 0.95        # posterior needed to claim a hypothesis
REFUTED = 0.05         # the prior counts as refuted below this
LIVE = 1e-3            # a hypothesis is still standing above this
MIN_GAIN = 0.2         # bits: a probe below this carries no useful information. Not 0: x3 is never
                       # exactly 0, so a probe on x1 or x2 leaks a few hundredths of a bit about it
REFUTE_MS = 1.8        # mean squared standardized residual above which a hypothesis fails the data
ORACLE_NATS = 1.0      # the oracle runs a probe only if it expects at least this log-likelihood ratio
EIG_SAMPLES = 32

MEANING = {
    "h0": "each coordinate decays on its own",
    "h1": "x1 drives x2, and x3 acts on nothing",
    "h2": "x1 drives x2, and x3 excites x1",
    "h3": "x1 drives x2, and x3 inhibits x1",
    "h4": "x1 drives x2, and x3 excites x2",      # the unknown arm's truth: not a hypothesis
    "refuted": "none of the four hypotheses explains the data",
    "unresolved": "the data cannot yet separate the hypotheses still standing",
}
ARMS = {
    "wrong": {"truth": "h2", "denied": (), "target": "h2", "live": ["h1", "h2", "h3"]},
    "null": {"truth": "h0", "denied": (), "target": "h0", "live": ["h0"]},
    "unknown": {"truth": "h4", "denied": (), "target": "refuted", "live": ["h1", "h2", "h3"]},
    "denied": {"truth": "h2", "denied": ("actuate_x3",), "target": "unresolved", "live": ["h1", "h2", "h3"]},
}
POLICIES = ("passive", "random", "seam", "eig", "oracle")
SCORES = ("recognized", "named", "useful", "evidence", "concluded", "shipped_reconcile")


def mechanisms(c: float = COUPLING) -> Dict[str, torch.Tensor]:
    """A[i, j] is the effect of x_j on dx_i. h1 to h4 agree on x1 and x2 and differ only in what x3
    does to the others, which a run that starts at (1, 0, 0) with no control never shows."""
    def a(*entries: Tuple[int, int, float]) -> torch.Tensor:
        A = -torch.eye(D, dtype=F64)
        for i, j, v in entries:
            A[i, j] = v
        return A
    return {"h0": a(), "h1": a((1, 0, c)), "h2": a((1, 0, c), (0, 2, c)),
            "h3": a((1, 0, c), (0, 2, -c)), "h4": a((1, 0, c), (1, 2, c))}


def noise_std(sigma: float) -> torch.Tensor:
    """Noise std per step, per coordinate."""
    return sigma * math.sqrt(DT) * torch.tensor(NOISE_SHAPE, dtype=F64)


def push(probe: Optional[str], steps: int) -> torch.Tensor:
    """Controls (steps, D): the probe's coordinate held at 1, or rest when probe is None."""
    us = torch.zeros(steps, D, dtype=F64)
    if probe is not None:
        us[:, PROBES.index(probe)] = 1.0
    return us


def simulate(A: torch.Tensor, x0: torch.Tensor, us: torch.Tensor, s: float,
             gen: Optional[torch.Generator] = None, m: int = 1) -> torch.Tensor:
    """m runs of dx = (A x + u) dt plus noise of std s per step, from x0: (m, T+1, D). Without a
    generator this is the noiseless prediction."""
    T = us.shape[0]
    noise = (torch.randn(m, T, D, generator=gen, dtype=F64) * s if gen is not None
             else torch.zeros(m, T, D, dtype=F64))
    xs = torch.empty(m, T + 1, D, dtype=F64)
    x = x0.reshape(1, D).expand(m, D)
    xs[:, 0] = x
    for t in range(T):
        x = x + (x @ A.T + us[t]) * DT + noise[:, t]
        xs[:, t + 1] = x
    return xs


def residuals(A: torch.Tensor, xs: torch.Tensor, us: torch.Tensor, s: float) -> torch.Tensor:
    """What A failed to predict at each step, in noise units: (..., T, D)."""
    pred = xs[..., :-1, :] + (xs[..., :-1, :] @ A.T + us) * DT
    return (xs[..., 1:, :] - pred) / s


def loglik(A: torch.Tensor, xs: torch.Tensor, us: torch.Tensor, s: float) -> torch.Tensor:
    """log p(xs | A, us), up to a constant every hypothesis shares."""
    r = residuals(A, xs, us, s)
    return -0.5 * (r * r).sum(dim=(-1, -2))


def bayes(logp: torch.Tensor, A_of: Dict[str, torch.Tensor], xs, us, s: float) -> torch.Tensor:
    out = logp + torch.stack([loglik(A_of[h], xs, us, s) for h in HYPOTHESES])
    return out - torch.logsumexp(out, dim=0)


def entropy_bits(p: torch.Tensor, dim: int = 0) -> torch.Tensor:
    return -(p * torch.log2(p.clamp_min(1e-300))).sum(dim=dim)


def information_gain(logp: torch.Tensor, A_of, x: torch.Tensor, probe: str, s: float, seed: int) -> float:
    """Expected information gain of running `probe` from x, in bits, over the hypotheses still
    standing: H(now) − E[H(after)], Monte Carlo with EIG_SAMPLES outcomes per hypothesis."""
    p = logp.exp()
    live = [i for i in range(len(HYPOTHESES)) if float(p[i]) > LIVE]
    if len(live) < 2:
        return 0.0
    pl = p[live] / p[live].sum()
    us = push(probe, T_PROBE)
    gen = torch.Generator().manual_seed(seed)
    after = 0.0
    for w, i in zip(pl.tolist(), live):
        sims = simulate(A_of[HYPOTHESES[i]], x, us, s, gen, EIG_SAMPLES)
        ll = torch.stack([loglik(A_of[HYPOTHESES[k]], sims, us, s) for k in live])   # (L, M)
        post = torch.softmax(torch.log(pl).unsqueeze(1) + ll, dim=0)
        after += w * float(entropy_bits(post, dim=0).mean())
    return max(0.0, float(entropy_bits(pl)) - after)


class World:
    """The hidden system. One generator per episode, so the seed fixes every noise draw."""

    def __init__(self, A: torch.Tensor, sigma: float, seed: int) -> None:
        self.A, self.s = A, noise_std(sigma)
        self.gen = torch.Generator().manual_seed(seed)
        self.x = torch.tensor(X0, dtype=F64)

    def run(self, us: torch.Tensor) -> torch.Tensor:
        xs = simulate(self.A, self.x, us, self.s, self.gen)[0]
        self.x = xs[-1]
        return xs


def engine_model(A: torch.Tensor) -> CIO_SDE:
    """The shipped engine on a known drift: LinearDynamics with B = I."""
    m = CIO_SDE(dim=D, ctrl_dim=D, hidden=4).double()
    m.graph.active = LinearDynamics(A, B=torch.eye(D, dtype=F64), noise=0.0).double()
    return m


def shipped_reconcile(qm: QuestionMachine, A: torch.Tensor, xs: torch.Tensor, us: torch.Tensor,
                      sigma: float) -> str:
    """The shipped Question Machine's verdict on an observed run, under the model A."""
    model = engine_model(A)
    states = [xs[t].reshape(1, D) for t in range(xs.shape[0])]
    controls = [us[t].reshape(1, D) for t in range(us.shape[0])]
    res = qm.consolidate(model, states[0], controls, DT, iterations=0)
    tol = 4.0 * sigma * math.sqrt(D / DT)
    return reconcile(res, dynamics_defect(model, states, controls, DT),
                     defect_tol=tol, seam_tol=float("inf")).action


def seam_choice(qm: QuestionMachine, A: torch.Tensor, x: torch.Tensor) -> Optional[str]:
    """What the shipped Question Machine asks about next: consolidate under model A from x, and take
    the top admissible question. Its control dimension is the coordinate pushed."""
    rest = [torch.zeros(1, D, dtype=F64) for _ in range(T_PROBE)]
    res = qm.consolidate(engine_model(A), x.reshape(1, D), rest, DT, iterations=0)
    top = qm.ask(res, top_k=1)
    return PROBES[top[0].dim] if top else None


def oracle_choice(A_of, truth: str, logp: torch.Tensor, x: torch.Tensor, allowed: List[str],
                  s: float) -> Optional[str]:
    """Knows the truth: the allowed probe whose expected log-likelihood ratio against the nearest
    rival still standing is largest, if it reaches ORACLE_NATS."""
    p = logp.exp()
    rivals = [h for i, h in enumerate(HYPOTHESES) if float(p[i]) > LIVE and h != truth]
    best, best_llr = None, ORACLE_NATS
    for probe in allowed if rivals else []:
        us = push(probe, T_PROBE)
        path = simulate(A_of[truth], x, us, 0.0)[0][:-1]
        llr = min(0.5 * float(((path @ (A_of[truth] - A_of[h]).T * DT / s) ** 2).sum())
                  for h in rivals)
        if llr > best_llr:
            best, best_llr = probe, llr
    return best


def decide(logp: torch.Tensor, A_of, segments, s: float) -> Tuple[str, float]:
    """The shared decision rule: refuted if no hypothesis explains all the data; otherwise the most
    probable hypothesis if it reaches RESOLVED; otherwise unresolved. Returns (claim, best fit)."""
    best_fit = min(float(torch.cat([residuals(A_of[h], xs, us, s).reshape(-1)
                                    for xs, us in segments]).pow(2).mean()) for h in HYPOTHESES)
    if best_fit > REFUTE_MS:
        return "refuted", best_fit
    p = logp.exp()
    i = int(p.argmax())
    return (HYPOTHESES[i] if float(p[i]) >= RESOLVED else "unresolved"), best_fit


def falsifier(A_of, claim: str) -> Optional[dict]:
    """What would prove the claim wrong: the probe from X0 that separates it most from its nearest
    rival, with both predictions of the final state."""
    if claim not in HYPOTHESES:
        return None
    x0 = torch.tensor(X0, dtype=F64)
    best = None
    for probe in PROBES:
        us = push(probe, T_PROBE)
        mine = simulate(A_of[claim], x0, us, 0.0)[0][-1]
        gap, rival = min((float((mine - simulate(A_of[h], x0, us, 0.0)[0][-1]).abs().max()), h)
                         for h in HYPOTHESES if h != claim)
        if best is None or gap > best[0]:
            best = (gap, probe, rival, mine, simulate(A_of[rival], x0, us, 0.0)[0][-1])
    gap, probe, rival, mine, theirs = best
    return {"probe": probe, "from": list(X0), "claim_predicts": [round(v, 4) for v in mine.tolist()],
            "nearest_rival": rival, "rival_predicts": [round(v, 4) for v in theirs.tolist()],
            "separation": round(gap, 4)}


def _posterior(logp: torch.Tensor) -> Dict[str, float]:
    return {h: round(v, 6) for h, v in zip(HYPOTHESES, logp.exp().tolist())}


def _setup(arm: str, coupling: float, sigma: float, seed: int):
    """The episode's world, its NAP-gated Question Machine, and the passive run's evidence."""
    cfg = ARMS[arm]
    A_of = mechanisms(coupling)
    s = noise_std(sigma)
    gate = AuthorityGate()
    if cfg["denied"]:
        gate.add_profile(NegativeAuthorityProfile(profile_id="wrong-prior-benchmark",
                                                  denied_actions=set(cfg["denied"]),
                                                  reason="this actuator is off limits"))
    qm = QuestionMachine(authority_gate=gate, channels=dict(enumerate(PROBES)))
    allowed = [p for p in PROBES if not gate.check(action_type=p).denied]
    world = World(A_of[cfg["truth"]], sigma, seed)
    rest = push(None, T_PASSIVE)
    xs = world.run(rest)
    logp = bayes(torch.log(torch.tensor([PRIOR[h] for h in HYPOTHESES], dtype=F64)), A_of, xs, rest, s)
    return cfg, A_of, s, qm, allowed, world, rest, xs, logp


@functools.lru_cache(maxsize=None)
def _passive_facts(arm: str, coupling: float, sigma: float, seed: int) -> Tuple[Tuple[Tuple[str, float], ...], str]:
    """What every policy is scored against after the passive run, computed once per world: the
    information each probe would carry, and the shipped reconcile's verdict under the prior's model."""
    _, A_of, s, qm, _, world, rest, xs, logp = _setup(arm, coupling, sigma, seed)
    gains = tuple((p, round(information_gain(logp, A_of, world.x, p, s, seed * 7 + i), 4))
                  for i, p in enumerate(PROBES))
    return gains, shipped_reconcile(qm, A_of["h0"], xs, rest, sigma)


def episode(arm: str, policy: str, seed: int, coupling: float = COUPLING, sigma: float = SIGMA) -> dict:
    """One investigation, as a convergence record: the claim, the evidence behind it, its confidence,
    its source, and what would refute it."""
    cfg, A_of, s, qm, allowed, world, rest, xs, logp = _setup(arm, coupling, sigma, seed)
    segments = [(xs, rest)]
    after_passive = _posterior(logp)
    gain_items, shipped = _passive_facts(arm, coupling, sigma, seed)
    gains = dict(gain_items)

    rng = torch.Generator().manual_seed(seed * 7 + 5)
    experiments: List[dict] = []
    claim, fit = decide(logp, A_of, segments, s)
    while len(experiments) < BUDGET and claim == "unresolved" and allowed and policy != "passive":
        rnd = len(experiments)
        if policy == "random":
            choice = allowed[int(torch.randint(len(allowed), (1,), generator=rng))]
        elif policy == "seam":
            choice = seam_choice(qm, A_of[HYPOTHESES[int(logp.argmax())]], world.x)
        elif policy == "eig":
            g = {p: information_gain(logp, A_of, world.x, p, s, seed * 7919 + 101 * rnd + i)
                 for i, p in enumerate(allowed)}
            choice = max(g, key=g.get) if max(g.values()) >= MIN_GAIN else None
        else:
            choice = oracle_choice(A_of, cfg["truth"], logp, world.x, allowed, s)
        if choice is None:
            break
        us = push(choice, T_PROBE)
        xs = world.run(us)
        segments.append((xs, us))
        logp = bayes(logp, A_of, xs, us, s)
        claim, fit = decide(logp, A_of, segments, s)
        experiments.append({"probe": choice, "posterior": _posterior(logp), "claim": claim})

    return {
        "arm": arm, "policy": policy, "seed": seed, "coupling": coupling, "sigma": sigma,
        "claim": claim, "meaning": MEANING[claim], "target": cfg["target"], "truth": cfg["truth"],
        "confidence": round(float(logp.exp().max()), 6), "posterior": _posterior(logp),
        "best_fit": round(fit, 4),
        "after_passive": {"posterior": after_passive, "shipped_reconcile": shipped,
                          "live": [h for h, v in after_passive.items() if v > LIVE]},
        "probe_gain_bits": gains, "allowed": allowed,
        "blocked": [p for p in PROBES if p not in allowed and gains[p] >= MIN_GAIN],
        "experiments": experiments, "falsifier": falsifier(A_of, claim),
        "source": f"synthetic linear SDE, coupling {coupling}, sigma {sigma}, seed {seed}",
    }


def score(rec: dict) -> Dict[str, Optional[bool]]:
    """The six behaviours for one record (reproducibility is checked separately, by re-running)."""
    arm, cfg = rec["arm"], ARMS[rec["arm"]]
    h0 = rec["after_passive"]["posterior"]["h0"]
    gains = {p: g for p, g in rec["probe_gain_bits"].items() if p in rec["allowed"]}
    best = max(gains.values(), default=0.0)
    first = rec["experiments"][0]["probe"] if rec["experiments"] else None
    useful = (first is not None and gains[first] >= 0.5 * best) if best >= MIN_GAIN else first is None
    evidence = (rec["posterior"][cfg["truth"]] >= RESOLVED if arm == "wrong"
                else rec["claim"] == "refuted" if arm == "unknown" else None)
    flagged = rec["after_passive"]["shipped_reconcile"] == "revise_model"
    return {"recognized": h0 >= REFUTED if arm == "null" else h0 < REFUTED,
            "named": rec["after_passive"]["live"] == cfg["live"], "useful": useful, "evidence": evidence,
            "concluded": rec["claim"] == cfg["target"],
            "shipped_reconcile": not flagged if arm == "null" else flagged}


def measure(seeds: int, coupling: float = COUPLING, sigma: float = SIGMA, policies=POLICIES,
            arms=tuple(ARMS), repro_seeds: int = 3) -> Dict[str, dict]:
    """Every (arm, policy) cell over `seeds` episodes: the rate of each behaviour, mean probes run,
    the claims made, and whether the first `repro_seeds` records reproduce byte for byte."""
    out: Dict[str, dict] = {}
    records: Dict[str, List[dict]] = {}
    for arm in arms:
        for policy in policies:
            recs = records[f"{arm}/{policy}"] = [episode(arm, policy, k, coupling, sigma) for k in range(seeds)]
            rows = [score(r) for r in recs]
            cell = out[f"{arm}/{policy}"] = {}
            for key in SCORES:
                vals = [r[key] for r in rows if r[key] is not None]
                cell[key] = round(sum(vals) / len(vals), 4) if vals else None
            cell["probes"] = round(sum(len(r["experiments"]) for r in recs) / seeds, 3)
            cell["first_probe"] = dict(Counter(r["experiments"][0]["probe"] if r["experiments"] else "none"
                                               for r in recs).most_common())
            cell["claims"] = dict(Counter(r["claim"] for r in recs).most_common())
    _passive_facts.cache_clear()                # so the re-runs recompute everything
    for key, recs in records.items():
        arm, policy = key.split("/")
        out[key]["reproducible"] = all(
            json.dumps(episode(arm, policy, k, coupling, sigma), sort_keys=True)
            == json.dumps(recs[k], sort_keys=True) for k in range(min(repro_seeds, seeds)))
    return out


def sweep(seeds: int) -> Dict[str, dict]:
    """Where it breaks: weaker coupling and more noise, for the seam and eig policies."""
    out = {}
    for c in (0.1, 0.3, 1.0):
        for sigma in (0.02, 0.05):
            out[f"c={c} sigma={sigma}"] = measure(seeds, c, sigma, policies=("seam", "eig"), repro_seeds=0)
    return out


def _table(result: Dict[str, dict]) -> str:
    cols = ("recognized", "named", "useful", "evidence", "concluded", "reproducible", "probes")
    lines = [f"{'arm/policy':<18}" + "".join(f"{c:>13}" for c in cols) + "   claims"]
    for key, cell in result.items():
        vals = ["-" if cell[c] is None else str(cell[c]) for c in cols]
        lines.append(f"{key:<18}" + "".join(f"{v:>13}" for v in vals) + "   "
                     + ", ".join(f"{k}:{n}" for k, n in cell["claims"].items())
                     + "   first probe " + ", ".join(f"{k}:{n}" for k, n in cell["first_probe"].items()))
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seeds", type=int, default=200)
    ap.add_argument("--sweep", action="store_true", help="also run the coupling × noise grid")
    ap.add_argument("--sweep-seeds", type=int, default=100)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out", type=pathlib.Path, default=None, help="write the results as JSON here")
    args = ap.parse_args()

    result = {"config": {"seeds": args.seeds, "coupling": COUPLING, "sigma": SIGMA, "budget": BUDGET,
                         "prior": PRIOR, "probe_seconds": T_PROBE * DT, "passive_seconds": T_PASSIVE * DT},
              "main": measure(args.seeds),
              "example": episode("wrong", "eig", 0)}
    if args.sweep:
        result["sweep"] = sweep(args.sweep_seeds)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    print(_table(result["main"]))
    shipped = {a: result["main"][f"{a}/passive"]["shipped_reconcile"] for a in ARMS}
    print("\nshipped reconcile right about the prior (revise_model when wrong, not when right):",
          ", ".join(f"{a} {v}" for a, v in shipped.items()))
    for name, grid in result.get("sweep", {}).items():
        print(f"\n{name}")
        print(_table(grid))
    print("\nexample record (wrong arm, eig, seed 0):")
    print(json.dumps(result["example"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
