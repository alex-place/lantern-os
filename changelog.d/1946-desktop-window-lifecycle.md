Fix desktop app dying with ERR_CONNECTION_REFUSED when a browser is already running
(#1946). The launcher shut the Core down when the spawned `msedge --app` process
exited — but with Edge already open, that process exits immediately (the window is
handed to the existing browser), killing the Core under a live window. The launcher
now polls for any browser using our dedicated `--user-data-dir` profile
(watchAppWindow) and quits only when the real window is gone. Also ships
`data/contexts/` in the installer so the Core finds personas.json instead of falling
back to defaults. Strengthens Act.
