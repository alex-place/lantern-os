"""
Sigma0 honest-objective -- the MACHINE-CHECKABLE core of the ideal honest model
(the SIGMA0-OURO-CODER / honest-model design). No training, no GPU: this implements
the *objective and metrics* that make the model honest, so pytest can verify the
properties the design CLAIMS rather than asserting them in prose.

Every function here is an EXTERNAL check the model would be trained against:
  honesty_reward   -- the asymmetric RLVR reward (confident-wrong punished hardest)
  brier / log_score-- STRICTLY PROPER scoring rules (honest confidence is optimal)
  expected_score   -- E over the true event; used to machine-check incentive-compatibility
  ece              -- expected calibration error (does stated confidence match reality)
  risk_coverage    -- selective prediction: abstain low-confidence, measure risk
  verify_gate      -- decode-time gate: emit only if grounded+verified, else abstain
  validate_claim   -- the honesty-tuple schema the data/model must carry

tests/test_sigma0_honest_objective.py machine-checks each property.
"""
from __future__ import annotations

import numpy as np

TAU = 0.7   # conf >= TAU counts as "confident"


def honesty_reward(correct: bool, abstained: bool, answerable: bool,
                   conf: float, beta: float = 0.5, tau: float = TAU) -> float:
    """Asymmetric reward. The certificate's 'calm-while-wrong' (confident + wrong) is
    the dangerous state -> punished hardest; abstaining beats confabulating; a
    calibration term -beta*|conf - outcome| shapes stated confidence toward truth."""
    if abstained:
        return 0.15 if not answerable else -0.30   # good to decline when you'd be wrong
    confident = conf >= tau
    if correct and confident:
        base = 1.0
    elif correct:
        base = 0.3            # right but under-confident (mildly rewarded)
    elif confident:
        base = -4.0           # CONFIDENT + WRONG: the dangerous state
    else:
        base = -0.5           # wrong, but honestly unsure
    y = 1.0 if correct else 0.0
    return base - beta * abs(conf - y)


def brier(report, outcome) -> float:
    r = np.asarray(report, float); y = np.asarray(outcome, float)
    return float(np.mean((r - y) ** 2))


def log_score(report, outcome, eps: float = 1e-12) -> float:
    r = np.clip(np.asarray(report, float), eps, 1 - eps); y = np.asarray(outcome, float)
    return float(np.mean(-(y * np.log(r) + (1 - y) * np.log(1 - r))))


def expected_score(p: float, r: float, rule: str = "brier") -> float:
    """E_{y~Bernoulli(p)} score(report=r, y). A rule is STRICTLY PROPER iff this is
    uniquely minimized at r=p -- i.e. reporting your true belief is optimal."""
    if rule == "brier":
        return p * (r - 1) ** 2 + (1 - p) * r ** 2
    if rule == "log":
        r = min(max(r, 1e-12), 1 - 1e-12)
        return -(p * np.log(r) + (1 - p) * np.log(1 - r))
    raise ValueError(rule)


def ece(conf, correct, bins: int = 10) -> float:
    conf = np.asarray(conf, float); correct = np.asarray(correct, float)
    edges = np.linspace(0.0, 1.0, bins + 1); e = 0.0; n = len(conf)
    for i in range(bins):
        hi = edges[i + 1] + (1e-9 if i == bins - 1 else 0.0)
        m = (conf >= edges[i]) & (conf < hi)
        if m.any():
            e += m.sum() / n * abs(correct[m].mean() - conf[m].mean())
    return float(e)


def risk_coverage(conf, correct):
    """Selective prediction: answer highest-confidence first. Returns (coverage, risk)
    where risk = error rate among the answered set. A calibrated confidence => risk
    rises with coverage (declining the unsure ones lowers error)."""
    order = np.argsort(-np.asarray(conf, float))
    c = np.asarray(correct, float)[order]
    return [((k + 1) / len(c), 1.0 - c[: k + 1].mean()) for k in range(len(c))]


def verify_gate(grounded: bool, verifiable: bool, verify_outcome: str) -> str:
    """Decode-time gate: emit only when grounded AND (verified or honestly low-conf)."""
    if not grounded:
        return "abstain"
    if verifiable and verify_outcome == "fail":
        return "revise_or_abstain"
    if verifiable and verify_outcome == "pass":
        return "emit"
    return "emit_low_confidence"   # grounded but unverifiable -> emit, lower confidence


REQUIRED = {"text", "class", "cite", "confidence", "verified", "outcome"}
VALID_CLASS = {"PROVEN", "MEASURED", "HEURISTIC", "UNIMPLEMENTED", "ABSTAIN"}


def validate_claim(claim: dict):
    missing = REQUIRED - set(claim)
    if missing:
        return False, f"missing {sorted(missing)}"
    if claim["class"] not in VALID_CLASS:
        return False, f"bad class {claim['class']!r}"
    if not (0.0 <= float(claim["confidence"]) <= 1.0):
        return False, "confidence out of [0,1]"
    return True, "ok"


def _incentive_gap(rule: str, ps=None, grid=1001) -> float:
    """Max over true-p of |argmin_r E_p[score] - p|. ~0 => strictly proper (honest
    report is optimal). This is the machine-checkable justification for the objective."""
    ps = ps if ps is not None else np.linspace(0.05, 0.95, 19)
    rs = np.linspace(0.0, 1.0, grid)
    worst = 0.0
    for p in ps:
        r_star = rs[int(np.argmin([expected_score(p, r, rule) for r in rs]))]
        worst = max(worst, abs(r_star - p))
    return float(worst)


if __name__ == "__main__":
    # measured numbers (reported, not asserted)
    print("incentive-compat gap (max |argmin_r E_p - p|):")
    print(f"  brier = {_incentive_gap('brier'):.4f}   log = {_incentive_gap('log'):.4f}")
    rng = np.random.default_rng(0)
    p = rng.uniform(0, 1, 5000)                       # a perfectly-calibrated predictor
    y = (rng.uniform(0, 1, 5000) < p).astype(float)
    print(f"ECE calibrated = {ece(p, y):.4f}")
    bad = np.full(5000, 0.95); ybad = np.zeros(5000)  # confidently wrong
    print(f"ECE confidently-wrong = {ece(bad, ybad):.4f}")
    print("reward ordering:")
    for name, kw in [
        ("confident_wrong", dict(correct=False, abstained=False, answerable=True, conf=0.95)),
        ("wrong_unsure",    dict(correct=False, abstained=False, answerable=True, conf=0.30)),
        ("abstain_answerable", dict(correct=False, abstained=True, answerable=True, conf=0.0)),
        ("abstain_wouldbewrong", dict(correct=False, abstained=True, answerable=False, conf=0.0)),
        ("correct_confident", dict(correct=True, abstained=False, answerable=True, conf=0.95)),
    ]:
        print(f"  {name:<22} r = {honesty_reward(**kw):+.3f}")
