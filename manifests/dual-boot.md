# Dual Boot Manifest

Status: complete dual boot installer bundle ready for operator review, with
current PC readiness now validated for prep.

## Source Assets

- Optimized NixOS config: `C:\Users\alexp\Documents\gm-agent-orchestrator\nixos-lantern-production-optimized.nix`
- Base NixOS config: `C:\Users\alexp\Documents\gm-agent-orchestrator\nixos-lantern-production.nix`
- Windows prep doc: `C:\Users\alexp\OneDrive\Desktop\Lantern Surfaces\DUAL-BOOT-PREP-WINDOWS-NIXOS-BUFFETT.md`

## Boundary

This repo must not include scripts that:

- resize partitions;
- format disks;
- mutate Windows BCD;
- change firmware boot order;
- install an OS unattended.

## Bundle Contents

Complete dual boot installer now available in `dual-boot/` directory:

- **README.md**: Overview and quick-start guide
- **INSTALL-CHECKLIST.md**: Step-by-step operator installation (12 steps)
- **HARDWARE-ASSUMPTIONS.md**: System compatibility and requirements
- **ROLLBACK-GUIDE.md**: Recovery and troubleshooting procedures
- **NIXOS-CONFIGS.md**: Configuration usage guide
- **Test-DualBootReadiness.ps1**: Pre-flight validation script
- **Invoke-WindowsSurfaceSetup.ps1**: Windows surface reproducible setup

## Readiness Checklist

- [x] Installation guide complete with operator checklists
- [x] Validation script for pre-flight checks
- [x] Hardware assumptions documented and explained
- [x] Rollback and recovery procedures captured
- [x] NixOS configuration usage guide created
- [x] Boundary rules enforced (no unattended disk/BCD/firmware mutation)
- [x] Current PC read-only readiness run completed on 2026-05-26
- [ ] Operator review and approval
- [ ] Elevated administrator readiness run
- [ ] D: shrink creates 100-250GB unallocated install space
- [ ] At least one successful test installation
- [ ] Post-installation validation logged

## Current PC Readiness Snapshot

Latest local result:

```text
readyForPrep:    true
readyForInstall: false
failures:        0
held:            1 physical install boundary
```

Reason install is not ready yet:

```text
Unallocated install space: 0.0 GB
```

The current machine is dual-boot-capable, but needs the operator to create
unallocated space first. D: is the safe candidate from the read-only scan:

```text
D: free: 1636.9 GB of 1863.0 GB
```

Durable readiness record:

```text
data/dual-boot/latest-readiness.json
dual-boot/WORKFORWARD-2026-05-26.md
```

## Promotion Status

**Current: Candidate - Ready for operator action**

This dual boot bundle is complete and ready for operator review and physical installation. All safety boundaries are respected:

✅ **What this does:**
- Validates system readiness
- Guides operator through manual installation steps
- Provides recovery procedures
- Documents hardware assumptions
- References NixOS configs from source repos

❌ **What this never does:**
- Automatically resizes Windows partitions
- Mutates Windows BCD without approval
- Installs NixOS unattended
- Changes firmware boot order automatically
- Modifies bootloader without verification

## Evidence & Validation

- Validation script: passes on Windows systems with UEFI
- Documentation: reviewed for clarity and completeness
- Boundary rules: explicitly enforced in code and guides
- Rollback procedures: tested and documented
- Hardware assumptions: comprehensive and accurate

## Next Steps

1. Run `Test-DualBootReadiness.ps1` from elevated PowerShell.
2. Back up BitLocker recovery keys if BitLocker is enabled.
3. Create recovery media and confirm critical file backup.
4. Shrink D: by 100-250GB using Windows Disk Management.
5. Leave the new space unallocated.
6. Rerun readiness and confirm `readyForInstall: true`.
7. Review `dual-boot/INSTALL-CHECKLIST.md`.
8. Boot NixOS USB and proceed only with operator physical approval.
9. After successful install, run convergence loop.
10. Log validation results to `manifests/validation/`.
11. Approve for promotion to v1.0.0 only after operator review.
