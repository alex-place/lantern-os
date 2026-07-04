"""
ouro_compat.py — pure, dependency-free compatibility checks for the Ouro serving path.

Split out of ouro_serve.py so the decision logic is unit-testable WITHOUT importing
torch / transformers or loading the model (ouro_serve.py loads the model at import time).

The one check here today: Ouro's weight-tied recurrent KV cache broke under
transformers>=4.56 (an upstream Cache-API change). The community fix
(Antizana/ouro-cache-fix, folded into the model's remote `modeling_ouro.py`) restores it,
but a stock transformers>=4.56 against un-patched remote code degrades generation
SILENTLY — no exception, just worse tokens. We cannot introspect the remote code's patch
state from here, so the honest move is to surface the risk loudly at startup rather than
let the loop run calm-while-wrong.

Evidence: ByteDance/Ouro-1.4B model card ("transformers<4.56.0, recommended ==4.54.1";
Antizana/ouro-cache-fix). Grounded 2026-07-04.
"""
from __future__ import annotations

# First transformers minor that needs the remote-code cache fix for Ouro.
OURO_CACHE_FIX_PIN = (4, 56, 0)


def parse_transformers_version(v) -> tuple[int, int, int]:
    """'4.57.6' -> (4, 57, 6). Tolerant of suffixes ('4.56.0.dev0', '4.57.6+cu121').

    Non-numeric leading segments collapse to 0; short versions right-pad with 0.
    """
    parts: list[int] = []
    for seg in str(v).split(".")[:3]:
        num = ""
        for ch in seg:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return (parts[0], parts[1], parts[2])


def transformers_cache_risk(model_id, tf_version) -> tuple[bool, str]:
    """Pure decision. Returns (at_risk, message).

    at_risk is True only when BOTH:
      * the served model is an Ouro model (the recurrent-cache issue is Ouro-specific;
        a non-Ouro coder slot like Qwen is unaffected), AND
      * transformers >= 4.56 (the version where the cache broke).
    message is a caller-facing string when at_risk, else "".
    """
    if "ouro" not in str(model_id).lower():
        return False, ""
    if parse_transformers_version(tf_version) < OURO_CACHE_FIX_PIN:
        return False, ""
    return True, (
        f"transformers {tf_version} >= 4.56 while serving Ouro model '{model_id}': "
        f"the recurrent KV cache needs the Antizana/ouro-cache-fix remote-code patch or "
        f"generation degrades SILENTLY. Pin transformers<4.56 (recommended ==4.54.1), or "
        f"confirm the fix is present in the model's modeling_ouro.py. "
        f"Set OURO_STRICT_TRANSFORMERS=1 to hard-fail instead of warn."
    )
