fix(ops): auto-deploy liveness probes /api/health, not the cold convergence endpoint (#2067)

`scripts/auto-deploy-stable.ps1` gated a fresh deploy on `/api/convergence/health`,
which does cold convergence-kernel work on first hit — slow enough after a restart to
time out the 4s probe and trigger a needless rollback of a healthy release. Switched
the `HealthOk` probe to the dependency-free `/api/health` (plain JSON liveness that
never touches the kernel). Verified `/api/health` returns 200 on the running server;
the script still parses clean.
