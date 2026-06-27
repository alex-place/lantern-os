### Ops: dual-boot launcher reaps zombies + matches the stable auto-deploy pattern

- `scripts/Start-DualServers.ps1` now launches both servers (`:4177` stable, `:4178` dev) with **absolute** entry paths, so each instance is uniquely identifiable by command line — the same convention the stable auto-deploy uses to reap leaked zombies.
- Its stop step is upgraded from a port-listener-only `Stop-Process` to a **tree-kill** (`taskkill /T`, so child services don't orphan) **plus a zombie sweep** over both worktrees' entry paths (catches a server that's alive but no longer listening). This is the same leak that caused the lantern-os.net 502 churn.
- Sets `LANTERN_CLOUDFLARE_TUNNEL=false` for both servers so neither spawns its own doomed cloudflared child (Unix creds path on Windows); the cloudflared Windows service is the real tunnel and dev is loopback-only.
