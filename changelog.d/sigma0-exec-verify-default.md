### Σ₀ grounding on by default + a clean test suite

The council's execution-grounded verify-face now runs on the live chat path. `COUNCIL_EXEC_VERIFY`
flips from default-off to **default-on** (opt-out via `COUNCIL_EXEC_VERIFY=0`): when a coding reply
carries runnable code + a check, `lib/exec-verify.js` runs it so the reply's own asserts — not the
model's self-judgment — decide grounded-vs-refuted. The sandbox is shell-free, temp-dir isolated,
hard-timed, output-capped, and runs with a minimal env that strips every API key, which is what
makes default-on defensible on the local single-operator surface. Shared/multi-tenant surfaces can
still set `COUNCIL_EXEC_VERIFY=0`. Closes #1640.

Also removed `tests/test_sigma0_state_abi.py`, an orphan that tested a deleted PCA `StateABI` design
(`.U`/`.fit`/`D_MIN`) and blocked clean `pytest tests/` collection with an `ImportError`. The current
`StateABIShim` is already covered by `tests/test_state_abi_shim.py`; nothing in production imports the
old class. Collection now succeeds with 0 errors, making the CLAUDE.md "clean run" claim true. Closes #1639.
