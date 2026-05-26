# Dual Boot Manifest

Status: planning only.

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

## Next Review

Before promotion, review the NixOS configs, record hardware assumptions, and
capture the operator's physical install checklist.

