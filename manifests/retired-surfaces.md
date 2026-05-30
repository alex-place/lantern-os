# Retired Or Deprecated Surfaces

This file prevents old paths from quietly becoming release gates.

## Deprecated

| Surface | Source | Replacement |
|---|---|---|
| Legacy Seven smoke check | `C:\tmp\human-flourishing-frameworks-scan\scripts\seven_surface_audit.py` | `docs/CONVERGENCE-LOOP.md` |
| Skeleton-only staging | initial `lantern-os` scaffold | Loop-driven readiness with open issue handling |
| Render Lantern cloud mirror | `render.yaml` / `render-server.js` | AWS ECS Fargate container lane with `cloud-server.js` |
| HFF Render mirror as Lantern status source | `human-flourishing-frameworks.onrender.com` | Local-held HFF status until a verified AWS/HFF endpoint exists |

## Held

| Surface | Reason |
|---|---|
| Automated dual boot install | Requires physical operator action and disk/bootloader mutation |
| Local-held HFF status | Requires fresh local or verified AWS evidence before public cloud claims |
