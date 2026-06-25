"""Repo-learning driver — the Research Team's "learn about the repo" pass.

This is NOT a new subsystem. It is a *driver* of the existing Convergence
``MemoryStore`` (src/convergence/memory.py), satisfying the architectural
convergence constraint: one memory, extension over addition, every feature
improves a single loop stage. Here the stage is **Remember** — the system
accumulates durable, grounded knowledge of its own codebase so that delegated
agents, chat, and routing can retrieve real repo facts instead of guessing.

What it does (the loop, applied to the repo):

  Observe  → walk a bounded allowlist of repo files (docs + the live code that
             describes the system)
  Remember → append one grounded knowledge record per file into the ONE memory
  Reason   → (extractive only — no LLM, so nothing is hallucinated; the summary
             is the file's own docstring/heading/leading comment)
  Verify   → each record cites the file path + content SHA as evidence, so it is
             written GROUNDED (passes memory.py's confidence-laundering gate) and
             can be queried back as trusted memory
  Converge → an incremental manifest (path -> sha) means re-runs only learn new
             or changed files; coverage accrues monotonically

Honesty contract: summaries are extractive (verbatim slices of the file), never
generated. Counts come from the manifest + the real on-disk memory log. If a
file has no extractable description it is still recorded with its symbol list so
coverage is truthful, not inflated.

Usage:
    python -m convergence.repo_learn --json [--max 200]
    python src/convergence/repo_learn.py --json --max 50
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from convergence.memory import MemoryStore  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "data" / "research" / "repo-learn-manifest.json"

# Bounded allowlist: the files that *describe the system*. Code that runs the
# loop + the docs that explain it. Deliberately excludes data/, node_modules/,
# vendored trees, and binaries.
SCAN_DIRS = [
    "docs",
    "src/convergence",
    "apps/lantern-garage/lib",
    "apps/lantern-garage/routes",
    "skills",
]
ROOT_FILES = ["CLAUDE.md", "AGENTS.md", "PROVIDERS.md", "SECURITY.md", "SKILLS.md", "README.md"]
EXTS = {".md", ".py", ".js"}
SKIP_PARTS = {"node_modules", "__pycache__", ".git", "dist", "build", "vendor", "data"}
MAX_BYTES = 200_000  # don't slurp generated megafiles


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def _iter_files():
    for rel in ROOT_FILES:
        p = REPO_ROOT / rel
        if p.is_file():
            yield p
    for d in SCAN_DIRS:
        base = REPO_ROOT / d
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in EXTS:
                continue
            if any(part in SKIP_PARTS for part in p.relative_to(REPO_ROOT).parts):
                continue
            yield p


_FENCE_RE = re.compile(r"```.*?```", re.S)
_RULE_RE = re.compile(r"^[-=*_]{3,}$")


def _strip_fences(text: str) -> str:
    return _FENCE_RE.sub("", text)


def _extract_summary(text: str, lang: str) -> str:
    """Extractive (verbatim) one-paragraph description — never generated."""
    if lang == "md":
        # First heading + first real paragraph after it (fenced code stripped,
        # horizontal rules and HTML comments skipped).
        lines = _strip_fences(text).splitlines()
        head = next((l.lstrip("# ").strip() for l in lines if l.startswith("#")), "")
        para = ""
        for l in lines:
            s = l.strip()
            if s and not s.startswith("#") and not s.startswith("<!--") and not _RULE_RE.match(s):
                para = s
                break
        return (f"{head} — {para}" if head and para else head or para)[:600]
    if lang == "py":
        m = re.search(r'"""(.*?)"""', text, re.S) or re.search(r"'''(.*?)'''", text, re.S)
        if m:
            return " ".join(m.group(1).split())[:600]
    if lang == "js":
        m = re.search(r"/\*\*(.*?)\*/", text, re.S)
        if m:
            cleaned = re.sub(r"^\s*\*", "", m.group(1), flags=re.M)
            return " ".join(cleaned.split())[:600]
    # Fallback: leading line comments.
    lead = []
    for l in text.splitlines():
        s = l.strip()
        if s.startswith("//") or s.startswith("#"):
            lead.append(s.lstrip("/# ").strip())
        elif s:
            break
    return " ".join(lead)[:600]


def _extract_symbols(text: str, lang: str):
    if lang == "py":
        return re.findall(r"^\s*(?:def|class)\s+([A-Za-z_]\w*)", text, re.M)[:40]
    if lang == "js":
        syms = re.findall(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)", text)
        syms += re.findall(r"(?:const|class)\s+([A-Za-z_]\w*)\s*=", text)
        syms += re.findall(r'"(/api/[A-Za-z0-9/_-]+)"', text)  # route paths
        return syms[:40]
    if lang == "md":
        return [h.lstrip("# ").strip() for h in re.findall(r"^#{1,3}\s+.+$", _strip_fences(text), re.M)][:40]
    return []


def learn(max_files: int) -> dict:
    t0 = time.time()
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        manifest = json.loads(MANIFEST_PATH.read_text("utf-8"))
    except Exception:
        manifest = {}

    store = MemoryStore(memory_dir=str(REPO_ROOT / "data"))

    scanned = learned = updated = unchanged = 0
    for p in _iter_files():
        scanned += 1
        rel = str(p.relative_to(REPO_ROOT)).replace("\\", "/")
        try:
            raw = p.read_bytes()[:MAX_BYTES]
            text = raw.decode("utf-8", "replace")
        except Exception:
            continue
        sha = _sha(text)
        prior = manifest.get(rel)
        if prior and prior.get("sha") == sha:
            unchanged += 1
            continue
        if (learned + updated) >= max_files:
            continue  # keep scanning for an accurate count, but stop writing

        lang = p.suffix.lower().lstrip(".")
        summary = _extract_summary(text, lang)
        symbols = _extract_symbols(text, lang)
        content = {
            "kind": "repo-knowledge",
            "path": rel,
            "lang": lang,
            "sha": sha,
            "lines": text.count("\n") + 1,
            "summary": summary,
            "symbols": symbols,
        }
        # Grounded: cites the file (path@sha) as evidence, so memory.py keeps it in
        # the trusted "convergence" log rather than the proposals partition.
        entry = store.append(
            source="repo-learn",
            content=content,
            confidence=0.8,
            evidence_ids=[f"repo:{rel}@{sha[:12]}"],
            log_type="convergence",
            verification_status="grounded",
        )
        manifest[rel] = {"sha": sha, "mem_id": entry.id, "learned_at": entry.timestamp.isoformat()}
        if prior:
            updated += 1
        else:
            learned += 1

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), "utf-8")
    return {
        "ok": True,
        "scanned": scanned,
        "learned": learned,
        "updated": updated,
        "unchanged": unchanged,
        "files_known": len(manifest),
        "wrote_this_pass": learned + updated,
        "capped": (learned + updated) >= max_files,
        "took_ms": int((time.time() - t0) * 1000),
        "manifest": str(MANIFEST_PATH.relative_to(REPO_ROOT)).replace("\\", "/"),
    }


def main():
    ap = argparse.ArgumentParser(description="Learn the repo into Convergence Memory")
    ap.add_argument("--max", type=int, default=200, help="Max files to write this pass")
    ap.add_argument("--json", action="store_true", help="Emit JSON summary")
    args = ap.parse_args()
    result = learn(args.max)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(
            f"repo-learn: scanned {result['scanned']}, "
            f"+{result['learned']} new, ~{result['updated']} changed, "
            f"{result['unchanged']} unchanged · {result['files_known']} known · {result['took_ms']}ms"
        )


if __name__ == "__main__":
    main()
