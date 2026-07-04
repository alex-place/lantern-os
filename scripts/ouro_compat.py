"""
ouro_compat.py — pure, dependency-free compatibility checks for the Ouro serving path.

Split out of ouro_serve.py so the decision logic is unit-testable WITHOUT importing
torch / transformers or loading the model (ouro_serve.py loads the model at import time).

Two things here: (1) `transformers_cache_risk()` reports when an Ouro model is served on a
transformers where the cache breaks; (2) `patch_universal_transformer_cache()` actually FIXES
it at runtime. Ouro's remote `UniversalTransformerCache` does `self.key_cache = []`, but
transformers >= 4.54 makes `Cache.key_cache` / `value_cache` READ-ONLY properties, so
`generate()` raises `property 'key_cache' has no setter`. **Empirically no stock version
fits** (measured 2026-07-04): >= 4.54 breaks the cache, while < 4.54 lacks Ouro's other
imports (`TransformersKwargs`, `check_model_inputs`, `GenericForQuestionAnswering`). So the
real fix is the runtime patch — it adds settable shadow properties to the imported class,
effect-equivalent to the community Antizana/ouro-cache-fix, and survives remote-code
re-downloads (we touch the class object, not the cached file).

Note: the Ouro model card's "transformers<4.56, recommended ==4.54.1" advice does NOT work
against the current remote code (rev 3aaa2224) — 4.54.1 also has the read-only property. Use
transformers 4.55.0 (matches the model config) + this patch.
"""
from __future__ import annotations

# transformers minor where Cache.key_cache became a read-only property (measured: 4.54.0);
# an Ouro model on this or newer needs patch_universal_transformer_cache().
OURO_CACHE_FIX_PIN = (4, 54, 0)


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

    at_risk is True (i.e. the cache patch is REQUIRED) only when BOTH:
      * the served model is an Ouro model (the recurrent-cache issue is Ouro-specific;
        a non-Ouro coder slot like Qwen is unaffected), AND
      * transformers >= 4.54 (where Cache.key_cache became a read-only property).
    ouro_serve.py applies patch_universal_transformer_cache() automatically, so this is an
    informational signal, not a blocker. message is a caller-facing string when at_risk.
    """
    if "ouro" not in str(model_id).lower():
        return False, ""
    if parse_transformers_version(tf_version) < OURO_CACHE_FIX_PIN:
        return False, ""
    return True, (
        f"transformers {tf_version} >= 4.54 while serving Ouro model '{model_id}': "
        f"Ouro's remote UniversalTransformerCache assigns to key_cache/value_cache, which are "
        f"read-only properties on transformers>=4.54, so generate() raises 'property has no "
        f"setter'. Pinning does NOT fix it (transformers<4.54 lacks Ouro's other imports). "
        f"The runtime patch_universal_transformer_cache() resolves it and is applied "
        f"automatically by ouro_serve.py."
    )


def patch_universal_transformer_cache():
    """Make Ouro's UniversalTransformerCache work on transformers >= 4.54.

    Ouro's remote modeling_ouro.py does `self.key_cache = []` / `self.value_cache = []`
    in its cache __init__, but transformers >= 4.54 makes `Cache.key_cache` /
    `Cache.value_cache` READ-ONLY properties, so stock transformers raises
    `property 'key_cache' has no setter` at generate() time. Empirically NO stock version
    fits: >= 4.54 has the property (breaks the cache), while < 4.54 lacks Ouro's other
    imports (`TransformersKwargs`, `check_model_inputs`, ...). So we patch the class at
    RUNTIME — adding settable shadow properties backed by private attrs — which also
    survives remote-code re-downloads (we touch the imported class object, not the file).
    Effect-equivalent to Antizana/ouro-cache-fix.

    Call AFTER the model loads (from_pretrained imports the remote module) and BEFORE
    generate(). Idempotent. Returns the patched module name, or None if the class is not
    imported yet (older transformers where the cache is already settable also returns a
    match and is a harmless no-op via the settable shadow).
    """
    import sys
    for name, mod in list(sys.modules.items()):
        cls = getattr(mod, "UniversalTransformerCache", None)
        if not isinstance(cls, type):
            continue
        if getattr(cls, "_lantern_cache_patched", False):
            return name
        for attr in ("key_cache", "value_cache"):
            priv = "_lantern_" + attr
            cls_prop = property(
                (lambda p: lambda self: getattr(self, p, None))(priv),
                (lambda p: lambda self, value: setattr(self, p, value))(priv),
            )
            setattr(cls, attr, cls_prop)
        cls._lantern_cache_patched = True
        return name
    return None
