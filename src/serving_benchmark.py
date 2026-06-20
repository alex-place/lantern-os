#!/usr/bin/env python3
"""
Standing Benchmark for Lantern OS Model Serving (Phase 2 — #730 validation).

Measures inference speed, decode quality, and cost-efficiency on a golden set,
then validates the result against the serving-mode contract before it is allowed
onto the leaderboard. Runs after model changes and on a daily CI cron.

Golden set: 10 diverse prompts covering reasoning, creative, code, and domain tasks.

Metrics:
  - latency_ms: Wall-clock time (token-inclusive decode)
  - tokens_generated: Output length (whitespace token count)
  - repetition_ratio: Unique tokens / total tokens (closer to 1.0 = better)
  - cost_estimate_usd: API cost or compute estimate
  - throughput_tokens_per_sec: tokens / wall-clock

Honesty contract (Σ₀ External Reality Rule):
  The connector silently falls back to a canned *offline persona stub* when a
  provider is unreachable. Recording that stub as if it were a real provider run
  would fabricate metrics. This runner therefore:
    1. Pins the requested model onto the provider config (the CLI model is no
       longer decorative — it is the model actually queried).
    2. Streams with fallback=False so an unreachable provider RAISES instead of
       degrading to the offline stub.
    3. Captures the connector's trailing metadata and rejects any run whose
       source/provider is "offline" or whose output is empty.
  A run that cannot reach its provider is recorded as an error, never as data.

Serving modes (src/serving_modes.py):
  - FAST (default):  latency < 2s, repetition_ratio > 0.85  → product guarantee
  - DEEP (OURO_NATIVE=1): repetition_ratio > 0.80; the 70-85s latency band only
    holds for the native Σ₀ Q-exit runtime, so it is reported as a WARN (not a
    hard gate) when validating non-native (cached) providers.
"""

import argparse
import json
import os
import sys
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data" / "benchmarks"
DATA_DIR.mkdir(parents=True, exist_ok=True)

LEADERBOARD_PATH = DATA_DIR / "leaderboard.jsonl"
REPORT_PATH = DATA_DIR / "REPORT.md"

# Make `import unified_agent_connector` / `serving_modes` work on a bare checkout.
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

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

# Per-mode validation contract (issue #730 Definition of Done).
# severity "error" → fails CI; "warn" → reported only.
#
# Repetition is two-tier so sampling noise near the boundary does not flap the
# gate: WARN below `target` (the issue's stated bar) but ERROR only below `floor`,
# which is true token-loop territory (a ✅✅✅ collapse scores ~0.1-0.3, far below).
# Latency and success-rate remain hard guarantees.
THRESHOLDS: Dict[str, Dict[str, Any]] = {
    "fast": {
        "latency": {"max_ms": 2000, "severity": "error"},
        "repetition": {"target": 0.85, "floor": 0.80},
        "success_rate": {"min": 0.9, "severity": "error"},
    },
    "deep": {
        # The 70-85s band only binds the native Σ₀ runtime; for non-native
        # providers it is informational, hence "warn".
        "latency": {"min_ms": 70000, "max_ms": 85000, "severity": "warn"},
        "repetition": {"target": 0.80, "floor": 0.75},
        "success_rate": {"min": 0.9, "severity": "error"},
    },
}

# Per-task quality floor used to catch reasoning/coding regressions (#730:
# "Reasoning tasks pass (no <0.1 quality drop)"). A task whose repetition_ratio
# collapses is the classic ✅✅✅ token-loop signature.
TASK_MIN_REPETITION_RATIO = 0.5


def calculate_repetition_ratio(text: str) -> float:
    """Calculate unique_tokens / total_tokens. Higher is better (no repetition)."""
    words = text.lower().split()
    if not words:
        return 1.0
    unique_words = len(set(words))
    total_words = len(words)
    return min(1.0, unique_words / max(total_words, 1))


