### Fixed

- Sitemap coverage: added the 5 genuinely-public, click-reachable pages that were served but unlisted (budget, ibkr-setup-guide, options, orchestration, watch) to sitemap.xml so crawlers can find them. The remaining reachable-but-unlisted pages are intentional (auth/settings SEO-excluded; fallout-radio/trader-guide/work are authed). The gate bucket (accounts/admin-flags) is already PROTECTED; the orphaned internal pages (entry/metrics/system-health/wide-search) are maintained, not dead. (#3109)
