# Courtney Quick Sync - Pull Latest

**Date:** 2026-05-30  
**Purpose:** Pull latest changes from remote master

---

## Quick Command

**Open PowerShell in your lantern-os directory and run:**

```powershell
git pull origin master
```

---

## Verify

After pulling, verify you're up to date:

```powershell
git status
```

Should show: "Your branch is up to date with 'origin/master'"

---

## What's New

Latest changes include:
- Launch readiness report and PDFs
- Courtney desktop bridge setup guide
- Kalshi live trading infrastructure
- Lantern trade chat app

---

## Start Local App

After pulling, start local Lantern OS:

```powershell
.\scripts\Start-LanternDesktopTester.ps1
```

Browser will open to: `http://127.0.0.1:4177`
