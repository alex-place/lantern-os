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
    python scripts/pr_crystallize.py --limit 200 --types feat,fix,refactor,perf
    python scripts/pr_crystallize.py --pack \
        --in data/training/pr-crystallized.clean.jsonl \
        --csf-out data/csf/coder-crystallization.csf
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

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


def gh_json(args: list[str]) -> object:
    """Run a `gh` command that emits JSON; return the parsed value ([] on failure)."""
    try:
        out = subprocess.run(["gh", *args], capture_output=True, text=True,
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


def gh_diff(number: int) -> str:
    try:
        out = subprocess.run(["gh", "pr", "diff", str(number)], capture_output=True,
                             text=True, encoding="utf-8", timeout=120)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def diff_stats(diff: str) -> tuple[int, int, list[str]]:
    """(added, deleted, changed_files) from a unified diff."""
    added = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    deleted = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    files = re.findall(r"^\+\+\+ b/(.+)$", diff, flags=re.M)
    return added, deleted, files


def issue_body(text: str, cache: dict) -> str:
    """Best-effort: fetch the body of the first referenced issue (Closes #N)."""
    m = _ISSUE_REF_RE.search(text or "")
    if not m:
        return ""
    n = m.group(1)
    if n in cache:
        return cache[n]
    data = gh_json(["issue", "view", n, "--json", "title,body"])
    body = ""
    if isinstance(data, dict):
        body = f"{data.get('title','')}\n{data.get('body','') or ''}".strip()
    cache[n] = body
    return body


def build_row(pr: dict, diff: str, issue_cache: dict, with_issue_body: bool = False) -> dict | None:
    title = (pr.get("title") or "").strip()
    body = (pr.get("body") or "").strip()
    number = pr.get("number")
    added, deleted, files = diff_stats(diff)

    # Filter: a PR whose files are ALL noise (locks/data/binaries/docs) has no signal.
    code_files = [f for f in files if not _NOISE_PATH_RE.search(f)]
    if not code_files:
        return None

    # Linked-issue body is a second gh call per PR — opt-in (title+body usually suffice).
    linked = issue_body(f"{title}\n{body}", issue_cache) if with_issue_body else ""
    intent = "\n\n".join(p for p in (title, body, linked) if p).strip()
    if len(intent) < 12:  # a title with no context is a weak instruction
        return None

    instruction = (
        "You are a coding agent working in the Keystone OS repository. "
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


def extract(args) -> None:
    types = {t.strip().lower() for t in args.types.split(",") if t.strip()}
    prs = gh_json(["pr", "list", "--state", "merged", "--limit", str(args.limit),
                   "--json", "number,title,body,mergedAt"])
    if not isinstance(prs, list) or not prs:
        print("No merged PRs returned by gh (auth? repo?).", file=sys.stderr)
        sys.exit(1)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    issue_cache: dict = {}
    kept = skipped = redactions = 0
    with out_path.open("w", encoding="utf-8") as fout:
        for pr in prs:
            title = pr.get("title") or ""
            if types and pr_type(title) not in types:
                skipped += 1
                continue
            diff = gh_diff(pr.get("number"))
            if not diff:
                skipped += 1
                continue
            _, _, files = diff_stats(diff)
            n_diff_lines = diff.count("\n")
            if n_diff_lines > args.max_diff_lines:  # giant PR → not a clean single lesson
                skipped += 1
                continue
            row = build_row(pr, diff, issue_cache, with_issue_body=args.with_issue_body)
            if row is None:
                skipped += 1
                continue
            redactions += row["meta"]["redactions"]
            fout.write(json.dumps(row, ensure_ascii=False) + "\n")
            kept += 1

    print(json.dumps({"kept": kept, "skipped": skipped, "redactions": redactions,
                      "out": str(out_path), "scanned": len(prs)}, indent=2))
    if args.pack and kept:
        stats = pack_csf(out_path, Path(args.csf_out))
        print("CSF:", json.dumps(stats, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=200, help="how many recent merged PRs to scan")
    ap.add_argument("--types", default="feat,fix,refactor,perf",
                    help="conventional-commit types to keep (comma-sep); '' = all")
    ap.add_argument("--max-diff-lines", type=int, default=600,
                    help="skip PRs whose diff exceeds this many lines")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output JSONL path")
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
