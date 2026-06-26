#!/usr/bin/env python3
"""
HumanEval Benchmark Runner for Ouro Model

Scores model completions on the real HumanEval suite using the `human-eval`
package's execution sandbox and the standard unbiased pass@k estimator.

IMPORTANT (External Reality Rule, #1188): this runner NEVER fabricates scores.
If the real harness cannot run — the `human-eval` package is missing, or no
model completions are supplied — it returns an explicit `measured: false` /
`status: "not_measured"` result with `pass_at_k: null` and exits non-zero, so no
downstream job can post invented numbers to GitHub as if they were measured.

Because generation requires a GPU, this runner SCORES pre-generated completions
(the realistic split: generate on the GPU box, score here). Provide them with
`--completions <samples.jsonl>` in the canonical human-eval format, one JSON
object per line: {"task_id": "HumanEval/0", "completion": "<code>"}.

Usage:
    # Real run (requires `pip install human-eval` + a samples file):
    python experiments/humaneval_runner.py --completions samples.jsonl --k 1,10,100
    # Without a real harness it reports not_measured and exits 2.
"""

import argparse
import json
import logging
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


def _pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased estimator of pass@k from the HumanEval paper:
    1 - C(n-c, k) / C(n, k), where n = samples per task, c = #correct."""
    import math
    if n - c < k:
        return 1.0
    return 1.0 - math.prod((n - c - i) / (n - i) for i in range(k))


def _not_measured(reason: str, checkpoint: str = "", extra: Optional[Dict] = None) -> Dict:
    """Honest 'no real result' payload — never carries fabricated scores (#1188)."""
    out = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "benchmark": "humaneval",
        "checkpoint": checkpoint,
        "measured": False,
        "status": "not_measured",
        "pass_at_k": None,
        "reason": reason,
    }
    if extra:
        out.update(extra)
    return out


def run_humaneval(completions_path: Optional[str],
                  checkpoint_path: str = "",
                  k_values: List[int] = [1, 10, 100]) -> Dict:
    """Score real model completions on HumanEval. Returns measured pass@k, or an
    explicit not_measured result if the real harness can't run. No fabrication."""
    if not completions_path:
        return _not_measured(
            "no --completions file supplied; generation requires a GPU, so this "
            "runner scores pre-generated completions and will not invent scores.",
            checkpoint_path,
        )

    try:
        from human_eval.data import read_problems
        from human_eval.execution import check_correctness
    except ImportError:
        return _not_measured(
            "the `human-eval` package is not installed (pip install human-eval); "
            "cannot run the real benchmark.",
            checkpoint_path,
        )

    samples_file = Path(completions_path)
    if not samples_file.exists():
        return _not_measured(f"completions file not found: {completions_path}", checkpoint_path)

    problems = read_problems()
    # Group completions by task so we can compute pass@k over n samples/task.
    by_task: Dict[str, List[str]] = defaultdict(list)
    with samples_file.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("task_id") in problems and "completion" in obj:
                by_task[obj["task_id"]].append(obj["completion"])

    if not by_task:
        return _not_measured(
            "completions file had no rows matching HumanEval task_ids.", checkpoint_path
        )

    per_task = []
    totals = defaultdict(lambda: [0, 0])  # k -> [sum_pass_at_k_numerator-ish via mean]
    pass_at_k_acc: Dict[str, List[float]] = {f"pass@{k}": [] for k in k_values}

    for task_id, completions in by_task.items():
        n = len(completions)
        correct = 0
        for completion in completions:
            res = check_correctness(problems[task_id], completion, timeout=10.0)
            if res.get("passed"):
                correct += 1
        per_task.append({"task_id": task_id, "n": n, "correct": correct})
        for k in k_values:
            if n >= k:
                pass_at_k_acc[f"pass@{k}"].append(_pass_at_k(n, correct, k))

    pass_at_k = {
        key: (round(sum(vals) / len(vals), 4) if vals else None)
        for key, vals in pass_at_k_acc.items()
    }

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "benchmark": "humaneval",
        "checkpoint": checkpoint_path,
        "measured": True,
        "status": "measured",
        "model": "ouro-qlora",
        "tasks_scored": len(by_task),
        "pass_at_k": pass_at_k,
        "per_task": per_task,
    }


def main():
    parser = argparse.ArgumentParser(description="Score Ouro completions on real HumanEval")
    parser.add_argument("--completions", help="JSONL of {task_id, completion} model outputs to score")
    parser.add_argument("--repo", default="ouro-checkpoints", help="HF repo ID (for labeling only)")
    parser.add_argument("--checkpoint", default="output.csf", help="Checkpoint filename (for labeling)")
    parser.add_argument("--k", default="1,10,100", help="Pass@k values (comma-separated)")
    parser.add_argument("--output", help="Write results to file (default: stdout)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    k_values = [int(x.strip()) for x in args.k.split(",")]
    checkpoint_label = f"{args.repo}/{args.checkpoint}"

    results = run_humaneval(args.completions, checkpoint_label, k_values)

    output_json = json.dumps(results, indent=2)
    if args.output:
        Path(args.output).write_text(output_json)
        logger.info(f"Results saved to {args.output}")
    else:
        print(output_json)

    # Exit non-zero when nothing real was measured, so unattended callers
    # (weekly-training-orchestrator) cannot post fabricated numbers (#1188).
    if not results.get("measured"):
        logger.error(f"HumanEval not measured: {results.get('reason')}")
        sys.exit(2)


if __name__ == "__main__":
    main()
