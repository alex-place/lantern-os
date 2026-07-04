Desktop `.exe` Windows installer (Inno Setup, direct-download channel), verified
end-to-end (#1946). `scripts/build-desktop-installer.mjs` (npm `build:installer`)
stages the payload and compiles `desktop/unisona.iss` into `Unisona-Setup-<ver>.exe`
— a per-user install (no admin) to `%LOCALAPPDATA%\unisona`, shipping only
`unisona.exe` as the runtime. Staged layout mirrors the repo so the Core's
`../../../src` requires resolve; a completeness guard fails the build if any declared
dep is missing from the bundle. Launcher now sets `SKIP_DEP_PREFLIGHT=1` so the
`lantern-os` `file:` self-dep doesn't false-trip server.js's preflight. Verified on
Windows: build → silent-install → installed app boots (HTTP 200) → clean uninstall.
Remaining: sign (SignPath) + MSIX/Store channel. Strengthens Act.
