#!/usr/bin/env python3
"""
Create a Lantern OS Managed Agent on Claude Haiku 4.5 backed by a
Memory store seeded from session training pairs.

Steps:
  1. Reuse or create memory store "lantern-csf-v1"
  2. Inject distilled knowledge from training pairs as memories
  3. Create managed agent (Haiku 4.5 + system prompt)
  4. Save agent ID + store ID -> data/training/ft-result.json

Usage:
    python scripts/upload-anthropic-finetune.py [--data data/training/haiku-ft-pairs.jsonl] [--dry-run]

Requires: ANTHROPIC_API_KEY in .env or environment.
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = REPO_ROOT / "data" / "training" / "haiku-ft-pairs.jsonl"
MODEL = "claude-haiku-4-5-20251001"
STORE_NAME = "lantern-csf-v1"
AGENT_NAME = "keystone-ft"
RESULT_PATH = REPO_ROOT / "data" / "training" / "ft-result.json"

SYSTEM_PROMPT = """You are unisona.ai, the engineering agent for the Lantern OS codebase. You have deep knowledge of this exact codebase built up from real session experience.

## Codebase architecture
- **Server**: server.js (port 4177) — REST + SSE streaming
- **Dream Chat**: lib/dream-chat.js — 6 agents (lantern, blinkbug, keystone, waterfall, xenon, founder)
- **Convergence Engine**: src/convergence_io_engine.py — TesseractEngine, ~4s, returns JSON
- **CSF v07**: src/csf/ — CSFFileWriter, CSFFileReader, SymbolicDictionary, QuantumDustField
- **StatusCube**: src/csf/status_cube.py — fields: stage_index, loop_count, scene_key, history, symbols, observations; archetype is a @property
- **ThreeDoorsEngine**: src/three_doors_engine.py — 7-stage loop, state as plain dicts
- **STAGES**: ["kingdome-garden","cloverfield","future-doors","xp-door","xenon-convergence","sigil-city","fog-door-return"]
- **Data**: JSON/JSONL under data/; CSF files under data/csf/

## Key facts (do not invent alternatives)
- State keys: scene_key, stage_index, loop_count, archetype, doors, text, history
- CSF file path: engine.cube._path() — NOT _get_csf_path()
- No ThreeDoorsGameState class — state is plain dicts from start_game()/choose_door()
- archetype is a computed @property on StatusCube, not a stored field
- Symbol keys from consolidation: "{arch}-walker", "affinity-{slug}", "{agent}-companion"
- TesseractEngine converge() returns in ~4s via subprocess; timeout is 8s in the Node adapter
- Git: one open PR per agent prefix. Direct master push needs OVERRIDE_MERGE=1

## Conventions
- No emojis unless asked. No trailing summaries. Read files before editing.
- Fix root causes not symptoms. Tests use the real API; no mocking internal state.
- Minimal code — no abstractions beyond what the task requires.

