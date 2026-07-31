# GCE Cloud Deploy Runbook (unisona.ai)

Operational record of the live single-tenant cloud deployment of `master` on Google
Compute Engine, fronted by Cloudflare. This is the first concrete instance of the
[ADR-0018](../adr/0018-web-tier-split-and-cloud-multi-tenancy.md) GCE origin decision.

> **Status: release-gated self-update.** The VM does **not** track `master` — merges
> alone never reach it. It moves when a **GitHub Release is published**: a
> `systemd` timer polls `releases/latest` every 15 minutes, checks out the new tag,
> reinstalls deps and restarts `lantern.service`. So shipping a change to prod
> means cutting a release (`/release`), not merging. See
> [`ops/gce/README.md`](../../ops/gce/README.md) for the mechanism and
> [Updating the running app](#updating-the-running-app) for the manual override.
>
> Provider secrets live in systemd drop-ins on the box, never in the repo, and are
> untouched by the tag checkout.
>
> Verified on the box 2026-07-31: `lantern-release-deploy.timer` is `enabled` +
> `active` (15-minute cadence), and a forced run rolled prod v1.14.0 → v1.14.1.
> (This block previously read "manual deploy, no CI/CD … one-time git clone",
> which contradicted `ops/gce/README.md` and is what #3119 flagged.)

**Force a deploy now** instead of waiting for the timer:

```bash
gcloud compute ssh lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48   --command="sudo systemctl start lantern-release-deploy.service"
```

## What's running

| Thing | Value |
|-------|-------|
| GCP project | `project-2f747c41-d0f3-4de9-b48` (number `843848914143`) |
| VM | `lantern-app`, zone `us-central1-a`, `e2-medium`, Debian 12, 30 GB pd-balanced |
| External IP | `104.197.219.106` (ephemeral — reserve a static IP if it must persist) |
| App service | systemd `lantern.service` → `node server.js` in `/opt/lantern-os/apps/lantern-garage`, binds `0.0.0.0:8080` |
| Tunnel service (lantern-os.net) | systemd `cloudflared` → tunnel `lantern-cloud` (`c666a37e-b03f-43a6-ad68-aa0455a7b246`), Cloudflare account `967f7517…` |
| Tunnel service (unisona.ai) | systemd `cloudflared-unisona` → tunnel `unisona.ai` (`1b1c2acf-4af9-45a0-9597-019d4a874a58`), Cloudflare account `ff492ab2…` — added 2026-07-10 (see [unisona.ai cutover](#unisonaai-tunnel-cutover-2026-07-10)) |
| MCP | `localhost:8771` (spawned by the app; **not** exposed publicly) |
| LLM | Gemini via **Vertex**, keyless off the VM service account |

Public hostnames all terminate at the VM's `localhost:8080`, but ride **two tunnels in two
Cloudflare accounts** (a tunnel CNAME only binds inside its own account):

| Hostname | Cloudflare account | Tunnel | VM connector |
|----------|--------------------|--------|--------------|
| `unisona.ai`, `www.unisona.ai` | `ff492ab2…` (registrar + live zone, NS `ashley`/`junade`) | `1b1c2acf` | `cloudflared-unisona` |
| `cloud.lantern-os.net` | `967f7517…` | `c666a37e` (`lantern-cloud`) | `cloudflared` |

`mcp.unisona.ai` resolves but is pinned to `http_status:404` at the tunnel — the port-8771 MCP is
no-auth and must never be publicly reachable.

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
`VERTEX_LOCATION=us-central1`.

**Vertex is the wire that spends the Cloud credits.** The AI-Studio key
(`generativelanguage.googleapis.com?key=…`) is free-tier and bills nothing; Vertex
(`LOCATION-aiplatform.googleapis.com`, Bearer ADC) bills the project. `gemini-transport`
picks Vertex whenever either env var above is set, so no key needs to be present here.

**Gemini leads by default here.** When Vertex is configured and the operator has not set
`KEYSTONE_PREFERRED_PROVIDER`, the dispatch order puts Gemini first — spending the credits
is the reason Vertex is on (`lib/stream-chat/provider-order.js`). Set
`KEYSTONE_PREFERRED_PROVIDER` explicitly to override; the rest of the chain still
backstops, so a Vertex outage never dead-ends a turn.

### Models valid in-region

Probed against Vertex `us-central1` on **2026-07-15** (`:generateContent`, real calls):

| model | result |
|-------|--------|
| `gemini-2.5-flash` (default, `GEMINI_MODEL`) | 200 |
| `gemini-2.5-flash-lite` | 200 |
| `gemini-2.5-pro` | 200 |
| `gemini-3.5-flash`, `gemini-3.1-flash-lite` | **404 — these ids do not exist** |

The 1.5/2.0 ids also 404. The chat's fallback chain lives in
`lib/provider-models.js` (`GEMINI_FALLBACK_MODELS`) — re-probe before editing it. It
previously listed the two `gemini-3.x` ids above, which meant every fallback hop was a
guaranteed 404 and this box had no working chat fallback at all.

## Environment (systemd drop-ins)

`/etc/systemd/system/lantern.service.d/` (each `chmod 600`, root-owned):

| File | Vars |
|------|------|
| `env.conf` | `SESSION_SECRET`, `GEMINI_USE_VERTEX`, `VERTEX_PROJECT`, `VERTEX_LOCATION`, `NODE_ENV=production` |
| `google.conf` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `providers.conf` | `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_CAMPAIGN_ID` |
| `discord.conf` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| `mail.conf` | `RESEND_API_KEY`, `MAIL_FROM`, `PUBLIC_BASE_URL` — see [Transactional email](#transactional-email-resend) |

Values were copied from the operator's `lantern-os-stable/.env.local`. `SESSION_SECRET`
is required because the app fail-closes when bound beyond loopback without one.

After editing any drop-in: `sudo systemctl daemon-reload && sudo systemctl restart lantern.service`.

## Transactional email (Resend)

Signup confirmation and password-reset mail goes out via **Resend's HTTPS API**, not SMTP —
cloud hosts (GCE included) throttle SMTP egress, which is a classic silent cause of
"the confirmation email never arrived". `lib/mailer.js` picks Resend whenever
`RESEND_API_KEY` is set, falls back to SMTP, and finally to a dev outbox.

**The dev fallback is the failure mode to watch for.** With no provider configured the
mailer does not error — it appends to `data/mail-outbox.jsonl` and the signup path
*auto-admits accounts without proving email ownership* (#2065). A prod box with no
`mail.conf` therefore looks healthy while silently sending nothing.

```bash
sudo tee /etc/systemd/system/lantern.service.d/mail.conf >/dev/null <<EOF
[Service]
Environment="RESEND_API_KEY=re_..."
Environment="MAIL_FROM=unisona.ai <no-reply@unisona.ai>"
Environment="PUBLIC_BASE_URL=https://unisona.ai"
EOF
sudo chmod 600 /etc/systemd/system/lantern.service.d/mail.conf
sudo systemctl daemon-reload && sudo systemctl restart lantern.service
```

- **`MAIL_FROM` must be on a domain verified in the Resend dashboard.** Check with
  `curl -H "Authorization: Bearer $RESEND_API_KEY" https://api.resend.com/domains` — the
  domain needs `"status":"verified"` and `"sending":"enabled"`. `unisona.ai` was verified
  2026-07-28. An unverified sender fails the send, not the signup, so it surfaces only in
  the journal.
- **`PUBLIC_BASE_URL` is required here, not optional.** Without it `lib/base-url.js` builds
  verification and password-reset links from the request `Host` header, which is spoofable —
  a forged Host points a genuine confirmation email at an attacker's domain (#2604). It
  belongs in prod only; loopback dev is handled natively and setting it locally would aim
  dev links at production.

### Verifying

`scripts/test-email.mjs` reads `.env`/`.env.local` and will **not** see the systemd
environment, so it reports `dev` on this box and is not a valid prod check. Test the app
instead — a real signup at `https://unisona.ai/auth.html` with an address you can read:

```bash
sudo journalctl -u lantern.service -n 50 --no-pager | grep -i mailer
```

A correctly configured box logs nothing there; a broken key or unverified sender logs
`[mailer] resend send failed to …` with Resend's reason (never the key). The signup
response itself is the other tell: `202 pendingVerification` with `"emailDelivery":"sent"`
and no `devVerifyLink` means the hard gate is active (#3021), whereas `201` means the box
fell through to the no-mailer auto-admit path.

### OAuth redirect URIs (register on each provider)

The callback is derived from the request host, so it's always
`https://unisona.ai/api/auth/<provider>/callback`. Each provider's app must list it:
Google (project 843848914143 OAuth client), Patreon client, Discord app (OAuth2 →
Redirects). Discord app id `1523112567386669187`.

## Cloudflare tunnels

Two named tunnels run **on the VM** (both outbound-only, so 8080 stays closed to the
internet), one per Cloudflare account because a tunnel CNAME only binds inside the
account that owns the tunnel:

- `cloudflared` → tunnel `lantern-cloud` (`c666a37e…`), account `967f7517…`. Locally
  managed via `/etc/cloudflared/config.yml`; routes `cloud.lantern-os.net` →
  `http://localhost:8080`.
- `cloudflared-unisona` → tunnel `unisona.ai` (`1b1c2acf…`), account `ff492ab2…`
  (which owns the unisona.ai registration + live zone). **Remotely managed** — its
  ingress is set in the Cloudflare Zero Trust dashboard / API, not a local config file:
  `unisona.ai`/`www` → `http://localhost:8080`, `mcp.unisona.ai` → `http_status:404`,
  catch-all `404`. Runs from the token baked into
  `/etc/systemd/system/cloudflared-unisona.service` (root, `chmod 600`).

Both are separate from the operator's PC tunnel `lantern-os` (`7045ac00…`, serves
`lantern-os.net` → PC:4177) so they don't fight.

`mcp.unisona.ai` is deliberately pinned to fail-closed **404**: the port-8771 MCP is
no-auth and exposes git-write / dispatch tools, so it must never be publicly reachable.
Gate with Cloudflare Access or the OAuth MCP (8772) before ever exposing it.

> **Cleanup left:** account `967f7517…` still holds a stray, permanently-`pending`
> duplicate `unisona.ai` zone (`1ee17c77…`, NS `corey`/`june`). It is inert — the
> registrar delegates to the `ff492ab2…` zone — but delete it to avoid confusion.

### unisona.ai tunnel cutover (2026-07-10)

**Symptom.** `unisona.ai` + `www` returned `502` while `cloud.lantern-os.net` (same VM,
same origin) served `200`.

**Root cause.** unisona.ai's tunnel (`1b1c2acf`, account `ff492ab2…`) was routed to
`http://localhost:4177` and its connector ran on the **operator's PC**, not the VM. The
PC's stable server wasn't answering, so every request dead-ended. GCP, DNS records, and
the app were all healthy. Repointing the `ff492ab2…` zone at the `967f7517…` tunnel is
**not** an option — cross-account tunnel CNAMEs don't bind (tested: returns `530`).

**Fix (all inside account `ff492ab2…`).**
1. Repointed tunnel `1b1c2acf` ingress → `localhost:8080`; sealed `mcp.unisona.ai` → `404`.
2. Installed `cloudflared-unisona.service` on the VM running that tunnel's token, next to
   the existing `cloudflared` connector — both to `localhost:8080`.
3. Stopped + disabled the PC's `Cloudflared-unisona` service so requests can't split-brain.
4. Verified `unisona.ai` + `www` → `200` (app `<title>unisona.ai</title>`), `mcp` → `404`.

To recreate the unisona connector on a fresh VM:

```bash
# token comes from the ff492ab2… account (Zero Trust → Networks → Tunnels → unisona.ai),
# or: cloudflared tunnel token 1b1c2acf  (needs that account's cert.pem)
sudo tee /etc/systemd/system/cloudflared-unisona.service >/dev/null <<EOF
[Unit]
Description=cloudflared unisona (ff49 tunnel 1b1c2acf)
After=network.target
[Service]
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run --token <FF49_TUNNEL_TOKEN>
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo chmod 600 /etc/systemd/system/cloudflared-unisona.service
sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared-unisona
```

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
grant `roles/aiplatform.user` to the SA, recreate the five env drop-ins, install **both**
cloudflared connectors — `cloudflared` for tunnel `lantern-cloud` (credentials from the
operator's `~/.cloudflared/`) and `cloudflared-unisona` for the `ff492ab2…` unisona.ai
tunnel (see [the cutover section](#unisonaai-tunnel-cutover-2026-07-10)) — and
(optionally) `pip install fastapi uvicorn[standard] sse-starlette httpx` for the MCP
child. Enable APIs: `compute`, `aiplatform`.

## Cost / lifecycle

`e2-medium` 24/7 ≈ $25/mo plus Vertex per-call. Stop when idle:

```bash
gcloud compute instances stop lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48
gcloud compute instances start lantern-app --zone=us-central1-a --project=project-2f747c41-d0f3-4de9-b48
```
