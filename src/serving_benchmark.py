#!/usr/bin/env python3
"""
Standing Benchmark for Lantern OS Model Serving.

Measures inference speed, decode quality, and cost-efficiency on a golden set.
Runs automatically after model changes and appends results to leaderboard.

Golden set: 10 diverse prompts covering reasoning, creative, code, and domain tasks.
Metrics:
  - latency_ms: Wall-clock time (token-inclusive decode)
  - tokens_generated: Output length
  - repetition_ratio: Unique tokens / total tokens (closer to 1.0 = better)
  - cost_estimate_usd: API cost or compute estimate
  - decode_quality: Manual or ML-scored coherence (0-1)
"""

import json
import time
import os
import sys
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
import hashlib

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data" / "benchmarks"
DATA_DIR.mkdir(parents=True, exist_ok=True)

LEADERBOARD_PATH = DATA_DIR / "leaderboard.jsonl"

# Golden set: 10 diverse prompts
GOLDEN_SET = [
    {
        "name": "reasoning_arithmetic",
        "task": "reasoning",
        "prompt": "What is 17 * 23 + 45 - 12? Show your work step by step.",
    },
    {
        "name": "reasoning_logic",
        "task": "reasoning",
        "prompt": "If all birds can fly and penguins are birds, why can't penguins fly? Explain.",
    },
    {
        "name": "creative_story",
        "task": "creative",
        "prompt": "Write a 2-sentence dream about a glowing door in a forest.",
    },
    {
        "name": "coding_python",
        "task": "coding",
        "prompt": "Write a Python function that reverses a string without using slicing.",
    },
    {
        "name": "coding_debug",
        "task": "coding",
        "prompt": "This Python code is buggy: `for i in range(10): print(i); i += 1)`. Find the bug.",
    },
    {
        "name": "domain_memory",
        "task": "domain",
        "prompt": "How does Lantern OS persist memories? Name 3 key components.",
    },
    {
        "name": "domain_convergence",
        "task": "domain",
        "prompt": "What is the Convergence Core? What are the 6 stages of the Observe→Converge loop?",
    },
    {
        "name": "multilingual_greeting",
        "task": "creative",
        "prompt": "Greet the user in 3 different languages.",
    },
    {
        "name": "short_response",
        "task": "reasoning",
        "prompt": "Is water wet? (1-2 sentences only)",
    },
    {
        "name": "long_context",
        "task": "reasoning",
        "prompt": "Summarize the Convergence 12 architecture in under 100 words.",
    },
]


def calculate_repetition_ratio(text: str) -> float:
    """Calculate unique_tokens / total_tokens. Higher is better (no repetition)."""
    words = text.lower().split()
    if not words:
        return 1.0
    unique_words = len(set(words))
    total_words = len(words)
    return min(1.0, unique_words / max(total_words, 1))


def estimate_cost(provider: str, tokens_generated: int, model: str) -> float:
    """Rough cost estimate for benchmarking."""
    rates = {
        "openai": {"gpt-4.1-mini": 0.15 / 1e6, "gpt-4": 0.03 / 1e6},
        "anthropic": {"claude-haiku-4-5-20251001": 0.80 / 1e6, "claude-sonnet-4-6": 3.0 / 1e6},
        "gemini": {"gemini-2.5-flash": 0.075 / 1e6},
        "deepseek": {"deepseek-chat": 0.14 / 1e6},
        "groq": {"llama-3.1-70b-versatile": 0.0},  # Free tier
        "ollama": {"*": 0.0},  # Local
    }
    rate = rates.get(provider, {}).get(model, rates.get(provider, {}).get("*", 1.0 / 1e6))
    return tokens_generated * rate


