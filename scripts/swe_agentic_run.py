"""Live agentic SWE run: propose (host ollama) -> grade ONE instance (WSL swebench) -> retry.

Orchestrates scripts/swe_agent_loop.run_agent_loop with REAL deps, reusing the working stack:
  - propose      -> ollama on the Windows host (the --direct path that emits patches), with the
                    last failing-test output fed back into the prompt.
  - apply_and_test-> write a 1-instance prediction, shell out to the swebench grader IN WSL for
                    that instance, read the report (applied? resolved?) + the test_output log.

Runs on Windows python; only the grade is delegated to WSL (so no WSL->ollama connectivity issue).
Each attempt costs ~1 ollama call + ~1 instance grade (minutes), so keep --max-attempts small.

    python scripts/swe_agentic_run.py --instance astropy__astropy-14365 --max-attempts 2
"""
import argparse, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from swe_agent_loop import run_agent_loop, ollama_propose  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABEL = "agentic"
GOLD = "princeton-nlp/SWE-bench_Lite"


def wsl_grade(instance_id, pred_rel, run_id):
    """Grade ONE instance in WSL (starts dockerd if needed). Blocking.

    Runs in WSL-native ext4 (/root/swe-<run_id>): swebench's logs/ mkdir hits a Python 3.14 +
    /mnt/c (9p) FileExistsError bug, so we keep its working dir off the Windows mount and copy
    the report + test_output back to /mnt/c for the Windows side to read."""
    cmd = ("docker info >/dev/null 2>&1 || ( nohup dockerd >/tmp/dockerd.log 2>&1 & sleep 12 ); "
           f"D=/root/swe-{run_id}; rm -rf $D; mkdir -p $D; cd $D; "
           f"python3 -m swebench.harness.run_evaluation --dataset_name {GOLD} "
           f"--predictions_path /mnt/c/dev/lantern-os/{pred_rel} --run_id {run_id} "
           f"--instance_ids {instance_id} --max_workers 1 >/tmp/agentic-grade.log 2>&1; "
           f"cp -f {LABEL}.{run_id}.json /mnt/c/dev/lantern-os/agentic.{run_id}.json 2>/dev/null; "
           f"cp -f logs/run_evaluation/{run_id}/{LABEL}/{instance_id}/test_output.txt "
           f"/mnt/c/dev/lantern-os/agentic-testout-{run_id}.txt 2>/dev/null; "
           f"rm -rf $D; echo GRADE_DONE")
    subprocess.run(["wsl", "-d", "Ubuntu", "-u", "root", "-e", "bash", "-lc", cmd], cwd=ROOT)


def read_report(run_id):
    p = os.path.join(ROOT, f"{LABEL}.{run_id}.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def read_test_output(run_id, instance_id):
    p = os.path.join(ROOT, f"agentic-testout-{run_id}.txt")
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()[-1500:]
    except Exception:
        return ""


def make_apply_and_test(instance_id):
    state = {"n": 0}
    def apply_and_test(patch):
        state["n"] += 1
        run_id = f"agentic-{instance_id.replace('__','-')}-{state['n']}"
        pred_rel = f"data/eval/swebench/{run_id}.jsonl"
        pred_abs = os.path.join(ROOT, pred_rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(pred_abs), exist_ok=True)
        with open(pred_abs, "w", encoding="utf-8") as f:
            f.write(json.dumps({"instance_id": instance_id, "model_patch": patch,
                                "model_name_or_path": LABEL}) + "\n")
        print(f"  [attempt {state['n']}] grading {instance_id} ...", flush=True)
        wsl_grade(instance_id, pred_rel, run_id)
        rep = read_report(run_id)
        resolved = instance_id in (rep.get("resolved_ids") or [])
        errored = instance_id in (rep.get("error_ids") or [])
        out = read_test_output(run_id, instance_id) or ("patch did not apply" if errored else "tests failed")
        print(f"  [attempt {state['n']}] applied={not errored} resolved={resolved}", flush=True)
        return {"applied": not errored, "passed": resolved, "output": out}
    return apply_and_test


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True, help="SWE-bench instance_id")
    ap.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite_oracle")
    ap.add_argument("--model", default="qwen2.5-coder:latest")
    ap.add_argument("--num-ctx", type=int, default=16384, dest="num_ctx")
    ap.add_argument("--max-attempts", type=int, default=2, dest="max_attempts")
    ap.add_argument("--timeout", type=int, default=240)
    a = ap.parse_args()

    from datasets import load_dataset
    ds = load_dataset(a.dataset, split="test")
    ex = next((r for r in ds if r["instance_id"] == a.instance), None)
    if ex is None:
        print(f"instance {a.instance} not in {a.dataset}"); sys.exit(2)
    context = ex.get("text") or ex.get("problem_statement", "")

    propose = ollama_propose(a.model, a.num_ctx, a.timeout)
    apply_and_test = make_apply_and_test(a.instance)

    print(f"=== agentic run: {a.instance} (max {a.max_attempts} attempts) ===", flush=True)
    t0 = time.time()
    result = run_agent_loop("Resolve the issue described above.", context, propose,
                            apply_and_test, max_attempts=a.max_attempts)
    dt = time.time() - t0
    summary = {
        "ts": int(t0), "instance": a.instance, "model": a.model, "mode": "agentic",
        "resolved": result["resolved"], "verdict": result["verdict"],
        "attempts": result["attempts"], "wall_s": round(dt, 1),
        "history": [{k: v for k, v in h.items() if k != "output"} for h in result["history"]],
    }
    log = os.path.join(ROOT, "data", "eval", "swebench", "agentic-runs.jsonl")
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps(summary) + "\n")
    print(f"\nVERDICT {a.instance}: resolved={result['resolved']} "
          f"({result['verdict']}, {result['attempts']} attempts, {round(dt)}s)", flush=True)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
