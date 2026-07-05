ci(release): build the desktop installer and self-update the cloud VM on release

Make both delivery channels move "on release only" from one `git tag vX.Y.Z`:

- **Desktop exe** — a new `build-desktop` job in `release.yml` (windows-latest)
  runs `npm ci` + Inno Setup, builds `Unisona-Setup-<version>.exe` via
  `scripts/build-desktop-installer.mjs`, and **appends** it to the just-created
  release. It `needs: [github-release]` and attaches separately, so a desktop-build
  failure can never block the web/source release. Previously the installer was a
  manual local Windows build uploaded by hand (that's how v1.8.63 shipped).

- **Cloud VM** — `ops/gce/lantern-release-deploy.{sh,service,timer}`: a systemd
  timer on the GCE box polls `releases/latest` and, on a new tag, checks it out,
  `npm install`s, and restarts `lantern.service`. The VM tracks releases, not
  `master`. Seed the state file with the current latest tag at install so the first
  tick can't roll the box back to an older release. See `ops/gce/README.md`.

Both remain unsigned for now (MSIX/SignPath pending, per the desktop README).
