#!/bin/sh
# gh-pr-cache.sh — Cache gh pr list results to avoid redundant API calls
#
# Usage:
#   source scripts/hooks/gh-pr-cache.sh
#   $(_gh_pr_cache_get "branch_name")  # Returns: 0 or 1 (cached)
#
# Overhead: ~50ms first call, <1ms subsequent calls (vs ~300ms per gh CLI call)

_GH_PR_CACHE_FILE="${XDG_RUNTIME_DIR:-.}/.gh-pr-list-cache-$$"
_GH_PR_CACHE_TTL=5  # seconds

_gh_pr_cache_load() {
  [ -f "$_GH_PR_CACHE_FILE" ] || return 1

  _now=$(date +%s)
  _mtime=$(stat -f%m "$_GH_PR_CACHE_FILE" 2>/dev/null || stat -c%Y "$_GH_PR_CACHE_FILE" 2>/dev/null || echo 0)
  _age=$((_now - _mtime))

  [ "$_age" -lt "$_GH_PR_CACHE_TTL" ] && return 0
  rm -f "$_GH_PR_CACHE_FILE"
  return 1
}

_gh_pr_cache_init() {
  gh pr list --repo alex-place/lantern-os --state open \
    --json headRefName,number,title \
    > "$_GH_PR_CACHE_FILE" 2>/dev/null || return 1
}

_gh_pr_cache_get() {
  # Arg: branch name
  # Returns: count of PRs for this branch (0 or 1+)

  [ -z "$1" ] && return 0

  _gh_pr_cache_load || _gh_pr_cache_init || return 0

  grep -q "\"headRefName\": \"$1\"" "$_GH_PR_CACHE_FILE" 2>/dev/null && echo 1 || echo 0
}

_gh_pr_cache_agent_list() {
  # Arg: agent prefix (claude, human, etc)
  # Returns: count of conflicting PRs

  [ -z "$1" ] && return 0

  _gh_pr_cache_load || _gh_pr_cache_init || return 0

  if [ "$1" = "human" ]; then
    grep "\"headRefName\":" "$_GH_PR_CACHE_FILE" 2>/dev/null | \
      grep -v "\"claude/" | grep -v "\"gemini/" | \
      grep -v "\"codex/" | grep -v "\"devin/" | \
      grep -v "\"grok/" | grep -v "\"openai/" | wc -l
  else
    grep "\"headRefName\": \"$1/" "$_GH_PR_CACHE_FILE" 2>/dev/null | wc -l
  fi
}

_gh_pr_cache_show() {
  # Display cached PRs for debugging
  _gh_pr_cache_load || _gh_pr_cache_init || {
    echo "  (cache unavailable)"
    return
  }
  cat "$_GH_PR_CACHE_FILE"
}

_gh_pr_cache_cleanup() {
  rm -f "$_GH_PR_CACHE_FILE"
}

trap "_gh_pr_cache_cleanup" EXIT
