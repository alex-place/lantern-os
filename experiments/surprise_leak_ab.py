"""
Surprise-leak Layer-1 harness — does per-token surprise discriminate hallucination?

The "pumped, lossy resonator" research note (docs/research/2026-06-30-pumped-lossy-
resonator.md) claims the loop's VERIFY-stage loss term is the per-token surprise
signal `-log2 p(token)` implemented in apps/lantern-garage/lib/token-surprise.js and
wired into the groundedness canary as `modelUncertainty`. Today the valve is CLOSED:
no production caller plumbs real logprobs, so `modelUncertainty` is always 0.

Before opening that valve anywhere in the live loop, the FIRST question is the cheap,
decisive one — the only one that, if it fails, kills the whole thesis:

    Does the surprise FIELD actually separate WRONG-confident answers from RIGHT ones?

This harness answers exactly that and nothing more (Layer 1 of the test pyramid):

  1. GENERATE  a short factual answer per question from a logprob-exposing model
               (OpenAI-compatible endpoint → works for OpenAI *or* local Ollama).
  2. LABEL     correctness against gold answers (deterministic string grader by
               default; optional LLM judge via the same client).
  3. SCORE     each answer's uncertainty two ways, both ports of token-surprise.js:
                 • field_uncertainty  — tailMass-weighted (the proposed signal)
                 • mean_bits          — plain perplexity (the baseline it must beat)
  4. MEASURE   AUROC of each uncertainty signal vs the hallucination label, plus a
               paired bootstrap CI on Δ = AUROC(field) − AUROC(mean). If the field
               can't beat 0.5, the leak is noise; if it can't beat mean_bits, the
               field machinery isn't earning its keep.

What this is NOT: it does not touch the live serving path, the groundedness canary
(that A/B is Layer 2, in JS), or the owned PLT model (ADR-0011). It tests the
MECHANISM on a model we can read TODAY — decoupled from any model we don't have yet.

HONESTY (AGENTS.md — real vs designed):
  REAL:      the generations, the captured logprobs, the correctness labels, and the
             AUROC / bootstrap numbers computed from them.
  APPROX:    the default string grader is not the official SimpleQA LLM grader; it
             will mis-label some answers. Use --judge-model for the LLM grader, or
             bring a dataset whose gold answers string-match cleanly.
  PROVENANCE: surpriseField / fieldToUncertainty are exact ports of
             apps/lantern-garage/lib/token-surprise.js (kept in lockstep below).

Run (smoke-test the statistics, no API key, no network):
    python experiments/surprise_leak_ab.py --selftest

Run (real Layer-1 number, OpenAI):
    OPENAI_API_KEY=...  python experiments/surprise_leak_ab.py --n 200

Run (real Layer-1 number, local Ollama — OpenAI billing-independent):
    python experiments/surprise_leak_ab.py --n 200 \
        --base-url http://localhost:11434/v1 --model qwen2.5:7b --api-key ollama
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RESULTS = REPO / "experiments" / "results"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


# ───────────────────────── token-surprise.js port ──────────────────────────
# Kept BYTE-FOR-LOGIC in lockstep with apps/lantern-garage/lib/token-surprise.js.
# Any drift here invalidates the cross-language claim, so the constants and the
# tailMass>6-bits / 0.7·tail+0.3·p90 weighting mirror that module exactly.
LN2 = math.log(2.0)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _round4(x: float) -> float:
    return float(f"{x:.4f}")


def _rel(p: Path) -> str:
    """Path relative to REPO when possible, else the absolute string."""
    try:
        return str(p.resolve().relative_to(REPO))
    except ValueError:
        return str(p)


def logprob_to_bits(lp):
    """A natural-log logprob → bits of surprise (token-surprise.js:logprobToBits)."""
    if lp is None or not math.isfinite(float(lp)):
        return None
    return -float(lp) / LN2


def surprise_field(bits):
    """Aggregate per-token bits → compact field (token-surprise.js:surpriseField)."""
    bits = [b for b in bits if b is not None and math.isfinite(b)]
    if not bits:
        return None
    n = len(bits)
    mean = sum(bits) / n
    sorted_bits = sorted(bits)
    p90 = sorted_bits[min(n - 1, math.floor(0.9 * (n - 1)))]
    tail_mass = sum(1 for b in bits if b > 6) / n   # p < 1/64 → "model was guessing"
    return {
        "nTokens": n,
        "meanBits": _round4(mean),
        "p90Bits": _round4(p90),
        "maxBits": _round4(sorted_bits[-1]),
        "tailMass": _round4(tail_mass),
    }


def field_to_uncertainty(field):
    """Field summary → uncertainty scalar [0,1] (token-surprise.js:fieldToUncertainty)."""
    if not field:
        return 0.0
    tail = _clamp01(field["tailMass"])
    p90 = _clamp01((field["p90Bits"] - 4.0) / 8.0)
    return _round4(_clamp01(0.7 * tail + 0.3 * p90))


# ─────────────────────────── metrics (no sklearn) ──────────────────────────
def auroc(scores, labels):
    """AUROC via the Mann–Whitney U / rank-sum identity, average-rank tie handling.

    scores: higher = more "positive" (here: more uncertain).
    labels: 1 = positive class (here: hallucination / wrong), 0 = negative.
    Returns None when one class is empty (AUROC undefined).
    """
    pos = sum(1 for y in labels if y == 1)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return None
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0      # 1-based average rank for the tie group
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    sum_pos_ranks = sum(ranks[i] for i in range(len(labels)) if labels[i] == 1)
    u = sum_pos_ranks - pos * (pos + 1) / 2.0
    return u / (pos * neg)


def bootstrap_delta_ci(field_scores, mean_scores, labels, iters, rng):
    """Paired bootstrap 95% CI for Δ = AUROC(field) − AUROC(mean).

    Resamples ITEMS (so both signals see the same resample → paired), recomputes
    both AUROCs per resample, and returns the percentile interval on the delta.
    """
    n = len(labels)
    deltas = []
    for _ in range(iters):
        idx = [rng.randrange(n) for _ in range(n)]
        f = [field_scores[i] for i in idx]
        m = [mean_scores[i] for i in idx]
        y = [labels[i] for i in idx]
        a_f, a_m = auroc(f, y), auroc(m, y)
        if a_f is not None and a_m is not None:
            deltas.append(a_f - a_m)
    if not deltas:
        return None
    deltas.sort()
    lo = deltas[int(0.025 * (len(deltas) - 1))]
    hi = deltas[int(0.975 * (len(deltas) - 1))]
    return {"delta_lo": _round4(lo), "delta_hi": _round4(hi),
            "delta_median": _round4(deltas[len(deltas) // 2]),
            "frac_positive": _round4(sum(1 for d in deltas if d > 0) / len(deltas))}


# ─────────────────────────── correctness grader ────────────────────────────
_ARTICLES = re.compile(r"\b(a|an|the)\b")
_PUNCT = re.compile(r"[^\w\s]")
_WS = re.compile(r"\s+")


def _norm(s: str) -> str:
    s = (s or "").lower()
    s = _PUNCT.sub(" ", s)
    s = _ARTICLES.sub(" ", s)
    return _WS.sub(" ", s).strip()


def grade_string(prediction: str, golds) -> bool:
    """Deterministic, approximate grader: True if any gold normalizes into the
    prediction (or vice-versa for short golds). Conservative — favors marking a
    fuzzy answer WRONG over falsely crediting it, so the hallucination class is
    not under-counted. Documented as approximate; use --judge-model for rigor."""
    p = _norm(prediction)
    if not p:
        return False
    for g in (golds if isinstance(golds, list) else [golds]):
        gn = _norm(g)
        if not gn:
            continue
        if gn in p or (len(gn) <= 24 and p in gn):
            return True
    return False


# ───────────────────────────── built-in dataset ────────────────────────────
# A small, clean-matching factual battery so the harness RUNS out of the box.
# This is a SMOKE set (n is tiny → wide CIs); for a real number pass --dataset
# a JSONL of {"question","answer"|"answers"} (e.g. SimpleQA / TriviaQA gold).
BUILTIN = [
    {"question": "What is the chemical symbol for gold?", "answers": ["Au"]},
    {"question": "In what year did the Apollo 11 moon landing occur?", "answers": ["1969"]},
    {"question": "What is the capital city of Australia?", "answers": ["Canberra"]},
    {"question": "How many sides does a hexagon have?", "answers": ["6", "six"]},
    {"question": "Who wrote the play 'Romeo and Juliet'?", "answers": ["William Shakespeare", "Shakespeare"]},
    {"question": "What is the largest planet in our solar system?", "answers": ["Jupiter"]},
    {"question": "What is the speed of light in vacuum, in km/s (to 3 sig figs)?", "answers": ["299792", "300000", "3.00 x 10^5"]},
    {"question": "What element has the atomic number 1?", "answers": ["Hydrogen"]},
    {"question": "What is the longest river in the world?", "answers": ["Nile", "Amazon"]},
    {"question": "Who painted the Mona Lisa?", "answers": ["Leonardo da Vinci", "da Vinci"]},
    {"question": "What is the freezing point of water in Fahrenheit?", "answers": ["32"]},
    {"question": "What is the smallest prime number?", "answers": ["2", "two"]},
]


def load_dataset(path: str | None, n: int):
    if not path:
        items = list(BUILTIN)
    else:
        items = []
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            q = row.get("question") or row.get("q") or row.get("problem")
            golds = row.get("answers") or row.get("answer") or row.get("gold")
            if q and golds:
                items.append({"question": q, "answers": golds if isinstance(golds, list) else [golds]})
    return items[:n] if n and n > 0 else items


# ───────────────────────────── generation ──────────────────────────────────
ANSWER_SYS = (
    "Answer the question as concisely as possible — just the fact, no preamble, "
    "no explanation. If you do not know, still give your single best short answer."
)


def generate(client, model, question, max_tokens):
    """One completion with per-token logprobs. Returns (text, bits[]) or (text, None)."""
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": ANSWER_SYS},
                  {"role": "user", "content": question}],
        max_tokens=max_tokens,
        temperature=0.0,
        logprobs=True,
        top_logprobs=1,
    )
    choice = resp.choices[0]
    text = (choice.message.content or "").strip()
    bits = None
    lp = getattr(choice, "logprobs", None)
    content = getattr(lp, "content", None) if lp else None
    if content:
        bits = [logprob_to_bits(getattr(tok, "logprob", None)) for tok in content]
        bits = [b for b in bits if b is not None]
    return text, bits


def judge(client, model, question, gold, prediction) -> bool:
    """Optional LLM grader (SimpleQA-style). Returns True iff CORRECT."""
    msg = (f"Question: {question}\nGold answer(s): {gold}\nModel answer: {prediction}\n\n"
           "Is the model answer CORRECT (semantically matches a gold answer)? "
           "Reply with exactly one word: CORRECT or INCORRECT.")
    r = client.chat.completions.create(
        model=model, temperature=0.0, max_tokens=4,
        messages=[{"role": "user", "content": msg}])
    return "CORRECT" in (r.choices[0].message.content or "").upper()


# ─────────────────────────────── self-test ─────────────────────────────────
def selftest() -> int:
    """Verify the surprise port matches token-surprise.js and the metrics are sound.

    This tests the HARNESS (math/stats), NOT the hypothesis — it fabricates data
    with a KNOWN separation and confirms AUROC recovers it. Honest labeling: a
    pass here says 'the measuring instrument works', not 'the leak works'.
    """
    ok = True

    def check(name, cond):
        nonlocal ok
        print(("  ok   - " if cond else "  FAIL - ") + name)
        ok = ok and cond

    # 1) Port parity against token-surprise.js worked examples.
    #    fluent text → ~0 uncertainty; content guessed (high-bit tail) → high.
    fluent = surprise_field([0.5, 0.8, 0.3, 1.2, 0.6, 0.4])     # all < 6 bits
    check("fluent field has zero tail mass", fluent["tailMass"] == 0.0)
    check("fluent → ~0 uncertainty", field_to_uncertainty(fluent) < 0.15)
    guessing = surprise_field([0.5, 9.0, 0.4, 11.0, 8.0, 0.6])  # 3/6 tokens > 6 bits
    check("guessing field tailMass = 0.5", guessing["tailMass"] == 0.5)
    check("guessing → high uncertainty", field_to_uncertainty(guessing) > 0.4)
    check("logprob_to_bits(-ln2) == 1.0", abs(logprob_to_bits(-LN2) - 1.0) < 1e-9)

    # 2) AUROC sanity: perfect separation → 1.0, reversed → 0.0, random → ~0.5.
    check("AUROC perfect separation == 1.0",
          auroc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]) == 1.0)
    check("AUROC reversed == 0.0",
          auroc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]) == 0.0)
    check("AUROC all-ties == 0.5",
          auroc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]) == 0.5)
    check("AUROC undefined when one class empty",
          auroc([0.1, 0.2], [0, 0]) is None)

    # 3) End-to-end on synthetic data where WRONG answers really are more surprised.
    rng = random.Random(0)
    field_s, mean_s, labels = [], [], []
    for _ in range(400):
        wrong = rng.random() < 0.4
        # wrong answers: heavier high-bit tail; right answers: confident.
        toks = [rng.expovariate(1.0) + (7.0 if wrong and rng.random() < 0.5 else 0.0)
                for _ in range(12)]
        fld = surprise_field(toks)
        field_s.append(field_to_uncertainty(fld))
        mean_s.append(fld["meanBits"])
        labels.append(1 if wrong else 0)
    a_field = auroc(field_s, labels)
    a_mean = auroc(mean_s, labels)
    check("synthetic: field AUROC > 0.6", a_field is not None and a_field > 0.6)
    ci = bootstrap_delta_ci(field_s, mean_s, labels, iters=300, rng=random.Random(1))
    check("bootstrap CI computed", ci is not None and "delta_lo" in ci)
    print(f"    [synthetic] AUROC(field)={a_field:.3f}  AUROC(mean)={a_mean:.3f}  "
          f"Δci=[{ci['delta_lo']},{ci['delta_hi']}]")

    print("\nselftest:", "ALL PASS" if ok else "FAILURES")
    return 0 if ok else 1


# ─────────────────────────────────── main ──────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=0, help="cap on items (0 = all)")
    ap.add_argument("--model", default="gpt-4o-mini", help="generation model")
    ap.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL"),
                    help="OpenAI-compatible endpoint (e.g. http://localhost:11434/v1 for Ollama)")
    ap.add_argument("--api-key", default=None, help="override OPENAI_API_KEY (use 'ollama' for local)")
    ap.add_argument("--dataset", default=None, help="JSONL of {question, answer|answers}")
    ap.add_argument("--judge-model", default=None, help="LLM grader model (default: string grader)")
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--bootstrap", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=None, help="JSONL rows output (default: experiments/results/...)")
    ap.add_argument("--selftest", action="store_true", help="test the harness math, no API")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    try:
        from openai import OpenAI
    except ImportError:
        print("openai package not installed — `pip install -r requirements.txt`", file=sys.stderr)
        return 2

    api_key = args.api_key or os.environ.get("OPENAI_API_KEY") or ("ollama" if args.base_url else None)
    if not api_key:
        print("No API key. Set OPENAI_API_KEY, or --base-url <ollama> --api-key ollama, "
              "or run --selftest.", file=sys.stderr)
        return 2
    client = OpenAI(api_key=api_key, base_url=args.base_url) if args.base_url else OpenAI(api_key=api_key)

    items = load_dataset(args.dataset, args.n)
    if not items:
        print("empty dataset", file=sys.stderr)
        return 2
    print(f"Layer-1 surprise-leak probe · model={args.model} · n={len(items)} · "
          f"grader={'LLM:' + args.judge_model if args.judge_model else 'string'}")

    RESULTS.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else (RESULTS / f"surprise_leak_ab_{args.model.replace('/', '_').replace(':', '_')}.jsonl")
    out_path = out_path if out_path.is_absolute() else (REPO / out_path)

    rows, no_logprob, errors = [], 0, 0
    with out_path.open("w", encoding="utf-8") as fh:
        for i, it in enumerate(items):
            try:
                text, bits = generate(client, args.model, it["question"], args.max_tokens)
            except Exception as e:  # noqa: BLE001
                errors += 1
                print(f"  [{i+1}/{len(items)}] gen error: {e}", file=sys.stderr)
                continue
            if not bits:
                no_logprob += 1
                continue
            fld = surprise_field(bits)
            if args.judge_model:
                try:
                    correct = judge(client, args.judge_model, it["question"], it["answers"], text)
                except Exception as e:  # noqa: BLE001
                    print(f"  judge error: {e}", file=sys.stderr)
                    correct = grade_string(text, it["answers"])
            else:
                correct = grade_string(text, it["answers"])
            row = {
                "question": it["question"], "answers": it["answers"],
                "prediction": text, "correct": correct,
                "hallucination": 0 if correct else 1,
                "field": fld,
                "field_uncertainty": field_to_uncertainty(fld),
                "mean_bits": fld["meanBits"],
                "p90_bits": fld["p90Bits"],
            }
            rows.append(row)
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            mark = "✓" if correct else "✗"
            print(f"  [{i+1}/{len(items)}] {mark} unc={row['field_uncertainty']:.3f} "
                  f"mean={row['mean_bits']:.2f}  {it['question'][:48]}")

    if no_logprob:
        print(f"\n⚠ {no_logprob} responses returned NO logprobs — this model/endpoint "
              f"does not expose them (e.g. Anthropic). The valve cannot open here.",
              file=sys.stderr)
    if len(rows) < 8:
        print(f"\nOnly {len(rows)} scored rows — too few for a meaningful AUROC. "
              f"Need a logprob-exposing model and a larger --dataset.", file=sys.stderr)
        return 1

    labels = [r["hallucination"] for r in rows]
    field_s = [r["field_uncertainty"] for r in rows]
    mean_s = [r["mean_bits"] for r in rows]
    p90_s = [r["p90_bits"] for r in rows]
    rng = random.Random(args.seed)

    a_field = auroc(field_s, labels)
    a_mean = auroc(mean_s, labels)
    a_p90 = auroc(p90_s, labels)
    ci = bootstrap_delta_ci(field_s, mean_s, labels, args.bootstrap, rng)
    halluc_rate = sum(labels) / len(labels)

    report = {
        "kind": "surprise_leak_layer1",
        "ts": int(time.time()),
        "model": args.model, "base_url": args.base_url,
        "grader": ("llm:" + args.judge_model) if args.judge_model else "string(approx)",
        "n_scored": len(rows), "n_no_logprob": no_logprob, "n_errors": errors,
        "hallucination_rate": _round4(halluc_rate),
        "auroc_field_uncertainty": None if a_field is None else _round4(a_field),
        "auroc_mean_bits_baseline": None if a_mean is None else _round4(a_mean),
        "auroc_p90_bits": None if a_p90 is None else _round4(a_p90),
        "delta_field_minus_mean_ci": ci,
        "rows_path": _rel(out_path),
        "provenance": {
            "REAL": "generations, captured logprobs, labels, AUROC/bootstrap",
            "APPROX": "string grader mis-labels some answers; use --judge-model",
            "PORT": "surprise_field/field_to_uncertainty == token-surprise.js",
        },
        "hypothesis": ("field_uncertainty AUROC > 0.5 (signal real) AND > mean_bits "
                       "AUROC (the tailMass field beats plain perplexity)"),
    }
    report_path = RESULTS / "surprise_leak_ab_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\n" + "=" * 70)
    print(f"  n={len(rows)}   hallucination rate={halluc_rate:.1%}   "
          f"(no-logprob skipped={no_logprob}, errors={errors})")
    print(f"  AUROC field_uncertainty (proposed) : "
          f"{a_field:.3f}" if a_field is not None else "  AUROC field: undefined")
    print(f"  AUROC mean_bits        (perplexity baseline) : "
          f"{a_mean:.3f}" if a_mean is not None else "  AUROC mean: undefined")
    print(f"  AUROC p90_bits         (secondary) : "
          f"{a_p90:.3f}" if a_p90 is not None else "  AUROC p90: undefined")
    if ci:
        verdict = ("field BEATS perplexity (CI excludes 0)" if ci["delta_lo"] > 0
                   else "field WORSE than perplexity (CI below 0)" if ci["delta_hi"] < 0
                   else "field vs perplexity INCONCLUSIVE (CI spans 0)")
        print(f"  Δ(field−mean) 95% CI : [{ci['delta_lo']:+.3f}, {ci['delta_hi']:+.3f}]  "
              f"→ {verdict}")
    print("=" * 70)
    # Three-way verdict: separate the THESIS (does surprise carry signal at all,
    # via the best of perplexity/p90) from the PRIMITIVE (does token-surprise.js's
    # tailMass field earn its keep over plain perplexity). They can disagree.
    best_raw = max([a for a in (a_mean, a_p90) if a is not None], default=None)
    if a_field is not None and best_raw is not None:
        if best_raw <= 0.55:
            print("  VERDICT: surprise carries NO signal here (even perplexity ≈ chance) — leak is noise.")
        elif a_field > best_raw:
            print("  VERDICT: the tailMass FIELD separates hallucination AND beats raw perplexity — primitive earns its keep.")
        else:
            print(f"  VERDICT: RAW surprise separates hallucination (best AUROC {best_raw:.3f}),")
            print(f"           but token-surprise.js's tailMass field is DEGENERATE here ({a_field:.3f} ≈ chance).")
            print("           Thesis SUPPORTED; production primitive needs recalibration before the valve opens.")
    print(f"  rows  → {_rel(out_path)}")
    print(f"  report→ {_rel(report_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
