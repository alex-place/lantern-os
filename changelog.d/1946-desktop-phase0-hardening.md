feat(desktop): ADR-0014 Phase-0 hardening seams — app-data state root, DPAPI key vault, loopback≠admin token (#1946)

Lands the three Core seams that must exist before a public unisona `.exe`
(ADR-0014 guardrails G2/G3/G4). All three are BEHAVIOUR-PRESERVING by default —
with none of `UNISONA_DESKTOP` / `UNISONA_STATE_DIR` / `UNISONA_LOCAL_TOKEN` set,
servers (4177 / 4178 / cloud) behave byte-for-byte as today.

- **State relocation (G2)** — new `lib/app-paths.js` is the one place that decides
  where writable state lives. Default: `<repoRoot>/data` (unchanged). Desktop
  (`UNISONA_DESKTOP=1`): `%APPDATA%\unisona\data` on Windows, XDG/Library on
  Linux/macOS; `UNISONA_STATE_DIR` overrides. `lib/tenant.js` now sources its
  `DATA_ROOT` from here, so the multi-tenancy seam (ADR-0018) and the desktop move
  share one anchor.
- **Key vault (G3)** — new `lib/key-vault.js` stores provider keys encrypted with
  Windows DPAPI (CurrentUser scope) at `<stateRoot>/keys.vault.json`; secrets are
  passed to the PowerShell child via env, never argv. `tenant.js` consults it only
  as a fallback when no plaintext env key is present, so `.env`-based servers are
  unchanged. Non-Windows `setKey` throws rather than write plaintext.
- **Loopback ≠ admin (G4)** — `lib/request-auth.js` gains a per-boot
  `UNISONA_LOCAL_TOKEN` gate: when set, loopback ALONE no longer confers operator
  rights (defeats local CSRF / DNS-rebind against 127.0.0.1); the request must
  carry the matching token. Token compares are now constant-time.

Follow-up slices (tracked on #1946): route the remaining direct
`path.join(repoRoot,"data",…)` call sites through `app-paths`; add a client fetch
header + first-run key-onboarding UI; then flip the launcher to
`UNISONA_DESKTOP=1` + mint the local token. Loop: **Remember** (durable per-user
state location) + **Act** (secure credential handling). Covered by
`test/desktop-phase0.test.js` (13 checks incl. a real DPAPI round-trip; folded
into `npm run test:sigma0`).
