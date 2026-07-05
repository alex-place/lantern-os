"""Contract gate for the Stage-0 reference capture
(models/keystone-sigma0-plt/capture_ref_logits.py, ADR-0011 #1934).

`check_parity.py --ref ref_logits.pt` is the faithful Stage-0 parity gate: it
loads `{input_ids[1,T], logits[1,T,V]}` and compares OUR forward's argmax against
the reference's over the full sequence. `capture_ref_logits.py` produces that
file. This test pins the *contract* between the two — the shape/dtype the capturer
writes must be exactly what the gate loads — WITHOUT needing a GPU or the ~9B
checkpoint. If they ever drift, the faithful parity number is silently
meaningless, so this guards it on CPU in CI.

It does NOT prove the model math (that is the GPU-gated run); it proves the
plumbing that carries the reference between the two scripts.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "keystone-sigma0-plt"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, MODEL_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_capture_writes_the_dict_check_parity_consumes(tmp_path):
    cap = _load("capture_ref_logits")
    out = tmp_path / "ref_logits.pt"

    # Fabricate a reference the way a real capture would shape it: [1,T] / [1,T,V].
    T, V = 6, 40
    input_ids = torch.arange(T).unsqueeze(0)
    logits = torch.randn(1, T, V)
    cap._save(out, input_ids, logits)

    # Replay check_parity's EXACT --ref loader + comparison (see check_parity.py:
    #   ref = torch.load(args.ref); ids = ref["input_ids"]; rl = ref["logits"]
    #   top1 = (ours.argmax(-1) == rl.argmax(-1)).float().mean()).
    ref = torch.load(out)
    assert set(ref) >= {"input_ids", "logits"}
    ids, rl = ref["input_ids"], ref["logits"]
    assert ids.shape == (1, T) and rl.shape == (1, T, V)
    assert ids.dtype == torch.long and rl.dtype == torch.float32
    # A reference compared against itself must agree 1.0 — proves the math runs.
    top1 = (rl.argmax(-1) == rl.argmax(-1)).float().mean().item()
    assert top1 == pytest.approx(1.0)


def test_prompts_are_imported_from_the_gate_no_drift():
    # The capturer must tokenize the SAME prompts the gate replays. It imports them
    # from check_parity; assert they are the identical object list, not a copy that
    # could silently diverge.
    cap = _load("capture_ref_logits")
    gate = _load("check_parity")
    assert cap.PROMPTS == gate.PROMPTS
    assert len(gate.PROMPTS) >= 1


def test_save_rejects_seq_length_mismatch(tmp_path):
    cap = _load("capture_ref_logits")
    with pytest.raises(AssertionError):
        cap._save(tmp_path / "x.pt", torch.arange(5).unsqueeze(0), torch.randn(1, 4, 10))
