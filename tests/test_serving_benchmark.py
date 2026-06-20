"""
Serving benchmark + validation tests (Phase 2 / issue #730).

All tests run without a live provider. The fixtures fake the
UnifiedAgentConnector so we can assert the *honesty contract*:

  - The model named on the CLI is the model actually queried (no longer
    decorative).
  - An offline-stub fallback is recorded as an error, never as provider data.
  - The FAST/DEEP validation thresholds gate exactly as the issue specifies,
    with the DEEP 70-85s latency band treated as a WARN for non-native runtimes.
"""

import json
import sys
from dataclasses import dataclass

import pytest

sys.path.insert(0, "src")

import serving_benchmark as sb  # noqa: E402
import unified_agent_connector as uac  # noqa: E402


# --------------------------------------------------------------------------- #
# Fake connector
# --------------------------------------------------------------------------- #
@dataclass
class FakeCfg:
    model: str = "default-model"
    api_key: str = "k"
    base_url: str = None
    temperature: float = 0.7
    max_tokens: int = 256
    timeout: float = 30.0


class FakeConnector:
    """Configurable stand-in for UnifiedAgentConnector.

    `behavior` and `seen_models` are class attributes so the no-arg constructor
    used by run_benchmark can still be steered from the test body.
    """

    behavior = "ok"          # ok | offline | empty | error
    seen_models = []

    def __init__(self):
        self._providers = {
            "ollama": FakeCfg(model="default-model"),
            "openai": FakeCfg(model="default-model"),
        }

    def stream(self, message, persona_id=None, provider=None, max_tokens=None,
               temperature=None, fallback=True, **kwargs):
        type(self).seen_models.append(self._providers[provider].model)
        behavior = type(self).behavior

        if behavior == "error":
            def gen():
                raise RuntimeError("provider exploded")
                yield  # pragma: no cover - makes this a generator
            return gen()

        if behavior == "offline":
            # Mirrors the real connector: yields stub words then returns a meta
            # dict tagged source=offline via StopIteration.
            def gen():
                for word in "the return door remembers".split():
                    yield word + " "
                return {"source": "offline", "provider": "offline",
                        "error": "all_providers_failed"}
            return gen()

        if behavior == "empty":
            def gen():
                return {}
                yield  # pragma: no cover
            return gen()

        # ok: mostly-unique text → high repetition ratio
        def gen():
            for word in f"unique reply about {message[:24]} alpha beta gamma delta".split():
                yield word + " "
            return {"source": "stream", "provider": provider}
        return gen()


@pytest.fixture(autouse=True)
def _wire_fake_connector(monkeypatch, tmp_path):
    """Swap in the fake connector and isolate leaderboard/report paths."""
    FakeConnector.behavior = "ok"
    FakeConnector.seen_models = []
    monkeypatch.setattr(uac, "UnifiedAgentConnector", FakeConnector)
    monkeypatch.setattr(sb, "LEADERBOARD_PATH", tmp_path / "leaderboard.jsonl")
    monkeypatch.setattr(sb, "REPORT_PATH", tmp_path / "REPORT.md")
    monkeypatch.delenv("OURO_NATIVE", raising=False)
    yield


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #
def test_repetition_ratio_empty_is_one():
    assert sb.calculate_repetition_ratio("") == 1.0


def test_repetition_ratio_all_unique_is_one():
    assert sb.calculate_repetition_ratio("a b c d e") == 1.0


def test_repetition_ratio_token_loop_is_low():
    # The ✅✅✅ failure mode: one word repeated 10x.
    assert sb.calculate_repetition_ratio("ok " * 10) == pytest.approx(0.1)


def test_estimate_cost_local_and_free_are_zero():
    assert sb.estimate_cost("ollama", 1000, "qwen2.5-coder") == 0.0
    assert sb.estimate_cost("groq", 1000, "llama-3.1-70b-versatile") == 0.0


def test_estimate_cost_paid_provider_is_positive():
    assert sb.estimate_cost("openai", 1_000_000, "gpt-4.1-mini") == pytest.approx(0.15)
    # Unknown model falls back to the provider's "*" rate, not zero.
    assert sb.estimate_cost("openai", 1_000_000, "mystery") == pytest.approx(0.15)


