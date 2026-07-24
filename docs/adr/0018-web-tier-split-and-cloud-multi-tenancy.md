---
adr: 0018
title: Split delivery into a hosted multi-tenant web tier and a full local desktop app — one Core, two profiles
status: Accepted
date: 2026-07-03
deciders: Alex Place
approved-by: Alex Place (2026-07-03)
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.

  RELATES TO:
    - ADR-0014 (unisona desktop launcher) — its Phase-0 hardening IS the tenancy
      seam this ADR generalises. The desktop `.exe` is the second backend of the
      same seam.
    - ADR-0016 (provider-agnostic OSS auth) — supplies the login/identity this
      tier gates on.
    - ADR-0008 (end product = personal AI wrapper) and ADR-0002 (single
      Convergence Core) — this ADR is a *delivery* decision under both, not a new
      subsystem.
-->


# ADR-0018: Split delivery into a hosted multi-tenant web tier and a full local desktop app — one Core, two profiles

## Status

Accepted — approved by Alex Place (2026-07-03).

## Context

We want two distinct delivery experiences over the **one** Convergence Core:

1. **Hosted web tier** — reachable on the public internet without the user owning
   a machine or the founder's PC being on. A logged-in user gets a persistent
   per-user profile + memory and uses their own model keys; it works *like local*
   for the reasoning loop, minus local-machine-only capabilities (no local LLM, no
   local-filesystem tools, no on-box trading execution, no local MCP/child
   processes, no per-tenant 24/7 collectors). Logged-out visitors get a sandboxed,
   ephemeral demo of the loop plus a Help/getting-started page.
2. **Desktop app** — the full local experience: the whole Core on the user's
   machine, per ADR-0014, packaged as a signed installable `.exe`.

Today neither exists as a coherent product:

- `unisona.ai` / `lantern-os.net` are Cloudflare **tunnels → `localhost:4177`**;
  they only work while the founder's PC is on ([[unisona-second-domain]]).
- The Railway entrypoint runs the **entire** `server.js` publicly
  ([`cloud-server.js`](../../cloud-server.js)), not a subset.
