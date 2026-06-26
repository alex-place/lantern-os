### Ops: auto-deploy self-heals a crashed-but-current stable server

- `scripts/auto-deploy-stable.ps1` (the tracked reference for the 4177 deploy task): the `up-to-date` branch now checks whether the server is actually running and **restarts it if it has died**, instead of logging "up-to-date" and leaving the site down. Previously a crashed-but-current 4177 only recovered when the *next commit* landed — which left lantern-os.net down until a manual `-Force`. Brings the tracked copy in sync with the running copy (`C:\dev\deploy-stable-from-master.ps1`).
