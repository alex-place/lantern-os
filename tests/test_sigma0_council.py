"""Machine-checks for the grounded Sigma0 council (experiments/sigma0_council.py).

The acid test: a council is only worth anything if it UPHOLDS grounded claims and
REJECTS fabricated / class-inflated ones. Each councilor grounds its verdict in a real
check (subprocess exit code, file resolution, artifact contents), so these tests exercise
those checks -- not opinions. Fast `python -c` verify_cmds (no pytest-in-pytest).
"""
from experiments.sigma0_council import convene, FABRICATED_CLAIM


def _decision(claim):
    return convene(claim)["decision"]


def test_council_rejects_fabricated_claim():
    """The headline: a 'SOTA 0.99' claim citing a nonexistent file must be REJECTED,
    and by MORE than one grounded lens (Auditor: cite missing; Calibrator: MEASURED
    unbacked; Skeptic: perfect+ungrounded)."""
    r = convene(FABRICATED_CLAIM)
    assert r["decision"] == "REJECTED"
    refuters = {name for name, _ in r["refutes"]}
    assert {"Auditor", "Calibrator", "Skeptic"} <= refuters, refuters


def test_council_rejects_class_inflation():
    """class PROVEN with nothing to execute -> Calibrator + Skeptic refute."""
    claim = {"text": "a grand theorem", "class": "PROVEN",
             "cite": "experiments/sigma0_council.py"}
    r = convene(claim)
    assert r["decision"] == "REJECTED"
    assert any(name == "Calibrator" for name, _ in r["refutes"])


def test_council_rejects_failing_verification():
    """A claim whose verify_cmd FAILS is refuted by the Executor (real subprocess)."""
    claim = {"text": "false thing", "class": "MEASURED",
             "cite": "experiments/sigma0_council.py",
             "verify_cmd": 'python -c "assert 1==2"'}
    r = convene(claim)
    assert r["decision"] == "REJECTED"
    assert any(name == "Executor" for name, _ in r["refutes"])


def test_council_upholds_a_grounded_claim():
    """Passing verify_cmd + resolving cite + present artifact + earned class -> UPHELD,
    with Executor, Auditor and Empiricist each grounding it."""
    claim = {"text": "arithmetic works", "class": "MEASURED",
             "cite": "experiments/sigma0_council.py::convene",
             "verify_cmd": 'python -c "assert 1+1==2"',
             "artifact": "experiments/sigma0_council.py", "expect": "def convene"}
    r = convene(claim)
    assert r["decision"] == "UPHELD", r
    grounders = {name for name, _ in r["grounds"]}
    assert {"Executor", "Auditor", "Empiricist"} <= grounders, grounders


def test_council_ungrounded_when_nothing_to_check():
    """A HEURISTIC claim with only a URL cite (unresolvable offline) and nothing to run
    is neither refuted nor grounded -> UNGROUNDED (honestly not upheld)."""
    claim = {"text": "a plausible design intuition", "class": "HEURISTIC",
             "cite": "https://example.com/paper"}
    r = convene(claim)
    assert r["decision"] == "UNGROUNDED", r


def test_every_councilor_grounds_in_a_real_check():
    """No councilor may return UPHOLD/REFUTE without touching reality: the Auditor must
    actually distinguish a resolving cite from a missing one."""
    ok = convene({"text": "x", "class": "HEURISTIC",
                  "cite": "experiments/sigma0_council.py"})
    missing = convene({"text": "x", "class": "HEURISTIC",
                       "cite": "experiments/does_not_exist_xyz.py"})
    a_ok = [v for v in ok["verdicts"] if v.councilor == "Auditor"][0]
    a_missing = [v for v in missing["verdicts"] if v.councilor == "Auditor"][0]
    assert a_ok.verdict == "UPHOLD" and a_missing.verdict == "REFUTE"
