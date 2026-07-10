fix(ci): make releases one-click. auto-tag.yml pushes the version tag with GITHUB_TOKEN,
and GitHub's recursion guard means a GITHUB_TOKEN-authored tag never triggers release.yml
— so the Release build (zips + desktop installer + GitHub Release) had to be dispatched by
hand. auto-tag now dispatches release.yml itself via workflow_dispatch (the documented
exception to the guard), with `actions: write`. No new secret.
