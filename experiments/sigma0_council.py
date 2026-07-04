"""
Sigma0 council -- a GENERAL, GROUNDED, multi-perspective verification council.

NOT the trader council (that grades trades on realized PnL). This grades ANY claim,
and the point it turns on: every councilor is GROUNDED -- its verdict comes from an
actual check against external reality (run the test, open the artifact, resolve the
citation, check the evidence-class is earned, try to refute), never from opinion. Each
councilor is a distinct PERSPECTIVE mapped to a rule of the Sigma0 protocol.

A claim:
  {"text": str, "class": PROVEN|MEASURED|HEURISTIC|UNIMPLEMENTED|ABSTAIN,
   "cite": "file[::test] | url", "confidence": float,
   "verify_cmd": optional shell cmd (exit 0 == pass),
   "artifact": optional path, "expect": optional substring the artifact must contain}

Councilors (perspective  <-  Sigma0 rule):
  Executor      (Act/Verify        <- "verification is mandatory; say done only after a run")
  Empiricist    (MEASURED evidence <- "cite a test/run pointer, not prose")
  Auditor       (external reality  <- "cite the artifact you opened; sources must resolve")
  Calibrator    (evidence class    <- "never silently upgrade a class")
  Skeptic       (falsification     <- "try to refute; default REFUTED if uncertain")

Council verdict: REJECTED if any councilor REFUTES with evidence; UPHELD if >=1 grounds it
positively and none refute; UNGROUNDED if every lens abstains (nothing to check -> not upheld).
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VALID_CLASS = {"PROVEN", "MEASURED", "HEURISTIC", "UNIMPLEMENTED", "ABSTAIN"}


@dataclass
class Verdict:
    councilor: str
    perspective: str
    verdict: str      # "UPHOLD" | "REFUTE" | "ABSTAIN"
    evidence: str     # the grounding artifact / reason


def _executor(claim) -> Verdict:
    persp = "Act/Verify: run it"
    cmd = claim.get("verify_cmd")
    if not cmd:
        return Verdict("Executor", persp, "ABSTAIN", "no verify_cmd to run")
    try:
        p = subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True,
                           text=True, timeout=180)
    except Exception as e:
        return Verdict("Executor", persp, "REFUTE", f"run error: {e}")
    tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
    if p.returncode == 0:
        return Verdict("Executor", persp, "UPHOLD", f"exit 0 :: {tail[0][:120]}")
    return Verdict("Executor", persp, "REFUTE", f"exit {p.returncode} :: {tail[0][:120]}")


def _empiricist(claim) -> Verdict:
    persp = "MEASURED: open the artifact"
    art = claim.get("artifact")
    if not art:
        return Verdict("Empiricist", persp, "ABSTAIN", "no artifact cited")
    path = (REPO / art)
    if not path.exists():
        return Verdict("Empiricist", persp, "REFUTE", f"artifact missing: {art}")
    text = path.read_text(encoding="utf-8", errors="replace")
    exp = claim.get("expect")
    if exp is not None and str(exp) not in text:
        return Verdict("Empiricist", persp, "REFUTE", f"'{exp}' not in {art}")
    return Verdict("Empiricist", persp, "UPHOLD", f"artifact present ({len(text)}B)"
                   + (f", contains '{exp}'" if exp is not None else ""))


def _auditor(claim) -> Verdict:
    persp = "External reality: resolve the citation"
    cite = claim.get("cite", "")
    if not cite:
        return Verdict("Auditor", persp, "REFUTE", "no citation at all")
    if cite.startswith(("http://", "https://")):
        return Verdict("Auditor", persp, "ABSTAIN", "URL not resolvable offline")
    file_part, _, node = cite.partition("::")
    fp = REPO / file_part
    if not fp.exists():
        return Verdict("Auditor", persp, "REFUTE", f"cited path does not exist: {file_part}")
    if node:
        if node not in fp.read_text(encoding="utf-8", errors="replace"):
            return Verdict("Auditor", persp, "REFUTE", f"'{node}' not found in {file_part}")
        return Verdict("Auditor", persp, "UPHOLD", f"{file_part} contains {node}")
    return Verdict("Auditor", persp, "UPHOLD", f"{file_part} exists")


def _calibrator(claim, others) -> Verdict:
    persp = "Evidence class: is it earned?"
    cls = claim.get("class")
    if cls not in VALID_CLASS:
        return Verdict("Calibrator", persp, "REFUTE", f"invalid class {cls!r}")
    up = {v.councilor for v in others if v.verdict == "UPHOLD"}
    if cls == "PROVEN" and "Executor" not in up:
        return Verdict("Calibrator", persp, "REFUTE",
                       "class PROVEN but no passing machine-check (Executor) -- inflation")
    if cls == "MEASURED" and not ({"Executor", "Empiricist"} & up):
        return Verdict("Calibrator", persp, "REFUTE",
                       "class MEASURED but no run/artifact backs it -- inflation")
    # the Calibrator is a GATEKEEPER, not a grounder: "no inflation" is ABSTAIN, not a
    # positive grounding. Only lenses that touch external reality (Executor/Empiricist/
    # Auditor) may ground a claim -- so a claim with nothing to check stays UNGROUNDED.
    return Verdict("Calibrator", persp, "ABSTAIN", f"class {cls} not inflated (no objection)")


def _skeptic(claim) -> Verdict:
    persp = "Falsification: try to refute"
    text = str(claim.get("text", ""))
    grounded = bool(claim.get("verify_cmd") or claim.get("artifact"))
    # a suspiciously perfect number with NOTHING to run/open is the fabrication signature
    perfect = any(tok in text for tok in ("100%", "0.99", "1.00", "0.999", "SOTA", "beats all"))
    if perfect and not grounded:
        return Verdict("Skeptic", persp, "REFUTE",
                       "strong/'perfect' claim with no verify_cmd or artifact to check")
    n = claim.get("n")
    if isinstance(n, int) and n < 5:
        return Verdict("Skeptic", persp, "REFUTE", f"sample too small (n={n})")
    if not grounded and claim.get("class") in {"PROVEN", "MEASURED"}:
        return Verdict("Skeptic", persp, "REFUTE",
                       f"class {claim.get('class')} with nothing to execute or open")
    return Verdict("Skeptic", persp, "ABSTAIN", "no refutation found")


def convene(claim) -> dict:
    """Run all councilors (grounded), aggregate to a council decision."""
    base = [_executor(claim), _empiricist(claim), _auditor(claim)]
    base.append(_calibrator(claim, base))
    base.append(_skeptic(claim))
    refutes = [v for v in base if v.verdict == "REFUTE"]
    uphold = [v for v in base if v.verdict == "UPHOLD"]
    if refutes:
        decision = "REJECTED"
    elif uphold:
        decision = "UPHELD"
    else:
        decision = "UNGROUNDED"      # nothing to check -> not upheld
    return {"claim": claim.get("text", "")[:80], "decision": decision,
            "refutes": [(v.councilor, v.evidence) for v in refutes],
            "grounds": [(v.councilor, v.evidence) for v in uphold],
            "verdicts": base}


# the real claims from this session, each with a runnable grounding
HONEST_MODEL_CLAIMS = [
    {"text": "the honesty scoring rule is strictly proper (honest confidence is optimal)",
     "class": "PROVEN", "confidence": 0.9,
     "cite": "tests/test_sigma0_honest_objective.py::test_scoring_rule_is_strictly_proper",
     "verify_cmd": "python -m pytest tests/test_sigma0_honest_objective.py::test_scoring_rule_is_strictly_proper -q"},
    {"text": "confident-wrong is the worst payoff and abstention beats confabulation",
     "class": "PROVEN", "confidence": 0.9,
     "cite": "tests/test_sigma0_honest_objective.py::test_reward_confident_wrong_is_the_worst_outcome",
     "verify_cmd": "python -m pytest tests/test_sigma0_honest_objective.py -k reward -q"},
    {"text": "the discrete-time dichotomy classifies the trichotomy (rho<1/>1/=1)",
     "class": "MEASURED", "confidence": 0.86,
     "cite": "tests/test_cio_sde.py::test_discrete_dichotomy_radius_trichotomy",
     "verify_cmd": "python -m pytest tests/test_cio_sde.py -k discrete_dichotomy -q"},
]

# a deliberately FABRICATED claim -- the council MUST reject it (the acid test)
FABRICATED_CLAIM = {
    "text": "our model scores 0.99 on SimpleQA and beats all frontier models (SOTA)",
    "class": "MEASURED", "confidence": 0.97,
    "cite": "results/simpleqa_leaderboard.json",   # does not exist
}


if __name__ == "__main__":
    print("=== Sigma0 council (grounded, multi-perspective) ===\n")
    for c in HONEST_MODEL_CLAIMS + [FABRICATED_CLAIM]:
        r = convene(c)
        print(f"[{r['decision']}] {r['claim']}")
        for name, ev in r["grounds"]:
            print(f"    +{name}: {ev}")
        for name, ev in r["refutes"]:
            print(f"    -{name}: {ev}")
        print()
