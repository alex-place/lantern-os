### Fixed
- **Debug-statement gate no longer false-fails on test/CLI code** — the
  `Debug statement check` (`.github/workflows/slop-check.yml`) and the local
  pre-commit hook only exempted top-level `tests/` + `test_*` files, so legitimate
  `console.log` in **colocated** `apps/**/test/*.test.js` and in `scripts/`/`experiments/`
  CLI tools (where stdout *is* `console.log`) blocked the merge. Broadened the
  exemption to any `**/test(s)/**`, `*.test.*`, `*.spec.*`, `test_*`, plus `scripts/`
  and `experiments/`. Real debug leaks in shipped `lib/`/`routes/`/`public/` code are
  still caught (verified with a negative control). Unblocks the sprawl-tripwire PR
  (#1561) and the surprise-valve test harness. Improves the **Converge** stage.
