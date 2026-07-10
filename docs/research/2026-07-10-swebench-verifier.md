# SWE-bench × the coding-backend verifier: gate mechanism proven; the measured number is Docker-blocked

**Date:** 2026-07-10 · **Evidence class:** MEASURED (mechanism) / BLOCKED (SWE-bench number)
**Loop stage:** Verify · **Artifacts:** `scripts/swebench_verifier_harness.py`, `data/eval/swebench_verifier_selftest.json`
**Issues:** #2187 (harness + gate accuracy) · #2246 (official grading)

## What was asked

- **#2187** — drive SWE-bench Lite through the #2174 coding-backend `tests-run` verifier; does the
  control plane's verifier correctly gate real repo patches? Measure gate accuracy.
- **#2246** — the official SWE-bench Lite resolved% via the swebench Docker harness.

## The hard infra reality on this box (proven, not assumed)

- **#2246 is impossible here.** The `swebench` package **won't even import on Windows** (`No module
  named 'resource'` — a Unix-only stdlib). The official grader needs Linux + Docker.
- **Local SWE-bench execution is infeasible without Docker — demonstrated end-to-end.** I set up
  `psf__requests-3362` for real: cloned, checked out the base commit, applied the test_patch, made a
  venv, installed. It fails to run because a **2016-era requests** vendored an old `urllib3` whose
  `urllib3.packages.six.moves` no longer exists on **Python 3.12**. Each SWE-bench instance needs its
  **era-matched Python + pinned deps** — which is exactly why SWE-bench ships a **per-instance Docker
  image**. No amount of local pip-pinning fixes this across 300 instances on one Python.

## What IS proven: the verifier gates real patches correctly

`swebench_verifier_harness.py` drives an instance through the **real** `tests-run.js` (`runTests`) — it
materialises candidate file contents into the repo, runs the FAIL_TO_PASS pytest command, captures the
verdict from the exit code, and restores the tree. Its `--selftest` builds a **synthetic instance** (a
real buggy `add(a,b)=a-b` + a real pytest test asserting `add(2,3)==5`) and drives both the **gold** fix
and the **buggy base** through the same verifier:

| candidate | verifier `passed` | expected | correct? |
|---|---|---|---|
| gold (`return a+b`) | **true** | pass | ✓ |
| base (`return a-b`) | **false** | fail | ✓ |

**gate_correct = true.** The control-plane verifier correctly PASSES a real fix and FAILS the real bug,
executed for real (pytest exit code), tree restored after. So the *mechanism* #2187 asks about works;
the harness is ready to produce the SWE-bench-specific gate-accuracy number on a Docker-equipped box.

## Status / go-forward

- **#2187:** harness built + gate mechanism proven (1/1 on the runnable synthetic). The SWE-bench-Lite
  gate-accuracy number is deferred to a Docker box — `swebench_verifier_harness.py --real` records the
  blocker and the exact run recipe. This is the honest state; box 3 of the acceptance ("needs
  Docker/WSL2") is confirmed by the requests-3362 attempt above.
- **#2246:** blocked on Docker + Linux (swebench is Windows-incompatible). Not runnable on this box at
  all; needs a Linux/WSL2 host with the swebench harness.

## Honest scope

The gate-accuracy figure is on ONE synthetic instance (a clean bug/fix), not the SWE-bench distribution
— it proves the wiring and the pass/fail gating, not a resolved%. The real SWE-bench number requires the
Docker toolchain. MEASURED (mechanism). Reproduce: `.venv-train/Scripts/python.exe
scripts/swebench_verifier_harness.py --selftest`.
