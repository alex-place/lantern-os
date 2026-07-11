---
name: release
description: Cut a full Unisona release — fold the changelog, bump the version, tag it, let CI build and publish the website + the native Windows desktop app (Unisona-Setup .exe), then rewrite the GitHub Release post for humans with the live URL, the .exe download, a features list, and current pricing. Use whenever the user types `/release` or `!release`, or asks to "cut a release", "ship a version", "release the website and exe", "tag a release", "publish a new version", "make a GitHub release", "do a release post", or "bump and release". Trigger even if they don't say "release" — any request to tag a version and publish a GitHub release with the app + download is this skill. Do NOT use it to hot-deploy master to GCE without a version (that's the deploy runbook), to merge one PR, or to only bump the changelog.
---

# Release

Ship one version of Unisona — the **hosted website** and the **native Windows desktop app** — off a single tag, then turn the machine-made GitHub Release into a real launch post: live URL, the `.exe` download, what's new, the feature set, and current pricing.

This is a **publishing** action. A GitHub Release is public and drives the production auto-deploy. Confirm with the user before pushing the tag, and never invent version numbers, features, or prices — read them from the repo.

## The machine you're driving (don't rebuild it)

The whole pipeline already exists; this skill orchestrates the human-side steps around it.

```
bump package.json ──▶ auto-tag.yml ──▶ vX.Y.Z tag ──▶ release.yml
                                                         ├─ build          → web-app zip + source zip
                                                         ├─ github-release → creates the Release, notes from CHANGELOG.MD
                                                         ├─ build-desktop  → Unisona-Setup-*.exe  (Windows, attached)
                                                         └─ deploy-pages   → gh-pages (static site)
GCE prod (unisona.ai) polls releases/latest ──▶ rolls the new tag  (ops/gce, ~15 min)
```

Key files: [`.github/workflows/release.yml`](../../../.github/workflows/release.yml),
[`.github/workflows/auto-tag.yml`](../../../.github/workflows/auto-tag.yml),
[`scripts/assemble-changelog.js`](../../../scripts/assemble-changelog.js),
[`ops/gce/README.md`](../../../ops/gce/README.md). Version of truth: root
[`package.json`](../../../package.json) (`.version`), mirrored to
`apps/lantern-garage/package.json` + `apps/lantern-garage/version.json` by the assembler.

## Preflight — refuse to release unless these hold

1. **On `master`, clean, up to date.** `git fetch && git status`. Untracked `data/**` runtime files are fine; uncommitted *tracked* changes are not.
2. **master is green.** `gh run list --branch master --limit 5`. Don't release on top of a red build.
3. **The server at least loads.** `node --check apps/lantern-garage/server.js`.
4. **There's something to ship.** `node scripts/assemble-changelog.js --check` lists pending `changelog.d/*` fragments. Zero fragments → ask the user whether this is a real release (an empty release is almost always a mistake).
5. **Pick the bump.** Default **patch**. Choose **minor** for user-facing features, **major** for breaking changes. Infer from the fragment prefixes (`feat-*` present → lean minor) but let the user confirm the level and the resulting `vX.Y.Z`.

## Step 1 — Fold the changelog + bump the version

```bash
node scripts/assemble-changelog.js            # patch  (or: minor | major)
```

This folds every `changelog.d/*` fragment into one `## [X.Y.Z] - DATE` entry in
`CHANGELOG.MD`, bumps all three version files, and deletes the consumed fragments. It's
idempotent. **Read the assembled `## [X.Y.Z]` block** — those bullets become the release
notes and your feature list, so fix any that read like internal commit noise now.

## Step 2 — Land the bump on master (this is what tags it)

Direct master push is blocked, so land the bump through a PR; merging it flips
`package.json` on master, which fires `auto-tag.yml` → the tag → `release.yml`.

```bash
V=$(node -p "require('./package.json').version")
git checkout -b "claude/release-v$V" master
git add CHANGELOG.MD package.json apps/lantern-garage/package.json apps/lantern-garage/version.json changelog.d
git commit -m "chore(release): v$V"        # ends with the Co-Authored-By trailer
git push -u origin "claude/release-v$V"
# gh pr create/merge are broken in this repo — use the API (see gotchas):
gh api repos/alex-place/lantern-os/pulls -X POST -f base=master -f head="claude/release-v$V" \
  -f title="chore(release): v$V" -f body="Version bump + assembled changelog for v$V."
# merge once green:
gh api repos/alex-place/lantern-os/pulls/<N>/merge -X PUT -f merge_method=squash
```

If the bump is already on master, you can instead tag directly:
`git tag -a "v$V" -m "Release v$V" && git push origin "v$V"`.

## Step 3 — Watch CI build the website + the exe

```bash
gh run list --workflow=release.yml --limit 3
gh run watch <run-id>            # or poll until conclusion=success
```

