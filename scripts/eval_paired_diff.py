"""
Paired-difference comparison of two eval runs — error bars instead of eyeballs (#1966).

Two leaderboard rows (e.g. pass@1 0.43 vs 0.49) usually answered the SAME problems,
so the honest comparison is over per-problem PAIRS (arXiv:2411.00640 "Adding Error
Bars to Evals", recommendations 1 & 4): paired mean difference with SEM + 95% CI,
win/loss/tie counts, and an exact two-sided sign test over the discordant pairs.
Nothing new is measured here — this only makes existing measurements comparable.

Inputs are the per-problem detail files the harnesses already write
(data/eval/humaneval/<label>-<ts>.jsonl and the like: one JSON object per line
with `task_id` and boolean `ok`).

    python scripts/eval_paired_diff.py data/eval/humaneval/A.jsonl data/eval/humaneval/B.jsonl
    python scripts/eval_paired_diff.py --selftest    # offline: known-answer proof

Exit codes: 0 ok, 1 selftest failure, 2 unusable inputs (no overlapping task_ids).
"""
import argparse
import json
import math
import os
import sys


def load_run(path):
    """Read a per-problem detail JSONL -> {task_id: bool(ok)}. Later duplicates win
    (a re-run of one task inside the same file supersedes the earlier row); rows
    without task_id/ok and unparseable lines are skipped."""
    results = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            tid = row.get("task_id") if isinstance(row, dict) else None
            if tid is None or "ok" not in row:
                continue
            results[str(tid)] = bool(row["ok"])
    return results


def sign_test_p(wins, losses):
    """Exact two-sided sign test over the discordant pairs (ties excluded).
    H0: P(win) = 0.5. Returns 1.0 when there are no discordant pairs."""
    m = wins + losses
    if m == 0:
        return 1.0
    k = max(wins, losses)
    tail = sum(math.comb(m, i) for i in range(k, m + 1)) / 2.0 ** m
    return min(1.0, 2.0 * tail)


def paired_stats(run_a, run_b):
    """Paired-difference stats over the task_ids BOTH runs answered.
    Raises ValueError when the runs share no task_ids (different benchmarks?)."""
    common = sorted(set(run_a) & set(run_b))
    if not common:
        raise ValueError("no overlapping task_ids between the two runs")
    diffs = [int(run_b[t]) - int(run_a[t]) for t in common]
    n = len(diffs)
    mean_a = sum(int(run_a[t]) for t in common) / n
    mean_b = sum(int(run_b[t]) for t in common) / n
    mean_d = sum(diffs) / n
    var_d = sum((d - mean_d) ** 2 for d in diffs) / (n - 1) if n > 1 else 0.0
    sem = math.sqrt(var_d / n) if n > 1 else 0.0
    ci = (mean_d - 1.96 * sem, mean_d + 1.96 * sem)
    wins = sum(1 for d in diffs if d > 0)    # B solved it, A didn't
    losses = sum(1 for d in diffs if d < 0)  # A solved it, B didn't
    ties = n - wins - losses
    return {
        "n": n,
        "mean_a": round(mean_a, 4),
        "mean_b": round(mean_b, 4),
        "paired_mean_diff": round(mean_d, 4),
        "sem": round(sem, 4),
        "ci95": [round(ci[0], 4), round(ci[1], 4)],
        "wins_b": wins,
        "losses_b": losses,
        "ties": ties,
        "sign_test_p": round(sign_test_p(wins, losses), 4),
        "significant_at_95": not (ci[0] <= 0.0 <= ci[1]),
    }


def selftest():
    """Offline known-answer proof: n=10, B wins 3 / loses 1 / ties 6 ->
    diff +0.2, SEM 0.2, CI (-0.192, +0.592), sign p 0.625, not significant."""
    fails = 0

    def check(name, cond):
        nonlocal fails
        print(f"[selftest] {name} -> {bool(cond)}")
        fails += 0 if cond else 1

    a = {f"t{i}": i < 5 for i in range(10)}                              # A passes t0..t4
    b = dict(a)
    b["t4"] = False                                                      # B loses t4
    b["t5"] = b["t6"] = b["t7"] = True                                   # B wins t5..t7
    s = paired_stats(a, b)
    check("n=10 shared problems", s["n"] == 10)
    check("means A=0.5 B=0.7", s["mean_a"] == 0.5 and s["mean_b"] == 0.7)
    check("wins/losses/ties = 3/1/6", (s["wins_b"], s["losses_b"], s["ties"]) == (3, 1, 6))
    check("paired mean diff = +0.2", abs(s["paired_mean_diff"] - 0.2) < 1e-9)
    check("sem = 0.2", abs(s["sem"] - 0.2) < 1e-9)
    check("ci95 = [-0.192, +0.592]", abs(s["ci95"][0] + 0.192) < 1e-3 and abs(s["ci95"][1] - 0.592) < 1e-3)
    check("sign test p = 0.625", abs(s["sign_test_p"] - 0.625) < 1e-9)
    check("gap NOT significant at 95%", s["significant_at_95"] is False)
    check("no discordant pairs -> p=1.0", sign_test_p(0, 0) == 1.0)
    check("5-0 split -> p=0.0625", abs(sign_test_p(5, 0) - 0.0625) < 1e-12)
    try:
        paired_stats({"x": True}, {"y": True})
        check("disjoint runs raise ValueError", False)
    except ValueError:
        check("disjoint runs raise ValueError", True)
    print("SELFTEST:", "PASS" if fails == 0 else f"FAIL ({fails})")
    sys.exit(0 if fails == 0 else 1)


def main():
    ap = argparse.ArgumentParser(description="Paired-difference comparison of two per-problem eval detail files")
    ap.add_argument("run_a", nargs="?", help="baseline per-problem detail JSONL (A)")
    ap.add_argument("run_b", nargs="?", help="candidate per-problem detail JSONL (B)")
    ap.add_argument("--label-a", default=None, help="display label for A (default: file name)")
    ap.add_argument("--label-b", default=None, help="display label for B (default: file name)")
    ap.add_argument("--selftest", action="store_true", help="offline known-answer proof; no files")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    if not a.run_a or not a.run_b:
        ap.error("run_a and run_b are required (or --selftest)")

    run_a, run_b = load_run(a.run_a), load_run(a.run_b)
    label_a = a.label_a or os.path.basename(a.run_a)
    label_b = a.label_b or os.path.basename(a.run_b)
    try:
        stats = paired_stats(run_a, run_b)
    except ValueError as e:
        print(f"FATAL: {e} — are these detail files from the same benchmark?", file=sys.stderr)
        sys.exit(2)

    result = {"kind": "paired-diff", "a": label_a, "b": label_b, "n_a": len(run_a), "n_b": len(run_b), **stats}
    lo, hi = stats["ci95"]
    print(f"paired comparison over n={stats['n']} shared problems "
          f"(A answered {len(run_a)}, B answered {len(run_b)})")
    print(f"  A {label_a}: mean {stats['mean_a']:.3f}    B {label_b}: mean {stats['mean_b']:.3f}")
    print(f"  B-A paired diff {stats['paired_mean_diff']:+.3f}   SEM {stats['sem']:.3f}   95% CI [{lo:+.3f}, {hi:+.3f}]")
    print(f"  pairs: B-wins {stats['wins_b']}   A-wins {stats['losses_b']}   ties {stats['ties']}   "
          f"sign-test p={stats['sign_test_p']}")
    print("  verdict:", "difference IS significant at 95% (CI excludes 0)" if stats["significant_at_95"]
          else "NOT significant at 95% (CI includes 0) — don't ship a conclusion on this gap")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
