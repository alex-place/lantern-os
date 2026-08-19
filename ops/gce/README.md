# GCE cloud VM — release-gated self-update

"Update on release only" for the `unisona.ai` cloud VM. The box does **not** track
`master`; it moves only when a new **GitHub Release** is published. Companion to the
desktop side (the `build-desktop` job in [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
builds + attaches the Windows installer to the same release), so a single
`git tag vX.Y.Z && git push --tags` ships both the cloud app and the desktop exe.

## Pieces

| File | Role |
|------|------|
| `lantern-release-deploy.sh` | Polls `releases/latest`; on a new tag → `git checkout` the tag, `npm install`, restart `lantern.service`. |
| `lantern-release-deploy.service` | systemd oneshot that runs the script (as root). |
| `lantern-release-deploy.timer` | Fires 3 min after boot, then every 15 min. |

The script reads/writes its last-deployed tag at `/var/lib/lantern/deployed-release.tag`.

## Install on the VM (one-time)

```bash
# Runs the live copy from /usr/local/bin so a tag checkout can't remove it mid-run.
sudo cp /opt/lantern-os/ops/gce/lantern-release-deploy.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/lantern-release-deploy.sh
sudo cp /opt/lantern-os/ops/gce/lantern-release-deploy.{service,timer} /etc/systemd/system/

# SEED the state to the current latest release so the first tick does NOT roll the
# box back to an older release than what it already runs.
sudo mkdir -p /var/lib/lantern
curl -fsSL https://api.github.com/repos/alex-place/lantern-os/releases/latest \
  | grep -oP '"tag_name":\s*"\K[^"]+' | sudo tee /var/lib/lantern/deployed-release.tag

sudo systemctl daemon-reload
sudo systemctl enable --now lantern-release-deploy.timer
```

To force a deploy now: `sudo systemctl start lantern-release-deploy.service`, then
`journalctl -u lantern-release-deploy.service -n 30`.

## Setting a secret (e.g. the Stripe key)

Env/secrets are systemd drop-ins in `/etc/systemd/system/lantern.service.d/`, outside
the checkout, so `git checkout -f <tag>` can't touch them. Set once; survives releases.

From your workstation, pulling the key out of your own environment:

```powershell
.\ops\gce\Push-StripeKey.ps1            # -WhatIf to preview, -Remove to undo
```

Or on the VM itself, pasting it at a prompt:

```bash
sudo bash ops/gce/set-stripe-key.sh       # --env-file, --file PATH, --remove
```

The same pair exists for the Resend mail config (`RESEND_API_KEY` + `MAIL_FROM` +
`PUBLIC_BASE_URL`): `Push-ResendKey.ps1` / `set-resend-key.sh`. That one is not
cosmetic — with **no** mail provider configured, `lib/local-auth.js` takes the
no-mailer path from #2065 and **auto-admits a public signup** with
`emailVerified`/`emailAssumed` set, so anyone can register an address they do not
own. Loopback is exempt, so it does **not** reproduce over `127.0.0.1` — only real
proxied traffic. See #3119.

Both validate the key's shape, write `0600` root-owned, `daemon-reload` + restart
`lantern.service`, and then verify `/api/billing/config` reports `configured:true`.
Neither ever puts the key in a command line -- argv is readable by any local user via
`ps`/`/proc` -- and neither echoes it.

> **Don't pipe secrets through `gcloud compute ssh --command` on Windows.** `gcloud`
> there is a PowerShell wrapper that does not forward stdin to ssh; it answers a
> prompt with `y`, and that single character is what lands in the file. It looks
> like it worked (`echo INSTALLED` still fires) and the app stays unconfigured.
> `Push-StripeKey.ps1` uses `gcloud compute scp` for this reason.

## Notes

- The `git checkout -f <tag>` discards any live hotfix drift in the checkout — by
  design, since a real fix belongs in the release. Env/secrets live in
  `/etc/systemd/system/lantern.service.d/*.conf`, untouched by the checkout.
- If you edit `lantern-release-deploy.sh` in the repo, re-copy it to
  `/usr/local/bin/` on the VM (the live copy is intentionally decoupled).
- Push-based alternative (release workflow SSHes into the VM) was not used to avoid
  storing a GCP service-account key as a GitHub secret; the VM already has metadata
  creds and polls read-only, so no new secret surface.