Wait for all four jobs. `build-desktop` (Windows) is the slow one and is what produces
`apps/lantern-garage/desktop/dist/Unisona-Setup-*.exe`, attached to the Release. It runs
*after* the release exists, so a desktop failure won't have blocked the web/source
release — if it fails, the Release still published without the exe; fix and re-run just
that job rather than re-tagging.

## Step 4 — Turn the auto-Release into a launch post (the deliverable)

CI publishes a bare Release named **"unisona.ai vX"** with raw CHANGELOG notes. Rewrite
it. **Unisona is the user-visible brand — never ship "unisona.ai/Lantern" in a public post.**

1. **Confirm the exe is attached:** `gh release view "v$V" --json assets -q '.assets[].name'` — expect `Unisona-Setup-<ver>.exe` (+ the zips).
2. **Source features + pricing from the repo, not memory:**
   - **Features** = the assembled `## [X.Y.Z]` bullets (what's new) + the standing capability set. Keep it human ("Native desktop app — a real window, not a browser tab"), not commit-speak.
   - **Pricing** = read [`apps/lantern-garage/public/pricing.html`](../../../apps/lantern-garage/public/pricing.html) (tiers: Public / Operator / Supporter / Pilot) and the Patreon page `patreon.com/c/lanterndreamjournal`. Quote the *current* numbers from that file — do not hardcode prices here, they drift.
3. **Write the post** to a temp file using the template below, then:

```bash
gh release edit "v$V" --title "Unisona v$V" --notes-file /tmp/release-post.md --latest
```

### Release-post template

```markdown
# Unisona v<X.Y.Z>

Your memory. Your keys. Your machine. A local-first reasoning cockpit that remembers,
reasons, acts, and verifies.

## Try it
- **Web:** https://unisona.ai  (live in your browser — no install)
- **Windows desktop app:** download **Unisona-Setup-<X.Y.Z>.exe** from the Assets below.
  A real native window (WebView2, not a browser). Unsigned for now, so on first run click
  *More info → Run anyway* past the SmartScreen notice.

## What's new in <X.Y.Z>
<the assembled ## [X.Y.Z] bullets, cleaned for humans>

## What Unisona does
<5–8 bullets of the standing feature set: the chat cockpit, persistent memory, real tool
use (documents, web, market data, repo/GitHub), the trading terminal, local model serving,
your keys stay on your machine…>

## Pricing
<the current tiers pulled from public/pricing.html + Patreon — name, price, what each unlocks.
Lead with the free tier. Link https://unisona.ai/pricing.html and the Patreon page.>

---
Full changelog: [CHANGELOG.MD](https://github.com/alex-place/lantern-os/blob/v<X.Y.Z>/CHANGELOG.MD)
```

## Step 5 — Verify, then report

- **Website shipped:** `curl -s -o /dev/null -w "%{http_code}" https://unisona.ai/` → 200, and confirm the served version advanced (footer / `/version` / `apps/lantern-garage/version.json` on the box). GCE lags the timer (~15 min) — if it hasn't rolled, say so; don't claim it's live before it is.
- **Release is correct:** `gh release view "v$V" --web` — title says *Unisona*, the `.exe` is in Assets, features + pricing render.
- **Report to Alex as a stakeholder** (outcome, not diffs): the version, the one-line what-shipped, the Release URL, and the direct `.exe` download link. Flag anything that didn't land (e.g. desktop job red, GCE not yet rolled).

## Gotchas (each cost a real run)

- **`gh pr create` / `gh pr merge` are broken here** (they invoke a git subcommand that errors). Always create + merge via `gh api …/pulls`.
- **Rebrand the Release.** CI names it "unisona.ai"; the public post must say **Unisona**. Same for the body — unisona.ai/Lantern are code-only names.
- **Don't hardcode pricing or features.** Read `public/pricing.html` and the CHANGELOG entry every time — baked-in numbers go stale and become a false public claim.
- **The tag creates the Release — don't pre-create it.** `softprops/action-gh-release` makes it; if you `gh release create` first, the workflow collides.
- **Unsigned exe.** SmartScreen will warn. Say so in the notes (don't let a user think it's malware). MSIX/SignPath signing is still pending — see `apps/lantern-garage/desktop/README.md`.
- **Prerelease flag is automatic** for tags containing a hyphen (`v1.9.0-rc1`) — use that for test releases so they don't become "latest" and trigger the GCE prod roll.
- **GCE is release-gated, not push-gated.** Only a *published GitHub Release* rolls prod; a bare tag without the Release (e.g. workflow failed) won't. Confirm the Release published before claiming the site updated.
- **Empty release = mistake.** No `changelog.d` fragments almost always means you're on the wrong branch or already released; stop and check.
