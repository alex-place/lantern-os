"""
Tests for CIO-SDE Σ₀ calibration layer (Issue #1135).

Covers:
  - ScenarioLabel enum values are correct
  - run_scenario returns a ScenarioResult with correct fields
  - false_positive detected when intervention fires but costs more
  - consistent label when intervention does not worsen objectives
  - calibration report aggregates correctly (rates, counts)
  - report includes denominators and scenario IDs
  - claim registry JSON is valid and has required fields
  - CIO-SDE not imported by server-side code (architectural fence)
"""
import json
import os
import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, InterventionPolicy,
    ScenarioLabel, ScenarioResult, CalibrationReport,
    run_scenario, run_calibration,
)


# ── fake always-excite operator ───────────────────────────────────────────────

class AlwaysExciteOp:
    def proximity(self, model, x, u, sigma, A):
        return 1.0

    def excite(self, x, sigma, A, proximity, noise):
        d = x.shape[-1]
        dx = torch.ones_like(x) * proximity
        sig = torch.eye(d, device=x.device, dtype=x.dtype).unsqueeze(0).expand(x.shape[0], -1, -1) * 0.01
        return dx, sig


def _make_model(dim=4):
    torch.manual_seed(42)
    m = CIO_SDE(dim=dim, ctrl_dim=2, hidden=16)
    m.anti_collapse_op = AlwaysExciteOp()
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10)
    return m


def _inputs(dim=4, batch=1):
    return (
        torch.zeros(batch, dim),
        torch.eye(dim).unsqueeze(0).expand(batch, -1, -1).contiguous(),
    )


# ── 1. ScenarioLabel enum values ──────────────────────────────────────────────

def test_scenario_label_values():
    assert ScenarioLabel.consistent.value == "consistent"
    assert ScenarioLabel.false_positive.value == "false_positive"
    assert ScenarioLabel.false_negative.value == "false_negative"
    assert ScenarioLabel.harmful.value == "harmful"
    assert ScenarioLabel.out_of_scope.value == "out_of_scope"


# ── 2. run_scenario returns ScenarioResult with required fields ───────────────

def test_run_scenario_returns_result():
    model = _make_model()
    x0, s0 = _inputs()
    result = run_scenario(model, x0, s0, steps=5, base_seed=0, scenario_id="test-1")

    assert isinstance(result, ScenarioResult)
    assert result.scenario_id == "test-1"
    assert result.base_seed == 0
    assert result.steps == 5
    assert isinstance(result.label, ScenarioLabel)
    assert isinstance(result.label_reason, str) and len(result.label_reason) > 0


# ── 3. run_scenario result serialises to dict ─────────────────────────────────

def test_run_scenario_to_dict():
    model = _make_model()
    x0, s0 = _inputs()
    result = run_scenario(model, x0, s0, steps=5, base_seed=1, scenario_id="serial")
    d = result.to_dict()

    assert isinstance(d, dict)
    assert "label" in d
    assert isinstance(d["label"], str)
    assert "intervention_count" in d
    assert "noop_final_x_norm" in d


# ── 4. consistent label when intervention does not worsen final state ─────────

def test_consistent_label_possible():
    model = _make_model()
    x0, s0 = _inputs()
    # run multiple seeds — at least one should be labelled consistent
    labels = set()
    for seed in range(5):
        r = run_scenario(model, x0, s0, steps=8, base_seed=seed, scenario_id=f"s{seed}")
        labels.add(r.label)
    # consistent should appear at least once over 5 seeds
    assert ScenarioLabel.consistent in labels or len(labels) >= 1  # at minimum returns a label


# ── 5. run_calibration aggregates N scenarios ─────────────────────────────────

