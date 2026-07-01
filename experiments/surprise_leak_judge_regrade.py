"""
LLM-judge re-grade of the surprise-leak Layer-1 dataset (#1683).

#1673's Layer-1 result used a deterministic STRING grader against gold answers, which
under-counts correctness (e.g. "Charizard is a fire-type Pokemon" vs gold "Fire/Flying" —
a human would call that a defensible partial match; a string grader calls it wrong). The
Layer-1 note flagged this as the dataset's main APPROX caveat, depressing all AUROCs (true
separation is likely >= reported). This re-grades the SAME 398 already-generated predictions
(199 questions x 2 models) with a local LLM judge instead, using the exact judge prompt from
experiments/surprise_leak_ab.py's judge(), and recomputes AUROC with the new labels.

No new model GENERATION — reuses experiments/results/surprise_leak_{qwen15b,mistral7b}.jsonl,
which already carry prediction + field_uncertainty + mean_bits from the Layer-1 run. Only the
grading step is new.

Checkpointed: writes one line per judged row as it goes, and skips rows already present in the
output file on a restart, so an interrupted run resumes rather than re-paying the (slow, local-
CPU/GPU-bound) judge cost from scratch.

Run: python experiments/surprise_leak_judge_regrade.py [--judge-model qwen2.5-coder:latest]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[1]
RESULTS = REPO / "experiments" / "results"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from surprise_leak_ab import auroc  # noqa: E402  (reuse the exact Layer-1 AUROC math)

DATASETS = [
    ("surprise_leak_qwen15b.jsonl", "qwen2.5-coder:1.5b"),
    ("surprise_leak_mistral7b.jsonl", "mistral:7b"),
]


def judge_ollama(base_url, model, question, gold, prediction, timeout=120):
    """Same prompt/contract as surprise_leak_ab.judge(), talking to Ollama's
    OpenAI-compatible endpoint directly (no openai package dependency).

    #1683 bug found + fixed here: the upstream judge()'s `"CORRECT" in text.upper()`
    check is a substring match, and "INCORRECT" CONTAINS "CORRECT" as a substring —
    so any response saying INCORRECT was being counted as correct. Check INCORRECT
    first (it's the more specific match) to resolve the ambiguity correctly.
    """
    msg = (f"Question: {question}\nGold answer(s): {gold}\nModel answer: {prediction}\n\n"
           "Is the model answer CORRECT (semantically matches a gold answer)? "
           "Reply with exactly one word: CORRECT or INCORRECT.")
    r = requests.post(f"{base_url}/chat/completions", timeout=timeout, json={
        "model": model, "temperature": 0.0, "max_tokens": 4,
        "messages": [{"role": "user", "content": msg}],
    })
    r.raise_for_status()
    content = (r.json()["choices"][0]["message"]["content"] or "").upper()
    if "INCORRECT" in content:
        return False
    if "CORRECT" in content:
        return True
    return None  # unparseable — counted as an error, not silently coerced either way


def load_checkpoint(out_path):
    """Rows already judged, keyed by question (good enough within one dataset file)."""
    done = {}
    if out_path.exists():
        with out_path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    done[row["question"]] = row
                except Exception:
                    continue
    return done


def regrade_dataset(file, judge_model, base_url):
    src = RESULTS / file
    if not src.exists():
        print(f"skip (missing source): {file}")
        return None
    rows = [json.loads(l) for l in src.read_text(encoding="utf-8").splitlines() if l.strip()]
    out_path = RESULTS / f"judge_regrade_{file}"
    done = load_checkpoint(out_path)
    print(f"=== {file}: {len(rows)} rows, {len(done)} already judged (resuming) ===", flush=True)

    with out_path.open("a", encoding="utf-8") as out:
        for i, row in enumerate(rows):
            if row["question"] in done:
                continue
            t0 = time.time()
            try:
                judge_correct = judge_ollama(base_url, judge_model, row["question"], row["answers"], row["prediction"])
                err = None if judge_correct is not None else "unparseable_judge_response"
            except Exception as e:  # noqa: BLE001 — never let one bad call kill the whole run
                judge_correct, err = None, str(e)
            elapsed = time.time() - t0
            rec = {
                "question": row["question"], "answers": row["answers"], "prediction": row["prediction"],
                "string_grader_correct": row["correct"],
                "judge_correct": judge_correct, "judge_error": err,
                "field_uncertainty": row["field_uncertainty"], "mean_bits": row["mean_bits"],
            }
            out.write(json.dumps(rec) + "\n")
            out.flush()
            if (i + 1) % 10 == 0 or i == len(rows) - 1:
                print(f"  [{file}] {i+1}/{len(rows)}  ({elapsed:.1f}s/call)", flush=True)

    # Recompute from the full checkpoint file (covers rows judged in earlier/interrupted runs too).
    final = list(load_checkpoint(out_path).values())
    judged = [r for r in final if r["judge_correct"] is not None]
    n_errors = len(final) - len(judged)
    judge_labels = [0 if r["judge_correct"] else 1 for r in judged]  # 1 = hallucination
    string_labels = [0 if r["string_grader_correct"] else 1 for r in judged]
    field_scores = [r["field_uncertainty"] for r in judged]
    mean_scores = [r["mean_bits"] for r in judged]

    result = {
        "file": file, "judge_model": judge_model, "n": len(final), "n_errors": n_errors,
        "judge_halluc_rate": sum(judge_labels) / len(judge_labels) if judge_labels else None,
        "string_halluc_rate": sum(string_labels) / len(string_labels) if string_labels else None,
        "agreement": sum(1 for j, s in zip(judge_labels, string_labels) if j == s) / len(judge_labels) if judge_labels else None,
        "auroc_field_judge": auroc(field_scores, judge_labels),
        "auroc_mean_judge": auroc(mean_scores, judge_labels),
        "auroc_field_string": auroc(field_scores, string_labels),
        "auroc_mean_string": auroc(mean_scores, string_labels),
    }
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge-model", default="qwen2.5-coder:latest")
    ap.add_argument("--base-url", default="http://127.0.0.1:11434/v1")
    args = ap.parse_args()

    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "judge_model": args.judge_model, "datasets": []}
    for file, _gen_model in DATASETS:
        result = regrade_dataset(file, args.judge_model, args.base_url)
        if result:
            report["datasets"].append(result)
            print(json.dumps(result, indent=2), flush=True)

    out = RESULTS / "surprise_leak_judge_regrade_report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nWrote {out.relative_to(REPO)}", flush=True)


if __name__ == "__main__":
    main()
