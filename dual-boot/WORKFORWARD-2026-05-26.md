# Dual Boot Workforward

Generated: 2026-05-26.

Status: aggressive safe progress, physical install still operator-held.

## Current Decision

The current Windows PC is ready for dual-boot preparation, but not ready for the
Linux installer yet.

```text
readyForPrep:    true
readyForInstall: false
failures:        0
held:            physical install / disk mutation
```

## Why It Does Not Show Installer-Ready Yet

The blocker is simple and concrete:

```text
Unallocated install space: 0.0 GB
```

Windows is dual-boot-capable. The Linux installer needs unallocated space before
it can safely install beside Windows.

## Current Hardware Signal

```text
Firmware: UEFI detected
Windows:  Microsoft Windows 11 Pro 10.0.26200
Disk 1:   PNY CS900 500GB SSD, GPT, 466 GB, Healthy
Disk 0:   ST2000DM008-2FR102, GPT, 1863 GB, Healthy
C: free:  35.6 GB of 464.9 GB
D: free:  1636.9 GB of 1863.0 GB
EFI:      present
```

D: is the obvious shrink candidate.

## Next 12-Minute Physical Sprint

1. Open PowerShell as Administrator.
2. Run:

   ```powershell
   cd C:\tmp\lantern-os
   powershell -NoProfile -ExecutionPolicy Bypass -File .\dual-boot\Test-DualBootReadiness.ps1
   ```

3. Save the output to `manifests/validation/` if desired.
4. Confirm BitLocker status and back up recovery keys if enabled.
5. Open Disk Management with `diskmgmt.msc`.
6. Review D: on the 2 TB drive.
7. Shrink D: by 100-250 GB.
8. Leave the new space unallocated.
9. Rerun the readiness script.
10. Confirm `readyForInstall: true`.
11. Create or verify the NixOS USB installer.
12. Start `dual-boot/INSTALL-CHECKLIST.md` at the keyboard.

## Held Line

Codex/orchestrator may prepare, validate, log, and package. The operator must
perform partition shrink, reboot, firmware selection, installer steps, and
bootloader decisions physically.

## Son's PC / Second Dual Boot

Use `dual-boot/SONS-PC-READINESS.md` for the second PC. Do not assume it matches
the current PC. Run the same readiness script there first and record the result
before planning partition work.
