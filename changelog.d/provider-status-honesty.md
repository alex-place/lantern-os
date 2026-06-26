### Provider status honesty: surface the env-hydration mismatch (#1233)

`/api/providers/status` (and `/api/providers/keys`) could report a provider "connected"
while the running dispatcher couldn't actually see the key — the status endpoint silently
hydrated `process.env` from the OS registry as a side effect of being queried, masking the
exact state that makes chat return the generic "all providers failed."

Now the status reflects the **dispatch source of truth** and surfaces the mismatch:

- A module-load snapshot records which keys the process **started with** (`startedWithKey`) —
  the true baseline the dispatcher saw on early requests, before any lazy hydration.
- Each provider reports `inProcessEnv` (dispatch-ready), `inRegistry` + `registryScope`
  (User/Machine), and `mismatch = inRegistry && !startedWithKey` — the danger state where the
  key exists in the OS but the process never loaded it. `available` now strictly tracks
  `inProcessEnv` (not "key exists somewhere"), and the response carries a `warnings[]` list +
  `summary.envConsistent`.
- Root-cause fix: the lazy fallback now reads **both User and Machine** scope (Start-DualServers
  hydrates both; the old path read User only, so a Machine-only key never loaded). The registry
  is probed in **one batched PowerShell call** instead of up to ~20 serial spawns (the old
  per-key path could hang the endpoint).

Verified on the dev preview: a process started *with* keys reports `envConsistent:true`/no
warnings; a process started *without* the keys while the registry has them reports
`mismatch:true` + per-provider warnings — the #1233 state made visible instead of masked.
