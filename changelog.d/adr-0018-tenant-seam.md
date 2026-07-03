ADR-0018 (Accepted): the web/desktop delivery split + cloud multi-tenancy. Adds
`apps/lantern-garage/lib/tenant.js` — the one `resolveTenant(req)` seam (guardrail
W2) that lets the single Convergence Core serve two profiles without a fork: a
`local` default that is byte-for-byte today's behaviour (single owner, the existing
`data/` tree, `process.env` keys — 4177 / 4178 / desktop unchanged) and a `cloud`
profile that namespaces memory under `data/tenants/<id>` and resolves bring-your-own
keys per session, never leaking the host's env keys to a tenant. Behaviour-preserving:
nothing routes through the seam yet; call-site migration is a later slice. (Remember/Act)