def test_parse_provider_specs():
    assert sb._parse_provider_specs("ollama:qwen2.5-coder, openai:gpt-4.1-mini") == [
        ("ollama", "qwen2.5-coder"), ("openai", "gpt-4.1-mini")]
    with pytest.raises(ValueError):
        sb._parse_provider_specs("no-colon-here")


def test_consume_stream_captures_return_meta():
    def gen():
        yield "hello "
        yield "world"
        return {"source": "offline"}
    text, meta = sb._consume_stream(gen())
    assert text == "hello world"
    assert meta == {"source": "offline"}


# --------------------------------------------------------------------------- #
# Honesty contract
# --------------------------------------------------------------------------- #
def test_cli_model_is_actually_queried():
    """The model named on the CLI must be pinned onto the provider config."""
    sb.run_benchmark("ollama", "qwen2.5-coder")
    assert FakeConnector.seen_models  # stream was called
    assert set(FakeConnector.seen_models) == {"qwen2.5-coder"}


def test_offline_stub_is_not_recorded_as_data():
    FakeConnector.behavior = "offline"
    result = sb.run_benchmark("ollama", "qwen2.5-coder")
    assert result["aggregates"] == {}                      # no fabricated metrics
    assert all("error" in r for r in result["runs"])       # every prompt errored
    assert any("offline" in r["error"] for r in result["runs"])


def test_empty_response_is_an_error():
    FakeConnector.behavior = "empty"
    result = sb.run_benchmark("ollama", "qwen2.5-coder")
    assert result["aggregates"] == {}
    assert any("empty" in r.get("error", "") for r in result["runs"])


def test_provider_failure_is_an_error_not_a_crash():
    FakeConnector.behavior = "error"
    result = sb.run_benchmark("ollama", "qwen2.5-coder")
    assert result["aggregates"] == {}
    assert any("provider exploded" in r.get("error", "") for r in result["runs"])


def test_unconfigured_provider_returns_error():
    result = sb.run_benchmark("groq", "llama-3.1-70b-versatile")
    assert result["error"].startswith("provider_not_configured")
    assert "groq" in result["error"]


def test_successful_run_produces_aggregates_and_records_mode():
    result = sb.run_benchmark("ollama", "qwen2.5-coder")
    agg = result["aggregates"]
    assert agg["success_rate"] == 1.0
    assert 0.0 < agg["avg_repetition_ratio"] <= 1.0
    assert result["mode"] == "fast"
    assert "decode_params" in result


# --------------------------------------------------------------------------- #
# Validation thresholds (#730 Definition of Done)
# --------------------------------------------------------------------------- #
def _fast_result(latency=1000, repetition=0.9, success=1.0, task_pass=True):
    return {
        "provider": "ollama", "model": "m", "mode": "fast",
        "aggregates": {
            "avg_latency_ms": latency, "avg_repetition_ratio": repetition,
            "success_rate": success, "total_cost_estimate_usd": 0.0,
        },
        "runs": [{"name": "t", "task": "reasoning", "task_pass": task_pass}],
    }


def test_fast_passes_when_within_contract():
    ok, checks = sb.validate_result(_fast_result())
    assert ok is True
    assert all(c["passed"] for c in checks if c["severity"] == "error")


def test_fast_fails_on_slow_latency():
    ok, _ = sb.validate_result(_fast_result(latency=3000))
    assert ok is False


def test_fast_fails_on_repetition_regression():
    # Below the 0.80 floor → token-loop territory → hard ERROR.
    ok, _ = sb.validate_result(_fast_result(repetition=0.70))
    assert ok is False


def test_fast_repetition_between_floor_and_target_is_warn_not_fail():
    # 0.82 is below the 0.85 target but above the 0.80 floor → WARN, gate passes.
    ok, checks = sb.validate_result(_fast_result(repetition=0.82))
    assert ok is True
    rep = next(c for c in checks if c["name"] == "repetition_ratio")
    assert rep["passed"] is False and rep["severity"] == "warn"


