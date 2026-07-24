r"""
swebench_verifier_harness.py — drive SWE-bench Lite instances through the #2174 coding-backend
`tests-run` verifier and measure gate accuracy: does the control plane's verifier correctly PASS a
gold-patched repo and FAIL the un-patched base? (#2187.)

For each instance the flow is: clone → checkout base_commit → apply test_patch (adds the FAIL_TO_PASS
test) → then call the REAL verifier (lib/coding-backend/verifiers/tests-run.js
runTests) twice — once materialising the GOLD file contents (expect passed=True) and once the BASE
contents (expect passed=False), with the instance's pytest FAIL_TO_PASS command as testCommand. Gate
accuracy = fraction of (gold→pass, base→fail) the verifier gets right.

⚠️ REAL instances need Docker/WSL2 (the SWE-bench toolchain): each instance requires its ERA-matched
Python + pinned deps. Proven infeasible on this box — Python 3.12 can't import a 2016 requests'
vendored urllib3 (`urllib3.packages.six.moves` is gone); that's exactly why SWE-bench ships per-instance
Docker images. So `--real` is a no-op stub here that records the blocker; run it on a Docker box.

`--selftest` builds a SYNTHETIC instance (a real buggy function + a real pytest test) and drives it
through the SAME verifier — runnable HERE — to prove the harness↔verifier wiring gates correctly.

Run:  .venv-train/Scripts/python.exe scripts/swebench_verifier_harness.py --selftest
      .venv-train/Scripts/python.exe scripts/swebench_verifier_harness.py --real --limit 5   # needs Docker
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TESTS_RUN_JS = REPO / "apps" / "lantern-garage" / "lib" / "coding-backend" / "verifiers" / "tests-run.js"

_NODE_DRIVER = r"""
const { runTests } = require(process.argv[2]);
const inp = JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8'));
runTests({ repoPath: inp.repoPath, files: inp.files, task: inp.task || '' },
         { testCommand: inp.testCommand })
  .then(r => { process.stdout.write(JSON.stringify(r)); })
  .catch(e => { process.stdout.write(JSON.stringify({ error: String(e) })); });
"""


def call_verifier(repo_path, files, test_command, task=""):
    """Invoke the real tests-run.js runTests and return its result dict."""
    with tempfile.TemporaryDirectory() as td:
        drv = Path(td) / "drv.js"
        drv.write_text(_NODE_DRIVER, encoding="utf-8")
        inp = Path(td) / "inp.json"
        inp.write_text(json.dumps({"repoPath": str(repo_path), "files": files,
                                   "testCommand": test_command, "task": task}), encoding="utf-8")
        out = subprocess.run(["node", str(drv), str(TESTS_RUN_JS), str(inp)],
                             capture_output=True, text=True, timeout=180,
                             env={**os.environ, "CODING_VERIFY_TESTS": "1"})
        try:
            return json.loads(out.stdout.strip() or "{}")
        except json.JSONDecodeError:
            return {"error": "bad verifier output", "stdout": out.stdout[-500:], "stderr": out.stderr[-500:]}


def selftest():
    """Synthetic instance: a real bug + a real pytest test, driven through the real verifier."""
    py = sys.executable
    with tempfile.TemporaryDirectory() as repo:
        repo = Path(repo)
        # the FAIL_TO_PASS test (part of the "repo", i.e. already materialised like an applied test_patch)
        (repo / "test_calc.py").write_text(
            "from calc import add\n\n"
            "def test_add():\n    assert add(2, 3) == 5\n    assert add(-1, 1) == 0\n", encoding="utf-8")
        # gold fix vs buggy base — passed to the verifier as candidate file contents
        gold = "def add(a, b):\n    return a + b\n"
        base = "def add(a, b):\n    return a - b  # BUG\n"
        # a fresh calc.py must exist for import; the verifier overwrites it with `files`
        (repo / "calc.py").write_text(base, encoding="utf-8")
        # safe-exec's SHELL_META rejects backslash; use a forward-slash python path (colon/slash are ok)
        test_cmd = f'"{py.replace(os.sep, "/")}" -m pytest test_calc.py -q -p no:cacheprovider'

        r_gold = call_verifier(repo, [{"path": "calc.py", "content": gold}], test_cmd)
        r_base = call_verifier(repo, [{"path": "calc.py", "content": base}], test_cmd)
        gold_ok = r_gold.get("passed") is True
        base_fail = r_base.get("passed") is False and not r_base.get("skipped")
        gate_correct = gold_ok and base_fail
        report = {
            "mode": "selftest (synthetic instance through the real tests-run.js verifier)",
            "gold_verdict": r_gold, "base_verdict": r_base,
            "gold_passes_as_expected": gold_ok, "base_fails_as_expected": base_fail,
            "gate_correct": gate_correct,
        }
        print(json.dumps(report, indent=2))
        return report


def real_stub(limit):
    """Would drive real SWE-bench Lite instances — blocked on Docker here (see module docstring)."""
    from datasets import load_dataset  # noqa: local import; heavy
    ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    sample = [ds[i]["instance_id"] for i in range(min(limit, len(ds)))]
    print(json.dumps({
        "mode": "real",
        "status": "BLOCKED — needs Docker/WSL2 (per-instance era-matched Python env)",
        "proven_infeasible_local": ("Python 3.12 in .venv-train cannot import a 2016-era requests' "
                                    "vendored urllib3 (urllib3.packages.six.moves removed). SWE-bench "
                                    "ships per-instance Docker images for exactly this reason; swebench "
                                    "also won't import on Windows (no `resource` module)."),
        "n_instances_available": len(ds), "would_run": sample,
        "how_to_run_on_a_docker_box": ("materialise each instance in its swebench image, apply "
                                       "test_patch, then call this harness's call_verifier() with the "
                                       "gold/base file contents and the FAIL_TO_PASS pytest command."),
    }, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--real", action="store_true")
    ap.add_argument("--limit", type=int, default=5)
    a = ap.parse_args()
    if a.real:
        real_stub(a.limit)
    else:
        rep = selftest()
        OUT = REPO / "data" / "eval" / "swebench_verifier_selftest.json"
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(rep, indent=2), encoding="utf-8")
        print(f"\nGATE {'CORRECT' if rep['gate_correct'] else 'WRONG'} — report -> {OUT.relative_to(REPO)}")
        sys.exit(0 if rep["gate_correct"] else 1)


if __name__ == "__main__":
    main()
