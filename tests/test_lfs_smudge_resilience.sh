#!/usr/bin/env bash
# #1550 — a deploy git op with an unresolvable LFS object must still complete.
#
# Faithful reproduction: a real git-lfs object whose endpoint is dead makes a checkout
# wedge (required filter) — exactly what wedged the stable auto-deploy. Then proves the
# effective lever the deploy scripts set, GIT_LFS_SKIP_SMUDGE=1, lets the same op complete
# (git-lfs writes the pointer instead of fetching). Behavioral part self-skips if git-lfs
# isn't installed (e.g. some CI images); the source-guard checks always run.
#
# Run: bash tests/test_lfs_smudge_resilience.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
ok()  { echo "  ok  - $1"; }
bad() { echo "  FAIL- $1"; fail=1; }

if command -v git-lfs >/dev/null 2>&1; then
  TMP="$(mktemp -d)"; trap 'cd /; rm -rf "$TMP"' EXIT
  cd "$TMP"
  git init -q repo && cd repo
  git config user.email t@t.io; git config user.name tester
  git lfs install --local >/dev/null 2>&1
  printf '*.bin filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
  git add .gitattributes && git commit -qm attrs
  printf 'pretend-binary-asset-bytes\n' > asset.bin
  git add asset.bin && git commit -qm asset      # asset.bin is now a real LFS object

  # Point LFS at a dead endpoint and drop the local object cache so a checkout MUST fetch.
  git config lfs.url 'http://127.0.0.1:1/dead-lfs-endpoint'
  git config filter.lfs.required true
  rm -rf .git/lfs/objects
  rm -f asset.bin

  # 1) WITHOUT the guard → reproduce the wedge (checkout can't fetch the object).
  if git checkout -- asset.bin >/dev/null 2>&1; then
    bad "expected the unguarded checkout to FAIL against the dead LFS endpoint"
  else
    ok "reproduces the wedge: checkout fails when a required LFS object can't be fetched"
  fi

  # 2) WITH GIT_LFS_SKIP_SMUDGE=1 (what the deploy scripts set) → completes.
  rm -f asset.bin
  if GIT_LFS_SKIP_SMUDGE=1 git checkout -- asset.bin >/dev/null 2>&1; then
    ok "GIT_LFS_SKIP_SMUDGE=1 lets the checkout COMPLETE despite the dead LFS endpoint"
  else
    bad "guarded checkout still failed — the fix does not unwedge the deploy"
  fi
  cd "$REPO"
else
  echo "  skip - git-lfs not installed; behavioral reproduction skipped (source guards still checked)"
fi

# 3) Both deploy paths apply the guards (the source-of-truth assertion).
grep -q 'GIT_LFS_SKIP_SMUDGE' "$REPO/scripts/auto-deploy-stable.ps1" \
  && grep -q 'filter.lfs.required false' "$REPO/scripts/auto-deploy-stable.ps1" \
  && ok "auto-deploy-stable.ps1 sets GIT_LFS_SKIP_SMUDGE + filter.lfs.required false" \
  || bad "auto-deploy-stable.ps1 is missing an LFS guard"
grep -q 'GIT_LFS_SKIP_SMUDGE' "$REPO/scripts/Invoke-GitAutoDeploy.ps1" \
  && grep -q 'filter.lfs.required false' "$REPO/scripts/Invoke-GitAutoDeploy.ps1" \
  && ok "Invoke-GitAutoDeploy.ps1 sets GIT_LFS_SKIP_SMUDGE + filter.lfs.required false" \
  || bad "Invoke-GitAutoDeploy.ps1 is missing an LFS guard"

if [ "$fail" -eq 0 ]; then echo; echo "all lfs-smudge-resilience checks passed"; else echo; echo "FAILED"; exit 1; fi
