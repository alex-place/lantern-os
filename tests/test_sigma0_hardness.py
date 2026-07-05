"""
Unit tests for the #2031 hardness proxy (experiments/sigma0_hardness.py).

The whole difficulty-proxy pipeline is pure Python, so — unlike the GPU model run — it is
fully verifiable on a CPU box. These tests prove: the graded set's answers are correct, the
set is matched-base-rate (a guesser can't beat chance), and the adaptivity / depth-accuracy
analysis reports the right verdicts on synthetic model outputs.

Run:  python -m pytest tests/test_sigma0_hardness.py -q
  or: python tests/test_sigma0_hardness.py   (self-running, no pytest / torch needed)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "experiments"))

import sigma0_hardness as H  # noqa: E402

_p = 0
def ok(desc, cond):
    assert cond, desc
    print("  ok  - " + desc)
    globals()["_p"] = globals()["_p"] + 1


def _expr_of(prompt):
    return prompt[len("What is "):].rstrip("?")


# ── the graded set ───────────────────────────────────────────────────────────
items = H.graded_problems()

ok("generates more than the 24/15 pilots (>= 40 items)", len(items) >= 40)

ok("covers all difficulty tiers", sorted({it["tier"] for it in items}) == list(range(1, H.N_TIERS + 1)))

ok("deterministic under a fixed seed", H.graded_problems(seed=7) == H.graded_problems(seed=7))

ok("every item's answer is arithmetically correct and sits at answer_index", all(
    int(eval(_expr_of(it["prompt"]), {"__builtins__": {}}, {})) == it["answer"]
    and it["options"][it["answer_index"]] == it["answer"]
    for it in items
))

ok("every item has 4 distinct options", all(
    len(it["options"]) == H.N_OPTIONS and len(set(it["options"])) == H.N_OPTIONS for it in items
))

# ── matched base rate (the confound #2031 fixes) ─────────────────────────────
mbr = H.check_matched_base_rate(items)
ok("a constant-index guesser cannot beat chance (matched base rate)",
   mbr["matched"] and mbr["best_constant_index_acc"] <= 0.30)
ok("the correct answer is not systematically the extreme (max/min) option",
   mbr["answer_is_extreme_rate"] < 0.7)

# ── empirical difficulty from solve-success ──────────────────────────────────
synthetic = ([{"tier": 1, "correct": True}] * 9 + [{"tier": 1, "correct": False}] * 1 +
             [{"tier": 4, "correct": True}] * 2 + [{"tier": 4, "correct": False}] * 8)
diff = H.empirical_difficulty(synthetic)
ok("difficulty = 1 - solve_rate, and a harder tier is harder",
   diff[1]["solve_rate"] == 0.9 and diff[4]["difficulty"] == 0.8 and diff[4]["difficulty"] > diff[1]["difficulty"])

# ── adaptivity: does E[exit depth] track REAL difficulty? ────────────────────
adaptive_pairs = [(d / 10.0, 1 + d / 10.0 * 3) for d in range(0, 11)]      # depth rises with difficulty
flat_pairs = [(d / 10.0, 3.4) for d in range(0, 11)]                       # depth flat (the #2025 finding)
ok("a gate that spends more depth on harder items reads as adaptive",
   H.adaptivity(adaptive_pairs)["adaptive"] and H.adaptivity(adaptive_pairs)["pearson_r"] > 0.9)
ok("a flat gate reads as NON-adaptive (reproduces the pilot's weak-adaptivity verdict)",
   not H.adaptivity(flat_pairs)["adaptive"] and H.adaptivity(flat_pairs)["depth_delta"] == 0.0)

# ── depth -> accuracy on hard tasks ──────────────────────────────────────────
helps = H.depth_accuracy_curve({1: 0.40, 2: 0.55, 4: 0.72, 8: 0.70})
flat = H.depth_accuracy_curve({1: 1.0, 2: 1.0, 4: 0.93, 8: 0.90})          # the arith finding: no help / dips
ok("deeper recurrence that lifts hard-task accuracy reads as helping",
   helps["helps_on_hard"] and helps["best_depth"] == 4 and helps["gain_over_base"] > 0.2)
ok("depth that doesn't lift accuracy reads as NOT helping (reproduces the pilot verdict)",
   not flat["helps_on_hard"])

print(f"\nall sigma0-hardness checks passed ({_p})")
