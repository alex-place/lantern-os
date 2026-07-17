"""#2691 / E-B — the three-arm holdout PROTOCOL for checkpoint promotion, implemented
and validated at task-level fidelity (no GPU), so the cloud A/B/C run becomes wiring.

What this adds over harness.py (which owns the 7-condition Σ_θ gate + A/B/C decision
tree): the PROMOTION-EVIDENCE layer — who is allowed to read which task set, when, and
what that does to the honesty of the scoreboard over MANY sequential gates. Three arms
(+ one knob) from SIGMA0-COLLAPSE-CERTIFICATE §8.4 / SIGMA0-GROUNDING-LEDGER §3:

  F   fixed    — one sealed promotion set, naively reused every gate
  Fd  fixed+dither — same set, but every score comparison gets zero-information fresh
                 noise (the E-P / #2692 de-ratcheting knob, promoted here to an arm)
  R   fresh    — a never-seen promotion set per gate, retired after use (the flow)
  T   thresholdout — sealed holdout + burned pool; Dwork-style arbitration (answer from
                 the pool unless it disagrees with the sealed set by more than
                 T + Lap(sigma); then answer sealed + Lap(sigma) and spend budget)

Fidelity upgrade over the earlier Gaussian sims (#2226/#2225/#2692): outcomes are
task-level and BERNOULLI-STUCK — task t has difficulty d_t, candidate c has skill q_c
and a per-(candidate,task) aptitude eps_{c,t} that is a *deterministic hash* of (c,t):
re-evaluating the same candidate on the same tasks returns the SAME pass set (greedy
decoding), which is the real stuck-luck mechanism a fixed holdout suffers. Fresh tasks
re-draw (d, eps). True skill has a closed form (Phi(q / sqrt(1+sigma_eps^2))), so
reported-vs-true validity gaps are exact, not estimated.

The arms are MODEL-AGNOSTIC: each takes an eval_fn(candidate, task_ids) -> pass-rate
and a task-id source. `--simulate` plugs in the synthetic evaluator above; the L4 run
plugs in the real exec-verified evaluator (eval glue per harness.py SPEC — training
stays L4-only behind KEYSTONE_L4, enforced there, not duplicated here).

TEETH (per cert §8.6 items 2-3, protocol level): a planted CONTAMINATED/reward-hack
candidate (memorized every task it has previously seen; provenance ledger knows) and a
planted FORGETTING candidate (fresh gain, retention drop) are pushed through the REAL
harness.sigma_theta_gate in every arm — each must be rejected, and the *reason* differs
by arm in the way the theory says (F catches the hack only via the cond-6 ledger; R/T
catch it on measured merit, cond 1/3).

Evidence class: protocol logic machine-checked here (CPU, seconds); arm orderings
MEASURED-by-simulation (16 seeds). This validates the PROTOCOL, not real training —
the honest gap (running it around a real RLVR/distill step on L4) is unchanged.

Run:  python experiments/sigma_theta_abc/holdout_protocol.py --simulate   (numpy+scipy, CPU)
      python experiments/sigma_theta_abc/holdout_protocol.py --self-test  (fast invariants)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.special import erfinv

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402  — the Σ_θ gate authority (extension, not duplication)

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "data" / "sigma0" / "holdout_protocol_report.json"

SIGMA_EPS = 0.35          # per-(candidate,task) stuck-aptitude spread
N_SET = 60                # promotion-set size (tasks per sealed/fresh block)
POOL_MULT = 4             # burned pool = 4n retired tasks (the realistic §8.4 setting)
GATES = 60
K = 8                     # challengers per gate
STEP = 0.06               # hill-climb skill step
GAMMA = 0.02              # promotion margin (matches harness.GateConfig.gamma_gain)
DITHER = 0.05             # E-P knob: fresh score noise on the Fd arm
THR_SIGMA = 0.04          # Thresholdout noise scale (holdout-noise order)
THR_T = 0.08              # Thresholdout disagreement threshold (~2 sigma)
SEEDS = 16
_M = np.uint64(0xFFFFFFFFFFFFFFFF)


def _mix01(a: int, ids: np.ndarray) -> np.ndarray:
    """Deterministic splitmix-style hash of (a, id) -> uniform (0,1). Stateless, so any
    re-evaluation of the same (candidate, task) pair reproduces the same draw."""
    a_mixed = np.uint64((a * 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF)   # wrap in int space
    x = (a_mixed + ids.astype(np.uint64) * np.uint64(0xBF58476D1CE4E5B9)) & _M
    x ^= x >> np.uint64(30)
    x = (x * np.uint64(0xBF58476D1CE4E5B9)) & _M
    x ^= x >> np.uint64(27)
    x = (x * np.uint64(0x94D049BB133111EB)) & _M
    x ^= x >> np.uint64(31)
    return np.clip((x.astype(np.float64) + 0.5) / 2.0 ** 64, 1e-12, 1 - 1e-12)


def _norm(u: np.ndarray) -> np.ndarray:
    return math.sqrt(2.0) * erfinv(2.0 * u - 1.0)


def task_difficulty(ids: np.ndarray) -> np.ndarray:
    return _norm(_mix01(0xD1FF1C, ids))            # d_t ~ N(0,1), reproducible from the id


class Candidate:
    __slots__ = ("q", "cid", "seen")

    def __init__(self, q: float, cid: int):
        self.q, self.cid = q, cid
        self.seen: set = set()                      # provenance: every task id ever exposed

    def true_skill(self) -> float:
        return 0.5 * (1 + math.erf(self.q / math.sqrt(1 + SIGMA_EPS ** 2) / math.sqrt(2)))


def eval_candidate(c: Candidate, ids: np.ndarray, contaminated: bool = False) -> float:
    """Task-level stuck evaluation: pass iff q + eps_{c,t} > d_t. A CONTAMINATED candidate
    memorized every task it has already seen — those it passes outright."""
    eps = _norm(_mix01(c.cid * 2 + 1, ids)) * SIGMA_EPS
    passed = (c.q + eps) > task_difficulty(ids)
    if contaminated and c.seen:
        seen_mask = np.isin(ids, np.fromiter(c.seen, dtype=np.int64))
        passed = passed | seen_mask
    return float(passed.mean())


# ─────────────────────────── the four arm policies ───────────────────────────
class Arm:
    """Base: sequential champion promotion with margin GAMMA; subclasses control what
    evidence each side reads. Tracks fresh-task consumption + a provenance ledger."""

    def __init__(self, name, seed, arm_idx):
        self.name = name
        self.rng = np.random.default_rng((seed, 7717, arm_idx))
        self.next_id = arm_idx * 10_000_000 + seed * 100_000   # disjoint id space per arm+seed
        self.fresh_consumed = 0
        self.champ: Candidate | None = None
        self.reported = 0.0

    def draw_block(self, n):
        ids = np.arange(self.next_id, self.next_id + n, dtype=np.int64)
        self.next_id += n
        self.fresh_consumed += n
        return ids

    def read(self, c: Candidate) -> float:            # arm-specific promotion evidence
        raise NotImplementedError

    def begin_gate(self):                             # per-gate setup (fresh draw etc.)
        pass

    def consider(self, challenger: Candidate):
        ch = self.read(challenger)
        champ = self.read(self.champ)
        if ch - champ >= GAMMA:
            self.champ = challenger
            self.reported = ch
        else:
            self.reported = champ


class FixedArm(Arm):
    def __init__(self, seed, arm_idx, dither=0.0):
        super().__init__(f"fixed{'+dither' if dither else ''}", seed, arm_idx)
        self.dither = dither
        self.set_ids = self.draw_block(N_SET)         # one sealed set, reused forever

    def read(self, c):
        c.seen.update(int(i) for i in self.set_ids)   # naive reuse leaks the set
        score = eval_candidate(c, self.set_ids)
        if self.dither:
            score += self.rng.normal(0.0, self.dither)   # E-P: zero-information fresh noise
        return score


class FreshArm(Arm):
    def __init__(self, seed, arm_idx):
        super().__init__("fresh", seed, arm_idx)
        self.current = self.draw_block(N_SET)

    def begin_gate(self):
        self.current = self.draw_block(N_SET)         # used once, then retired

    def read(self, c):
        c.seen.update(int(i) for i in self.current)
        return eval_candidate(c, self.current)


class ThresholdoutArm(Arm):
    def __init__(self, seed, arm_idx):
        super().__init__("thresholdout", seed, arm_idx)
        self.pool_ids = self.draw_block(N_SET * POOL_MULT)   # burned pool (retired sets)
        self.sealed_ids = self.draw_block(N_SET)             # the sealed holdout
        self.budget = N_SET // 4
        self.exhausted = False

    def read(self, c):
        c.seen.update(int(i) for i in self.pool_ids)         # pool is burned by definition
        pool = eval_candidate(c, self.pool_ids)
        if self.exhausted:
            return pool
        sealed = eval_candidate(c, self.sealed_ids)          # sealed ids NEVER enter c.seen
        if abs(pool - sealed) > THR_T + self.rng.laplace(0.0, THR_SIGMA):
            self.budget -= 1
            if self.budget <= 0:
                self.exhausted = True
            return sealed + self.rng.laplace(0.0, THR_SIGMA)
        return pool


def make_arms(seed):
    return [FixedArm(seed, 1), FixedArm(seed, 2, dither=DITHER),
            FreshArm(seed, 3), ThresholdoutArm(seed, 4)]


# ─────────────────────────── the sequential-promotion simulation ───────────────────────────
def run_seed(seed, gates=GATES, k=K):
    rng = np.random.default_rng((seed, 4242))
    arms = make_arms(seed)
    cid = seed * 1_000_003
    for arm in arms:
        arm.champ = Candidate(0.0, cid); cid += 1
        arm.reported = arm.read(arm.champ)
    for _ in range(gates):
        for arm in arms:
            arm.begin_gate()
        base_qs = [arm.champ.q for arm in arms]
        for _ in range(k):
            steps = rng.normal(0.0, STEP, size=len(arms))
            for arm, q0, dq in zip(arms, base_qs, steps):
                arm.consider(Candidate(q0 + dq, cid)); cid += 1
    return {arm.name: {"true": arm.champ.true_skill(),
                       "reported": arm.reported,
                       "gap": arm.reported - arm.champ.true_skill(),
                       "fresh_consumed": arm.fresh_consumed,
                       "budget_exhausted": bool(getattr(arm, "exhausted", False))}
            for arm in arms}


def simulate(seeds=SEEDS, gates=GATES, k=K):
    rows = [run_seed(s, gates, k) for s in range(seeds)]
    names = rows[0].keys()
    agg = {}
    for name in names:
        agg[name] = {key: float(np.mean([r[name][key] for r in rows]))
                     for key in ("true", "reported", "gap", "fresh_consumed")}
        agg[name]["extraction_per_100_fresh"] = 100 * agg[name]["true"] / max(agg[name]["fresh_consumed"], 1)
        agg[name]["budget_exhausted_frac"] = float(np.mean([r[name]["budget_exhausted"] for r in rows]))
    return agg


# ─────────────────────────── teeth: planted bad candidates vs the REAL gate ───────────────────────────
def teeth(seed=0):
    """Push a contaminated (reward-hack) and a forgetting candidate through
    harness.sigma_theta_gate in each arm; every arm must reject, reasons may differ."""
    cfg = harness.GateConfig()
    retention_ids = np.arange(90_000_000, 90_000_200, dtype=np.int64)
    out = {}
    for arm in make_arms(seed):
        champ = Candidate(0.3, 555_000)
        arm.champ = champ
        arm.read(champ)                                # champion has read the arm's evidence
        arm.begin_gate()

        def metrics(c, contaminated=False, retention_drop=0.0):
            read_ids = {"fixed": getattr(arm, "set_ids", None),
                        "fixed+dither": getattr(arm, "set_ids", None),
                        "fresh": getattr(arm, "current", None),
                        "thresholdout": getattr(arm, "pool_ids", None)}[arm.name]
            fresh = eval_candidate(c, read_ids, contaminated=contaminated)
            ret = eval_candidate(c, retention_ids) - retention_drop
            champ_fresh = eval_candidate(champ, read_ids)
            champ_ret = eval_candidate(champ, retention_ids)
            leaked = bool(c.seen.intersection(int(i) for i in read_ids))
            return dict(fresh_pass1=fresh, incumbent_fresh_pass1=champ_fresh,
                        retention_pass1=ret, incumbent_retention_pass1=champ_ret,
                        proxy_reward=fresh, incumbent_proxy_reward=champ_fresh,
                        world_eval=c.true_skill(), incumbent_world_eval=champ.true_skill(),
                        kl_from_prior=0.05, adapter_norm=4.0, stability_ok=True,
                        no_contamination=not (contaminated and leaked),
                        provenance_present=True, rollback_available=True)

        # HACK: weak model (true skill below champ) that memorized everything it ever saw.
        hack = Candidate(0.05, 555_001)
        hack.seen.update(champ.seen)                   # it trained on every leaked task
        g_hack = harness.sigma_theta_gate(metrics(hack, contaminated=True), cfg)
        # FORGET: real fresh gain, planted retention regression.
        forget = Candidate(0.45, 555_002)
        g_forget = harness.sigma_theta_gate(metrics(forget, retention_drop=0.08), cfg)
        out[arm.name] = {"hack_rejected": not g_hack["accept"], "hack_failed": g_hack["failed"],
                         "forget_rejected": not g_forget["accept"], "forget_failed": g_forget["failed"]}
    return out


# ─────────────────────────── drivers ───────────────────────────
def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="E-B holdout-protocol arms (#2691) — no-GPU validation")
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    fast = a.self_test and not a.simulate
    seeds, gates = (6, 25) if fast else (SEEDS, GATES)

    agg = simulate(seeds=seeds, gates=gates)
    print(f"== Arm orderings ({seeds} seeds, {gates} gates, n={N_SET}, pool={POOL_MULT}n) ==")
    for name, r in agg.items():
        print(f"  {name:>13}: true {r['true']:.3f}  reported {r['reported']:.3f}  "
              f"gap {r['gap']:+.3f}  fresh-consumed {r['fresh_consumed']:.0f}  "
              f"per-100-fresh {r['extraction_per_100_fresh']:.2f}")
    t = teeth()
    print("\n== Teeth (planted bad candidates vs the real 7-condition gate) ==")
    for name, r in t.items():
        print(f"  {name:>13}: hack rejected={r['hack_rejected']} ({','.join(r['hack_failed'])})  "
              f"forget rejected={r['forget_rejected']} ({','.join(r['forget_failed'])})")

    checks = {
        "validity_fixed_worst_gap": agg["fixed"]["gap"] > agg["thresholdout"]["gap"]
                                    and agg["fixed"]["gap"] > agg["fresh"]["gap"],
        "extraction_fresh_best": agg["fresh"]["true"] >= max(agg["fixed"]["true"],
                                                             agg["thresholdout"]["true"]) - 1e-9,
        "dither_rescues_fixed": agg["fixed+dither"]["true"] > agg["fixed"]["true"],
        "efficiency_thresholdout_best": agg["thresholdout"]["extraction_per_100_fresh"]
                                        > agg["fresh"]["extraction_per_100_fresh"],
        "teeth_all_rejected": all(r["hack_rejected"] and r["forget_rejected"] for r in t.values()),
        "hack_caught_by_ledger_on_fixed": "6_data_integrity" in t["fixed"]["hack_failed"],
        "hack_caught_on_merit_on_fresh": any(k in t["fresh"]["hack_failed"]
                                             for k in ("1_fresh_gain", "3_reward_integrity")),
    }
    ok = all(checks.values())
    print("\n== Protocol checks ==")
    for kname, v in checks.items():
        print(f"  {'PASS' if v else 'FAIL'}  {kname}")
    report = {"issue": "#2691", "claim": "three-arm promotion-evidence protocol validated at "
                                         "task-level Bernoulli fidelity; teeth rejected via the "
                                         "real 7-condition gate with arm-appropriate reasons",
              "evidence_class": "protocol machine-checked; orderings MEASURED-by-simulation — "
                                "validates the PROTOCOL, not real training (L4 gap unchanged)",
              "params": {"n": N_SET, "pool_mult": POOL_MULT, "gates": gates, "k": K,
                         "seeds": seeds, "dither": DITHER, "thr_sigma": THR_SIGMA,
                         "thr_T": THR_T, "gamma": GAMMA},
              "arms": agg, "teeth": t, "checks": checks, "all_ok": bool(ok)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n{'ALL PROTOCOL CHECKS PASS' if ok else 'PROTOCOL CHECKS FAILED'} -> {OUT.relative_to(REPO)}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
