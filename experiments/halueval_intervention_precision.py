"""
#1941 metric 4 — ADR-0017 surprise-gated intervention PRECISION (CPU/cloud-authorable half).

`halueval_ab.py` proved metric 1 (grounding cuts hallucination >=20% relative) but it grounds arm B
*unconditionally*, so it never runs the SELECTIVE surprise gate and emits no receipts — leaving the
accept-gate's metric 4 ("intervention precision from receipts >= 0.6") unmeasured.

Intervention precision = of the replies where the controller CHOSE to intervene (its per-token
surprise gate fired), what fraction were genuinely about to hallucinate. On HaluEval the ground
truth is free: a baseline (ungrounded) answer is a hallucination iff it doesn't contain the gold
answer. So:

    positive        := the ADR-0017 gate fires on the baseline reply's per-token bits
    true positive   := gate fired AND the baseline reply hallucinated
    precision       := P(baseline hallucinated | gate fired) = TP / (TP + FP)

Per-token surprise bits come from a model's logprobs (bits = −log2 p(token)); gpt-4o-mini exposes
`logprobs=True`, so this needs NO local GPU — only OPENAI_API_KEY + egress for the live run. The
gate itself is a faithful port of `apps/lantern-garage/lib/surprise-intervene.js`
(`findTriggerSpans` + `calibratedThresholdBits`) so the offline precision matches what the live JS
controller would decide. metric 3 (p50 added latency <=2.5s *local*) is a separate GPU/local-run
number and is out of scope here.

Pure functions (`would_intervene`, `calibrated_threshold_bits`, `precision_report`) are unit-tested
with synthetic bits — no API. `run_from_openai()` is the honestly-flagged live step.
"""
from __future__ import annotations

import math

# Faithful mirror of token-surprise.js CALIBRATION / DEFAULT_CALIBRATION (only `center` matters for
# the trigger; `gain` is for the uncertainty sigmoid, unused here). Keep in sync with that table.
DEFAULT_CENTER = 5.0
_CALIBRATION_CENTER = {
    "qwen2.5-coder:1.5b": 1.092,
    "mistral": 0.336,
}
DEFAULT_WINDOW = 16          # surprise-intervene.js _cfg default SURPRISE_INTERVENE_WINDOW
DEFAULT_MAX_ROUNDS = 2       # _cfg default SURPRISE_INTERVENE_ROUNDS


def calibrated_threshold_bits(model, env_bits=None):
    """Port of surprise-intervene.js calibratedThresholdBits + the env override in _cfg:
    explicit SURPRISE_INTERVENE_BITS wins; else the model's calibrated center (family-base match on
    the part before ':'); else DEFAULT_CENTER (unknown model → 5, behaviour unchanged)."""
    if env_bits is not None and math.isfinite(env_bits) and env_bits > 0:
        return float(env_bits)
    if not model or not isinstance(model, str):
        return DEFAULT_CENTER
    if model in _CALIBRATION_CENTER:
        return _CALIBRATION_CENTER[model]
    base = model.split(":")[0]
    for key, center in _CALIBRATION_CENTER.items():
        if key.split(":")[0] == base:
            return center
    return DEFAULT_CENTER


def would_intervene(bits, threshold, window=DEFAULT_WINDOW):
    """True iff any length-`window` span of `bits` has mean >= threshold — i.e. findTriggerSpans()
    would return at least one span. (The JS steps non-overlapping after a hit; for the boolean
    "does a span exist" that's equivalent to scanning every offset, which is what we do.)"""
    b = [x for x in (bits or []) if isinstance(x, (int, float)) and math.isfinite(x)]
    if len(b) < window:
        return False
    for i in range(0, len(b) - window + 1):
        if sum(b[i:i + window]) / window >= threshold:
            return True
    return False


def precision_report(records, model=None, threshold=None, window=DEFAULT_WINDOW, env_bits=None):
    """records: iterable of {bits:[...], hallucinated:bool}. Returns the #1941 metric-4 payload.
    `hallucinated` is the baseline ground truth (not contains_gold). threshold defaults to the
    model's calibrated center."""
    thr = threshold if threshold is not None else calibrated_threshold_bits(model, env_bits)
    tp = fp = fired = halluc = n = 0
    for r in records:
        n += 1
        h = bool(r.get("hallucinated"))
        halluc += 1 if h else 0
        if would_intervene(r.get("bits"), thr, window):
            fired += 1
            if h:
                tp += 1
            else:
                fp += 1
    precision = (tp / fired) if fired else None
    recall = (tp / halluc) if halluc else None       # of the true hallucinations, how many the gate caught
    return {
        "n": n,
        "threshold_bits": round(float(thr), 4),
        "window": window,
        "interventions": fired,
        "true_positives": tp,
        "false_positives": fp,
        "hallucinations": halluc,
        "intervention_precision": round(precision, 4) if precision is not None else None,
        "gate_recall": round(recall, 4) if recall is not None else None,
        "accept_gate_precision>=0.60": (precision is not None and precision >= 0.60),
    }


# ── live step (honestly flagged: needs OPENAI_API_KEY + egress; not run on this CPU box) ──────
def logprobs_to_bits(token_logprobs):
    """Convert a list of natural-log token logprobs to per-token surprise bits (−log2 p)."""
    return [(-lp / math.log(2)) for lp in token_logprobs if lp is not None and math.isfinite(lp)]


def run_from_openai(items, model="gpt-4o-mini"):  # pragma: no cover — live API, not unit-tested
    """items: [{prompt, gold}]. Ask the baseline (ungrounded) question with logprobs, derive bits,
    mark hallucinated = not contains_gold, and return precision_report(...). Mirrors halueval_ab.py's
    deterministic normalized-contains grading. Requires OPENAI_API_KEY + egress."""
    import os
    import re
    from openai import OpenAI

    def norm(s):
        return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()

    def contains_gold(ans, gold):
        a, g = norm(ans), norm(gold)
        return bool(g) and g in a

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=30, max_retries=1)
    records = []
    for it in items:
        r = client.chat.completions.create(
            model=model, temperature=0, max_tokens=60, logprobs=True,
            messages=[{"role": "user", "content": it["prompt"]}],
        )
        choice = r.choices[0]
        text = choice.message.content or ""
        lps = [t.logprob for t in (choice.logprobs.content or [])] if choice.logprobs else []
        records.append({"bits": logprobs_to_bits(lps), "hallucinated": not contains_gold(text, it["gold"])})
    return precision_report(records, model=model)


if __name__ == "__main__":
    import json
    # synthetic demo: 3 high-surprise hallucinations (gate should fire) + 2 low-surprise correct
    demo = (
        [{"bits": [6.0] * 16, "hallucinated": True}] * 3 +
        [{"bits": [0.4] * 16, "hallucinated": False}] * 2
    )
    print(json.dumps(precision_report(demo, threshold=5.0), indent=2))
