"""eval_keystone `native` engine — the CPU-measurable serve-kernel path (#2883).

The `native` engine runs AutoModelForCausalLM.generate in-process (bf16, greedy,
low_cpu_mem_usage), matching the ouro_serve DEFAULT kernel. Because greedy decoding is
deterministic in the weights, its pass@1 equals the GPU-served number token-for-token — so
a slow CPU run is a REAL measurement, and the golden leaderboard is producible without CUDA
or Ollama. These guards pin the wiring WITHOUT loading a model (CI has no GPU/weights):
the factory is importable, the CLI exposes the choice, and the row schema carries provenance.

  python -m pytest tests/test_eval_keystone_native.py -q
"""
import importlib.util
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT = os.path.join(ROOT, "scripts", "eval_keystone.py")


def _load_module():
    # importing runs no model code (torch is imported INSIDE make_native_engine, and main() is
    # guarded by __main__) — so this is zero-dep and safe in CI.
    spec = importlib.util.spec_from_file_location("eval_keystone_under_test", _SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_native_factory_is_importable_without_torch():
    m = _load_module()
    assert hasattr(m, "make_native_engine"), "native engine factory must exist"
    # the factory defers torch/transformers to call-time, so importing it must not require them
    assert callable(m.make_native_engine)


def test_native_is_a_cli_engine_choice():
    out = subprocess.run([sys.executable, _SCRIPT, "--help"],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert "native" in out.stdout, "native must be a selectable --engine choice"
    assert "--dtype" in out.stdout and "--limit" in out.stdout


def test_row_schema_carries_native_provenance():
    """The leaderboard summary dict must self-document a native run: engine + base_model +
    dtype + device. Asserted structurally against the source so a reviewer can trust the row
    says WHAT was measured (CPU bf16 kernel), not just the number."""
    src = open(_SCRIPT, encoding="utf-8").read()
    for field in ('"engine": a.engine', '"base_model":', '"dtype":', '"device":'):
        assert field in src, f"leaderboard row missing provenance field: {field}"
    # device is 'cpu' precisely when the native engine ran
    assert '("cpu" if a.engine == "native" else None)' in src
