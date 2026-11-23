"""LLM access for every arm: OpenEvolve's own OpenAI-compatible client, plus accounting.

Models are interchangeable: any OpenAI-compatible endpoint whose key is in the
environment works. Every call is recorded with its purpose and token counts so the arms
can be compared at equal compute. `FakeLLM` lets the whole loop run offline in tests.
"""
from __future__ import annotations

import asyncio
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional, Tuple

from openevolve.config import LLMModelConfig
from openevolve.llm.openai import OpenAILLM

ENDPOINTS = {
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY"),
    "deepseek": ("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
    "xai": ("https://api.x.ai/v1", "XAI_API_KEY"),
}

# USD per 1M tokens (input, output), list prices as checked 2026-11-05. Used only to
# report cost; token counts are the compute measure.
PRICES = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-5.4-nano": (0.20, 1.25),
    "gpt-5.4-mini": (0.75, 4.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "fake": (0.0, 0.0),
}


@dataclass
class Ledger:
    calls: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    prompt_tokens: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    completion_tokens: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    failures: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    seconds: Dict[str, float] = field(default_factory=lambda: defaultdict(float))

    def record(self, purpose: str, usage: Optional[dict], seconds: float, failed: bool) -> None:
        self.calls[purpose] += 1
        self.seconds[purpose] += seconds
        if failed:
            self.failures[purpose] += 1
        if usage:
            self.prompt_tokens[purpose] += int(usage.get("prompt_tokens", 0) or 0)
            self.completion_tokens[purpose] += int(usage.get("completion_tokens", 0) or 0)

    def totals(self, model: str) -> dict:
        pin, pout = PRICES.get(model, (float("nan"), float("nan")))
        tin = sum(self.prompt_tokens.values())
        tout = sum(self.completion_tokens.values())
        return {
            "calls": sum(self.calls.values()),
            "failures": sum(self.failures.values()),
            "prompt_tokens": tin,
            "completion_tokens": tout,
            "usd": round(tin * pin / 1e6 + tout * pout / 1e6, 4),
            "by_purpose": {p: {"calls": self.calls[p], "prompt_tokens": self.prompt_tokens[p],
                               "completion_tokens": self.completion_tokens[p],
                               "failures": self.failures[p]} for p in self.calls},
        }

    def to_dict(self) -> dict:
        return {k: dict(getattr(self, k)) for k in
                ("calls", "prompt_tokens", "completion_tokens", "failures", "seconds")}

    @classmethod
    def from_dict(cls, d: dict) -> "Ledger":
        led = cls()
        for k, v in d.items():
            getattr(led, k).update(v)
        return led


class ProviderUnavailable(RuntimeError):
    """Too many model calls in a row failed: an outage, or an account out of credit."""


class FailureBreaker:
    """Stop after `limit` failed calls in a row instead of recording empty proposals.

    One call that still fails after the client's own retries is a spent call. Eight in a
    row means the provider is down; carrying on would log a stretch of invalid proposals
    as if the improver had made them. A stopped loop resumes from its last finished
    generation (`ArmRun._load_state`).
    """

    def __init__(self, limit: int = 8):
        self.limit, self.streak = limit, 0

    def note(self, failed: bool) -> None:
        self.streak = self.streak + 1 if failed else 0
        if self.streak >= self.limit:
            raise ProviderUnavailable(f"{self.streak} model calls in a row failed")


class LLM:
    """OpenEvolve's OpenAILLM with per-purpose accounting."""

    def __init__(self, model: str, provider: str = "openai", temperature: float = 0.7,
                 max_tokens: int = 2048, ledger: Optional[Ledger] = None):
        base, env = ENDPOINTS[provider]
        cfg = LLMModelConfig(name=model, api_base=base, api_key=os.environ[env],
                             temperature=temperature, max_tokens=max_tokens, timeout=180,
                             retries=4, retry_delay=10)
        self.model = model
        self.impl = OpenAILLM(cfg)
        self.ledger = ledger or Ledger()
        self.breaker = FailureBreaker()

    async def chat(self, system: str, user: str, purpose: str, temperature: Optional[float] = None,
                   max_tokens: Optional[int] = None) -> Tuple[Optional[str], Optional[dict]]:
        kwargs = {}
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        t0 = time.time()
        self.impl.last_usage = None
        try:
            text = await self.impl.generate_with_context(
                system_message=system, messages=[{"role": "user", "content": user}], **kwargs)
        except Exception:  # noqa: BLE001  (retries exhausted: count it, move on)
            self.ledger.record(purpose, self.impl.last_usage, time.time() - t0, failed=True)
            self.breaker.note(True)
            return None, None
        usage = self.impl.last_usage
        self.ledger.record(purpose, usage, time.time() - t0, failed=text is None)
        self.breaker.note(text is None)
        return text, usage


class FakeLLM:
    """Offline stand-in: `script(system, user, purpose, temperature)` returns the reply."""

    def __init__(self, script: Callable[[str, str, str, Optional[float]], str],
                 ledger: Optional[Ledger] = None):
        self.model = "fake"
        self.script = script
        self.ledger = ledger or Ledger()
        self.breaker = FailureBreaker()

    async def chat(self, system: str, user: str, purpose: str, temperature: Optional[float] = None,
                   max_tokens: Optional[int] = None):
        await asyncio.sleep(0)
        text = self.script(system, user, purpose, temperature)
        usage = {"prompt_tokens": (len(system) + len(user)) // 4,
                 "completion_tokens": len(text or "") // 4}
        self.ledger.record(purpose, usage, 0.0, failed=text is None)
        self.breaker.note(text is None)
        return text, usage
