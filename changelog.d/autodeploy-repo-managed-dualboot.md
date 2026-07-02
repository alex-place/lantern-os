### Ops: stable auto-deploy is now repo-managed and windowless

- New `scripts/Register-AutoDeployStable.ps1` makes the 4177 auto-deploy a first-class repo unit: it copies the tracked, authoritative `scripts/auto-deploy-stable.ps1` to the out-of-repo running path (`C:\dev\deploy-stable-from-master.ps1`), writes a hidden `wscript` launcher, and (re)registers the `KeystoneAutoDeployStable` scheduled task. No more hand-syncing the two copies — the drift that left the running copy missing the LFS `required=false` fix.
- The task now launches via the hidden launcher (window style 0), so the 5-minute deploy cycle no longer flashes a PowerShell console in the user session.
- `scripts/Start-DualServers.ps1` re-syncs the deploy script on every quickstart when the task already exists (`-RegisterAutoDeploy` for first-time setup on a deploy host, `-NoAutoDeploy` to skip). Editing the tracked script + re-running dual-boot now ships a deploy-script change.
- Documented in QUICKSTART.md ("Keep the public stable server auto-deploying").