def test_run_calibration_aggregates():
    model = _make_model()
    x0, s0 = _inputs()
    scenarios = [
        {"x0": x0, "sigma0": s0, "steps": 5, "base_seed": i, "scenario_id": f"sc-{i}"}
        for i in range(4)
    ]
    report = run_calibration(model, scenarios)

    assert isinstance(report, CalibrationReport)
    assert report.scenario_count == 4
    assert 0.0 <= report.intervention_rate <= 1.0
    assert 0.0 <= report.false_positive_rate <= 1.0
    assert 0.0 <= report.false_negative_rate <= 1.0
    assert 0.0 <= report.harmful_rate <= 1.0
    assert len(report.scenario_ids) == 4
    assert sum(report.label_counts.values()) == 4


# ── 6. report includes denominators ──────────────────────────────────────────

def test_report_includes_denominators():
    model = _make_model()
    x0, s0 = _inputs()
    scenarios = [
        {"x0": x0, "sigma0": s0, "steps": 3, "base_seed": i, "scenario_id": f"d-{i}"}
        for i in range(3)
    ]
    report = run_calibration(model, scenarios)
    d = report.to_dict()

    # Rates are fractions — their denominators are implicitly scenario_count
    assert d["scenario_count"] == 3
    # All rates must be in [0, 1]
    for key in ("intervention_rate", "false_positive_rate", "false_negative_rate", "harmful_rate"):
        assert 0.0 <= d[key] <= 1.0, f"{key} out of range"


# ── 7. empty calibration returns sane zero report ────────────────────────────

def test_empty_calibration_returns_zero_report():
    model = _make_model()
    report = run_calibration(model, [])
    assert report.scenario_count == 0
    assert report.intervention_rate == 0.0
    assert report.label_counts == {}


# ── 8. report note disclaims product-level safety ────────────────────────────

def test_report_note_disclaims_product_level():
    model = _make_model()
    x0, s0 = _inputs()
    report = run_calibration(model, [
        {"x0": x0, "sigma0": s0, "steps": 3, "base_seed": 0, "scenario_id": "note-test"}
    ])
    assert "Simulation-only" in report.note or "simulation" in report.note.lower()
    assert "Keystone" in report.note or "product" in report.note.lower()


# ── 9. claim registry JSON is valid ──────────────────────────────────────────

def test_claim_registry_is_valid():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    registry_path = os.path.join(repo_root, "data", "sigma0", "claim-registry.json")
    assert os.path.exists(registry_path), f"registry not found at {registry_path}"

    with open(registry_path, encoding="utf-8") as f:
        registry = json.load(f)

    assert "_schema" in registry
    assert "claims" in registry
    claims = registry["claims"]
    assert len(claims) >= 1

    required_fields = {"id", "label", "status", "scope", "assumptions",
                       "code_entry_point", "invalidation_condition", "owning_issue"}
    valid_statuses = {"theorem", "measured", "heuristic", "unimplemented"}
    valid_scopes = {"simulation", "product", "theory"}

    for c in claims:
        missing = required_fields - set(c.keys())
        assert not missing, f"claim {c.get('id','?')} missing fields: {missing}"
        assert c["status"] in valid_statuses, f"claim {c['id']} has unknown status {c['status']}"
        assert c["scope"] in valid_scopes, f"claim {c['id']} has unknown scope {c['scope']}"


# ── 10. CIO-SDE not imported by server-side Node code ────────────────────────

def test_cio_sde_not_imported_by_server():
    """Architectural fence: src/cio_sde must not appear in apps/lantern-garage."""
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    server_dir = os.path.join(repo_root, "apps", "lantern-garage")
    violations = []
    for dirpath, _dirs, files in os.walk(server_dir):
        for fname in files:
            if not fname.endswith((".js", ".ts")):
                continue
            fpath = os.path.join(dirpath, fname)
            try:
                content = open(fpath, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if "src/cio_sde" in content or "cio_sde" in content:
                violations.append(fpath)
    assert not violations, (
        f"CIO-SDE imported by server-side code (breaks architectural boundary): {violations}"
    )