- The gh-pages deploy copies the **full** `public/` bundle to `/dream/` as a
  **static mirror with no backend** ([`deploy.yml:52`](../../.github/workflows/deploy.yml#L52)),
  so chat there cannot work.
- `LANTERN_CHAT_ONLY=1` only skips background collectors/convergence loops
  ([`server.js:590`](../../server.js#L590)); it does **not**
  restrict the served page/route surface.
- The Core is **single-tenant to the bone**: one `data/` tree, and every chat
  request reads a **global** `process.env.*_API_KEY`
  ([`dream-chat.js:911`](../../lib/dream-chat.js#L911)) — there
  is no per-user key path.

**North Star framing.** A hosted tier improves **no loop stage** by itself — like
the desktop app (ADR-0014), it is a *delivery channel*, justified as the first
real reach of foundational principle **[12] local-first ownership** to users who
won't `git clone`. Crucially, the work it forces — a per-user state location, a
per-user key vault, and identity that is not "loopback = admin" — is **exactly**
ADR-0014's Phase-0 hardening. Doing it once, as a Core seam, strengthens
**Remember** (durable per-tenant memory location) and **Act** (secure per-tenant
key handling) for *every* deployment. This is extension of the one Core, not a new
subsystem — it passes the Feature Gate on the same basis ADR-0014 did.

Loop stage: primarily **delivery**; the required seam touches **Remember** and
**Act**.

## Decision

We will ship **two delivery profiles of the one, unmodified Convergence Core**,
separated by configuration — a tenancy/storage backend and a capability profile —
**never by a fork**.

**Topology.** Cloudflare is the **front**, a Node origin is the **compute**:

```
Browser ─▶ Cloudflare (Pages static shell + Functions edge: auth/rate-limit/proxy
           + DNS/TLS/CDN)
                    │
                    ▼
           Full Node Core (server.js) on a Google Compute Engine VM,
           MULTI-TENANT: per-user memory + per-user keys, login-gated
```

**Host.** The cloud origin is a **GCE VM** now — it runs today's `server.js`
unmodified (native modules + `child_process` + a **persistent local SSD** for the
append-only JSONL + CSF memory), is funded by our existing Google credits, and
reaches Vertex via the instance service account (ADC) automatically. **GKE
Autopilot** with persistent volumes is the named scale-up path when tenant load
justifies managed, autoscaling, node-less infrastructure. Cloudflare Workers/Pages
Functions are **not** the compute (they cannot run the Core — see Alternatives).

**Model.** The cloud default model is **Gemini via Vertex** on our credits
(already wired: [`gemini-transport.js:15`](../../lib/gemini-transport.js#L15),
[`dream-chat.js:1078`](../../lib/dream-chat.js#L1078)); other
providers require the user's own key. No local LLM in the cloud profile.

**Guardrails (binding conditions):**

- **W1 — One Core, two profiles.** Cloud and desktop run the *same* `server.js`.
  All divergence is confined to a `resolveTenant()` backend + a capability profile.
  No forked server, no "lite" codebase.
- **W2 — One tenancy seam.** Every memory / conversation / profile / key access on
  the request path goes through `resolveTenant(req) → { userId, memoryStore,
  keyStore }`. No ambient global `data/` writes or `process.env` key reads on a
  per-request path. This seam is the single multi-tenant boundary and the single
  place the desktop and cloud backends differ.
- **W3 — Login-gated; loopback ≠ admin in cloud.** The cloud profile requires an
  authenticated session (ADR-0016) for anything past the public demo; the
  loopback-admin shortcut is disabled in the cloud profile.
- **W4 — Capability profile.** The cloud profile excludes local-machine features:
  local LLM, local-filesystem tools, on-box trading execution, local MCP /
  `child_process` features, and per-tenant 24/7 collectors. Gated by deployment
  profile, not a code fork.
- **W5 — Cloudflare fronts, does not compute.** CF Pages (static) + Functions
  (edge auth/rate-limit/proxy) + DNS/TLS/CDN in front of the GCE origin. Moving
  compute onto Workers is out of scope (it requires a storage re-platform);
  revisit only via a new ADR.
- **W6 — Key custody: session-only at launch.** Users' keys are held per session,
  never persisted at rest, until an opt-in encrypted-at-rest store is deliberately
  designed. Keys are never logged and never sent to the browser.
- **W7 — Funded default, BYO for the rest.** Default = Vertex Gemini on our
  credits, rate-limited and quota'd per tenant; other models require the user's own
  key. Credits are a **runway, not a business model** — the BYO/paid path must
  exist before credits deplete.
- **W8 — Filesystem memory preserved.** The JSONL + CSF filesystem model stays
  (GCE now). Any move to a managed store (GKE Autopilot / DB / object store) is a
  deliberate later step **behind W2's seam** — a backend swap, never an ambient
  rewrite.

**Phasing:**

- **Phase A — cloud tier.** (A1) `resolveTenant()` seam + per-user memory namespace
  on the GCE filesystem; (A2) login-gate + loopback-admin off (W3); (A3) per-user
  key resolution, session-only (W6); (A4) capability profile (W4); (A5) CF Pages
  static shell + Functions edge (W5); (A6) logged-out sandboxed loop demo + Help
  page. Ship the logged-out demo first; the authed app lands once the seam (A1) is
  in.
- **Phase B — desktop `.exe`.** The **same** `resolveTenant()` seam with the
  desktop backend (state in `%APPDATA%\unisona\`, keys in Windows Credential
  Manager/DPAPI, a local token), then Node SEA package + Azure signing + installer
  (ADR-0014 Phase 1-package). Phase B is gated on the seam — which is ADR-0014's
  Phase-0 hardening.

## Consequences

- **Positive:** one Core serves both a public product and a local product;
  Cloudflare stays the front (already run) and GCE runs the code we already have
  (no rewrite); the tenancy seam is the shared hardening ADR-0014 already required,
  so the desktop `.exe` and the cloud SaaS advance together; the default model is
  funded by existing Google credits with no new code; GCE gives Google-grade
  reliability (unlike Fly.io) and a real disk that fits the filesystem memory model
  (unlike Cloud Run/Workers).
- **Negative / trade-offs:** multi-tenancy is real, critical-path work and did not
  exist before (single `data/` tree + global env keys); we become **custodian of
  users' memory and (optionally) keys** — a security burden (encryption at rest,
  never-log, quotas, abuse limits); running the cloud origin means operating
  production infrastructure — appropriate now that this is a team-built product
  with paying users, but a real responsibility; the funded default is finite
  runway, so a BYO/paid path is mandatory, not optional.
- **Follow-ups:**
  - Phase A issues: `resolveTenant()` seam + per-user memory namespace; login-gate
    + loopback-admin-off; per-user key resolution (session-only); capability
    profile; CF Pages + Functions front; logged-out loop demo + Help page.
  - Phase B issues: desktop tenancy backend (`%APPDATA%`, DPAPI, local token);
    Node SEA package + signing + installer (folds ADR-0014 Phase-0/Phase-1-package).
  - Open decision to resolve before the key store is built: key custody model
    (session-only vs. opt-in encrypted-at-rest vs. both) — parked per W6.
  - Confirm the **type/amount/expiry** of the Google credits on the Vertex project
    (trial vs. startup grant) — sets the funded-default runway.

## Alternatives considered

- **Cloudflare Workers / Pages Functions as the compute** — rejected: the Workers
  runtime is V8 isolates, not Node; no local filesystem, no `child_process`, no
  native addons (`sharp`/`tesseract`). The Core uses all three, so this is a
  re-platform (memory → R2/D1/Durable Objects, drop native + child processes), not
  a host change — and a second, Workers-shaped Core risks the W1 fork. Kept as a
  *possible future* backend behind the W2 seam, not a launch path.
- **Cloudflare Workers Containers** — deferred: a real container runs native code
  and child processes, but its disk is ephemeral (persistent per-user memory still
  needs R2/D1/DO), and it is beta and billed for on-demand invocations, not a cheap
  always-on stateful host.
- **Google Cloud Run** — rejected for the memory-bearing origin: stateless;
  persistence only via GCS-FUSE (poor for JSONL appends) or Filestore (costly).
  Attractive only after memory moves off the filesystem — the W8 "later step."
- **Fly.io** — rejected for a paying-user product: heavy 2025–2026 incident record,
  no contractual SLA, no automatic cross-region failover.
- **Railway** — rejected: ephemeral filesystem + usage-metered billing.
- **AWS (EC2/Lightsail)** — works, but no synergy with our Google credits and
  reaching Vertex needs a shipped service-account key; GCE wins *given our credits*.
- **A separate cloud codebase / repo** — rejected: this is precisely how a domain
  becomes a second product (forbidden "independent ecosystem" / sprawl). W1 forbids
  it.
- **Do nothing (keep the tunnel + full-app Railway + static gh-pages mirror)** —
  rejected: the tunnel depends on the founder's PC, Railway exposes the whole app,
  and the gh-pages mirror has no backend. None is a hosted, multi-tenant product.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Public domains are CF tunnels → `localhost:4177` (PC-dependent) | [[unisona-second-domain]] | High | memory |
| Railway entrypoint runs the whole `server.js` publicly, not a subset | [`cloud-server.js`](../../cloud-server.js) | High | repo |
| gh-pages ships the full `public/` as a static mirror with no backend | [`deploy.yml:52`](../../.github/workflows/deploy.yml#L52) | High | repo |
| `LANTERN_CHAT_ONLY=1` gates only background loops, not the served surface | [`server.js:590`](../../server.js#L590) | High | repo |
| Core is single-tenant: chat keys are global `process.env`, no per-user path | [`dream-chat.js:911`](../../lib/dream-chat.js#L911) | High | repo |
| Login/identity infra already exists (session + OAuth + local) | [`session-identity.js`](../../lib/session-identity.js), [`oauth-core.js`](../../lib/oauth-core.js), [`local-auth.js`](../../lib/local-auth.js), [`routes/auth.js`](../../routes/auth.js); ADR-0016 | High | repo |
| Chat already routes Gemini through Vertex (ADC) when `VERTEX_PROJECT` is set | [`gemini-transport.js:15`](../../lib/gemini-transport.js#L15), [`dream-chat.js:1078`](../../lib/dream-chat.js#L1078) | High | repo |
| Vertex bills the Cloud project (AI-Studio free tier is credit-depleted) | [`gemini-transport.js` header](../../lib/gemini-transport.js) comment (#1376) | High | repo |
| Native-module deps complicate any isolate/bundle target (`sharp`, `tesseract`) | [`package.json:53`](../../package.json#L53); ADR-0014 evidence | High | repo |
| CF Workers cannot run the Core: no local FS, no child processes | Cloudflare Workers Node.js compatibility docs (developers.cloudflare.com) | High | web |
| Standard Google Cloud credits apply to Compute Engine, not Vertex-only | cloud.google.com/free ; dev.to 2026 GCP credits guide | Medium | web |
| Cloud Run is stateless; persistence via GCS-FUSE or Filestore only | docs.cloud.google.com/run cloud-storage-volume-mounts ; cloudwebschool comparison | High | web |
| GCE fits: persistent local SSD + full OS + runs unmodified Node | cloudwebschool Cloud Run vs GKE vs Compute Engine | High | web |
| GKE Autopilot = managed, node-less, StatefulSets + per-pod persistent disks | docs.cloud.google.com/kubernetes-engine ; cloudwebschool | High | web |
| Fly.io reliability record + no SLA (2025–2026) | status.flyio.net/history ; kuberns.com Fly production analysis | High | web |
