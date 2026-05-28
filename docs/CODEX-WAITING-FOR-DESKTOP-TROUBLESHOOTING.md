# Codex Waiting for Desktop Troubleshooting

Status: diagnostic note
Date: 2026-05-28
Source: operator-provided GitHub issue snapshot for `openai/codex#22715`

## Purpose

Capture the safe troubleshooting path for the Codex mobile message:

```text
Waiting for desktop... Follow the instructions in the desktop app to get connected.
```

The same visible message can hide several different failures. Do not assume the desktop app is authorized, paired, or repairable from UI state alone.

## Observed Failure Modes

| Case | Symptom | Evidence to inspect | Safe next action |
|---|---|---|---|
| Desktop capability not advertised | Mobile waits; desktop shows no useful instructions | Codex app-server config/read or feature state lacks `remote_connections` and/or `remote_control` | Update to a fixed official build first; if testing a local build, prove the feature flags are exposed before claiming success. |
| Remote-control daemon not running | Mobile waits for desktop indefinitely | `codex remote-control start --json` or daemon status/logs | Start the daemon manually and watch JSON/log output. |
| Relay/backend unreachable | Daemon exists but cannot connect to backend | daemon stderr, socket state, proxy variables | Retry with explicit `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` only if the operator actually uses a proxy. |
| MFA required | Daemon enrollment is rejected with HTTP 403 and `Multi-factor authentication required` | app-server daemon stderr log | Enable MFA, sign out/in on desktop, confirm same account/workspace on mobile, generate a fresh QR code. |
| Stale mobile binding | Mobile waits for the wrong host after prior attempts | mobile pairing state and fresh QR flow | Exit stale waiting screen, remove old binding if visible, scan a fresh QR code. |
| Unsupported or not-yet-enabled platform path | Desktop route exists but feature remains unavailable | app version, platform, release notes, issue tracker | Hold; do not patch blindly. |

## Diagnostic Order

1. Record Codex Desktop version, mobile platform, Windows/macOS version, account, and workspace.
2. Update Codex Desktop and CLI to the latest official release available to the operator.
3. Confirm the desktop and mobile app are logged into the same ChatGPT/OpenAI account and workspace.
4. Run a read-only daemon check:

```powershell
codex remote-control start --json
```

5. Inspect daemon stderr logs if available. Useful paths reported in the issue include:

```text
~/.codex/app-server-daemon/app-server.stderr.log
```

6. If the log says MFA is required, enable MFA, sign out and back in, then generate a fresh QR code.
7. If the daemon is stuck at backend connection and the operator uses a proxy, start with explicit proxy variables and retest.
8. If the app-server does not advertise both remote control and remote connections, treat the desktop build as unsupported or feature-gated until an official fix or reviewed local build exists.

## Windows Feature-Gate Note

The issue snapshot describes a community-tested local source patch that made Windows desktop visible to mobile by exposing `remote_connections` alongside `remote_control` in the public app-server feature/config path.

Boundary:

- This repo may record the diagnostic and source-level hypothesis.
- Do not replace packaged binaries automatically from Lantern OS.
- Do not patch WindowsApps or Store-managed files.
- Do not claim a local binary swap is safe unless the operator requested it, backup exists, hashes are recorded, and the replacement binary is built from reviewed source.
- Prefer official Codex updates over local binary modification.

## Minimal Local Evidence Receipt

```text
Date/time:
Codex desktop version:
Codex CLI version:
OS/platform:
Mobile platform:
Same account/workspace confirmed: yes/no
MFA enabled: yes/no/unknown
Daemon command run:
Daemon status:
Daemon log excerpt:
Proxy in use: yes/no
Feature flags observed:
Fresh QR generated: yes/no
Mobile result:
Classification: feature_gate | daemon_not_running | backend_unreachable | mfa_required | stale_binding | unsupported | resolved | held
Next action:
```

## Do Not Claim

- Do not claim desktop pairing is fixed from config edits alone.
- Do not claim a mobile failure is caused by the phone until the desktop daemon and backend enrollment are checked.
- Do not claim MCP or Codex remote tools are available from advertised capability alone.
- Do not merge app binary patches into Lantern OS.

## Recommended Comment Shape

```text
This looks like one UI message covering multiple backend states. A useful diagnostic split would be:

1. platform unsupported or remote feature not enabled for this desktop build;
2. desktop app installed but app-server does not advertise remote_connections/remote_control;
3. remote-control daemon not running;
4. daemon running but relay/backend unreachable, including proxy issues;
5. daemon enrollment rejected, such as MFA-required HTTP 403;
6. mobile waiting on a stale host binding.

A read-only diagnostic panel showing desktop host id, feature flags, daemon status, relay registration, enrollment error, and last backend heartbeat would make the issue much easier to resolve safely.
```