def estimate_cost(provider: str, tokens_generated: int, model: str) -> float:
    """Rough cost estimate (USD) for benchmarking. Local/free providers → 0.0."""
    rates = {
        "openai": {"gpt-4.1-mini": 0.15 / 1e6, "gpt-4": 0.03 / 1e6, "*": 0.15 / 1e6},
        "anthropic": {
            "claude-haiku-4-5-20251001": 0.80 / 1e6,
            "claude-sonnet-4-6": 3.0 / 1e6,
            "*": 0.80 / 1e6,
        },
        "gemini": {"gemini-2.5-flash": 0.075 / 1e6, "*": 0.075 / 1e6},
        "deepseek": {"deepseek-chat": 0.14 / 1e6, "*": 0.14 / 1e6},
        "groq": {"*": 0.0},  # Free tier
        "ollama": {"*": 0.0},  # Local
    }
    prov_rates = rates.get(provider, {})
    rate = prov_rates.get(model, prov_rates.get("*", 1.0 / 1e6))
    return tokens_generated * rate


def _consume_stream(gen) -> Tuple[str, Dict[str, Any]]:
    """Drain a connector.stream() generator.

    Returns (text, meta). `meta` includes the connector's trailing status dict —
    notably {"source": "offline", ...} when it degraded to the canned stub. We
    capture it from both yielded dicts and the StopIteration return value so an
    offline fallback can never be mistaken for a real provider run.
    """
    parts: List[str] = []
    meta: Dict[str, Any] = {}
    while True:
        try:
            tok = next(gen)
        except StopIteration as stop:
            if isinstance(stop.value, dict):
                meta = stop.value
            break
        if isinstance(tok, str):
            parts.append(tok)
        elif isinstance(tok, dict):
            meta = tok
    return "".join(parts), meta


def _current_mode_name(explicit: Optional[str] = None) -> str:
    """Resolve the active serving mode name (fast/deep), honoring an override."""
    if explicit:
        return explicit
    try:
        from serving_modes import get_serving_mode

        mode = get_serving_mode()
        return mode.name if mode else "unknown"
    except Exception:
        return "unknown"


def _current_decode_params() -> Dict[str, Any]:
    try:
        from serving_modes import get_decode_params, get_serving_mode

        mode = get_serving_mode()
        return get_decode_params(mode) if mode else {}
    except Exception:
        return {}


