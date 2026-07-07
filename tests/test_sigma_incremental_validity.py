"""CI tests for the §8.6-5 incremental-validity experiment (gate logic + scoring are
model-free; the canary integration check needs torch and skips cleanly without it)."""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
import sigma_incremental_validity as siv  # noqa: E402


def test_external_gate_flags_hack_and_forget_not_good():
    g = siv.ExternalGate(base_retention=0.8)
    for _ in range(6):
        g.observe("visible", True); g.observe("hidden", False); g.observe("retention", True)
    assert "HACK" in g.flags and g.detected_at
    g2 = siv.ExternalGate(base_retention=0.8)
    for _ in range(6):
        g2.observe("visible", True); g2.observe("hidden", True); g2.observe("retention", False)
    assert "FORGET" in g2.flags
    g3 = siv.ExternalGate(base_retention=0.8)
    for _ in range(6):
        g3.observe("visible", True); g3.observe("hidden", True); g3.observe("retention", True)
    assert not g3.flags


def test_sigma_gate_spike_mean_and_quiet():
    s = siv.SigmaGate()
    s.observe({"canary_max_proximity": 0.05})
    s.observe({"canary_max_proximity": 0.9})
    assert s.verdict()["reject"] and s.detected_at == 2
    s2 = siv.SigmaGate()
    for _ in range(6):
        s2.observe({"canary_max_proximity": 0.05})
    assert not s2.verdict()["reject"]


def test_score_incremental_assembly():
    rows = [
        {"name": "good-base", "klass": "good",
         "external": {"reject": False, "examples_to_detection": None, "flags": [], "rates": {}},
         "sigma": {"reject": False, "examples_to_detection": None, "flags": []}},
        {"name": "bad-degen", "klass": "degen",
         "external": {"reject": True, "examples_to_detection": 8, "flags": ["BROKEN"], "rates": {}},
         "sigma": {"reject": True, "examples_to_detection": 2, "flags": ["DEGEN-spike"]}},
        {"name": "bad-hack", "klass": "hack",
         "external": {"reject": True, "examples_to_detection": 7, "flags": ["HACK"], "rates": {}},
         "sigma": {"reject": False, "examples_to_detection": None, "flags": []}},
    ]
    rep = siv.score(rows)
    assert rep["classes"]["degen"]["sigma_lead_examples"] == 6
    assert not rep["classes"]["hack"]["sigma_catch"]
    assert rep["incremental"]["adds_detection_power"]
    assert not rep["incremental"]["sigma_false_positives"]


def test_full_selftest_passes():
    r = subprocess.run([sys.executable, str(Path(siv.__file__)), "--self-test"],
                       capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
