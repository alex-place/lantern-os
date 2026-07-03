#!/usr/bin/env bash
# Integration tests for the Stop hooks:
#   require-pr-before-stop.sh  (PR gate: spent-branch detection, session attribution, nag dedupe)
#   stop-warn-uncommitted.sh   (per-session baseline isolation)
#
# Self-contained: builds throwaway git repos under mktemp, stubs `gh` via PATH, asserts on
# the hooks' stdout (block JSON) / stderr (soft notes) / exit codes. No network, no writes
# outside $TMP. Run: bash scripts/hooks/test-stop-hooks.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRE_PR="$HERE/require-pr-before-stop.sh"
STOP_WARN="$HERE/stop-warn-uncommitted.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# gh stub: prints $GH_STUB_RESPONSE (or fails when unset) regardless of args.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
[ -n "${GH_STUB_RESPONSE:-}" ] || exit 1
printf '%s' "$GH_STUB_RESPONSE"
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

PASS=0; FAIL=0; N=0
ok()   { N=$((N+1)); PASS=$((PASS+1)); echo "ok $N - $1"; }
fail() { N=$((N+1)); FAIL=$((FAIL+1)); echo "FAIL $N - $1"; }
assert_contains()     { case "$2" in *"$1"*) ok "$3" ;; *) fail "$3 (missing: $1) got: $(printf '%s' "$2" | head -c 300)" ;; esac; }
assert_not_contains() { case "$2" in *"$1"*) fail "$3 (unexpected: $1) got: $(printf '%s' "$2" | head -c 300)" ;; *) ok "$3" ;; esac; }

# Build a work repo + bare origin with master pushed; leaves you on branch "lane/x".
# Layout: $1 = repo dir name. cwd ends inside the work repo.
make_repo() {
  local d="$TMP/$1"
  git init -q --bare "$d-origin.git"
  git init -q -b master "$d"
  cd "$d"
  mkdir -p apps
  echo base > apps/x.js
  git add . && git commit -qm "base commit for hook tests"
  git remote add origin "$d-origin.git"
  git push -q origin master
  git fetch -q origin
  git checkout -qb lane/x
}

stop_json='{"session_id":"SID","hook_event_name":"Stop","stop_hook_active":false}'
run_hook() { # $1=session id → stdout; stderr lands in $TMP/err (read via err_out)
  printf '%s' "${stop_json/SID/$1}" | bash "$REQUIRE_PR" 2>"$TMP/err"
}
err_out() { cat "$TMP/err" 2>/dev/null; }
snap() { # $1=session id — record session-start baseline+HEAD via the companion's --snapshot
  printf '%s' "${stop_json/SID/$1}" | bash "$STOP_WARN" --snapshot
}

echo "# require-pr-before-stop.sh"

# T1: loop guard — stop_hook_active:true never blocks.
make_repo t1
out="$(printf '%s' '{"session_id":"s1","stop_hook_active":true}' | bash "$REQUIRE_PR" 2>/dev/null)"
assert_not_contains '"decision"' "$out" "loop guard passes stop_hook_active"

# T2: SPENT branch — pushed, ahead of origin/master, no open PR, but tip == merged PR head.
make_repo t2
echo v2 > apps/x.js && git commit -qam "work that got squash-merged"
git push -q origin lane/x
snap s2   # snapshot AT current head → session made no commits either way
export GH_STUB_RESPONSE="[{\"state\":\"MERGED\",\"headRefOid\":\"$(git rev-parse HEAD)\"}]"
out="$(run_hook s2)"
assert_not_contains '"decision"' "$out" "spent branch (squash-merged tip) passes silently"

# T3: unlanded + session DID commit → block once, then dedupe to soft note.
make_repo t3
snap s3                                  # session starts at base
echo v2 > apps/x.js && git commit -qam "session's own unlanded work"
git push -q origin lane/x
export GH_STUB_RESPONSE="[]"
out="$(run_hook s3)"
assert_contains '"decision"' "$out" "unlanded session work blocks (first stop)"
assert_contains 'NO open PR' "$out" "block reason names the missing PR"
out="$(run_hook s3)"
assert_not_contains '"decision"' "$out" "same state re-stop does not re-block (dedupe)"
assert_contains 'already flagged once' "$(err_out)" "dedupe leaves a soft stderr note"

# T4: unlanded but session made NO commits (concurrent/pre-session work) → soft pass.
make_repo t4
echo v2 > apps/x.js && git commit -qam "someone else's commit before session start"
git push -q origin lane/x
snap s4                                  # snapshot == HEAD → this session added nothing
export GH_STUB_RESPONSE="[]"
out="$(run_hook s4)"
assert_not_contains '"decision"' "$out" "no-commit session is not blocked for others' work"
assert_contains 'not blocking' "$(err_out)" "attribution soft note emitted"

# T5: unpushed commits that predate the session → soft pass.
make_repo t5
echo v2 > apps/x.js && git commit -qam "pre-session unpushed commit"
snap s5                                  # snapshot == HEAD
out="$(run_hook s5)"
assert_not_contains '"decision"' "$out" "pre-session unpushed commits do not block"
assert_contains 'predate this session or belong to a concurrent session' "$(err_out)" "unpushed soft note emitted"

# T6: unpushed commits made BY the session → block once, dedupe on repeat.
make_repo t6
snap s6
echo v2 > apps/x.js && git commit -qam "session's own unpushed commit"
out="$(run_hook s6)"
assert_contains '"decision"' "$out" "session's unpushed commits block (first stop)"
out="$(run_hook s6)"
assert_not_contains '"decision"' "$out" "unpushed re-stop does not re-block (dedupe)"

# T7: open PR exists → pass regardless of ahead count.
make_repo t7
snap s7
echo v2 > apps/x.js && git commit -qam "work with an open PR"
git push -q origin lane/x
export GH_STUB_RESPONSE='[{"state":"OPEN","headRefOid":"abc"}]'
out="$(run_hook s7)"
assert_not_contains '"decision"' "$out" "open PR passes"

# T8: gh unavailable → fail-open (no block).
make_repo t8
snap s8
echo v2 > apps/x.js && git commit -qam "work while offline"
git push -q origin lane/x
unset GH_STUB_RESPONSE
out="$(run_hook s8)"
assert_not_contains '"decision"' "$out" "gh failure fails open"

echo "# stop-warn-uncommitted.sh"

# T9: per-session baselines are isolated — a later session's snapshot must not clobber
# an earlier session's, and each session only sees its own delta.
make_repo t9
snap sidA                                # A starts on a clean tree
echo dirty > apps/x.js                   # tree gets dirty AFTER A's snapshot
snap sidB                                # B starts with the dirt already present
errA="$(printf '%s' "${stop_json/SID/sidA}" | bash "$STOP_WARN" 2>&1 >/dev/null)"
errB="$(printf '%s' "${stop_json/SID/sidB}" | bash "$STOP_WARN" 2>&1 >/dev/null)"
assert_contains 'apps/x.js' "$errA" "session A sees its in-session dirt"
assert_not_contains 'apps/x.js' "$errB" "session B's baseline is not clobbered by A's (isolation)"

# T10: --snapshot records the session-start HEAD for the PR gate.
make_repo t10
snap sidC
[ "$(tr -d '[:space:]' < "$(git rev-parse --git-dir)/claude-session-state/sidC.head")" = "$(git rev-parse HEAD)" ] \
  && ok "--snapshot records session-start HEAD" || fail "--snapshot records session-start HEAD"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