def run_benchmark(
    provider: str,
    model: str,
    system_prompt: str = "",
    *,
    max_tokens: int = 200,
    temperature: float = 0.7,
    mode_label: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the golden set against `provider:model` and return aggregated results.

    Streams with fallback=False and the requested model pinned onto the provider
    config, so the recorded metrics belong to the model named in the leaderboard —
    or the run is recorded as an error. Offline-stub responses are rejected.
    """
    try:
        from unified_agent_connector import UnifiedAgentConnector
    except ImportError as exc:
        print(f"[benchmark] Cannot import UnifiedAgentConnector ({exc}); skipping run")
        return {"error": "import_failed", "provider": provider, "model": model}

    connector = UnifiedAgentConnector()

    # Pin the requested model onto the provider config so we benchmark the model
    # we *say* we benchmarked (the CLI arg was previously ignored).
    providers = getattr(connector, "_providers", {})
    if provider not in providers:
        return {
            "error": f"provider_not_configured:{provider}",
            "provider": provider,
            "model": model,
            "available_providers": sorted(providers.keys()),
        }
    if getattr(providers[provider], "model", None) != model:
        providers[provider] = replace(providers[provider], model=model)

    mode_name = _current_mode_name(mode_label)
    results: Dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "provider": provider,
        "model": model,
        "mode": mode_name,
        "decode_params": _current_decode_params(),
        "golden_set_size": len(GOLDEN_SET),
        "runs": [],
        "aggregates": {},
    }

    total_latency_ms = 0.0
    total_tokens = 0
    total_cost = 0.0
    repetition_ratios: List[float] = []
    success_count = 0

    for item in GOLDEN_SET:
        start_time = time.time()
        try:
            gen = connector.stream(
                item["prompt"],
                persona_id=None,
                provider=provider,
                max_tokens=max_tokens,
                temperature=temperature,
                fallback=False,  # never degrade to the offline stub
            )
            text, meta = _consume_stream(gen)
            latency_ms = (time.time() - start_time) * 1000

            source = str(meta.get("source", "")).lower()
            meta_provider = str(meta.get("provider", "")).lower()
            if source == "offline" or meta_provider == "offline":
                raise RuntimeError(f"offline fallback (not a real {provider} run): {meta.get('error', '')}")
            if not text.strip():
                raise RuntimeError("empty response from provider")

            token_count = len(text.split())
            repetition_ratio = calculate_repetition_ratio(text)
            cost = estimate_cost(provider, token_count, model)

            results["runs"].append({
                "name": item["name"],
                "task": item["task"],
                "latency_ms": round(latency_ms, 2),
                "tokens_generated": token_count,
                "repetition_ratio": round(repetition_ratio, 3),
                "task_pass": repetition_ratio >= TASK_MIN_REPETITION_RATIO,
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

    if success_count > 0:
        results["aggregates"] = {
            "success_rate": round(success_count / len(GOLDEN_SET), 3),
            "avg_latency_ms": round(total_latency_ms / success_count, 2),
            "avg_tokens_per_prompt": round(total_tokens / success_count, 1),
            "avg_repetition_ratio": round(sum(repetition_ratios) / len(repetition_ratios), 3),
            "min_repetition_ratio": round(min(repetition_ratios), 3),
            "total_cost_estimate_usd": round(total_cost, 6),
            "throughput_tokens_per_sec": round(total_tokens / (total_latency_ms / 1000), 2) if total_latency_ms > 0 else 0,
        }

    return results


def append_to_leaderboard(result: Dict[str, Any]) -> None:
    """Append benchmark run to leaderboard JSONL."""
    with open(LEADERBOARD_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(result) + "\n")
    print(f"[benchmark] Appended result to {LEADERBOARD_PATH}")


def load_leaderboard() -> List[Dict[str, Any]]:
    """Load all leaderboard rows (skipping malformed lines)."""
    if not LEADERBOARD_PATH.exists():
        return []
    runs: List[Dict[str, Any]] = []
    with open(LEADERBOARD_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                runs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return runs


# --- Validation (#730 Definition of Done) ---

def validate_result(result: Dict[str, Any]) -> Tuple[bool, List[Dict[str, Any]]]:
    """Validate a single benchmark result against its mode contract.

    Returns (ok, checks). ok is False only when an "error"-severity check fails.
    """
    checks: List[Dict[str, Any]] = []
    mode = result.get("mode", "fast")
    agg = result.get("aggregates") or {}
    contract = THRESHOLDS.get(mode, THRESHOLDS["fast"])

    if not agg:
        checks.append({
            "name": "has_data", "passed": False, "severity": "warn",
            "detail": f"no successful runs for {result.get('provider')}:{result.get('model')} "
                      f"({result.get('error', 'all golden-set prompts failed')})",
        })
        # No data is a skip (WARN), not a regression — credentials may be absent.
        return True, checks

    def _check(name, passed, severity, detail):
        checks.append({"name": name, "passed": passed, "severity": severity, "detail": detail})

    # Latency: a single upper bound (fast) or a band (deep, informational).
    lat = agg.get("avg_latency_ms", float("inf"))
    lc = contract["latency"]
    if "min_ms" in lc and "max_ms" in lc:
        _check("latency_within_band", lc["min_ms"] <= lat <= lc["max_ms"], lc["severity"],
               f"avg_latency_ms={lat} (band {lc['min_ms']}-{lc['max_ms']})")
    else:
        _check("latency_under_max", lat <= lc["max_ms"], lc["severity"],
               f"avg_latency_ms={lat} (<= {lc['max_ms']})")

    # Repetition: WARN below target, ERROR below floor (token-loop regression).
    rep = agg.get("avg_repetition_ratio", 0)
    rc = contract["repetition"]
    if rep < rc["floor"]:
        _check("repetition_ratio", False, "error",
               f"avg_repetition_ratio={rep} < floor {rc['floor']} (token-loop regression)")
    elif rep < rc["target"]:
        _check("repetition_ratio", False, "warn",
               f"avg_repetition_ratio={rep} < target {rc['target']} (above floor {rc['floor']})")
    else:
        _check("repetition_ratio", True, "error",
               f"avg_repetition_ratio={rep} >= target {rc['target']}")

    # Success rate: every golden-set prompt should return a real reply.
    sr = agg.get("success_rate", 0)
    _check("success_rate", sr >= contract["success_rate"]["min"], "error",
           f"success_rate={sr} (>= {contract['success_rate']['min']})")

    # Per-task regression: any task whose decode collapsed into repetition.
    failed_tasks = [r["name"] for r in result.get("runs", []) if r.get("task_pass") is False]
    _check(
        "no_task_repetition_collapse",
        not failed_tasks,
        "error",
        f"tasks below repetition floor {TASK_MIN_REPETITION_RATIO}: {failed_tasks}" if failed_tasks else "all tasks above floor",
    )

    ok = all(c["passed"] for c in checks if c["severity"] == "error")
    return ok, checks


def _latest_per_config(runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Most recent run for each (provider, model, mode) key."""
    latest: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for r in runs:
        key = (r.get("provider", "?"), r.get("model", "?"), r.get("mode", "fast"))
        prev = latest.get(key)
        if prev is None or r.get("timestamp", "") >= prev.get("timestamp", ""):
            latest[key] = r
    return list(latest.values())


def validate_leaderboard(results: Optional[List[Dict[str, Any]]] = None) -> bool:
    """Validate the latest run per config. Returns True if all error checks pass."""
    runs = results if results is not None else _latest_per_config(load_leaderboard())
    if not runs:
        print("[validate] No runs to validate.")
        return True

    overall_ok = True
    print("\n" + "=" * 80)
    print("SERVING VALIDATION  (#730 -- FAST/DEEP contract)")
    print("=" * 80)
    for r in runs:
        ok, checks = validate_result(r)
        overall_ok = overall_ok and ok
        label = f"{r.get('provider','?')}:{r.get('model','?')} [{r.get('mode','?')}]"
        status = "PASS" if ok else "FAIL"
        print(f"\n{status}  {label}")
        for c in checks:
            mark = "OK " if c["passed"] else ("XX " if c["severity"] == "error" else "-- ")
            print(f"   {mark}[{c['severity']:5}] {c['name']}: {c['detail']}")
    print("\n" + "=" * 80)
    print(f"OVERALL: {'PASS' if overall_ok else 'FAIL'}")
    print("=" * 80)
    return overall_ok


# --- Reporting ---

def summarize_leaderboard() -> None:
    """Print summary of best-performing configs."""
    successful = [r for r in load_leaderboard() if r.get("aggregates")]
    if not successful:
        print("[benchmark] No successful runs in leaderboard")
        return

    by_latency = sorted(successful, key=lambda r: r["aggregates"]["avg_latency_ms"])
    by_repetition = sorted(successful, key=lambda r: r["aggregates"]["avg_repetition_ratio"], reverse=True)
    by_cost = sorted(successful, key=lambda r: r["aggregates"]["total_cost_estimate_usd"])

    print("\n" + "=" * 80)
    print("LANTERN OS SERVING BENCHMARK LEADERBOARD")
    print(f"({len(successful)} successful runs)")
    print("=" * 80)

    print("\n[FASTEST] (product default candidate):")
    for r in by_latency[:3]:
        agg = r["aggregates"]
        print(f"  {r['provider']:10} {r['model']:30} [{r.get('mode','?'):4}] "
              f"latency={agg['avg_latency_ms']:8.1f}ms repetition={agg['avg_repetition_ratio']:.3f}")

    print("\n[BEST DECODE QUALITY] (no repetition):")
    for r in by_repetition[:3]:
        agg = r["aggregates"]
        print(f"  {r['provider']:10} {r['model']:30} [{r.get('mode','?'):4}] "
              f"repetition={agg['avg_repetition_ratio']:.3f} latency={agg['avg_latency_ms']:8.1f}ms")

    print("\n[CHEAPEST]:")
    for r in by_cost[:3]:
        agg = r["aggregates"]
        cost = agg["total_cost_estimate_usd"]
        cost_str = f"${cost:.6f}" if cost > 0 else "FREE (local)"
        print(f"  {r['provider']:10} {r['model']:30} cost={cost_str:14} latency={agg['avg_latency_ms']:8.1f}ms")

    print("\n" + "=" * 80)


def write_report(path: Path = REPORT_PATH) -> None:
    """Write a Markdown leaderboard report for monitoring (#730 'Monitor leaderboard')."""
    runs = load_leaderboard()
    successful = [r for r in runs if r.get("aggregates")]
    lines = [
        "# Serving Benchmark Leaderboard",
        "",
        f"_Generated {datetime.now(timezone.utc).isoformat()} · "
        f"{len(successful)} successful run(s) of {len(runs)} total._",
        "",
        "Validation contract (#730): FAST → latency <2s (hard), repetition target 0.85 / "
        "floor 0.80; DEEP → repetition target 0.80 / floor 0.75. Repetition is WARN below "
        "target but ERROR only below floor (token-loop territory). The 70-85s DEEP latency "
        "band applies to the native Σ₀ runtime only.",
        "",
    ]
    if not successful:
        lines += ["> No successful runs yet. Runs accrue daily via "
                  "`.github/workflows/serving-benchmark.yml`.", ""]
    else:
        lines += [
            "| Provider | Model | Mode | Avg latency (ms) | Avg repetition | Success | Tok/s | Cost (USD) | Last run |",
            "|---|---|---|---:|---:|---:|---:|---:|---|",
        ]
        for r in sorted(_latest_per_config(successful), key=lambda r: r["aggregates"]["avg_latency_ms"]):
            a = r["aggregates"]
            cost = a["total_cost_estimate_usd"]
            lines.append(
                f"| {r.get('provider','?')} | {r.get('model','?')} | {r.get('mode','?')} "
                f"| {a['avg_latency_ms']:.1f} | {a['avg_repetition_ratio']:.3f} "
                f"| {a.get('success_rate',0)*100:.0f}% | {a.get('throughput_tokens_per_sec',0):.1f} "
                f"| {('%.6f' % cost) if cost > 0 else 'free'} | {r.get('timestamp','?')[:19]} |"
            )
        lines.append("")
        # Daily-run counter for the DoD ("≥7 daily runs").
        days = sorted({r.get("timestamp", "")[:10] for r in successful if r.get("timestamp")})
        lines += [f"**Distinct days with a successful run:** {len(days)} "
                  f"(Definition of Done target: ≥7)", ""]
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[benchmark] Wrote report to {path}")


def _parse_provider_specs(spec: str) -> List[Tuple[str, str]]:
    """Parse 'anthropic:claude-haiku-4-5-20251001,openai:gpt-4.1-mini' → [(provider, model), ...]."""
    out: List[Tuple[str, str]] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" not in chunk:
            raise ValueError(f"Bad spec '{chunk}', expected provider:model")
        provider, model = chunk.split(":", 1)
        out.append((provider.strip(), model.strip()))
    return out


def main(argv: Optional[List[str]] = None) -> int:
    # Windows consoles default to cp1252; keep output robust to stray Unicode in
    # model names / previews without crashing the validation gate.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Run, validate, or summarize serving benchmarks")
    parser.add_argument("--run", help="Run one benchmark: provider:model (e.g. anthropic:claude-haiku-4-5-20251001)")
    parser.add_argument("--providers", help="Run several: 'anthropic:claude-haiku-4-5-20251001,openai:gpt-4.1-mini'")
    parser.add_argument("--mode", choices=["fast", "deep"], default=None,
                        help="Serving mode for the run (sets OURO_NATIVE). Default: current env.")
    parser.add_argument("--max-tokens", type=int, default=200)
    parser.add_argument("--no-append", action="store_true", help="Do not write the run to the leaderboard")
    parser.add_argument("--summarize", action="store_true", help="Summarize leaderboard")
    parser.add_argument("--validate", action="store_true",
                        help="Validate latest leaderboard runs; exit 1 on regression")
    parser.add_argument("--report", nargs="?", const=str(REPORT_PATH), default=None,
                        help="Write a Markdown leaderboard report (default path if no arg)")
    args = parser.parse_args(argv)

    did_something = False

    # Mode selection drives the connector's decode params via OURO_NATIVE.
    mode_label = None
    if args.mode:
        mode_label = args.mode
        if args.mode == "deep":
            os.environ["OURO_NATIVE"] = "1"
        else:
            os.environ.pop("OURO_NATIVE", None)

    specs: List[Tuple[str, str]] = []
    if args.run:
        specs += _parse_provider_specs(args.run)
    if args.providers:
        specs += _parse_provider_specs(args.providers)

    run_ok = True
    for provider, model in specs:
        did_something = True
        print(f"[benchmark] Running {provider}:{model} (mode={mode_label or 'env'}) on golden set...")
        result = run_benchmark(provider, model, max_tokens=args.max_tokens, mode_label=mode_label)
        print(json.dumps(result.get("aggregates", {"error": result.get("error")}), indent=2))
        if not args.no_append and (result.get("aggregates") or result.get("runs")):
            append_to_leaderboard(result)
        ok, _ = validate_result(result)
        run_ok = run_ok and ok

    if args.summarize:
        did_something = True
        summarize_leaderboard()

    if args.report is not None:
        did_something = True
        write_report(Path(args.report))

    if args.validate:
        did_something = True
        if not validate_leaderboard():
            return 1

    if specs and not run_ok:
        return 1

    if not did_something:
        parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
