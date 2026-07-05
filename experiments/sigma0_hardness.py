"""
Σ₀ trilogy hardening (3/3, #2031) — a REAL hardness proxy + a matched-base-rate graded set.

The pilots (`sigma0_qexit_adaptive.py`, `sigma0_depth_accuracy.py`) had two weaknesses this
module fixes, and it fixes them in a way that is verifiable WITHOUT the GPU/model:

  1. Difficulty was next-token entropy (a poor proxy). Here difficulty is **empirical
     solve-success** on a graded set — the model's own multi-step correctness, binned per tier.
  2. The graded set was tiny (24/15) and, on the facts route, base-rate CONFOUNDED (an
     implausible distractor let a base-rate guesser win). Here every item is 4-way MCQ with a
     **uniformly-distributed correct index** — a constant guesser scores exactly chance (0.25),
     and distractors straddle the answer so "pick the largest/smallest" cannot win either.

This module is deliberately **torch-free**: the dataset and every analysis function are pure
Python, so the whole difficulty-proxy pipeline is unit-tested on a CPU box. The only GPU step
is running Ouro to produce, per item, (a) whether it solved it and (b) its Q-exit depth — which
`sigma0_qexit_adaptive.py` / `sigma0_depth_accuracy.py` supply by calling `graded_problems()`
for the set and then feeding results back into `empirical_difficulty()`, `adaptivity()`, and
`depth_accuracy_curve()`.

Acceptance mapping (#2031):
  - "diverse graded set ... matched base rate"      → graded_problems() + check_matched_base_rate()
  - "difficulty = actual multi-step solve-success"  → empirical_difficulty()
  - "does E[exit depth] track REAL difficulty"       → adaptivity()
  - "does depth ever help on hard tasks"             → depth_accuracy_curve()
"""
from __future__ import annotations

import random

N_TIERS = 4          # step count grows with tier: tier t has (t+1) operands / t binary ops
N_OPTIONS = 4        # 4-way MCQ → chance = 0.25


# ── graded problem generator ─────────────────────────────────────────────────
def _gen_expr(tier: int, rng: random.Random):
    """Build an arithmetic expression with `tier` binary ops (Python precedence) and its
    exact integer answer. Operands/ops are chosen so the answer is deterministic."""
    n_ops = tier
    operands = [rng.randint(2, 19) for _ in range(n_ops + 1)]
    ops = [rng.choice(["+", "-", "*"]) for _ in range(n_ops)]
    parts = [str(operands[0])]
    for i, op in enumerate(ops):
        parts.append(op)
        parts.append(str(operands[i + 1]))
    expr = " ".join(parts)
    # Safe: `expr` is only our own digits/operators/spaces; no names, no builtins.
    answer = int(eval(expr, {"__builtins__": {}}, {}))          # noqa: S307 (validated input)
    left_to_right = _eval_left_to_right(operands, ops)           # the classic precedence mistake
    return expr, answer, left_to_right


def _eval_left_to_right(operands, ops):
    """Evaluate ignoring precedence (a common wrong answer) — a strong distractor."""
    acc = operands[0]
    for i, op in enumerate(ops):
        b = operands[i + 1]
        acc = acc + b if op == "+" else acc - b if op == "-" else acc * b
    return acc


