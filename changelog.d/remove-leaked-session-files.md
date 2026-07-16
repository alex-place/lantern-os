Security cleanup: removed the two `data/sessions/*.json` server session-store
entries that landed on master via #2575 (the filenames ARE the session IDs — the
live sessions were quarantined on the fleet host and are invalid), and gitignored
`data/sessions/` so runtime session state can never be committed again. Note the
IDs remain in git history; treat them as burned — rotating `SESSION_SECRET`
invalidates everything signed before it. (Improves Verify — secrets stay out of
the repo.)
