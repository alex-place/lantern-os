"""
Lantern OS Serving Modes: Fast (default) vs. Deep (opt-in).

FAST MODE (product default):
  - Uses cached KV inference (UniversalTransformerCache in Ollama/Ouro)
  - Anti-repetition decode params enabled
  - Target: sub-2s replies for dream chat
  - Suitable for: interactive use, UX feedback, real-time systems

DEEP MODE (opt-in via OURO_NATIVE=1):
  - Native Σ₀ Q-exit loop (adaptive depth, grounded reasoning)
  - Higher reasoning latency (70-85s acceptable for research)
  - Suitable for: architecture decisions, grant writing, core system design

Detection:
  - OURO_NATIVE=1 in env → use deep mode
  - Otherwise → use fast cached mode (default)

Configuration per provider is immutable once set. Switching modes requires server restart.
"""

import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class ServingMode:
    """Describes inference behavior for a request."""
    name: str
    use_kv_cache: bool
    max_latency_ms: int
    decode_antirepetition: bool
    reasoning_depth: str  # "shallow" or "adaptive"
    description: str


FAST_MODE = ServingMode(
    name="fast",
    use_kv_cache=True,
    max_latency_ms=2000,
    decode_antirepetition=True,
    reasoning_depth="shallow",
    description="Cached KV inference with anti-repetition decode. Product default for interactive use.",
)

DEEP_MODE = ServingMode(
    name="deep",
    use_kv_cache=False,
    max_latency_ms=120000,
    decode_antirepetition=True,
    reasoning_depth="adaptive",
    description="Native Σ₀ Q-exit loop. Opt-in for architecture decisions and grounded reasoning.",
)


def get_serving_mode() -> ServingMode:
    """Determine which serving mode to use."""
    if os.environ.get("OURO_NATIVE", "").lower() in ("1", "true", "yes"):
        return DEEP_MODE
    return FAST_MODE


def serving_mode_for(dilation: Optional[float] = None) -> ServingMode:
    """Pick the serving mode for a given time-dilation — the within→without bridge.

    `OURO_NATIVE=1` still hard-forces DEEP. Otherwise escalate FAST→DEEP only when the
    dilation is high enough that `grounding_policy(D).deep_mode` is set (route by
    difficulty: a productively-uncertain turn earns the slow Σ₀ loop; a routine one
    stays on the sub-2s cached path). `dilation=None` ⇒ the env-based default.
    """
    base = get_serving_mode()
    if base.name == "deep" or dilation is None:
        return base
    try:
        from convergence_io.dilation import grounding_policy
        if grounding_policy(float(dilation)).deep_mode:
            return DEEP_MODE
    except Exception:
        pass
    return base


def get_decode_params(mode: ServingMode) -> dict:
    """Get decode parameters appropriate to the serving mode."""
    if not mode.decode_antirepetition:
        return {}

    # Fast mode: aggressive antirepetition to prevent token loops
    if mode.name == "fast":
        return {
            "top_p": 0.95,
            "frequency_penalty": 0.5,
            "repetition_penalty": 1.1,  # For Ollama
            "repeat_last_n": 64,         # For Ollama
        }

    # Deep mode: moderate antirepetition (adaptive loop may need some repetition for grounding)
    if mode.name == "deep":
        return {
            "top_p": 0.98,
            "frequency_penalty": 0.2,
            "repetition_penalty": 1.05,
            "repeat_last_n": 128,
        }

    return {}


def describe_mode() -> str:
    """Human-readable description of current mode."""
    mode = get_serving_mode()
    return f"[{mode.name.upper()}] {mode.description} (max {mode.max_latency_ms}ms)"


if __name__ == "__main__":
    mode = get_serving_mode()
    print(f"Current serving mode: {mode.name}")
    print(f"Description: {mode.description}")
    print(f"Decode params: {get_decode_params(mode)}")
