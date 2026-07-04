Desktop app auto-updates itself, delta-only (#1946). lib/desktop-updater.js keeps the
installed Core code in sync with GitHub master: it asks the git-tree API for every
tracked file + blob SHA, compares against local git-blob-shas, and downloads ONLY the
changed files from raw.githubusercontent.com — a few KB, not the 120MB installer.
Staged in the background, applied at next startup before the Core runs. node_modules /
exe / LFS media aren't patched (rare → prompt full installer). Line-ending-aware
(CRLF→LF, git hash-object-identical). Gated on the packaged app; disable with
UNISONA_NO_UPDATE=1. Verified against the real repo (0 changes when current; 1-file
delta when drifted). Strengthens Act.
