### Σ₀ council hardening — adversarial-audit fixes (exec-verify security + agent-loop crash)

A Claude multi-agent audit (3 review lenses + adversarial verify; 12/12 findings confirmed) surfaced real defects in the council code. This lands the two highest-value, fully-verified ones:
- **exec-verify sandbox:** model-proposed code inherited the server's full env (API keys **exfiltratable**), ran in the server cwd (could overwrite repo/state files), and had no output cap. Now: minimal env (no secrets), `cwd` = isolated temp dir, `maxBuffer` cap, and output-overflow is reported distinctly instead of mislabelled "timeout". Pre-emptive — `verifyExec` has no live caller yet, but the fix must precede wiring it into the coding path.
- **swe_agent_loop crash:** `subprocess.run(test_cmd, shell=False)` with a string SWE-bench command (`python -m pytest …`) raised FileNotFoundError and aborted the whole self-correction loop instead of returning a refuted verdict. Now `shell=isinstance(test_cmd,str)` + OSError → failed verdict.

Tests green: exec-verify 6/6 (real subprocess, minimal env), swe_agent_loop selftest 5/5.
