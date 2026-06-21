#!/usr/bin/env python3
"""
Extract fine-tuning pairs from Claude Code session transcripts.

Reads all session JSONL files from the .claude/projects/ directory,
reconstructs conversation threads, filters for high-quality code/engineering
turns, and outputs Anthropic fine-tuning JSONL.

Usage:
    python scripts/extract-session-pairs.py [--out data/training/haiku-ft-pairs.jsonl]
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# Claude Code's per-project transcript dir is named after the repo's absolute
# path with the drive-colon and every path separator replaced by '-'
# (e.g. C:\dev\lantern-os -> C--dev-lantern-os). Derive it from REPO_ROOT so
# this works on any machine/checkout; allow an explicit override via env var.
_slug = str(REPO_ROOT).replace(":", "-").replace("\\", "-").replace("/", "-")
SESSIONS_DIR = Path(
    os.environ.get("CLAUDE_SESSIONS_DIR")
    or Path.home() / ".claude" / "projects" / _slug
)
DEFAULT_OUT = REPO_ROOT / "data" / "training" / "haiku-ft-pairs.jsonl"

SYSTEM_PROMPT = """You are an expert engineering assistant deeply familiar with the Lantern OS codebase — a local-first OS cockpit built by a solo developer (Alex Place).

## Architecture
- **Server**: `apps/lantern-garage/server.js` on port 4177, REST API + SSE streaming
- **Dream Chat**: `apps/lantern-garage/lib/dream-chat.js` — 6 agent personas (lantern, blinkbug, keystone, waterfall, xenon, founder)
- **Convergence Engine**: `src/convergence_io_engine.py` — 4-layer TesseractEngine pipeline (~4s, returns JSON)
- **CSF v07**: `src/csf/` — QuantumDustField, CSFFileWriter/Reader, SymbolicDictionary
- **StatusCube**: `src/csf/status_cube.py` — player ImagniVerse (stage_index, loop_count, symbols, observations, archetype property)
- **ThreeDoorsEngine**: `src/three_doors_engine.py` — 7-stage game loop using StatusCube
- **Data**: `.json`/`.jsonl` files under `data/`; CSF files under `data/csf/`

## Key conventions
- No `ThreeDoorsGameState` class — state is plain dicts from `start_game()` / `choose_door()`
- State fields: `scene_key`, `stage_index`, `loop_count`, `archetype`, `doors`, `text`, `history`
- CSF path: `engine.cube._path()` — not `_get_csf_path()`
- Tests use the real engine API; no mocking of internal state
- Git: monoworkstream rules — one open PR per agent prefix (`claude/`, `gemini/`, etc.)
- Commit messages: no slop (< 8 chars, "wip", "temp" blocked)
- No emojis unless explicitly requested
- No trailing summaries — end responses at the last action

## Test commands
```bash
python -m pytest tests/ -q --tb=short --ignore=tests/test_anti_entropy_memory.py --ignore=tests/test_audit_chain.py --ignore=tests/test_discord_bot.py --ignore=tests/test_discord_voice_gate.py
```

Always read existing code before editing. Fix root causes, not symptoms."""


def extract_user_query(content) -> str:
    """Extract the human-typed query from a user record's content.
    Returns empty string if content is only tool_results (no real text)."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            block.get("text", "").strip()
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p).strip()
    return ""


