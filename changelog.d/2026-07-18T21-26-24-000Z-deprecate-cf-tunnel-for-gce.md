### Changed

- Marked the **Cloudflare-tunnel-to-local-fleet-host** deployment path **DEPRECATED** in favor of the **GCE origin** (per the Accepted ADR-0018, `docs/adr/0018-web-tier-split-and-cloud-multi-tenancy.md`). `docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md` now carries a deprecation banner pointing to the GCE deploy runbook (`docs/ops/gce-cloud-deploy-runbook.md`); `docs/ARCHITECTURE.md`'s prod-origin bullet now says GCE VM + Cloudflare edge/CDN, not a tunnel to local 4177. The tunnel remains a local-dev / fallback option only.
