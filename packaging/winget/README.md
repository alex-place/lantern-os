# winget distribution

Manifests to publish Unisona to the Windows Package Manager (`winget install Unisona`).
Each release gets a folder `Unisona.Unisona/<version>/` with three files (version /
installer / locale) per the winget schema.

## Submit a version

winget packages live in the community repo, so submission is a PR to
[`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs) under
`manifests/u/Unisona/Unisona/<version>/`.

```powershell
# validate + test locally first (needs the winget client)
winget validate .\packaging\winget\Unisona.Unisona\1.9.0
winget install --manifest .\packaging\winget\Unisona.Unisona\1.9.0   # optional local install test

# then submit — easiest via wingetcreate (it forks + opens the PR for you)
wingetcreate update Unisona.Unisona `
  --version 1.9.0 `
  --urls https://github.com/alex-place/lantern-os/releases/download/v1.9.0/Unisona-Setup-1.9.0.exe `
  --submit
```

## Per-release regeneration

The **`InstallerUrl`** and **`InstallerSha256`** change every release. To refresh:

```bash
V=1.9.1
URL="https://github.com/alex-place/lantern-os/releases/download/v$V/Unisona-Setup-$V.exe"
SHA=$(curl -sL "$URL" | sha256sum | cut -d' ' -f1)   # or Get-FileHash on Windows
# copy the 1.9.0 folder to $V, then bump PackageVersion, InstallerUrl, InstallerSha256.
```

## Notes

- **`InstallerType: inno`** — winget knows the Inno Setup silent switches, so no custom
  switches are needed; `Scope: user` matches the per-user (`PrivilegesRequired=lowest`) install.
- **`ProductCode: {8F3A2C1E-…}_is1`** — the Inno uninstall registry key, so winget can
  detect installed/updatable state. It must match the `AppId` in
  [`apps/lantern-garage/desktop/unisona.iss`](../../apps/lantern-garage/desktop/unisona.iss).
- **Signing:** the installer is currently unsigned, so first-run shows SmartScreen. winget
  accepts unsigned installers, but sign it (see the release workflow's signing step, or ship
  via the Microsoft Store which re-signs) to clear the warning. `winget` itself is trusted;
  the warning is from the downloaded installer, not winget.
