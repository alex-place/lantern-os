"""Σ₀ SWE agent loop — propose → apply → test → retry, grounded in execution.

Single-shot diffs are brittle: Qwen scored 0/3 on SWE-bench Lite, 2 applied-but-wrong, because a
blind patch must reproduce the exact surrounding lines AND the correct fix in one shot. This closes
the seam (src/cio_sde/question.py): the model proposes a patch, the repo's REAL tests run, and a
failing test (`refuted`) feeds its output back as grounding for the next attempt — the council's
refuted->retry (lib/council-review.js, lib/exec-verify.js) made into a control loop.

The model call (`propose`) and the repo apply+test (`apply_and_test`) are INJECTED, so the loop
logic is testable with no model and no Docker:

    python scripts/swe_agent_loop.py --selftest

Live wiring (needs the running stack): `propose` -> ollama /api/chat (the --direct path), and
`apply_and_test` -> `git apply` + the instance's FAIL_TO_PASS test command, run INSIDE the swebench
WSL/Docker env that already grades the result. That integration is the next step; this is its core.
"""
from __future__ import annotations

import argparse, http.client, json, subprocess, sys, time

MAX_FEEDBACK = 1200  # cap the failure text fed back into the next attempt


def run_agent_loop(problem, context, propose, apply_and_test, max_attempts=4):
    """Drive propose -> apply -> test -> retry until a test passes or attempts run out.

    propose(problem, context, history) -> patch_str ("" if none).
    apply_and_test(patch) -> {"applied": bool, "passed": bool, "output": str}.
    Returns {"resolved", "patch", "verdict", "attempts", "history"}. Each non-passing attempt is
    appended to `history` (with its failure output) so propose() can self-correct against it."""
    history = []
    best = {"patch": "", "verdict": "no_patch", "attempt": 0}
    for attempt in range(1, max_attempts + 1):
        patch = propose(problem, context, history) or ""
        if not patch.strip():
            history.append({"attempt": attempt, "event": "no_patch"})
            continue
        res = apply_and_test(patch) or {}
        if not res.get("applied"):
            history.append({"attempt": attempt, "event": "apply_failed",
                            "output": str(res.get("output", ""))[:MAX_FEEDBACK]})
            best = {"patch": patch, "verdict": "apply_failed", "attempt": attempt}
            continue
        if res.get("passed"):
            return {"resolved": True, "patch": patch, "verdict": "resolved",
                    "attempts": attempt, "history": history}
        history.append({"attempt": attempt, "event": "refuted",
                        "output": str(res.get("output", ""))[:MAX_FEEDBACK]})
        best = {"patch": patch, "verdict": "refuted", "attempt": attempt}
    return {"resolved": False, "patch": best["patch"], "verdict": best["verdict"],
            "attempts": max_attempts, "history": history}


# ── live dependencies (need the running stack; not exercised by --selftest) ──────────────

def ollama_propose(model, num_ctx, timeout, host="127.0.0.1", port=11434):
    """Build a `propose` that asks ollama for a patch and feeds the last failure back in."""
    def propose(problem, context, history):
        last = next((h for h in reversed(history) if h.get("output")), None)
        feedback = ""
        if last:
            feedback = (f"\n\nYour previous patch {last['event'].replace('_', ' ')}. Test/apply output:\n"
                        f"{last['output']}\nFix it. Output ONLY the corrected unified diff.")
        sys_msg = ("You are a code-fixing tool. Output ONLY a unified diff (git patch) that resolves "
                   "the issue, inside one ```diff block, context lines matching the source exactly. "
                   "No prose, no tools, no reproduction scripts.")
        body = json.dumps({
            "model": model, "stream": False, "options": {"num_ctx": num_ctx, "temperature": 0},
            "messages": [{"role": "system", "content": sys_msg},
                         {"role": "user", "content": f"{context}\n\n{problem}{feedback}"}],
        }).encode("utf-8")
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        try:
            conn.request("POST", "/api/chat", body=body, headers={"Content-Type": "application/json"})
            raw = conn.getresponse().read().decode("utf-8", "replace")
        finally:
            conn.close()
        try:
            return json.loads(raw).get("message", {}).get("content", "")
        except Exception:
            return ""
    return propose