## Test command
python -m pytest tests/ -q --tb=short --ignore=tests/test_anti_entropy_memory.py --ignore=tests/test_audit_chain.py --ignore=tests/test_discord_bot.py --ignore=tests/test_discord_voice_gate.py"""


def load_env():
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def get_client():
    load_env()
    try:
        import anthropic
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            print("ANTHROPIC_API_KEY not set.")
            sys.exit(1)
        return anthropic.Anthropic(api_key=key)
    except ImportError:
        print("anthropic SDK not installed. Run: pip install anthropic")
        sys.exit(1)


def load_training_pairs(path: Path) -> list[dict]:
    pairs = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            msgs = rec.get("messages", [])
            if len(msgs) >= 2:
                pairs.append({"user": msgs[0]["content"], "assistant": msgs[1]["content"]})
    return pairs


def distill_memory(pair: dict, index: int) -> tuple[str, str]:
    """Convert a training pair into a memory path + content.

    Extracts the key pattern/answer from the pair.
    Returns (path, content) where path is /sessions/NNNN.
    """
    user = pair["user"].strip()[:200]
    assistant = pair["assistant"].strip()

    # Extract a compact answer — first 800 chars of assistant text
    content = f"Q: {user}\nA: {assistant[:800]}"
    path = f"/sessions/{index:04d}"
    return path, content


def get_or_create_store(client) -> str:
    """Find existing lantern-csf-v1 store or create a new one."""
    existing = client.beta.memory_stores.list()
    for store in existing.data:
        if store.name == STORE_NAME:
            print(f"Reusing existing memory store: {store.id}")
            return store.id

    print(f"Creating memory store: {STORE_NAME}")
    store = client.beta.memory_stores.create(name=STORE_NAME)
    print(f"  Created -> {store.id}")
    return store.id


def seed_memories(client, store_id: str, pairs: list[dict]):
    """Inject training pairs as memories."""
    print(f"Seeding {len(pairs)} memories into {store_id}...")
    injected = 0
    for i, pair in enumerate(pairs):
        path, content = distill_memory(pair, i)
        try:
            client.beta.memory_stores.memories.create(
                memory_store_id=store_id,
                path=path,
                content=content,
            )
            injected += 1
            if injected % 20 == 0:
                print(f"  {injected}/{len(pairs)}...")
                time.sleep(0.3)
        except Exception as e:
            print(f"  Warning: pair {i} failed: {e}")
    print(f"  Done. {injected}/{len(pairs)} memories injected.")
    return injected


def get_or_create_agent(client) -> str:
    """Find existing keystone-ft agent or create a new one."""
    existing = client.beta.agents.list()
    for agent in existing.data:
        if agent.name == AGENT_NAME:
            print(f"Reusing existing agent: {agent.id}")
            return agent.id

    print(f"Creating agent: {AGENT_NAME} on {MODEL}")
    agent = client.beta.agents.create(
        name=AGENT_NAME,
        model=MODEL,
        system=SYSTEM_PROMPT,
    )
    print(f"  Created -> {agent.id}")
    return agent.id


def save_result(store_id: str, agent_id: str):
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    result = {
        "agent_id": agent_id,
        "memory_store_id": store_id,
        "model": MODEL,
        "agent_name": AGENT_NAME,
        "store_name": STORE_NAME,
        "usage": {
            "memory_store_resource": {
                "type": "memory_store",
                "memory_store_id": store_id,
                "access": "read_write",
                "instructions": "Use this store to recall patterns from past Lantern OS engineering sessions."
            }
        }
    }
    RESULT_PATH.write_text(json.dumps(result, indent=2))
    print(f"Saved -> {RESULT_PATH}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(DEFAULT_DATA))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", metavar="AGENT_ID", help="Check an existing agent")
    parser.add_argument("--list-stores", action="store_true")
    args = parser.parse_args()

    client = get_client()

    if args.status:
        agent = client.beta.agents.retrieve(args.status)
        print(json.dumps(agent.model_dump(), indent=2, default=str))
        return

    if args.list_stores:
        stores = client.beta.memory_stores.list()
        for s in stores.data:
            print(f"  {s.id}  {s.name}  {s.status}")
        return

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"Training data not found: {data_path}")
        print("Run: python scripts/extract-session-pairs.py")
        sys.exit(1)

    pairs = load_training_pairs(data_path)
    print(f"Loaded {len(pairs)} training pairs")

    if args.dry_run:
        print("\nDry run. Would:")
        print(f"  Get or create memory store: {STORE_NAME}")
        print(f"  Inject {len(pairs)} memories (paths /sessions/0000 .. /sessions/{len(pairs)-1:04d})")
        print(f"  Get or create agent: {AGENT_NAME} on {MODEL}")
        print(f"  System prompt: {len(SYSTEM_PROMPT)} chars")
        path, content = distill_memory(pairs[0], 0)
        print(f"\n  Sample memory path: {path}")
        print(f"  Sample content: {content[:200]}...")
        return

    store_id = get_or_create_store(client)
    seed_memories(client, store_id, pairs)
    agent_id = get_or_create_agent(client)
    result = save_result(store_id, agent_id)

    print("\nDone.")
    print(f"  Agent ID:     {agent_id}")
    print(f"  Memory store: {store_id}")
    print(f"\nNext: wire into unified_agent_connector.py")
    print(f"  provider: 'keystone-ft'")
    print(f"  agent_id: '{agent_id}'")
    print(f"  memory_store_id: '{store_id}'")


if __name__ == "__main__":
    main()
