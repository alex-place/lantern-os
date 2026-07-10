feat(tooling): add the `/release` skill — one command to fold the changelog, bump the
version, tag it, let CI build + publish the website and the native Windows desktop app
(Unisona-Setup .exe), then rewrite the GitHub Release into a launch post with the live
URL, the .exe download, features, and current pricing. Orchestrates the existing
release.yml / auto-tag.yml pipeline; does not replace it.