def git_apply_and_test(repo_dir, test_cmd):
    """Build an `apply_and_test` that applies a patch in a cloned repo and runs the test command.
    Run this INSIDE the instance's env (the swebench container) so the deps exist."""
    def apply_and_test(patch):
        ap = subprocess.run(["git", "apply", "-"], cwd=repo_dir, input=patch,
                            capture_output=True, text=True)
        if ap.returncode != 0:
            return {"applied": False, "passed": False, "output": ap.stderr[:MAX_FEEDBACK]}
        # A string test_cmd (the SWE-bench form, e.g. "python -m pytest …") needs shell=True; a list
        # runs shell-free. Either way, an OS error (bad interpreter, missing file) becomes a failed
        # verdict, not an exception that aborts the whole self-correction loop.
        try:
            tr = subprocess.run(test_cmd, cwd=repo_dir, shell=isinstance(test_cmd, str),
                                capture_output=True, text=True)
        except OSError as e:
            return {"applied": True, "passed": False, "output": f"test command failed to run: {e}"}
        ok = tr.returncode == 0
        # leave the tree clean for the next attempt
        subprocess.run(["git", "checkout", "--", "."], cwd=repo_dir, capture_output=True)
        return {"applied": True, "passed": ok, "output": (tr.stdout + tr.stderr)[-MAX_FEEDBACK:]}
    return apply_and_test


def selftest():
    """Offline proof of the loop logic — no model, no Docker."""
    fails = 0

    # 1) wrong twice, then correct -> resolves on attempt 3 with 2 refutations recorded.
    n = {"i": 0}
    def propose_progressive(p, c, h):
        n["i"] += 1
        return "GOOD" if n["i"] >= 3 else f"BAD{n['i']}"
    def test_good_only(patch):
        return {"applied": True, "passed": patch == "GOOD",
                "output": "" if patch == "GOOD" else "AssertionError: x != y"}
    r = run_agent_loop("p", "c", propose_progressive, test_good_only, max_attempts=4)
    ok = r["resolved"] and r["attempts"] == 3 and sum(1 for h in r["history"] if h["event"] == "refuted") == 2
    print(f"[selftest] retry until pass (attempt 3)   -> {ok}"); fails += 0 if ok else 1

    # 2) always wrong -> exhausts attempts, not resolved, verdict refuted.
    r = run_agent_loop("p", "c", lambda p, c, h: "BAD", test_good_only, max_attempts=3)
    ok = (not r["resolved"]) and r["attempts"] == 3 and r["verdict"] == "refuted"
    print(f"[selftest] exhaust attempts -> refuted    -> {ok}"); fails += 0 if ok else 1

    # 3) unappliable patch -> apply_failed recorded (and fed back).
    r = run_agent_loop("p", "c", lambda p, c, h: "BAD",
                       lambda patch: {"applied": False, "output": "patch does not apply"}, max_attempts=2)
    ok = (not r["resolved"]) and r["verdict"] == "apply_failed" and r["history"][0]["event"] == "apply_failed"
    print(f"[selftest] unappliable -> apply_failed     -> {ok}"); fails += 0 if ok else 1

    # 4) the failing output is handed to propose() so it can self-correct.
    saw = {"feedback": False}
    def propose_reads_history(p, c, h):
        if any(x.get("output") for x in h):
            saw["feedback"] = True
            return "GOOD"
        return "BAD"
    r = run_agent_loop("p", "c", propose_reads_history, test_good_only, max_attempts=4)
    ok = r["resolved"] and saw["feedback"] and r["attempts"] == 2
    print(f"[selftest] failure fed back to propose     -> {ok}"); fails += 0 if ok else 1

    # 5) no patch ever -> no_patch verdict, not resolved.
    r = run_agent_loop("p", "c", lambda p, c, h: "", test_good_only, max_attempts=2)
    ok = (not r["resolved"]) and r["verdict"] == "no_patch"
    print(f"[selftest] empty proposals -> no_patch     -> {ok}"); fails += 0 if ok else 1

    print("SELFTEST:", "PASS" if fails == 0 else f"FAIL ({fails})")
    sys.exit(0 if fails == 0 else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="offline loop-logic proof; no model/Docker")
    ap.add_argument("--max-attempts", type=int, default=4, dest="max_attempts")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    print("Live agentic SWE runs wire propose->ollama_propose and apply_and_test->git_apply_and_test "
          "inside the swebench env. Run --selftest to verify the loop logic offline.")


if __name__ == "__main__":
    main()
