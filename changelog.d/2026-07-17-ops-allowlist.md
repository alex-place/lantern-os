### Fixed

- ci: allowlist the top-level `ops/` directory in the convergence anti-sprawl scan, so master goes green again. `ops/gce/` (the GCE release auto-deploy service/timer/script that rolls unisona.ai, added in #2117) is intentional deploy infrastructure, but `scripts/convergence-manager.js` never listed it in `ALLOWED_TOP` — so `SPRAWL:ops` was a standing blocking issue on every Convergence CI run. Strengthens **Verify** (a green master reflects real health, not a stale allowlist).
