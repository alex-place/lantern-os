### Fixed

- Nav-map now respects nav-config: build-nav-map.mjs excludes surfaces the shipped nav hides (feature-flags.getNavMap), so a flag-hidden page like /create.html is no longer claimed click-reachable while auth-gate.js hides its footer link (#3177). Removed the hidden /create.html from sitemap.xml so all three sources agree it is non-public, and added a node-runnable guard (nav-map-hidden.test.js) so this can't drift again.
