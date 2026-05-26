# Local Controls / AccessX Bridge

Generated: 2026-05-26.

Purpose: use local Windows controls as the bridge until Lantern has full
in-house apps.

## Command

From either `C:\tmp\lantern-os` or `C:\Users\alexp`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternLocalControls.ps1
```

Options:

```powershell
-OpenDashboard
-OpenAccessX
-OpenDiskPrep
```

## What It Does

- Opens Tony Garage.
- Checks dashboard health.
- Checks local MCP health.
- Checks Lantern health.
- Detects AccessX if installed.
- Saves validation to `manifests/validation/LOCAL-CONTROLS-LATEST.json`.

## Boundary

This is local control, not a replacement for an in-house app. It does not
automate disk mutation, collect cash, or publish stores. It keeps the cockpit
running while the app layer matures.
