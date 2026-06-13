"""
loop.py — autonomous scan → score → suggest loop with operator gate.

The operator gate is intentional:
  - The loop writes a spec to csf/ingest/auto-*.md and stops.
  - To approve: move/act on the file.
  - To reject: delete the file.
  - Agents never touch code without the operator seeing the spec first.

Usage:
    python src/csf_agent/loop.py --once          # scan, write top spec, exit
    python src/csf_agent/loop.py --watch         # run --once every 60s
    python src/csf_agent/loop.py --once --dry-run  # print, write nothing, exit
"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Allow running as a script from repo root
_SRC = Path(__file__).resolve().parents[1]
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from csf_agent.embedder import CSFEmbedder
from csf_agent.scanner import scan_issues
from csf_agent.scorer import score_issues
from csf_agent.suggester import generate_spec, write_spec

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_INGEST_DIR = _REPO_ROOT / "csf" / "ingest"
_WATCH_INTERVAL = 60  # seconds


# ── public helper (used by convergence_io_engine.py inspect) ──────────────────

def get_pending_specs(ingest_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    """
    Return list of dicts for pending auto-*.md specs in csf/ingest/.
    Each dict: {path, name, issue_number, size_bytes}
    """
    ingest_dir = ingest_dir or _DEFAULT_INGEST_DIR
    if not ingest_dir.exists():
        return []
    specs = []
    for p in sorted(ingest_dir.glob("auto-*.md")):
        # Extract issue number from filename: auto-YYYY-MM-DD-issue-NNN.md
        parts = p.stem.split("-issue-")
        number = int(parts[-1]) if len(parts) == 2 and parts[-1].isdigit() else None
        specs.append({
            "path": str(p),
            "name": p.name,
            "issue_number": number,
            "size_bytes": p.stat().st_size,
        })
    return specs


# ── core scan-score-suggest logic ─────────────────────────────────────────────

def _has_pending(ingest_dir: Path) -> bool:
    return any(ingest_dir.glob("auto-*.md")) if ingest_dir.exists() else False


def run_once(
    dry_run: bool = False,
    ingest_dir: Optional[Path] = None,
    repo: str = "alex-place/lantern-os",
) -> int:
    """
    Scan issues, score them, write (or print) the top spec.
    Returns exit code (0 = ok, 1 = no issues found).
    """
    ingest_dir = ingest_dir or _DEFAULT_INGEST_DIR

    issues = scan_issues(repo=repo)
    if not issues:
        print("[csf-agent] scanned 0 issues — nothing to do", flush=True)
        return 1

    embedder = CSFEmbedder()
    ranked = score_issues(issues, embedder)

    top = ranked[0]
    number = top["number"]
    title = top["title"]
    score = top["score"]

    print(
        f"[csf-agent] scanned {len(issues)} issues, "
        f"top: #{number} {title!r} score={score:.4f}",
        flush=True,
    )

    if dry_run:
        print("[csf-agent] --dry-run: spec NOT written", flush=True)
        print(generate_spec(top, score), flush=True)
        return 0

    path = write_spec(top, score, ingest_dir=ingest_dir)
    print(f"[csf-agent] spec written → {path}", flush=True)
    return 0


def run_watch(
    dry_run: bool = False,
    ingest_dir: Optional[Path] = None,
    repo: str = "alex-place/lantern-os",
    interval: int = _WATCH_INTERVAL,
) -> None:
    """Loop run_once every `interval` seconds. Skip if auto-*.md already pending."""
    ingest_dir = ingest_dir or _DEFAULT_INGEST_DIR

    # Graceful Ctrl-C
    def _handle_sigint(sig, frame):  # noqa: ANN001
        print("\n[csf-agent] interrupted — exiting", flush=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_sigint)

    print(f"[csf-agent] watch mode — interval={interval}s", flush=True)
    while True:
        if _has_pending(ingest_dir) and not dry_run:
            print(
                "[csf-agent] pending spec found in csf/ingest/ — skipping this tick",
                flush=True,
            )
        else:
            run_once(dry_run=dry_run, ingest_dir=ingest_dir, repo=repo)
        time.sleep(interval)


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="CSF Agent — autonomous issue → ingest-spec loop"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once",  action="store_true", help="Run one scan/score/suggest cycle and exit")
    mode.add_argument("--watch", action="store_true", help="Run --once every 60s until Ctrl-C")
    parser.add_argument("--dry-run", action="store_true", help="Print spec, do not write file")
    parser.add_argument("--repo",    default="alex-place/lantern-os", help="GitHub repo slug")
    parser.add_argument("--interval", type=int, default=_WATCH_INTERVAL,
                        help="Seconds between watch ticks (default 60)")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    if args.once:
        sys.exit(run_once(dry_run=args.dry_run, repo=args.repo))
    else:
        run_watch(dry_run=args.dry_run, repo=args.repo, interval=args.interval)
