# GCE Cloud Deploy Runbook (unisona.ai)

Operational record of the live single-tenant cloud deployment of `master` on Google
Compute Engine, fronted by Cloudflare. This is the first concrete instance of the
[ADR-0018](../adr/0018-web-tier-split-and-cloud-multi-tenancy.md) GCE origin decision.

> **Status: manual deploy, no CI/CD.** The VM is a one-time `git clone`; merges to
> `master` do **not** reach it automatically. Update it with the steps in
> [Updating the running app](#updating-the-running-app). Provider secrets live in
> systemd drop-ins on the box, never in the repo.

## What's running

| Thing | Value |
|-------|-------|
| GCP project | `project-2f747c41-d0f3-4de9-b48` (number `843848914143`) |
| VM | `lantern-app`, zone `us-central1-a`, `e2-medium`, Debian 12, 30 GB pd-balanced |
| External IP | `104.197.219.106` (ephemeral — reserve a static IP if it must persist) |
| App service | systemd `lantern.service` → `node server.js` in `/opt/lantern-os/apps/lantern-garage`, binds `0.0.0.0:8080` |
| Tunnel service | systemd `cloudflared` → tunnel `lantern-cloud` (`c666a37e-b03f-43a6-ad68-aa0455a7b246`) |
| MCP | `localhost:8771` (spawned by the app; **not** exposed publicly) |
| LLM | Gemini via **Vertex**, keyless off the VM service account |

Public hostnames (Cloudflare → tunnel → `localhost:8080`): `unisona.ai`,
`www.unisona.ai`, `cloud.lantern-os.net`.

## Driving gcloud

The box has **no** interactive gcloud account — only Application Default
Credentials. Bridge management commands with the ADC token:

```bash
export CLOUDSDK_AUTH_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
# compute/iam commands now work; they need the project ID, not the number.
gcloud compute ssh lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48
```

## Vertex (keyless)

The VM's default compute SA `843848914143-compute@developer.gserviceaccount.com` is
granted `roles/aiplatform.user` and runs with `--scopes=cloud-platform`, so Gemini
reaches Vertex through the metadata server — no key files. Enabled by these env vars
(see drop-ins below): `GEMINI_USE_VERTEX=1`, `VERTEX_PROJECT=project-2f747c41-d0f3-4de9-b48`,
`VERTEX_LOCATION=us-central1`. Only `gemini-2.5-flash` is currently valid in-region
(the 1.5/2.0 model ids 404 on Vertex).

## Environment (systemd drop-ins)

`/etc/systemd/system/lantern.service.d/` (each `chmod 600`, root-owned):

| File | Vars |
|------|------|
| `env.conf` | `SESSION_SECRET`, `GEMINI_USE_VERTEX`, `VERTEX_PROJECT`, `VERTEX_LOCATION`, `NODE_ENV=production` |
| `google.conf` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `providers.conf` | `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_CAMPAIGN_ID` |
| `discord.conf` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |

Values were copied from the operator's `lantern-os-stable/.env.local`. `SESSION_SECRET`
is required because the app fail-closes when bound beyond loopback without one.

After editing any drop-in: `sudo systemctl daemon-reload && sudo systemctl restart lantern.service`.

### OAuth redirect URIs (register on each provider)

The callback is derived from the request host, so it's always
`https://unisona.ai/api/auth/<provider>/callback`. Each provider's app must list it:
Google (project 843848914143 OAuth client), Patreon client, Discord app (OAuth2 →
Redirects). Discord app id `1523112567386669187`.

## Cloudflare tunnel

Dedicated named tunnel `lantern-cloud` runs **on the VM** (outbound-only, so 8080
stays closed to the internet). Config `/etc/cloudflared/config.yml` routes the three
hostnames to `http://localhost:8080`. It is separate from the operator's PC tunnel
`lantern-os` (serves `lantern-os.net` → PC:4177) so they don't fight. The tunnel and
all zones live in Cloudflare account `967f7517df9d7bd043aa9156e37c28ed`.

`mcp.unisona.ai` is deliberately **left out** of the ingress (fail-closed 404): the
port-8771 MCP is no-auth and exposes git-write / dispatch tools, so it must never be
publicly reachable. Gate with Cloudflare Access or the OAuth MCP (8772) before ever
exposing it.

## Updating the running app

No auto-deploy. To ship `master` (or a merged PR) to the box:

```bash
export CLOUDSDK_AUTH_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
gcloud compute ssh lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48 --command='
  sudo git config --global --add safe.directory /opt/lantern-os
  cd /opt/lantern-os && sudo git pull --ff-only origin master
  sudo npm install --omit=dev --prefix apps/lantern-garage
  sudo systemctl restart lantern.service
  sleep 6 && curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8080/'
```

Notes:
- The clone is **shallow (depth-1)**; if `git pull` complains, `sudo git fetch --unshallow origin` once.
- Static assets (`public/`) are served from disk — no restart needed for HTML/JS/CSS-only changes.
- Live hotfixes applied directly to `/opt/lantern-os/...` will conflict with a pull
  until the same change lands in `master`. Prefer landing a PR, then pulling.

## Provisioning from scratch

If the VM is lost, recreate it: create an `e2-medium` Debian-12 instance with
`--service-account=843848914143-compute@developer.gserviceaccount.com --scopes=cloud-platform`,
a startup script that installs Node 20 + git, clones `master`
(`GIT_LFS_SKIP_SMUDGE=1`), `npm install`, and installs `lantern.service`. Then:
grant `roles/aiplatform.user` to the SA, recreate the four env drop-ins, install the
cloudflared connector for tunnel `lantern-cloud` (credentials from the operator's
`~/.cloudflared/`), and (optionally) `pip install fastapi uvicorn[standard]
sse-starlette httpx` for the MCP child. Enable APIs: `compute`, `aiplatform`.

## Cost / lifecycle

`e2-medium` 24/7 ≈ $25/mo plus Vertex per-call. Stop when idle:

```bash
gcloud compute instances stop lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48
gcloud compute instances start lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48
```
