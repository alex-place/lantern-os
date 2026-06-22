---
type: feat
issue: 848
---
feat(kernel): keystoneRun() emits a Convergence Record on every terminal outcome (success / applied_unverified / verification_failed), writing to data/convergence/records.jsonl — closes the kernel loop in the live serving path (#848).
