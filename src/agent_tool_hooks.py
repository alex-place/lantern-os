"""
Agent Tool Hooks — Lantern OS

Pre and post tool call hooks for all agents.  Enforces:
  - Logging / audit trail
  - Rate limiting
  - CSF cache read/write gates
  - Safety boundary checks
  - Retry with backoff on transient failures

Usage:
    from agent_tool_hooks import ToolHookRegistry, run_with_hooks
    registry = ToolHookRegistry()
    result = registry.run("tools/call", {"name": "queue_status", ...})
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol

logger = logging.getLogger("lantern.agent_hooks")

REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK_AUDIT_LOG = REPO_ROOT / "data" / "agent_hook_audit.jsonl"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class HookContext:
    """Context passed through every pre/post hook chain."""

    tool_name: str
    arguments: Dict[str, Any]
    agent_id: str = "default"
    request_id: str = ""
    started_at: str = field(default_factory=_now)
    ended_at: Optional[str] = None
    result: Optional[Any] = None
    error: Optional[str] = None
    cache_hit: bool = False
    csf_validated: bool = False
    retry_count: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


def _sha256_short(data: Any) -> str:
    return hashlib.sha256(json.dumps(data, default=str).encode()).hexdigest()[:16]


# Tools whose output is LIVE or side-effecting — their results must never be
# cached/replayed, otherwise the MCP surface diverges from keystone (dream) chat,
# which calls tool-runner.js directly with no result cache. Caching a file Read
# would serve stale contents after an edit; caching a policy-gated denial (from a
# non-operator call) would poison every later operator call with the same args.
_NEVER_CACHE_TOOLS = frozenset({
    # canonical filesystem / shell / mutating shared tools
    "Read", "LS", "Glob", "Grep", "Bash", "PowerShell", "Write", "Edit",
    "workspace_read", "workspace_write", "workspace_list", "recall_memory",
    "create_document", "generate_document",
    # live operational tools (state changes between calls)
    "queue_status", "get_status", "boot_check", "fleet_status", "system_status",
    "task_run", "execute_task", "worker_tick", "worker_status",
})


def _result_is_cacheable_success(result: Any) -> bool:
    """A result is cacheable only if it plainly succeeded. Denied/blocked/failed
    dicts (ok:false / status in a deny set) must never be stored or replayed."""
    if isinstance(result, dict):
        if result.get("ok") is False:
            return False
        status = str(result.get("status", "")).lower()
        if status in {"denied", "blocked", "error", "unavailable", "failed"}:
            return False
    return True


# ── Pre-hook signatures ──

class PreHook(Protocol):
    def __call__(self, ctx: HookContext) -> None: ...


class PostHook(Protocol):
    def __call__(self, ctx: HookContext) -> None: ...


# ── Built-in hooks ──

class RateLimitPreHook:
    """Simple token-bucket rate limiter per tool+agent."""

    def __init__(self, max_calls: int = 60, window_seconds: float = 60.0):
        self.max_calls = max_calls
        self.window = window_seconds
        self._buckets: Dict[str, List[float]] = {}

    def __call__(self, ctx: HookContext) -> None:
        key = f"{ctx.agent_id}:{ctx.tool_name}"
        now = time.time()
        bucket = self._buckets.get(key, [])
        bucket = [t for t in bucket if now - t < self.window]
        if len(bucket) >= self.max_calls:
            raise RuntimeError(f"Rate limit exceeded for {ctx.tool_name} ({self.max_calls}/{self.window}s)")
        bucket.append(now)
        self._buckets[key] = bucket
        ctx.metadata["rate_limit_ok"] = True


class CsfCachePreHook:
    """Before tool call: attempt CSF cache read.  If hit, short-circuit."""

    def __init__(self, cache_dir: Optional[Path] = None):
        from csf_cache_manager import CsfCacheManager
        self.cache = CsfCacheManager(cache_dir)

    def __call__(self, ctx: HookContext) -> None:
        if ctx.tool_name in _NEVER_CACHE_TOOLS:
            return
        cache_key = _sha256_short({"tool": ctx.tool_name, "args": ctx.arguments})
        hit = self.cache.get(cache_key)
        # Only replay a plainly-successful cached result. A stale denial/failure
        # must never short-circuit a fresh call (fixes operator-gate poisoning).
        if hit is not None and _result_is_cacheable_success(hit):
            ctx.result = hit
            ctx.cache_hit = True
            ctx.csf_validated = True
            logger.info("CSF cache hit for %s (key=%s)", ctx.tool_name, cache_key)


class SafetyBoundaryPreHook:
    """Block known unsafe tool/argument combos."""

    BLOCKED = {
        "shell": {"rm", "del", "format", "mkfs", "dd"},
        "file_write": {"/etc", "/boot", "C:\\Windows"},
    }

    def __call__(self, ctx: HookContext) -> None:
        for tool_pat, bad_args in self.BLOCKED.items():
            if tool_pat in ctx.tool_name.lower():
                for arg in bad_args:
                    if any(arg in str(v) for v in ctx.arguments.values()):
                        raise RuntimeError(f"Safety boundary blocked: {arg} in {ctx.tool_name}")
        ctx.metadata["safety_ok"] = True


class AuditLogPostHook:
    """Append every tool call to an append-only JSONL audit log."""

    def __call__(self, ctx: HookContext) -> None:
        entry = {
            "timestamp": _now(),
            "agent_id": ctx.agent_id,
            "request_id": ctx.request_id,
            "tool_name": ctx.tool_name,
            "args_hash": _sha256_short(ctx.arguments),
            "cache_hit": ctx.cache_hit,
            "csf_validated": ctx.csf_validated,
            "retry_count": ctx.retry_count,
            "error": ctx.error,
            "duration_ms": round(
                (time.time() - datetime.fromisoformat(ctx.started_at).timestamp()) * 1000, 2
            ) if ctx.ended_at else None,
        }
        try:
            HOOK_AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
            with open(HOOK_AUDIT_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as exc:
            logger.warning("Audit log write failed: %s", exc)


class CsfCachePostHook:
    """After tool call: write result to CSF cache if not already cached."""

    def __init__(self, cache_dir: Optional[Path] = None):
        from csf_cache_manager import CsfCacheManager
        self.cache = CsfCacheManager(cache_dir)

    def __call__(self, ctx: HookContext) -> None:
        if ctx.cache_hit or ctx.error:
            return
        if ctx.tool_name in _NEVER_CACHE_TOOLS:
            return
        # Never persist a denied/blocked/failed result — it would poison later calls.
        if not _result_is_cacheable_success(ctx.result):
            return
        cache_key = _sha256_short({"tool": ctx.tool_name, "args": ctx.arguments})
        self.cache.set(cache_key, ctx.result, agent_id=ctx.agent_id, tool_name=ctx.tool_name)
        ctx.csf_validated = True
        logger.info("CSF cache written for %s (key=%s)", ctx.tool_name, cache_key)


class RetryPostHook:
    """If the tool failed with a transient error, schedule retry metadata."""

    def __call__(self, ctx: HookContext) -> None:
        if ctx.error and ctx.retry_count < 3:
            ctx.metadata["should_retry"] = True
            ctx.metadata["retry_after_ms"] = 2 ** ctx.retry_count * 100
            ctx.retry_count += 1


# ── Registry ──

class ToolHookRegistry:
    """Central registry for pre/post hooks around agent tool calls."""

    def __init__(self, agent_id: str = "default"):
        self.agent_id = agent_id
        self.pre_hooks: List[PreHook] = []
        self.post_hooks: List[PostHook] = []
        self._install_defaults()

    def _install_defaults(self) -> None:
        self.pre_hooks = [
            RateLimitPreHook(),
            CsfCachePreHook(),
            SafetyBoundaryPreHook(),
        ]
        self.post_hooks = [
            CsfCachePostHook(),
            AuditLogPostHook(),
            RetryPostHook(),
        ]

    def add_pre(self, hook: PreHook) -> None:
        self.pre_hooks.append(hook)

    def add_post(self, hook: PostHook) -> None:
        self.post_hooks.append(hook)

    def run(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        fn: Optional[Callable[..., Any]] = None,
        request_id: Optional[str] = None,
    ) -> Any:
        """Execute the full pre → tool → post pipeline."""
        ctx = HookContext(
            tool_name=tool_name,
            arguments=arguments,
            agent_id=self.agent_id,
            request_id=request_id or _sha256_short(tool_name + _now()),
        )

        # Pre hooks
        for hook in self.pre_hooks:
            hook(ctx)
            if ctx.cache_hit and ctx.result is not None:
                # Short-circuit: cache hit
                for post in self.post_hooks:
                    post(ctx)
                return ctx.result

        # Execute tool
        if fn is not None:
            try:
                ctx.result = fn(**arguments)
            except Exception as exc:
                ctx.error = str(exc)
                logger.exception("Tool %s failed", tool_name)
        else:
            ctx.error = "No tool function provided"

        ctx.ended_at = _now()

        # Post hooks
        for hook in self.post_hooks:
            hook(ctx)

        if ctx.error and not ctx.metadata.get("should_retry"):
            raise RuntimeError(ctx.error)

        return ctx.result


# ── Convenience wrapper ──

def run_with_hooks(
    tool_name: str,
    arguments: Dict[str, Any],
    fn: Callable[..., Any],
    agent_id: str = "default",
    request_id: Optional[str] = None,
) -> Any:
    """One-shot helper."""
    registry = ToolHookRegistry(agent_id=agent_id)
    return registry.run(tool_name, arguments, fn=fn, request_id=request_id)
