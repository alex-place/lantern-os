# Runbook — History rewrite to shrink `.git` after corpus condense

> **Status:** prepared, NOT yet executed. Run only **after** the consolidation
> PR (#1181) has merged to `master` **and** the other open PRs/worktree branches
> are merged or closed. A history rewrite force-pushes `master`; doing it while
> other branches are based on the old history forces a painful rebase on all of
> them.

## Why

`scripts/csf_condense_corpus.py` already removed the dump corpus from the **tip**
of `master`, but the big blobs still live in **history**, so `.git` stays ~747 MB.
This rewrite purges them from all history and reclaims that space.

## Blast radius — read before running

- **Irreversible.** Old commit IDs are gone after `gc`. Take a backup mirror first.
- **Force-pushes `master`.** Railway auto-deploys `master`; the
  `KeystoneAutoDeployStable` scheduled task resets the stable server from
  `master` every 5 min. **Pause both first** (see step 1) or they race the push.
- **All local worktrees become stale.** After the push, the working clones must
  be re-cloned (their object history no longer matches). See step 6.
- Do **not** run `git filter-repo` directly in `C:\dev\lantern-os` — it has 11
  linked worktrees and filter-repo refuses / can corrupt them. Use a fresh
  mirror clone (step 2).

## Paths purged (decided 2026-06-25)

| Path pattern | Why |
|---|---|
| `data/ingest/`, `data/rag-intake/`, `data/reports/`, `docs/research-papers/`, `csf/ingest/` | The dump corpus — now in the CSF archive, lossless + verified |
| `output/*.mp4` | Rendered video, regenerable artifact |
| `models/*/fc-*.jsonl` | Function-calling training data (regen: `scripts/convert_fc_dataset.py`) |
| `models/**/*.safetensors` | Model adapter checkpoints, regenerable from training |

## Procedure

```bash
# 0. PRECONDITION: confirm the only meaningful open work is merged/closed.
gh pr list --state open    # expect empty (or only intentionally-kept lanes)

# 1. Pause the deployers (PowerShell, admin):
#    Disable-ScheduledTask -TaskName KeystoneAutoDeployStable
#    Disable-ScheduledTask -TaskName <autowork task>     # whatever drives the fleet
#    …and pause Railway auto-deploy in the Railway dashboard.

# 2. Fresh MIRROR clone (never the live working repo with its worktrees):
git clone --mirror https://github.com/alex-place/lantern-os.git lantern-os-rewrite.git
cd lantern-os-rewrite.git
cp -r . ../lantern-os-rewrite-BACKUP.git        # backup before the irreversible step

# 3. Rewrite — drop the blobs from ALL history:
git filter-repo \
  --invert-paths \
  --path data/ingest/ \
  --path data/rag-intake/ \
  --path data/reports/ \
  --path docs/research-papers/ \
  --path csf/ingest/ \
  --path-glob 'output/*.mp4' \
  --path-glob 'models/*/fc-*.jsonl' \
  --path-regex '^models/.*\.safetensors$'

# 4. Repack + measure:
git reflog expire --expire=now --all
git gc --prune=now --aggressive
du -sh .                 # compare against the ~747 MB starting point

# 5. Push the rewritten history (filter-repo drops 'origin'; re-add it):
git remote add origin https://github.com/alex-place/lantern-os.git
git push --force --mirror origin
#   (or, to limit to the main branches: git push --force origin master gh-pages)

# 6. Re-clone the working copies (their objects no longer match):
#    - Remove C:\dev\lantern-os and re-clone fresh.
#    - Re-create needed worktrees off the new master.
#    - Re-copy data/csf_archives/*.csf into each (gitignored, not in git).

# 7. Re-enable the deployers and Railway auto-deploy. Verify:
#    - /api/convergence/health is green (deploy gate)
#    - Knowledge Center PDF list loads and a PDF opens (CSF-backed serving)
```

## Post-conditions

- `.git` materially smaller (the ~150–250 MB of purged blobs gone).
- `master` tip identical in *content* to pre-rewrite (only history changed).
- CSF archive still the sole copy of the corpus — keep the backup mirror until
  the archive itself is backed up off-machine.