def run_benchmark(provider: str, model: str, system_prompt: str = "") -> Dict[str, Any]:
    """Run benchmark on golden set and return aggregated results."""
    try:
        from unified_agent_connector import UnifiedAgentConnector
    except ImportError:
        print(f"[benchmark] Cannot import UnifiedAgentConnector; skipping run")
        return {"error": "import_failed"}

    connector = UnifiedAgentConnector()
    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "provider": provider,
        "model": model,
        "golden_set_size": len(GOLDEN_SET),
        "runs": [],
        "aggregates": {},
    }

    total_latency_ms = 0
    total_tokens = 0
    total_cost = 0.0
    repetition_ratios = []
    success_count = 0

    for item in GOLDEN_SET:
        start_time = time.time()
        try:
            text = ""
            token_count = 0
            for token in connector.stream(
                item["prompt"],
                persona_id=None,
                provider=provider,
                max_tokens=200,
                temperature=0.7,
            ):
                if isinstance(token, str):
                    text += token
                    token_count += len(token.split())

            latency_ms = (time.time() - start_time) * 1000
            repetition_ratio = calculate_repetition_ratio(text)
            cost = estimate_cost(provider, token_count, model)

            results["runs"].append({
                "name": item["name"],
                "task": item["task"],
                "latency_ms": round(latency_ms, 2),
                "tokens_generated": token_count,
                "repetition_ratio": round(repetition_ratio, 3),
                "cost_estimate_usd": round(cost, 6),
                "output_preview": text[:100] + ("..." if len(text) > 100 else ""),
            })

            total_latency_ms += latency_ms
            total_tokens += token_count
            total_cost += cost
            repetition_ratios.append(repetition_ratio)
            success_count += 1

        except Exception as e:
            results["runs"].append({
                "name": item["name"],
                "task": item["task"],
                "error": str(e),
            })

    # Compute aggregates
    if success_count > 0:
        results["aggregates"] = {
            "success_rate": success_count / len(GOLDEN_SET),
            "avg_latency_ms": round(total_latency_ms / success_count, 2),
            "avg_tokens_per_prompt": round(total_tokens / success_count, 1),
            "avg_repetition_ratio": round(sum(repetition_ratios) / len(repetition_ratios), 3),
            "total_cost_estimate_usd": round(total_cost, 6),
            "throughput_tokens_per_sec": round(total_tokens / (total_latency_ms / 1000), 2) if total_latency_ms > 0 else 0,
        }

    return results


def append_to_leaderboard(result: Dict[str, Any]) -> None:
    """Append benchmark run to leaderboard JSONL."""
    with open(LEADERBOARD_PATH, "a") as f:
        f.write(json.dumps(result) + "\n")
    print(f"[benchmark] Appended result to {LEADERBOARD_PATH}")


def summarize_leaderboard() -> None:
    """Print summary of best-performing configs."""
    if not LEADERBOARD_PATH.exists():
        print("[benchmark] Leaderboard empty")
        return

    runs = []
    with open(LEADERBOARD_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    runs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    if not runs:
        print("[benchmark] No runs in leaderboard")
        return

    # Filter to successful runs
    successful = [r for r in runs if "aggregates" in r and r.get("aggregates")]

    if not successful:
        print("[benchmark] No successful runs")
        return

    # Sort by latency (fast default)
    by_latency = sorted(successful, key=lambda r: r["aggregates"]["avg_latency_ms"])

    # Sort by repetition quality
    by_repetition = sorted(successful, key=lambda r: r["aggregates"]["avg_repetition_ratio"], reverse=True)

    # Sort by cost
    by_cost = sorted(successful, key=lambda r: r["aggregates"]["total_cost_estimate_usd"])

    print("\n" + "="*80)
    print("LANTERN OS SERVING BENCHMARK LEADERBOARD")
    print("="*80)

    print("\n🚀 FASTEST (product default candidate):")
    for r in by_latency[:3]:
        agg = r["aggregates"]
        print(f"  {r['provider']:10} {r['model']:30} "
              f"latency={agg['avg_latency_ms']:6.1f}ms "
              f"repetition={agg['avg_repetition_ratio']:.3f}")

    print("\n📊 BEST DECODE QUALITY (no repetition):")
    for r in by_repetition[:3]:
        agg = r["aggregates"]
        print(f"  {r['provider']:10} {r['model']:30} "
              f"repetition={agg['avg_repetition_ratio']:.3f} "
              f"latency={agg['avg_latency_ms']:6.1f}ms")

    print("\n💰 CHEAPEST:")
    for r in by_cost[:3]:
        agg = r["aggregates"]
        if agg["total_cost_estimate_usd"] > 0:
            print(f"  {r['provider']:10} {r['model']:30} "
                  f"cost=${agg['total_cost_estimate_usd']:.6f} "
                  f"latency={agg['avg_latency_ms']:6.1f}ms")
        else:
            print(f"  {r['provider']:10} {r['model']:30} "
                  f"cost=FREE (local) "
                  f"latency={agg['avg_latency_ms']:6.1f}ms")

    print("\n" + "="*80)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run or summarize serving benchmarks")
    parser.add_argument("--run", help="Run benchmark: FORMAT provider:model (e.g., ollama:qwen2.5-coder)")
    parser.add_argument("--summarize", action="store_true", help="Summarize leaderboard")

    args = parser.parse_args()

    if args.summarize:
        summarize_leaderboard()
    elif args.run:
        parts = args.run.split(":")
        if len(parts) != 2:
            print("Usage: --run provider:model")
            sys.exit(1)
        provider, model = parts
        print(f"[benchmark] Running {provider}:{model} on golden set...")
        result = run_benchmark(provider, model)
        print(json.dumps(result, indent=2))
        append_to_leaderboard(result)
        summarize_leaderboard()
    else:
        parser.print_help()
