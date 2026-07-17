#!/usr/bin/env python3
"""
Consolidate all Markdown files in the repo into a single CSF archive.

Uses the canonical, lossless CSF core (:mod:`csf`, zstd-backed). The previous
version used the v0.7 *lossy* symbolic text compressor (removed in the v2
consolidation), so round-trips were only approximate; this one is bit-perfect.

Usage:
    python scripts/consolidate_md_to_csf.py
    python scripts/consolidate_md_to_csf.py --output data/all-docs.csf
    python scripts/consolidate_md_to_csf.py --verify  # decompress and check
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List

# Add src/ to path so we can import the CSF core
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

import csf  # noqa: E402

# Single archive member that holds the whole concatenated corpus.
CORPUS_MEMBER = "all-docs.md"

# ------------------------------------------------------------------
# File discovery
# ------------------------------------------------------------------

# Directories that are legacy, skill sprawl, or not part of core convergence docs.
EXCLUDES = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".pytest_cache",
    # Legacy / sprawl directories
    "skills", "surfaces", "services", "templates", "tickets", "test-results",
    "repo-seeds", "profiles", "ops", "dual-boot", "aws-deployment", "artifacts",
    "offers", "ledger", "infra", "dashboard", "art",
    # Old source trees (preserved in archive; not core docs)
    "discord_lounge_bot", "mcp_server", "dream_journal",
    # Data / runtime dirs
    "data", "archive",
}

# Only top-level READMEs and docs under these paths are considered core.
CORE_DOC_PATHS = {
    "README.md", "docs", "src/csf", "apps/lantern-garage", "scripts", "config",
    "manifests", ".github", "benchmarks",
}


def find_md_files(root: Path) -> List[Path]:
    """Find core .md files relevant to convergence / CSF, excluding legacy sprawl."""
    paths: List[Path] = []
    for p in root.rglob("*.md"):
        rel = p.relative_to(root).as_posix()
        if any(part in EXCLUDES for part in p.parts):
            continue
        if not any(rel == cp or rel.startswith(cp + "/") for cp in CORE_DOC_PATHS):
            continue
        paths.append(p)
    paths.sort()
    return paths


# ------------------------------------------------------------------
# Corpus assembly
# ------------------------------------------------------------------

FILE_HEADER = "\n===== FILE: {path} =====\n\n"
FILE_FOOTER = "\n===== END: {path} =====\n"


def build_corpus(files: List[Path], root: Path) -> str:
    """Concatenate all markdown files with clear file-boundary markers."""
    parts: List[str] = []
    for f in files:
        rel = f.relative_to(root).as_posix()
        parts.append(FILE_HEADER.format(path=rel))
        parts.append(f.read_text(encoding="utf-8"))
        parts.append(FILE_FOOTER.format(path=rel))
    return "".join(parts)


def decompress_csf(csf_path: Path) -> str:
    """Read a CSF archive and return the original corpus text (lossless)."""
    return csf.read_file(str(csf_path), CORPUS_MEMBER).decode("utf-8")


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Consolidate Markdown files into a CSF archive")
    p.add_argument("--output", "-o", default="data/all-docs.csf", help="Output .csf path")
    p.add_argument("--repo-root", default=str(REPO_ROOT), help="Repository root directory")
    p.add_argument("--verify", action="store_true", help="Decompress and verify round-trip")
    p.add_argument("--list", action="store_true", help="List files that would be included")
    args = p.parse_args(argv)

    root = Path(args.repo_root).resolve()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    md_files = find_md_files(root)
    print(f"Found {len(md_files)} markdown files")

    if args.list:
        for f in md_files:
            print(f"  {f.relative_to(root).as_posix()}")
        return 0

    if args.verify:
        if not output.exists():
            print(f"ERROR: {output} not found. Run without --verify first.")
            return 1
        print(f"Reading {output} ...")
        text = decompress_csf(output)
        print(f"Decompressed corpus: {len(text):,} chars")
        print(f"Files in corpus: {text.count('===== FILE:')}")
        return 0

    # Build corpus
    print("Building corpus ...")
    corpus = build_corpus(md_files, root)
    original_bytes = len(corpus.encode("utf-8"))
    print(f"Corpus size: {original_bytes:,} bytes ({len(md_files)} files)")

    # Compress with the canonical lossless CSF core (zstd-backed)
    print("Compressing with CSF core (zstd) ...")
    csf.pack_blobs({CORPUS_MEMBER: corpus.encode("utf-8")}, str(output))
    file_size = output.stat().st_size
    print(f"\nWrote {output}")
    print(f"  File size: {file_size:,} bytes")
    print(f"  Compression: {1 - (file_size / original_bytes):.2%}")
    print(f"  Files: {len(md_files)}")

    # Bit-perfect round-trip verification
    print("\nVerifying round-trip ...")
    restored = decompress_csf(output)
    if restored == corpus:
        print("  [ok] Bit-perfect round-trip verified")
        return 0
    print("  [warn] Round-trip mismatch (unexpected for the lossless core)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
