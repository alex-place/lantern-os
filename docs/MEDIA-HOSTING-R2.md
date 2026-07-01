# Media Hosting — Cloudflare R2

**Decision (2026-06-29):** gallery/showcase media (images, video) is served from
**Cloudflare R2**, not committed to git. App stays local-first behind the existing
**Cloudflare Tunnel → 127.0.0.1:4177**. Domain/DNS stays on Cloudflare.

Why R2: `$0.015/GB/month`, **zero egress fees**, 10 GB free tier. Our current media
(~76 MB) is free; even 1 GB is ~$1.50/mo and serving it to visitors costs nothing.
Source: <https://developers.cloudflare.com/r2/pricing/>.

## How it fits together

```
git repo            R2 bucket (media bytes)          browser
─────────           ─────────────────────            ───────
manifest.json  ──▶  koh/<id>.webp                ──▶  <img src=base+id.webp>
(metadata,          koh/<id>-t.webp                   base = manifest.base
 tracked)           gage/bfdm/*.mp4 …
```

- **Tracked in git:** only `manifest.json` (titles/categories — the source of truth).
- **Gitignored, lives in R2:** the actual `.webp` / `.mp4` bytes.
- The Explore gallery reads `manifest.base` and prefixes each `id.webp`. Local dev
  uses `base = "/assets/content/koh/"`; production flips it to the R2 URL.

## One-time setup (your Cloudflare account — I can't do this part)

1. **Create a bucket:** Cloudflare dashboard → R2 → *Create bucket* → e.g. `keystone-media`.
2. **Make it publicly readable** for serving:
   - *Settings → Public access*: either enable the **r2.dev** dev URL, or (recommended)
   - **Connect a custom domain** like `media.lantern-os.net` (R2 → bucket → *Settings →
     Custom Domains*). Cloudflare provisions TLS automatically.
3. **Create an API token:** R2 → *Manage R2 API Tokens* → *Create* → **Object Read & Write**,
   scoped to this bucket. Copy the **Access Key ID** and **Secret Access Key**.
4. **Export the env vars** (PowerShell `User` env or your shell profile):
   ```
   R2_ACCOUNT_ID=<your account id>     # R2 overview page
   R2_ACCESS_KEY=<access key id>
   R2_SECRET_KEY=<secret access key>
   R2_BUCKET=keystone-media
   ```

## Uploading / updating media

Install [rclone](https://rclone.org/downloads/), then:

```bash
scripts/sync-media-r2.sh         # dry-run — shows what would upload
scripts/sync-media-r2.sh --go    # upload changed files only
```

This syncs `apps/lantern-garage/public/assets/content/` → the bucket, preserving the
`koh/` prefix, with a 1-year immutable cache header. Re-run it whenever you add art.

## Flip serving to R2

After the first `--go` upload, set the base in
`apps/lantern-garage/public/assets/content/koh/manifest.json`:

```json
"base": "https://media.lantern-os.net/koh/"
```

(or the `https://<bucket>.<account>.r2.dev/koh/` dev URL). The gallery now loads from
R2 everywhere — local, tunnel, any host — with no per-server sync. To go back to
local-only, set `"base": "/assets/content/koh/"`.

## Notes

- **Originals:** keep the full-res source PNGs archived (local + optionally an
  `originals/` prefix in R2). The webp in the bucket are web derivatives.
- **CORS:** not needed for `<img>`/`<video>` tags. If you later fetch bytes via JS
  cross-origin, add a CORS policy on the bucket.
- **The Gage panel** (`/assets/gage/*`) can move to R2 the same way once its media is
  gitignored; today it still serves locally.
