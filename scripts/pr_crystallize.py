#!/usr/bin/env python3
"""
Crystallize merged PRs into verified coding-training rows — Σ₀'s own grounding.

The user goal: "crystallize and update our own weights with our own grounding."
The single best grounding source in this repo is its **merged PRs**: a merge is a
verification event (CI-pass + human review), so an issue→diff pair needs NO
re-execution gate — the merge already IS the gate. This extractor turns each
qualifying merged PR into one training row:

    instruction  = the intent (PR title + body, + linked issue title/body)
    output       = the merged unified diff (the VERIFIED patch)
    meta         = provenance (pr number, merged_at, files, +/- lines, type)

Rows are emitted in the SAME schema as scripts/gen_sigma0_traces.py
({instruction, input, output, meta}) so the existing crystallization consumers
(scripts/decontaminate_training.py, continual_ouro_pipeline.py, train-qlora-ouro.py)
ingest them unchanged. Least-sprawl: no new corpus format, no new retriever.

Pipeline (this script owns extract + the CSF pack; decontam is the existing step):

    extract  →  scripts/pr_crystallize.py            (this file)
    clean    →  scripts/decontaminate_training.py    (existing; 13-gram vs HumanEval+MBPP)
    pack     →  scripts/pr_crystallize.py --pack      (mirrors src/csf/coder_grounding.build)
    train    →  models/keystone-sigma0-plt/train_lora.py  (cloud L4 ≥24GB — the 3070 can't)
    gate     →  scripts/eval_swebench_chat.py / eval_humaneval_chat.py  (verified:false→true)

Why "into CSF": the crystallization corpus is packed into ONE self-contained,
integrity-checked omni-CSF archive (data/csf/coder-crystallization.csf), exactly
like the coder's KC grounding — one lossless file, per-row sha256, codec-fit.

Requires the `gh` CLI (HTTPS works in this sandbox; direct git/gh calls are fine).
Generated data is local/gitignored (contains diffs of the whole repo).

CLI:
    # our own repo (default):
    python scripts/pr_crystallize.py --limit 200 --types feat,fix,refactor,perf
    # external big-name OSS repos — license-gated (permissive SPDX only), parallel:
    python scripts/pr_crystallize.py --repo huggingface/transformers --repo tiangolo/fastapi \
        --limit 200 --jobs 8 --out data/training/pr-crystallized-external.jsonl
    # pack a (decontaminated) corpus into one CSF archive:
    python scripts/pr_crystallize.py --pack \
        --in data/training/pr-crystallized.clean.jsonl \
        --csf-out data/csf/coder-crystallization.csf

This feeds the "Unisona" local model: a brand-new 8GB-native coder that merges the
Ouro (looped) + LoopCoder/PLT lineages by distilling into the Ouro-1.4B student
(train+run on the 3070) from our PRs + permissive OSS PRs, tool-integrated with
keystone chat / creator dashboard / traders, updated by the ADR-0010 OFFLINE,
verify-gated flywheel (never an online weight write in the request path).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# SPDX ids we may legally harvest + redistribute a derived training corpus from.
# Permissive only — copyleft (GPL/AGPL/LGPL/MPL) and unlicensed repos are skipped
# so the crystallized model stays cleanly Apache-2.0-compatible.
PERMISSIVE_LICENSES = {
    "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
    "ISC", "0BSD", "Unlicense", "Zlib", "BSL-1.0", "PostgreSQL", "Python-2.0",
}

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "data" / "training" / "pr-crystallized.jsonl"
DEFAULT_CSF = REPO / "data" / "csf" / "coder-crystallization.csf"
_ARC_CORPUS = "training/pr-crystallized.jsonl"  # member path inside the archive

# ── Secret / PII scrubbing (mirrors scripts/build_claude_session_dataset.py) ──
# Diffs can contain a leaked key or an absolute home path; never write those raw.
SECRET_RE = re.compile(
    r"(sk-ant-[A-Za-z0-9\-_]{20,}|sk-[A-Za-z0-9\-_]{20,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xai-[A-Za-z0-9\-]{20,}|AKIA[0-9A-Z]{16}|"
    r"xox[baprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,})"
)
WINDOWS_HOME_RE = re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\s\"']+")
UNIX_HOME_RE = re.compile(r"(?<![\w.-])/home/[^/\s\"']+")
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")


def scrub(text: str) -> tuple[str, int]:
    """Redact secrets/home-paths/emails. Returns (clean_text, n_redactions)."""
    n = 0
    for pat, repl in (
        (SECRET_RE, "[REDACTED_SECRET]"),
        (WINDOWS_HOME_RE, "%USERPROFILE%"),
        (UNIX_HOME_RE, "~"),
        (EMAIL_RE, "[REDACTED_EMAIL]"),
    ):
        text, k = pat.subn(repl, text)
        n += k
    return text, n


# ── PR classification + filtering ────────────────────────────────────────────
_TYPE_RE = re.compile(r"^\s*(feat|fix|refactor|perf|research|test|chore|docs|build|ci|style|revert)\b", re.I)
# A diff whose changed files are ONLY these carries no transferable coding signal.
_NOISE_PATH_RE = re.compile(
    r"(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.min\.(js|css)|"
    r"CHANGELOG|changelog\.d/|/data/|\.jsonl$|\.csf$|\.(png|jpg|jpeg|gif|webp|pdf|zip|bin|lockb)$)",
    re.I,
)
_ISSUE_REF_RE = re.compile(r"#(\d+)")


def pr_type(title: str) -> str:
    m = _TYPE_RE.match(title or "")
    return m.group(1).lower() if m else "other"


def gh_json(args: list[str], repo: str | None = None) -> object:
    """Run a `gh` command that emits JSON; return the parsed value ([] on failure).
    `repo` ('owner/name') targets an EXTERNAL repo via `-R`; None = current repo."""
    full = ["gh", *args] + (["-R", repo] if repo else [])
    try:
        out = subprocess.run(full, capture_output=True, text=True,
                             encoding="utf-8", timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"  ! gh {' '.join(args[:3])}…: {e}", file=sys.stderr)
        return []
    if out.returncode != 0:
        print(f"  ! gh {' '.join(args[:3])}…: {out.stderr.strip()[:160]}", file=sys.stderr)
        return []
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return []


def gh_diff(number: int, repo: str | None = None) -> str:
    cmd = ["gh", "pr", "diff", str(number)] + (["-R", repo] if repo else [])
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             encoding="utf-8", timeout=120)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def repo_license(repo: str) -> str | None:
    """SPDX id of an external repo's license via the GitHub API (None if unknown)."""
    data = gh_json(["api", f"repos/{repo}", "--jq", ".license.spdx_id"])
    # `gh api --jq` on a scalar prints a bare string that json.loads sees as invalid
    # unless quoted; fall back to a raw call.
    if isinstance(data, str) and data:
        return data
    try:
        out = subprocess.run(["gh", "api", f"repos/{repo}", "--jq", ".license.spdx_id"],
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
        spdx = out.stdout.strip()
        return spdx or None
    except (OSError, subprocess.TimeoutExpired):
        return None


def diff_stats(diff: str) -> tuple[int, int, list[str]]:
    """(added, deleted, changed_files) from a unified diff."""
    added = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    deleted = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    files = re.findall(r"^\+\+\+ b/(.+)$", diff, flags=re.M)
    return added, deleted, files


def issue_body(text: str, cache: dict, repo: str | None = None) -> str:
    """Best-effort: fetch the body of the first referenced issue (Closes #N)."""
    m = _ISSUE_REF_RE.search(text or "")
    if not m:
        return ""
    n = m.group(1)
    key = f"{repo or 'self'}#{n}"
    if key in cache:
        return cache[key]
    data = gh_json(["issue", "view", n, "--json", "title,body"], repo)
    body = ""
    if isinstance(data, dict):
        body = f"{data.get('title','')}\n{data.get('body','') or ''}".strip()
    cache[key] = body
    return body


def build_row(pr: dict, diff: str, issue_cache: dict, with_issue_body: bool = False,
              repo: str | None = None, spdx: str | None = None) -> dict | None:
    title = (pr.get("title") or "").strip()
    body = (pr.get("body") or "").strip()
    number = pr.get("number")
    added, deleted, files = diff_stats(diff)

    # Filter: a PR whose files are ALL noise (locks/data/binaries/docs) has no signal.
    code_files = [f for f in files if not _NOISE_PATH_RE.search(f)]
    if not code_files:
        return None

    # Linked-issue body is a second gh call per PR — opt-in (title+body usually suffice).
    linked = issue_body(f"{title}\n{body}", issue_cache, repo) if with_issue_body else ""
    intent = "\n\n".join(p for p in (title, body, linked) if p).strip()
    if len(intent) < 12:  # a title with no context is a weak instruction
        return None

    where = f"the {repo} repository" if repo else "the Keystone OS repository"
    instruction = (
        f"You are a coding agent working in {where}. "
        "Implement the following change and return a unified diff.\n\n" + intent
    )
    output = "```diff\n" + diff.rstrip() + "\n```"

    instruction, r1 = scrub(instruction)
    output, r2 = scrub(output)
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "meta": {
            "source": "pr-crystallize",
            "repo": repo or "self",
            "license": spdx,
            "pr": number,
            "merged_at": pr.get("mergedAt"),
            "type": pr_type(title),
            "files": code_files[:40],
            "added": added,
            "deleted": deleted,
            "redactions": r1 + r2,
            "verified": True,          # merge = CI-pass + review; the patch landed
            "verification": "merged-pr",
        },
    }


