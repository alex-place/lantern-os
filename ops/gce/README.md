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

## Notes

- The `git checkout -f <tag>` discards any live hotfix drift in the checkout — by
  design, since a real fix belongs in the release. Env/secrets live in
  `/etc/systemd/system/lantern.service.d/*.conf`, untouched by the checkout.
- If you edit `lantern-release-deploy.sh` in the repo, re-copy it to
  `/usr/local/bin/` on the VM (the live copy is intentionally decoupled).
- Push-based alternative (release workflow SSHes into the VM) was not used to avoid
  storing a GCP service-account key as a GitHub secret; the VM already has metadata
  creds and polls read-only, so no new secret surface.