def test_fast_fails_on_low_success_rate():
    ok, _ = sb.validate_result(_fast_result(success=0.5))
    assert ok is False


def test_task_repetition_collapse_fails():
    ok, checks = sb.validate_result(_fast_result(task_pass=False))
    assert ok is False
    assert any(c["name"] == "no_task_repetition_collapse" and not c["passed"] for c in checks)


def test_deep_latency_band_is_warn_only():
    """A fast Ollama deep-mode run (1.5s) violates the 70-85s band but must not
    fail the gate — that band only binds the native Σ₀ runtime."""
    deep = {
        "provider": "ollama", "model": "m", "mode": "deep",
        "aggregates": {"avg_latency_ms": 1500, "avg_repetition_ratio": 0.82,
                       "success_rate": 1.0, "total_cost_estimate_usd": 0.0},
        "runs": [{"name": "t", "task": "reasoning", "task_pass": True}],
    }
    ok, checks = sb.validate_result(deep)
    assert ok is True
    latency_checks = [c for c in checks if "latency" in c["name"]]
    assert latency_checks and all(c["severity"] == "warn" for c in latency_checks)


def test_deep_still_fails_on_repetition_regression():
    deep = {
        "provider": "ollama", "model": "m", "mode": "deep",
        "aggregates": {"avg_latency_ms": 1500, "avg_repetition_ratio": 0.5,
                       "success_rate": 1.0, "total_cost_estimate_usd": 0.0},
        "runs": [{"name": "t", "task": "reasoning", "task_pass": True}],
    }
    ok, _ = sb.validate_result(deep)
    assert ok is False


def test_no_data_run_is_a_skip_not_a_failure():
    """Absent credentials (zero successful prompts) is a WARN/skip, not a regression."""
    ok, checks = sb.validate_result({"provider": "openai", "model": "m",
                                     "mode": "fast", "aggregates": {}, "runs": []})
    assert ok is True
    assert any(c["name"] == "has_data" and c["severity"] == "warn" for c in checks)


# --------------------------------------------------------------------------- #
# Leaderboard + report
# --------------------------------------------------------------------------- #
def test_append_and_load_roundtrip():
    sb.append_to_leaderboard(_fast_result(latency=1111))
    sb.append_to_leaderboard(_fast_result(latency=2222))
    rows = sb.load_leaderboard()
    assert len(rows) == 2
    assert rows[0]["aggregates"]["avg_latency_ms"] == 1111


def test_latest_per_config_keeps_most_recent():
    old = dict(_fast_result(), timestamp="2026-06-01T00:00:00")
    new = dict(_fast_result(), timestamp="2026-06-20T00:00:00")
    latest = sb._latest_per_config([old, new])
    assert len(latest) == 1
    assert latest[0]["timestamp"] == "2026-06-20T00:00:00"


def test_validate_leaderboard_fails_when_a_config_regresses():
    sb.append_to_leaderboard(dict(_fast_result(), timestamp="2026-06-20T00:00:00"))
    sb.append_to_leaderboard(dict(_fast_result(repetition=0.5),
                                  provider="ollama", model="bad",
                                  timestamp="2026-06-20T01:00:00"))
    assert sb.validate_leaderboard() is False


def test_write_report_renders_table(tmp_path):
    sb.append_to_leaderboard(dict(_fast_result(), timestamp="2026-06-20T00:00:00"))
    out = tmp_path / "r.md"
    sb.write_report(out)
    text = out.read_text(encoding="utf-8")
    assert "Serving Benchmark Leaderboard" in text
    assert "Distinct days with a successful run" in text


def test_main_run_gates_on_regression(monkeypatch):
    """`--run` on a regressing config returns exit 1 (per-run gate)."""
    FakeConnector.behavior = "ok"
    # Force a failing repetition by making the fake emit a token loop.
    monkeypatch.setattr(sb, "TASK_MIN_REPETITION_RATIO", 1.01)  # impossible floor
    rc = sb.main(["--run", "ollama:qwen2.5-coder", "--mode", "fast", "--no-append"])
    assert rc == 1
