fix(ci): make releases fully hands-free and keep the deployed version label correct.
(1) auto-tag.yml now dispatches release.yml via workflow_dispatch — a GITHUB_TOKEN-pushed
tag never triggers release.yml (recursion guard), so the Release build never auto-fired
before. (2) assemble-changelog.js now also refreshes the SERVED
apps/lantern-garage/public/version.json (not just the root version.json), so the footer
stops showing a stale version after a release rolls (the v1.8.0 "shows old build" report).