# ── CSF crystallization pack (mirrors src/csf/coder_grounding.build) ──────────
def pack_csf(jsonl_path: Path, out_path: Path) -> dict:
    """Pack a crystallization JSONL into ONE integrity-checked omni-CSF archive."""
    sys.path.insert(0, str(REPO / "src"))
    from csf import csf_pack  # noqa: E402  (path set above)

    raw = Path(jsonl_path).read_bytes()
    n = sum(1 for ln in raw.splitlines() if ln.strip())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    csf_pack.pack_blobs(
        {_ARC_CORPUS: raw}, str(out_path), compress=True, codec="omni",
        extra_meta={"crystallization": {"kind": "coder", "corpus": _ARC_CORPUS,
                                        "rows": n, "source": "merged-prs"}},
    )
    size = out_path.stat().st_size
    return {"rows": n, "raw_bytes": len(raw), "archive_bytes": size,
            "ratio": round(len(raw) / size, 2) if size else 0.0,
            "codec": "omni", "path": str(out_path)}


def _row_for(pr: dict, repo: str | None, spdx: str | None, args, issue_cache: dict):
    """Fetch one PR's diff and build a row (or None). Runs in a worker thread."""
    diff = gh_diff(pr.get("number"), repo)
    if not diff or diff.count("\n") > args.max_diff_lines:
        return None
    return build_row(pr, diff, issue_cache, with_issue_body=args.with_issue_body,
                     repo=repo, spdx=spdx)


