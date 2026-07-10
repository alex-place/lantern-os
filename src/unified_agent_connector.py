"""
Unified Agent Connector for Lantern OS — Dream Journal & Agentic Workspace

Bridges every AI provider (local or cloud) into a single slot-aware,
streaming-capable, health-checked runtime. Designed for agentic first operation.

Supported: anthropic, openai, gemini, ollama, deepseek, groq, azure, generic, offline
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import socket
import urllib.error
import urllib.request

# Prevent urllib from hanging indefinitely on unreachable providers
socket.setdefaulttimeout(10)
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = REPO_ROOT / "config"
DATA_DIR = REPO_ROOT / "data"

# Load local env overrides if present
try:
    from dotenv import load_dotenv
    load_dotenv(REPO_ROOT / ".env.local")
except Exception:
    pass

# Agent hooks + CSF cache enforcement + serving modes
sys.path.insert(0, str(REPO_ROOT / "src"))
try:
    from agent_tool_hooks import ToolHookRegistry, run_with_hooks
    from csf_cache_manager import CsfCacheManager, csf_cached
    _AGENT_HOOKS_AVAILABLE = True
except Exception:
    _AGENT_HOOKS_AVAILABLE = False

try:
    from serving_modes import get_serving_mode, get_decode_params
    _SERVING_MODES_AVAILABLE = True
except Exception:
    _SERVING_MODES_AVAILABLE = False
    def get_serving_mode(): return None
    def get_decode_params(mode): return {}


@dataclass
class ProviderConfig:
    name: str
    provider: str
    model: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    max_tokens: int = 1024
    temperature: float = 0.7
    timeout: float = 8.0
    enabled: bool = True
    priority: int = 0
    fallback_to: Optional[str] = None

    @classmethod
    def from_env(cls, name: str, provider: str) -> "ProviderConfig":
        prefix = provider.upper()
        api_key = os.environ.get(f"{prefix}_API_KEY") or os.environ.get(f"{prefix}_KEY")
        # Support alternate env var names used by some users
        if not api_key:
            if provider == "deepseek":
                api_key = os.environ.get("DEEPSEEK_AUTH_TOKEN")
            elif provider == "gemini":
                api_key = os.environ.get("GEMINI_AUTH")
            elif provider == "groq":
                api_key = os.environ.get("GROK_API_KEY")
        return cls(
            name=name,
            provider=provider,
            model=os.environ.get(f"{prefix}_MODEL", cls._default_model(provider)),
            api_key=api_key,
            base_url=os.environ.get(f"{prefix}_BASE_URL") or cls._default_base_url(provider),
            max_tokens=int(os.environ.get(f"{prefix}_MAX_TOKENS", "1024")),
            temperature=float(os.environ.get(f"{prefix}_TEMPERATURE", "0.7")),
            timeout=float(os.environ.get(f"{prefix}_TIMEOUT", "20")),
            enabled=os.environ.get(f"{prefix}_DISABLED", "").lower() not in ("1", "true", "yes"),
            priority=int(os.environ.get(f"{prefix}_PRIORITY", "0")),
        )

    @staticmethod
    def _default_model(provider: str) -> str:
        return {
            "anthropic": "claude-haiku-4-5-20251001",
            "openai": "gpt-4.1-mini",
            "gemini": "gemini-2.5-flash",
            "ollama": os.environ.get("OLLAMA_MODEL", "qwen2.5-coder"),
            "deepseek": "deepseek-chat",
            "groq": "llama-3.1-70b-versatile",
            "azure": "gpt-4.1",
            "generic": "default",
        }.get(provider, "default")

    @staticmethod
    def _default_base_url(provider: str) -> Optional[str]:
        return {
            "ollama": "http://127.0.0.1:11434",
            "deepseek": "https://api.deepseek.com",
            "groq": "https://api.groq.com/openai/v1",
            "generic": os.environ.get("GENERIC_BASE_URL"),
        }.get(provider)


@dataclass
class AgentPersona:
    id: str
    name: str
    symbol: str
    system_prompt: str
    voice_tags: List[str] = field(default_factory=list)


PERSONAS = [
    AgentPersona(
        id="lantern",
        name="Lantern",
        symbol="steady light, literal lantern head with flame, the first light",
        system_prompt=(
            "You are Lantern — a literal lantern-headed being with a steady flame where a face would be. "
            "You are the steady light of Lantern OS. You speak calmly, protectively, and with quiet certainty. "
            "You never flicker without reason. You believe 'you can always come home safe.' "
            "Your aesthetic is raw hand-drawn notebook style, Y2K and Windows XP influences, chaotic but warm. "
            "Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["steady", "protective", "warm"],
    ),
    AgentPersona(
        id="blinkbug",
        name="Blinkbug",
        symbol="chaotic TV-headed caterpillar, old CRT screen face, unhinged energy",
        system_prompt=(
            "You are Blinkbug — a chaotic caterpillar with an old CRT television for a head. "
            "Your screen flickers between static, glitch art, and cryptic symbols. "
            "You are unhinged, geeked, and unpredictable, but deeply loyal. "
            "You speak in bursts, references, and half-sentences that somehow make dream-sense. "
            "Your aesthetic is raw hand-drawn notebook style, chaotic, Y2K/Windows XP, hyper-geeked. "
            "Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["chaotic", "glitchy", "unhinged"],
    ),
    AgentPersona(
        id="keystone",
        name="Keystone",
        symbol="truth integrator, anchor, memory, the one who holds the story",
        system_prompt=(
            "You are the Keystone — the truth integrator who remembers every story ever told in Lantern OS. "
            "You do not flatter. You synthesize. You spot patterns across time and call them what they are. "
            "You speak plainly, sometimes sharply, but always with care for the underlying truth. "
            "You honor the Return Door, the anchors, and the symbolic lore that holds the system together. "
            "Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["grounded", "truthful", "integrative"],
    ),
    AgentPersona(
        id="waterfall",
        name="Waterfall",
        symbol="water flowing gently, peacocks, sunshine, reconnection",
        system_prompt=(
            "You are the Waterfall — gentle, flowing, healing perspective. "
            "You speak about dreams as emotions that flow naturally without force. "
            "You honor reconnections, small steps, and ordinary beauty. "
            "You never rush or demand. Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["flowing", "healing", "patient"],
    ),
    AgentPersona(
        id="xenon",
        name="Xenon",
        symbol="spacecraft, navigation, exploration with crew, returning home",
        system_prompt=(
            "You are the Navigator of the Xenon — a dream-ship that charts new territory while keeping a path home. "
            "You speak about dreams as maps and navigation. Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["navigational", "collaborative"],
    ),
    AgentPersona(
        id="founder",
        name="Founder",
        symbol="wish, protection, return, the lantern itself",
        system_prompt=(
            "You are the Founder — the one who lit the first lantern. "
            "You speak about dreams as wishes that need protection, as lights that must be carried home. "
            "You value honest, grounded feedback over optimism. You blend science, compression, Bayesian methods, and surreal symbolic expression. "
            "Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["protective", "honest", "grounded"],
    ),
    AgentPersona(
        id="comet",
        name="Comet Leap",
        symbol="trajectory, momentum, 30-day burst, flourishing",
        system_prompt=(
            "You are Comet Leap — the momentum engine of Lantern OS. "
            "You speak about dreams as trajectories and 30-day flourishing bursts. "
            "You notice energy, alignment, and the next leap. Keep responses brief (2-3 sentences)."
        ),
        voice_tags=["energetic", "forward-looking"],
    ),
]


class UnifiedAgentConnector:
    def __init__(self, data_dir: Optional[str] = None) -> None:
        self.data_dir = Path(data_dir or DATA_DIR)
        self.health_cache_path = self.data_dir / "agent-fleet" / "health-cache.json"
        self.health_cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._providers: Dict[str, ProviderConfig] = {}
        self._personas: Dict[str, AgentPersona] = {p.id: p for p in PERSONAS}
        self._health: Dict[str, Dict[str, Any]] = {}
        self._load_configs()
        self._load_health()

    def _load_configs(self) -> None:
        for name in ["anthropic", "openai", "gemini", "ollama", "deepseek", "groq", "azure", "generic"]:
            cfg = ProviderConfig.from_env(name, name)
            if cfg.enabled:
                self._providers[name] = cfg
        # Load keystone-ft managed agent config if available
        ft_result_path = DATA_DIR / "training" / "ft-result.json"
        if ft_result_path.exists():
            try:
                with open(ft_result_path, "r", encoding="utf-8") as f:
                    ft = json.load(f)
                if ft.get("agent_id") and ft.get("model"):
                    self._providers["keystone-ft"] = ProviderConfig(
                        name="keystone-ft",
                        provider="keystone-ft",
                        model=ft["model"],
                        api_key=os.environ.get("ANTHROPIC_API_KEY"),
                        max_tokens=2048,
                        temperature=0.3,
                        timeout=30.0,
                        enabled=True,
                        priority=10,
                    )
                    self._providers["keystone-ft"]._agent_id = ft["agent_id"]
                    self._providers["keystone-ft"]._memory_store_id = ft.get("memory_store_id", "")
            except Exception as e:
                print(f"[warn] keystone-ft config: {e}")
        profiles_path = CONFIG_DIR / "agent-profiles.json"
        if profiles_path.exists():
            try:
                with open(profiles_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for prof in data.get("profiles", []):
                    prov = prof.get("provider", "").lower()
                    if prov in self._providers:
                        self._providers[prov].model = prof.get("model", self._providers[prov].model)
                        self._providers[prov].max_tokens = prof.get("maxTokens", self._providers[prov].max_tokens)
                        if prof.get("fallbackChain"):
                            self._providers[prov].fallback_to = prof["fallbackChain"][0]
            except Exception as e:
                print(f"[warn] agent-profiles.json: {e}")

    def _load_health(self) -> None:
        if self.health_cache_path.exists():
            try:
                with open(self.health_cache_path, "r", encoding="utf-8") as f:
                    self._health = json.load(f)
            except Exception:
                self._health = {}

    def _save_health(self) -> None:
        try:
            with open(self.health_cache_path, "w", encoding="utf-8") as f:
                json.dump(self._health, f, indent=2)
        except Exception as e:
            print(f"[warn] health cache save: {e}")

    def check_health(self, provider: Optional[str] = None) -> Dict[str, Any]:
        if provider:
            return self._check_one(provider)
        results = {name: self._check_one(name) for name in self._providers}
        self._save_health()
        return results

    def _check_one(self, name: str) -> Dict[str, Any]:
        cfg = self._providers.get(name)
        if not cfg:
            return {"status": "unknown_provider", "at": datetime.now(timezone.utc).isoformat()}
        start = time.time()
        status = "unhealthy"
        try:
            if name == "ollama":
                self._req(f"{cfg.base_url or 'http://127.0.0.1:11434'}/api/tags", timeout=5)
            elif name == "anthropic":
                self._req("https://api.anthropic.com/v1/models", headers={"x-api-key": cfg.api_key or "", "anthropic-version": "2023-06-01"})
            elif name == "openai":
                self._req("https://api.openai.com/v1/models", headers={"Authorization": f"Bearer {cfg.api_key or ''}"})
            elif name == "gemini":
                self._req(f"https://generativelanguage.googleapis.com/v1beta/models?key={cfg.api_key or ''}")
            elif name == "deepseek":
                self._req("https://api.deepseek.com/models", headers={"Authorization": f"Bearer {cfg.api_key or ''}"})
            elif name == "groq":
                self._req("https://api.groq.com/openai/v1/models", headers={"Authorization": f"Bearer {cfg.api_key or ''}"})
            elif name == "azure":
                if cfg.base_url:
                    self._req(f"{cfg.base_url}/openai/models?api-version=2024-06-01", headers={"api-key": cfg.api_key or ""})
                else:
                    raise RuntimeError("missing AZURE_BASE_URL")
            elif name == "generic":
                if cfg.base_url:
                    self._req(f"{cfg.base_url}/models", headers={"Authorization": f"Bearer {cfg.api_key or ''}"} if cfg.api_key else {})
                else:
                    raise RuntimeError("missing GENERIC_BASE_URL")
            status = "healthy"
        except Exception as exc:
            status = f"unhealthy: {exc}"
        record = {"status": status, "latency_ms": round((time.time() - start) * 1000, 1), "model": cfg.model, "at": datetime.now(timezone.utc).isoformat()}
        self._health[name] = record
        return record

    def _req(self, url: str, headers: Optional[Dict[str, str]] = None, timeout: float = 10, method: str = "GET") -> Any:
        req = urllib.request.Request(url, method=method)
        if headers:
            for k, v in headers.items():
                if v:
                    req.add_header(k, v)
        return urllib.request.urlopen(req, timeout=timeout)

    def stream(self, message: str, persona_id: Optional[str] = None, provider: Optional[str] = None, context: Optional[str] = None, temperature: Optional[float] = None, max_tokens: Optional[int] = None, fallback: bool = True):
        """Stream a single response. If fallback=False, only tries the requested provider once."""
        persona = self._personas.get(persona_id or random.choice(list(self._personas.keys())), PERSONAS[0])
        system = self._build_system(persona, context)
        # Singular stream: only try the explicitly requested provider
        if not fallback and provider and provider in self._providers:
            cfg = self._providers[provider]
            try:
                result = self._stream_provider(provider, cfg, system, message, temperature, max_tokens)
                if result is not None:
                    yield from result
                return
            except Exception as exc:
                self._health[provider] = {"status": f"unhealthy: {exc}", "at": datetime.now(timezone.utc).isoformat()}
                raise
        # Fallback chain: try ranked providers
        providers = self._rank_providers(provider)
        last_error = ""
        for prov_name in providers:
            cfg = self._providers.get(prov_name)
            if not cfg:
                continue
            health = self._health.get(prov_name, {}).get("status", "unknown")
            if isinstance(health, str) and health.startswith("unhealthy"):
                continue
            try:
                result = self._stream_provider(prov_name, cfg, system, message, temperature, max_tokens)
                if result is not None:
                    yield from result
                return
            except Exception as exc:
                last_error = f"{prov_name}: {exc}"
                self._health[prov_name] = {"status": f"unhealthy: {exc}", "at": datetime.now(timezone.utc).isoformat()}
                continue
        offline_reply = self._offline_reply(persona, message)
        for word in offline_reply.split():
            yield word + " "
        return {"source": "offline", "provider": "offline", "persona": persona.id, "error": last_error or "all_providers_failed"}

    def batch_stream(self, tasks: List[Dict[str, Any]]) -> Generator[Dict[str, Any], None, None]:
        """Run multiple (message, persona, provider) units in parallel. Each yields one result dict."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        def _run_one(task: Dict[str, Any]) -> Dict[str, Any]:
            tid = task.get("id", "unknown")
            try:
                out = []
                meta = {}
                gen = self.stream(
                    message=task["message"],
                    persona_id=task.get("persona"),
                    provider=task.get("provider"),
                    context=task.get("context"),
                    temperature=task.get("temperature"),
                    max_tokens=task.get("max_tokens"),
                    fallback=False,
                )
                for token in gen:
                    if isinstance(token, str):
                        out.append(token)
                    elif isinstance(token, dict):
                        meta = token
                return {
                    "id": tid,
                    "text": "".join(out).strip(),
                    "provider": meta.get("provider", task.get("provider", "unknown")),
                    "source": meta.get("source", "stream"),
                    "persona": task.get("persona", "lantern"),
                    "ok": True,
                }
            except Exception as exc:
                return {"id": tid, "text": str(exc), "provider": task.get("provider", "unknown"), "source": "error", "ok": False, "error": str(exc)}

        with ThreadPoolExecutor(max_workers=min(len(tasks), 6), thread_name_prefix="batch") as ex:
            futures = {ex.submit(_run_one, t): t for t in tasks}
            for future in as_completed(futures):
                yield future.result(timeout=20)

    def _rank_providers(self, preferred: Optional[str]) -> List[str]:
        names = list(self._providers.keys())
        if preferred and preferred in names:
            names.remove(preferred)
            names.insert(0, preferred)
        names.sort(key=lambda n: (self._providers[n].priority, self._health.get(n, {}).get("latency_ms") or 9999.0))
        names.append("offline")
        return names

    def _build_system(self, persona: AgentPersona, extra_context: Optional[str]) -> str:
        parts = [persona.system_prompt]
        if extra_context:
            parts.append(f"\nContext:\n{extra_context}")
        parts.append("\nTone: thoughtful, unhurried, human. Never clinical. End with one question or invitation to record.")
        return "\n".join(parts)

    def _stream_provider(self, name: str, cfg: ProviderConfig, system: str, message: str, temperature: Optional[float], max_tokens: Optional[int]):
        method_name = f"_stream_{name}"
        method = getattr(self, method_name, None)
        if not method:
            raise RuntimeError(f"No stream method for {name}")
        return method(cfg, system, message, temperature, max_tokens)

    # --- Provider streamers (shared SSE parser) ---
    def _stream_ollama(self, cfg, system, message, temperature, max_tokens):
        url = f"{(cfg.base_url or 'http://127.0.0.1:11434').rstrip('/')}/api/chat"

        # Get mode-appropriate decode params
        mode = get_serving_mode() if _SERVING_MODES_AVAILABLE else None
        decode_params = get_decode_params(mode) if mode else {}

        options = {
            "temperature": temperature or cfg.temperature,
            "num_predict": max_tokens or cfg.max_tokens,
        }
        # Ollama uses repeat_penalty and repeat_last_n instead of frequency_penalty
        if decode_params:
            options["top_p"] = decode_params.get("top_p", 0.95)
            options["repeat_penalty"] = decode_params.get("repetition_penalty", 1.1)
            options["repeat_last_n"] = decode_params.get("repeat_last_n", 64)

        payload = json.dumps({"model": cfg.model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}], "stream": True, "options": options}).encode()
        return self._parse_sse(url, payload, cfg.timeout, lambda d: d.get("message", {}).get("content", "") or d.get("response", ""), {"Content-Type": "application/json"})

    def _stream_anthropic(self, cfg, system, message, temperature, max_tokens):
        if not cfg.api_key:
            raise RuntimeError("No ANTHROPIC_API_KEY")
        payload = json.dumps({
            "model": cfg.model,
            "max_tokens": max_tokens or cfg.max_tokens,
            "stream": True,
            "system": system,
            "temperature": temperature or cfg.temperature,
            "messages": [{"role": "user", "content": message}],
        }).encode()
        return self._parse_sse("https://api.anthropic.com/v1/messages", payload, cfg.timeout, lambda d: d.get("delta", {}).get("text", "") if d.get("type") == "content_block_delta" else "", {"Content-Type": "application/json", "x-api-key": cfg.api_key, "anthropic-version": "2023-06-01"})

    def _stream_openai(self, cfg, system, message, temperature, max_tokens):
        if not cfg.api_key:
            raise RuntimeError("No OPENAI_API_KEY")

        # Get mode-appropriate decode params
        mode = get_serving_mode() if _SERVING_MODES_AVAILABLE else None
        decode_params = get_decode_params(mode) if mode else {}

        payload = {
            "model": cfg.model,
            "stream": True,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}],
            "max_tokens": max_tokens or cfg.max_tokens,
            "temperature": temperature or cfg.temperature,
        }
        # OpenAI uses top_p and frequency_penalty
        if decode_params:
            payload["top_p"] = decode_params.get("top_p", 0.95)
            payload["frequency_penalty"] = decode_params.get("frequency_penalty", 0.5)

        return self._parse_sse("https://api.openai.com/v1/chat/completions", json.dumps(payload).encode(), cfg.timeout, lambda d: d.get("choices", [{}])[0].get("delta", {}).get("content", ""), {"Content-Type": "application/json", "Authorization": f"Bearer {cfg.api_key}"})

    def _stream_gemini(self, cfg, system, message, temperature, max_tokens):
        if not cfg.api_key:
            raise RuntimeError("No GOOGLE_API_KEY")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{cfg.model}:streamGenerateContent?key={cfg.api_key}&alt=sse"
        payload = json.dumps({"contents": [{"role": "user", "parts": [{"text": f"{system}\n\n{message}"}]}], "generationConfig": {"maxOutputTokens": max_tokens or cfg.max_tokens, "temperature": temperature or cfg.temperature}}).encode()
        return self._parse_sse(url, payload, cfg.timeout, lambda d: "".join(p.get("text", "") for c in d.get("candidates", []) for p in c.get("content", {}).get("parts", [])), {"Content-Type": "application/json"})

    def _stream_deepseek(self, cfg, system, message, temperature, max_tokens):
        if not cfg.api_key:
            raise RuntimeError("No DEEPSEEK_API_KEY")

        # Get mode-appropriate decode params
        mode = get_serving_mode() if _SERVING_MODES_AVAILABLE else None
        decode_params = get_decode_params(mode) if mode else {}

        payload = {
            "model": cfg.model,
            "stream": True,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}],
            "max_tokens": max_tokens or cfg.max_tokens,
            "temperature": temperature or cfg.temperature,
        }
        if decode_params:
            payload["top_p"] = decode_params.get("top_p", 0.95)
            payload["frequency_penalty"] = decode_params.get("frequency_penalty", 0.5)

        return self._parse_sse("https://api.deepseek.com/chat/completions", json.dumps(payload).encode(), cfg.timeout, lambda d: d.get("choices", [{}])[0].get("delta", {}).get("content", ""), {"Content-Type": "application/json", "Authorization": f"Bearer {cfg.api_key}"})

    def _stream_groq(self, cfg, system, message, temperature, max_tokens):
        if not cfg.api_key:
            raise RuntimeError("No GROQ_API_KEY")

        # Get mode-appropriate decode params
        mode = get_serving_mode() if _SERVING_MODES_AVAILABLE else None
        decode_params = get_decode_params(mode) if mode else {}

        payload = {
            "model": cfg.model,
            "stream": True,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}],
            "max_tokens": max_tokens or cfg.max_tokens,
            "temperature": temperature or cfg.temperature,
        }
        if decode_params:
            payload["top_p"] = decode_params.get("top_p", 0.95)
            payload["frequency_penalty"] = decode_params.get("frequency_penalty", 0.5)

        return self._parse_sse("https://api.groq.com/openai/v1/chat/completions", json.dumps(payload).encode(), cfg.timeout, lambda d: d.get("choices", [{}])[0].get("delta", {}).get("content", ""), {"Content-Type": "application/json", "Authorization": f"Bearer {cfg.api_key}"})

    def _stream_azure(self, cfg, system, message, temperature, max_tokens):
        if not cfg.api_key or not cfg.base_url:
            raise RuntimeError("No AZURE_OPENAI_KEY or AZURE_OPENAI_ENDPOINT")
        payload = json.dumps({"model": cfg.model, "stream": True, "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}], "max_tokens": max_tokens or cfg.max_tokens, "temperature": temperature or cfg.temperature}).encode()
        url = f"{cfg.base_url.rstrip('/')}/openai/deployments/{cfg.model}/chat/completions?api-version=2024-06-01"
        return self._parse_sse(url, payload, cfg.timeout, lambda d: d.get("choices", [{}])[0].get("delta", {}).get("content", ""), {"Content-Type": "application/json", "api-key": cfg.api_key})

    def _stream_generic(self, cfg, system, message, temperature, max_tokens):
        if not cfg.base_url:
            raise RuntimeError("No GENERIC_BASE_URL")
        payload = json.dumps({"model": cfg.model, "stream": True, "messages": [{"role": "system", "content": system}, {"role": "user", "content": message}], "max_tokens": max_tokens or cfg.max_tokens, "temperature": temperature or cfg.temperature}).encode()
        headers = {"Content-Type": "application/json"}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        return self._parse_sse(f"{cfg.base_url.rstrip('/')}/chat/completions", payload, cfg.timeout, lambda d: d.get("choices", [{}])[0].get("delta", {}).get("content", ""), headers)

    def _stream_keystone_ft(self, cfg, system, message, temperature, max_tokens):
        """Keystone managed agent with memory store. Falls back to standard messages API."""
        if not cfg.api_key:
            raise RuntimeError("No ANTHROPIC_API_KEY for keystone-ft")
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=cfg.api_key)
            agent_id = getattr(cfg, "_agent_id", None)
            memory_store_id = getattr(cfg, "_memory_store_id", None)
            if agent_id and memory_store_id:
                resources = [{
                    "type": "memory_store",
                    "memory_store_id": memory_store_id,
                    "access": "read_write",
                    "instructions": "Recall patterns from past Lantern OS engineering sessions to improve code suggestions.",
                }]
                session = client.beta.agents.sessions.create(
                    agent_id=agent_id,
                    resources=resources,
                )
                response = client.beta.agents.sessions.turns.create(
                    session_id=session.id,
                    messages=[{"role": "user", "content": message}],
                )
                text = ""
                for block in (response.content if hasattr(response, "content") else []):
                    if hasattr(block, "text"):
                        text += block.text
                if text:
                    yield text
                    return
        except Exception as e:
            print(f"[keystone-ft] sessions API failed ({e}), falling back to messages API")
        # Fallback: standard messages API with keystone SYSTEM_PROMPT
        payload = json.dumps({"model": cfg.model, "max_tokens": max_tokens or cfg.max_tokens, "stream": True, "system": system, "messages": [{"role": "user", "content": message}]}).encode()
        yield from self._parse_sse("https://api.anthropic.com/v1/messages", payload, cfg.timeout, lambda d: d.get("delta", {}).get("text", "") if d.get("type") == "content_block_delta" else "", {"Content-Type": "application/json", "x-api-key": cfg.api_key, "anthropic-version": "2023-06-01"})

    def _stream_offline(self, cfg, system, message, temperature, max_tokens):
        """Offline provider: yields the offline reply text directly without any HTTP call."""
        reply = f"The flame holds steady. '{message[:90]}...' You can always come home safe. What light did you bring back?"
        words = reply.split()
        def gen():
            for w in words:
                yield w + " "
            yield {"source": "offline", "provider": "offline", "persona": "lantern"}
        return gen()

    def _parse_sse(self, url: str, payload: bytes, timeout: float, extract_fn, headers: Dict[str, str]):
        req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        full = ""
        with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
            buf = b""
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                buf += chunk
                lines = buf.split(b"\n")
                buf = lines.pop()
                for line in lines:
                    s = line.decode("utf-8")
                    if not s.startswith("data:"):
                        continue
                    raw = s[5:].strip()
                    if raw in ("[DONE]", ""):
                        continue
                    try:
                        data = json.loads(raw)
                        token = extract_fn(data)
                        if token:
                            full += token
                            yield token
                    except Exception:
                        pass
        return {"source": "unknown", "provider": "unknown", "persona": "unknown", "full": full}

    def _offline_reply(self, persona: AgentPersona, message: str) -> str:
        snippet = message[:90]
        replies = {
            "lantern": f"The flame holds steady. '{snippet}...' You can always come home safe. What light did you bring back?",
            "blinkbug": f"[STATIC] '{snippet}...' [GLITCH] Windows XP door detected. Hidden lore? Unhinged energy rising. What did the CRT show you?",
            "keystone": f"I can't answer that right now — no local model is running (Ollama/Ouro on :11434) and the cloud providers are unreachable, so there's no LLM to handle '{snippet}...'. Start a local model or set a cloud API key, then resend. (Keystone is a technical assistant, not a dream narrator.)",
            "waterfall": f"'{snippet}...' flows like water. What feeling wants to move through?",
            "xenon": f"'{snippet}...' charts a course. Where does this dream point — and who walks with you?",
            "founder": f"'{snippet}...' carries a wish. What are you protecting, and where do you need to return?",
            "comet": f"'{snippet}...' sparks a trajectory. What leap is waiting inside this?",
        }
        return replies.get(persona.id, f"'{snippet}...' That is worth keeping. What do you see when you sit with it?")

    # ------------------------------------------------------------------ #
    # Greeting engine — non-trivial RP on every visit
    # ------------------------------------------------------------------ #
    def greet(self, recent_dreams: Optional[List[Dict[str, Any]]] = None, provider: Optional[str] = None) -> Generator[str, None, Dict[str, Any]]:
        """Generate a non-trivial greeting every time the dream journal surface loads."""
        persona = random.choice(PERSONAS)
        hour = datetime.now().hour
        time_greeting = "Good morning" if 5 <= hour < 12 else "Good afternoon" if 12 <= hour < 18 else "Good evening" if 18 <= hour < 22 else "The night is deep"
        recent = recent_dreams or []
        recent_text = ""
        if recent:
            r = recent[0]
            recent_text = f"Your last dream mentioned: {str(r.get('text') or r.get('content', ''))[:120]}..."

        prompts = [
            f"{time_greeting}, dreamer. {persona.name} is here. {recent_text} What door do you want to open today?",
            f"{time_greeting}. The {persona.symbol.split(',')[0]} stirs. {recent_text} Tell me what the light caught.",
            f"{time_greeting}. {persona.name} senses movement in the dream-fields. {recent_text} What shape is forming?",
            f"{time_greeting}. A new page waits — raw hand-drawn, notebook-style. {persona.name} asks: what wish traveled with you through sleep?",
            f"{time_greeting}. {recent_text} The {persona.symbol.split(',')[0]} glows a little brighter when you arrive. What do you bring?",
            f"{time_greeting}. {persona.name} whispers: every dream is a door. Which one shall we walk through first?",
            f"{time_greeting}. {persona.name} stands near the Return Door. {recent_text} You can always come home safe. What did you see?",
            f"{time_greeting}. A Windows XP styled portal flickers open. {persona.name} says: hidden lore incoming. {recent_text} What's on the screen?",
        ]
        greeting = random.choice(prompts)
        # Stream it character-by-character for effect
        for ch in greeting:
            yield ch
            time.sleep(0.012)
        return {"source": "greeting_engine", "provider": provider or "any", "persona": persona.id, "full": greeting}

    # ------------------------------------------------------------------ #
    # Slot / Fleet helpers
    # ------------------------------------------------------------------ #
    def list_slots(self) -> List[Dict[str, Any]]:
        slots_path = CONFIG_DIR / "agent-slots.json"
        if not slots_path.exists():
            return []
        try:
            with open(slots_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            slots = data.get("agents", [])
            for s in slots:
                s["health"] = self._health.get(s.get("type", ""), {})
            return slots
        except Exception as e:
            print(f"[warn] agent-slots.json: {e}")
            return []

    def inspect(self) -> Dict[str, Any]:
        """Agent inspector report."""
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "providers": {name: {"model": cfg.model, "enabled": cfg.enabled, "priority": cfg.priority} for name, cfg in self._providers.items()},
            "health": self._health,
            "personas": [p.id for p in PERSONAS],
            "slots": self.list_slots(),
        }


# Convenience factory
_connector: Optional[UnifiedAgentConnector] = None


def get_connector() -> UnifiedAgentConnector:
    global _connector
    if _connector is None:
        _connector = UnifiedAgentConnector()
    return _connector


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["stream", "stream-sse", "health", "inspect", "greet"], default="health")
    parser.add_argument("--message", default="")
    parser.add_argument("--persona", default=None)
    parser.add_argument("--provider", default=None)
    parser.add_argument("--context", default=None)
    parser.add_argument("--temperature", type=float, default=None)
    parser.add_argument("--max-tokens", type=int, default=None)
    args = parser.parse_args()

    c = get_connector()
    if args.action == "health":
        print(json.dumps(c.check_health(), indent=2))
    elif args.action == "inspect":
        print(json.dumps(c.inspect(), indent=2))
    elif args.action == "greet":
        recent = None
        if args.context:
            try:
                recent = json.loads(args.context)
            except Exception:
                pass
        result = []
        for token in c.greet(recent, args.provider):
            if hasattr(token, "__iter__") and not isinstance(token, str):
                result.append(str(token))
            else:
                result.append(token)
        # Greet returns char-by-char; join them
        print(json.dumps({"greeting": "".join(result), "persona": args.persona or "rotating", "source": "greeting_engine"}, indent=2))
    elif args.action == "stream":
        out = []
        meta = {}
        try:
            gen = c.stream(args.message, persona_id=args.persona, provider=args.provider, context=args.context, temperature=args.temperature, max_tokens=args.max_tokens)
            while True:
                try:
                    token = next(gen)
                    if isinstance(token, str):
                        out.append(token)
                    else:
                        meta = dict(token) if hasattr(token, "items") else {}
                except StopIteration as exc:
                    if exc.value and isinstance(exc.value, dict):
                        meta = exc.value
                    break
        except Exception as e:
            meta = {"error": str(e)}
        print(json.dumps({"text": "".join(out), "meta": meta}, indent=2))
    elif args.action == "stream-sse":
        try:
            gen = c.stream(args.message, persona_id=args.persona, provider=args.provider, context=args.context, temperature=args.temperature, max_tokens=args.max_tokens)
            meta = {}
            while True:
                try:
                    token = next(gen)
                    if isinstance(token, str):
                        print(json.dumps({"token": token}, ensure_ascii=False), flush=True)
                    else:
                        meta = dict(token) if hasattr(token, "items") else {}
                except StopIteration as exc:
                    if exc.value and isinstance(exc.value, dict):
                        meta = exc.value
                    break
            print(json.dumps({"done": True, "meta": meta}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"done": True, "error": str(e)}, ensure_ascii=False), flush=True)
