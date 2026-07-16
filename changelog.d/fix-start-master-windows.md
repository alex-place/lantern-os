Fixed `start:master` (the stable-server autostart entrypoint): it still chained
`python3 …/human-flourishing-frameworks/export_snapshot.py || true` — that script
was deleted in the consolidation, and on Windows cmd `|| true` is not a command,
so the chain died **before `node --watch server.js` ever ran**. This is what kept
the 4177 stable server (and with it the in-process PR auto-merge watcher) from
booting on the fleet host. The script is now just pull + serve. (Improves Act —
the auto-merge/deploy loop can actually start.)