def _harvest_repo(repo: str | None, args, fout, issue_cache: dict) -> tuple[int, int]:
    """Harvest one repo (None = current). External repos are license-gated. Returns (kept, skipped)."""
    spdx = None
    if repo is not None:
        spdx = repo_license(repo)
        if not args.allow_any_license and spdx not in PERMISSIVE_LICENSES:
            print(f"  ! skip {repo}: license {spdx!r} not in the permissive allowlist", file=sys.stderr)
            return (0, 0)
    prs = gh_json(["pr", "list", "--state", "merged", "--limit", str(args.limit),
                   "--json", "number,title,body,mergedAt"], repo)
    if not isinstance(prs, list) or not prs:
        print(f"  ! {repo or 'self'}: no merged PRs (auth? repo?)", file=sys.stderr)
        return (0, 0)
    # Conventional-commit type filter applies to OUR repo only — external OSS repos
    # rarely use `feat:`/`fix:` prefixes, so gate them by noise/size/intent instead.
    types = {t.strip().lower() for t in args.types.split(",") if t.strip()}
    if types and repo is None:
        prs = [p for p in prs if pr_type(p.get("title") or "") in types]

    kept = skipped = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as ex:
        for row in ex.map(lambda p: _row_for(p, repo, spdx, args, issue_cache), prs):
            if row is None:
                skipped += 1
            else:
                fout.write(json.dumps(row, ensure_ascii=False) + "\n")
                kept += 1
    print(f"  {repo or 'self'}: kept {kept}, skipped {skipped}  (license={spdx or 'n/a'}, jobs={args.jobs})")
    return (kept, skipped)


def extract(args) -> None:
    # Sources: external --repo entries, plus OUR repo (default when no --repo, or --include-self).
    repos: list[str | None] = list(args.repo)
    if args.include_self or not repos:
        repos = [None] + repos

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    issue_cache: dict = {}
    total_kept = total_skipped = 0
    with out_path.open("a" if args.append else "w", encoding="utf-8") as fout:
        for repo in repos:
            k, s = _harvest_repo(repo, args, fout, issue_cache)
            total_kept += k
            total_skipped += s

    print(json.dumps({"kept": total_kept, "skipped": total_skipped, "out": str(out_path),
                      "repos": [r or "self" for r in repos]}, indent=2))
    if args.pack and total_kept:
        print("CSF:", json.dumps(pack_csf(out_path, Path(args.csf_out)), indent=2))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=200, help="how many recent merged PRs to scan PER repo")
    ap.add_argument("--repo", action="append", default=[], metavar="OWNER/NAME",
                    help="external repo to harvest (repeatable); permissive-licensed only unless --allow-any-license")
    ap.add_argument("--include-self", action="store_true",
                    help="also harvest the current repo (default when no --repo is given)")
    ap.add_argument("--allow-any-license", action="store_true",
                    help="skip the SPDX permissive-license gate on external repos (only for repos you've vetted)")
    ap.add_argument("--jobs", type=int, default=6, help="concurrent gh-diff fetches (external harvest at scale)")
    ap.add_argument("--types", default="feat,fix,refactor,perf",
                    help="conventional-commit types to keep for OUR repo (comma-sep); '' = all")
    ap.add_argument("--max-diff-lines", type=int, default=600,
                    help="skip PRs whose diff exceeds this many lines")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output JSONL path")
    ap.add_argument("--append", action="store_true", help="append to --out instead of overwriting")
    ap.add_argument("--with-issue-body", action="store_true",
                    help="also fetch each linked issue's body (2nd gh call per PR — slower)")
    ap.add_argument("--pack", action="store_true", help="also pack the output into CSF")
    ap.add_argument("--csf-out", default=str(DEFAULT_CSF), help="CSF archive path (with --pack)")
    ap.add_argument("--in", dest="pack_in", default=None,
                    help="pack-only mode: pack this existing JSONL into CSF and exit")
    args = ap.parse_args()

    if args.pack_in:  # pack an already-extracted (e.g. decontaminated) corpus
        stats = pack_csf(Path(args.pack_in), Path(args.csf_out))
        print("CSF:", json.dumps(stats, indent=2))
        return
    extract(args)


if __name__ == "__main__":
    main()
