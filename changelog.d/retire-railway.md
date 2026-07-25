### Railway deploy retired

Operator decision 2026-07-24: Railway is deprecated. No config files existed in-repo (it was
dashboard-configured); removed every live reference — `cloud-server.js` is now the generic cloud
entrypoint (GCE today, per ADR-0018), comments/env/docs de-branded. Historical mentions in
CHANGELOG/archives left as history. This removes Railway from PR #2923's unverified-deploy list;
remaining operator checks: GCE path + stable-host launcher + desktop build.