def _distractors(answer: int, precedence_miss: int, rng: random.Random):
    """Three distinct wrong options that STRADDLE the answer (some above, some below), so the
    correct option is not systematically the max or min — defeats a magnitude heuristic."""
    cands = []
    if precedence_miss != answer:
        cands.append(precedence_miss)
    # deltas on both sides of the answer, scaled to the answer's magnitude
    scale = max(1, abs(answer) // 10)
    for d in (scale, -scale, 2 * scale, -2 * scale, scale + 1, -(scale + 1)):
        v = answer + d
        if v != answer and v not in cands:
            cands.append(v)
        if len(cands) >= 6:
            break
    rng.shuffle(cands)
    out = []
    for v in cands:
        if v != answer and v not in out:
            out.append(v)
        if len(out) == N_OPTIONS - 1:
            break
    i = 1
    while len(out) < N_OPTIONS - 1:            # pathological tiny answers — pad deterministically
        if answer + i not in out and answer + i != answer:
            out.append(answer + i)
        i += 1
    return out


def graded_problems(n_per_tier: int = 12, seed: int = 20260704):
    """A deterministic, diverse, graded MCQ set (N_TIERS × n_per_tier items). Each item:
    { tier, prompt, options[4], answer_index, answer }. The correct index is CYCLED across the
    whole set so it is uniform → a constant-index guesser scores exactly chance."""
    rng = random.Random(seed)
    items = []
    idx_cycle = 0
    for tier in range(1, N_TIERS + 1):
        for _ in range(n_per_tier):
            expr, answer, ltr = _gen_expr(tier, rng)
            distractors = _distractors(answer, ltr, rng)
            correct_index = idx_cycle % N_OPTIONS
            idx_cycle += 1
            options = list(distractors)
            options.insert(correct_index, answer)
            items.append({
                "tier": tier,
                "prompt": f"What is {expr}?",
                "options": options,
                "answer_index": correct_index,
                "answer": answer,
            })
    return items


# ── confound check ───────────────────────────────────────────────────────────
def check_matched_base_rate(items):
    """Prove a base-rate strategy can't beat chance on this set. Returns index distribution,
    the best constant-index accuracy, and how often the answer is the extreme (max/min) option."""
    n = len(items)
    idx_counts = [0] * N_OPTIONS
    extreme = 0
    for it in items:
        idx_counts[it["answer_index"]] += 1
        opts = it["options"]
        if it["answer"] == max(opts) or it["answer"] == min(opts):
            extreme += 1
    best_constant_index_acc = (max(idx_counts) / n) if n else 0.0
    return {
        "n": n,
        "index_distribution": idx_counts,
        "best_constant_index_acc": round(best_constant_index_acc, 4),
        "chance": round(1.0 / N_OPTIONS, 4),
        "answer_is_extreme_rate": round(extreme / n, 4) if n else 0.0,
        "matched": best_constant_index_acc <= (1.0 / N_OPTIONS) + 0.05,
    }


# ── difficulty from real solve-success ───────────────────────────────────────
def empirical_difficulty(results):
    """results: [{tier, correct: bool}] from the model run. Difficulty per tier = 1 − solve_rate;
    this REPLACES the next-token-entropy proxy. Returns per-tier solve rate + difficulty."""
    by_tier = {}
    for r in results:
        t = r["tier"]
        by_tier.setdefault(t, [0, 0])
        by_tier[t][1] += 1
        if r.get("correct"):
            by_tier[t][0] += 1
    out = {}
    for t, (ok, total) in sorted(by_tier.items()):
        solve = ok / total if total else 0.0
        out[t] = {"n": total, "solve_rate": round(solve, 4), "difficulty": round(1.0 - solve, 4)}
    return out


def _pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return 0.0
    return cov / (vx ** 0.5 * vy ** 0.5)


# ── does E[exit depth] track REAL difficulty? ────────────────────────────────
def adaptivity(pairs, r_threshold: float = 0.3):
    """pairs: [(difficulty, exit_depth)] per item (difficulty from empirical_difficulty, exit_depth
    from the Q-exit gate). A genuinely adaptive gate spends MORE depth on HARDER items → positive
    correlation AND hard-tier mean depth > easy-tier mean depth."""
    if not pairs:
        return {"n": 0, "pearson_r": 0.0, "adaptive": False}
    diffs = [p[0] for p in pairs]
    depths = [p[1] for p in pairs]
    r = _pearson(diffs, depths)
    med = sorted(diffs)[len(diffs) // 2]
    easy = [d for df, d in pairs if df <= med]
    hard = [d for df, d in pairs if df > med]
    easy_mean = sum(easy) / len(easy) if easy else 0.0
    hard_mean = sum(hard) / len(hard) if hard else easy_mean
    return {
        "n": len(pairs),
        "pearson_r": round(r, 4),
        "easy_mean_depth": round(easy_mean, 4),
        "hard_mean_depth": round(hard_mean, 4),
        "depth_delta": round(hard_mean - easy_mean, 4),
        "adaptive": r >= r_threshold and hard_mean > easy_mean,
    }


# ── does forced depth ever help on hard tasks? ───────────────────────────────
def depth_accuracy_curve(acc_by_depth, min_gain: float = 0.05):
    """acc_by_depth: {depth: accuracy_on_hard_tasks}. Returns the curve, the best depth, and
    whether deeper recurrence HELPS (best accuracy beats the shallowest by >= min_gain)."""
    if not acc_by_depth:
        return {"curve": {}, "best_depth": None, "helps_on_hard": False}
    depths = sorted(acc_by_depth)
    base_depth = depths[0]
    base_acc = acc_by_depth[base_depth]
    best_depth = max(depths, key=lambda d: acc_by_depth[d])
    best_acc = acc_by_depth[best_depth]
    return {
        "curve": {int(d): round(float(acc_by_depth[d]), 4) for d in depths},
        "base_depth": base_depth,
        "best_depth": best_depth,
        "gain_over_base": round(best_acc - base_acc, 4),
        "helps_on_hard": (best_acc - base_acc) >= min_gain and best_depth > base_depth,
    }


if __name__ == "__main__":
    # Demo the CPU-verifiable half (no model needed).
    import json
    probs = graded_problems()
    print(f"[hardness] generated {len(probs)} graded MCQ problems across {N_TIERS} tiers")
    print("[hardness] base-rate check:", json.dumps(check_matched_base_rate(probs)))