def extract_assistant_text(content) -> str:
    """Extract the visible text response from an assistant record's content.
    Skips thinking blocks and tool_use blocks."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            block.get("text", "").strip()
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p).strip()
    return ""


def quality_score(text: str) -> int:
    """Score how useful an assistant turn is as training data."""
    score = 0
    if len(text) > 200:
        score += 1
    if len(text) > 800:
        score += 2
    # Code indicators
    if "```" in text:
        score += 3
    if re.search(r"\bdef \w+|\bclass \w+|\bfunction \w+", text):
        score += 2
    if re.search(r"\.(py|js|ts|json|jsonl|html|css)\b", text):
        score += 1
    # Engineering actions
    if any(kw in text.lower() for kw in ["pytest", "test", "csf", "statusCube", "stage_index",
                                          "loop_count", "three_doors", "convergence", "tesseract"]):
        score += 2
    if any(kw in text.lower() for kw in ["fixed", "rewritten", "refactor", "now passes", "green"]):
        score += 1
    # Penalise thin acks
    if len(text) < 80:
        score -= 5
    LOW_VALUE = ["tool loaded", "yes.", "ok.", "done.", "sure.", "understood.",
                 "i'll continue", "picking up", "resuming"]
    if any(text.lower().strip().startswith(p) for p in LOW_VALUE):
        score -= 10
    return score


def load_session(path: Path):
    """Load records from one session JSONL, return list of dicts."""
    records = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except OSError:
        pass
    return records


def find_real_query(uuid: str, by_uuid: dict, max_hops: int = 20) -> str:
    """Walk UP the parentUuid chain from a given uuid to find the nearest
    genuine user query (string content or text-block array, not tool_result-only)."""
    current = uuid
    for _ in range(max_hops):
        rec = by_uuid.get(current)
        if rec is None:
            break
        if rec.get("type") == "user":
            text = extract_user_query(rec.get("message", {}).get("content", ""))
            if text:
                return text
        current = rec.get("parentUuid", "")
        if not current:
            break
    return ""


def build_conversation(records) -> list[dict]:
    """
    For each non-sidechain assistant turn with substantial text, walk up the
    parentUuid chain to find the originating user query.
    Returns list of {user, assistant, score} dicts.
    """
    by_uuid = {r["uuid"]: r for r in records if "uuid" in r}

    assistant_records = [
        r for r in records
        if r.get("type") == "assistant" and not r.get("isSidechain", False)
    ]

    if not assistant_records:
        return []

    turns = []
    for ar in assistant_records:
        content = ar.get("message", {}).get("content", [])
        a_text = extract_assistant_text(content)
        if not a_text:
            continue

        # Walk up tree to find real user query
        user_text = find_real_query(ar.get("parentUuid", ""), by_uuid)
        if not user_text:
            continue

        turns.append({
            "user": user_text,
            "assistant": a_text,
            "score": quality_score(a_text),
        })

    return turns


def make_example(turns_window: list[dict]) -> dict:
    """Convert a window of turns into an Anthropic fine-tuning record."""
    messages = []
    for t in turns_window:
        messages.append({"role": "user", "content": t["user"]})
        messages.append({"role": "assistant", "content": t["assistant"]})
    return {"system": SYSTEM_PROMPT, "messages": messages}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions-dir", default=str(SESSIONS_DIR))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-score", type=int, default=3,
                        help="Minimum quality score for assistant turns (default: 3)")
    parser.add_argument("--window", type=int, default=2,
                        help="Turns per training example (default: 2)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print stats without writing output")
    args = parser.parse_args()

    sessions_dir = Path(args.sessions_dir)
    if not sessions_dir.exists():
        print(f"Sessions dir not found: {sessions_dir}", file=sys.stderr)
        sys.exit(1)

    jsonl_files = list(sessions_dir.glob("*.jsonl"))
    print(f"Found {len(jsonl_files)} session files in {sessions_dir}")

    all_turns = []
    for path in jsonl_files:
        records = load_session(path)
        turns = build_conversation(records)
        all_turns.extend(turns)

    print(f"Total (user, assistant) pairs extracted: {len(all_turns)}")

    # Deduplicate by (user[:200], assistant[:200]) fingerprint
    seen = set()
    deduped = []
    for t in all_turns:
        key = (t["user"][:200], t["assistant"][:200])
        if key not in seen:
            seen.add(key)
            deduped.append(t)
    print(f"After dedup: {len(deduped)} unique pairs (removed {len(all_turns) - len(deduped)})")

    # Filter by quality
    good_turns = [t for t in deduped if t["score"] >= args.min_score]
    print(f"High-quality turns (score >= {args.min_score}): {len(good_turns)}")

    if not good_turns:
        print("No qualifying turns found. Lower --min-score or check sessions dir.")
        sys.exit(1)

    # Score distribution
    from collections import Counter
    dist = Counter(t["score"] for t in all_turns)
    print("Score distribution:", dict(sorted(dist.items())))

    # Build training examples with sliding window
    examples = []
    window = args.window
    if window == 1:
        for t in good_turns:
            examples.append(make_example([t]))
    else:
        # Pair consecutive good turns (same session context)
        for i in range(len(good_turns)):
            window_turns = good_turns[i:i + window]
            if len(window_turns) == window:
                examples.append(make_example(window_turns))

    print(f"Training examples generated: {len(examples)}")

    if args.dry_run:
        # Print a sample
        if examples:
            print("\n--- Sample example ---")
            ex = examples[0]
            print(f"Messages: {len(ex['messages'])}")
            for m in ex["messages"]:
                preview = m["content"][:120].replace("\n", " ")
                print(f"  [{m['role']}]: {preview}...")
        return

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    size_kb = out_path.stat().st_size / 1024
    print(f"\nWrote {len(examples)} examples -> {out_path} ({size_kb:.1f} KB)")
    print("Next: python scripts/upload-anthropic-finetune.py --data", out_path)


if __name__ == "__main__":
    main()
