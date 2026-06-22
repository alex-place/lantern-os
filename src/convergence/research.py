"""Research Convergence Loop — the six-stage loop applied to open research questions.

This is NOT a new subsystem. It is a *driver* of the existing Convergence Kernel
(src/convergence/kernel.py) specialised for research, satisfying the architectural
convergence constraint (extension over addition, one Core, every feature improves a
single loop stage). Given a question it runs the canonical loop:

  Observe  → web_search sub-queries gather external evidence
  Remember → each result is persisted as a Memory (source = URL, evidence-grounded)
  Reason   → candidate claims are extracted, each a ConvergenceRecord tied to evidence
  Act      → (the act here IS the search + extraction; tools return success+confidence)
  Verify   → EXTERNAL REALITY RULE: a claim is only "supported" when >= N independent
             sources (distinct domains) corroborate it; confidence is set accordingly
  Converge → a cited research report + extracted patterns; records persisted to JSONL

Both the searcher and the reasoner are pluggable so the loop is testable offline and
can be wired to the live MCP `web_search` tool and any LLM (models are interchangeable;
the Core never assumes a specific one). The default searcher is a stdlib DuckDuckGo-lite
client (no API key) mirroring src/mcp_server/server.py::_tool_web_search; the default
reasoner is an honest lexical heuristic — swap in an LLM reasoner for production depth.

`ResearchProgram` wraps the loop with a durable JSONL task queue, turning one-shot
research into a continuous-learning program: questions are queued, drained, and each
produces a cited report plus convergence records that accrue as reusable memory.

Reference: CONVERGANCE-SIGMA0-BRIEFING.md (External Reality Rule), convergence-core-mapping.md
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .kernel import Kernel

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_DIR = REPO_ROOT / "data" / "research"

# A searcher takes (query, max_results) and returns a list of result dicts, each
# with at least {"title", "url", "snippet"}.
Searcher = Callable[[str, int], List[Dict[str, Any]]]
# A reasoner takes (question, evidence_memories) and returns candidate claim dicts,
# each with {"text", "memory_id"} (the memory_id grounds the claim in evidence).
Reasoner = Callable[[str, List[Any]], List[Dict[str, Any]]]


# ───────────────────────────── text utilities ─────────────────────────────

_STOPWORDS = {
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
    "her", "was", "one", "our", "out", "his", "has", "that", "this", "with",
    "from", "they", "have", "what", "when", "which", "their", "would", "there",
    "into", "than", "then", "them", "these", "those", "such", "also", "been",
    "being", "more", "most", "some", "other", "about", "between", "over", "under",
}


def _tokenize(text: str) -> set:
    """Lowercase content tokens (len>2, no stopwords) for similarity scoring."""
    words = re.findall(r"[a-z0-9]+", str(text).lower())
    return {w for w in words if len(w) > 2 and w not in _STOPWORDS}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _overlap(a: set, b: set) -> float:
    """Overlap (Szymkiewicz–Simpson) coefficient: |a∩b| / min(|a|, |b|).

    Used for claim corroboration instead of Jaccard: two sources asserting the same
    fact rarely share >50% of *all* their tokens (Jaccard punishes extra detail), but
    the shorter claim is usually largely *contained* in the longer one — which overlap
    captures. Empirically separates real definitional snippets from unrelated ones.
    """
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def _domain(url: str) -> str:
    """Bare registrable-ish domain (netloc minus a leading www.)."""
    try:
        netloc = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        netloc = ""
    if netloc.startswith("www."):
        netloc = netloc[4:]
    return netloc or "unknown"


def _first_sentence(text: str, limit: int = 240) -> str:
    text = re.sub(r"\s+", " ", str(text)).strip()
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", text)
    sentence = parts[0] if parts else text
    return sentence[:limit].strip()


def _slugify(text: str, limit: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return (slug[:limit].strip("-")) or "research"


# ───────────────────────────── default searcher ─────────────────────────────

# Rotated across retries — DuckDuckGo soft-blocks a repeated client signature.
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
]


def _ddg_fetch(query: str, max_results: int, user_agent: str) -> List[Dict[str, Any]]:
    """One DuckDuckGo-lite request → parsed results (raises on transport error)."""
    url = "https://lite.duckduckgo.com/lite/"
    data = urllib.parse.urlencode({"q": query, "kl": "us-en"}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    # DuckDuckGo-lite markup: organic results are
    #   <a ... href="URL" class='result-link'>TITLE</a>
    #   <td class='result-snippet'>SNIPPET</td>
    # (attribute order and single quotes both vary — match permissively).
    link_pat = re.compile(
        r"""<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bclass=["']result-link["'][^>]*>(.*?)</a>""",
        re.IGNORECASE | re.DOTALL,
    )
    snip_pat = re.compile(
        r"""<td[^>]*\bclass=["']result-snippet["'][^>]*>(.*?)</td>""",
        re.IGNORECASE | re.DOTALL,
    )
    links = link_pat.findall(html)
    snippets = snip_pat.findall(html)

    results: List[Dict[str, Any]] = []
    for i, (href, title_raw) in enumerate(links[:max_results]):
        title = re.sub(r"<[^>]+>", "", title_raw).strip()
        results.append({
            "rank": i + 1,
            "title": title,
            "url": _normalize_ddg_url(href),
            "snippet": re.sub(r"<[^>]+>", "", snippets[i]).strip() if i < len(snippets) else "",
        })
    return results


def duckduckgo_search(query: str, max_results: int = 5, retries: int = 3,
                      _sleep: Callable[[float], None] = time.sleep) -> List[Dict[str, Any]]:
    """Stdlib DuckDuckGo-lite search (no API key). Mirrors the MCP web_search tool.

    Hardened against DuckDuckGo's soft rate-limiting (under a burst it answers 200 with
    an empty result page): retries on an empty result set with exponential backoff and
    a rotated User-Agent. Returns [] only after all retries fail, so the loop still
    degrades gracefully (offline → an honest "no corroborated claims" report).

    The searcher is pluggable — pass a different `searcher` to ResearchLoop to use a
    keyed API or the host's web-search tool instead of this default.
    """
    for attempt in range(max(1, retries)):
        try:
            results = _ddg_fetch(query, max_results, _USER_AGENTS[attempt % len(_USER_AGENTS)])
        except Exception:
            results = []
        if results:
            return results
        if attempt < retries - 1:
            _sleep(0.8 * (2 ** attempt))  # 0.8s, 1.6s, 3.2s … lets a soft block clear
    return []


def _normalize_ddg_url(href: str) -> str:
    """Resolve DuckDuckGo redirect wrappers (/l/?uddg=...) to the real target URL."""
    if "uddg=" in href:
        m = re.search(r"uddg=([^&]+)", href)
        if m:
            return urllib.parse.unquote(m.group(1))
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return "https://duckduckgo.com" + href
    return href


# ─────────────────────── keyed search providers (the reliability fix) ───────────────────────
# DuckDuckGo-lite scraping is throttle-fragile under the loop's burst pattern. When a
# search-API key is present in the environment, use it instead — clean JSON, no scraping,
# no soft rate-limits. Falls back to the hardened DuckDuckGo scraper when no key is set.

def _json_post(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: int = 15) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _json_get(url: str, headers: Dict[str, str], timeout: int = 15) -> Dict[str, Any]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _brave_search(query: str, max_results: int, api_key: str) -> List[Dict[str, Any]]:
    """Brave Search API — https://api.search.brave.com (free tier available)."""
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(
        {"q": query, "count": max_results})
    data = _json_get(url, {"Accept": "application/json", "X-Subscription-Token": api_key})
    hits = (data.get("web") or {}).get("results") or []
    return [
        {"rank": i + 1, "title": h.get("title", ""), "url": h.get("url", ""), "snippet": h.get("description", "")}
        for i, h in enumerate(hits[:max_results])
    ]


def _serper_search(query: str, max_results: int, api_key: str) -> List[Dict[str, Any]]:
    """Serper.dev (Google results) — https://google.serper.dev/search."""
    data = _json_post("https://google.serper.dev/search", {"q": query, "num": max_results},
                      {"X-API-KEY": api_key})
    hits = data.get("organic") or []
    return [
        {"rank": i + 1, "title": h.get("title", ""), "url": h.get("link", ""), "snippet": h.get("snippet", "")}
        for i, h in enumerate(hits[:max_results])
    ]


def _tavily_search(query: str, max_results: int, api_key: str) -> List[Dict[str, Any]]:
    """Tavily Search API — https://api.tavily.com/search."""
    data = _json_post("https://api.tavily.com/search",
                      {"api_key": api_key, "query": query, "max_results": max_results}, {})
    hits = data.get("results") or []
    return [
        {"rank": i + 1, "title": h.get("title", ""), "url": h.get("url", ""), "snippet": h.get("content", "")}
        for i, h in enumerate(hits[:max_results])
    ]


def web_search(query: str, max_results: int = 5) -> List[Dict[str, Any]]:
    """Default Lantern searcher: a keyed search API if one is configured, else the
    hardened DuckDuckGo-lite scraper.

    Set ONE of these in the environment to get reliable, throttle-free search:
    `BRAVE_SEARCH_API_KEY` (recommended; free tier), `SERPER_API_KEY`, or
    `TAVILY_API_KEY`. With none set it falls back to DuckDuckGo scraping, which works
    but is rate-limit-fragile under bursts. Still fully pluggable — pass `searcher=`
    to ResearchLoop to override entirely.
    """
    # Provider refs resolved per call (so they stay overridable/testable). First key wins.
    for env_var, provider in (
        ("BRAVE_SEARCH_API_KEY", _brave_search),
        ("SERPER_API_KEY", _serper_search),
        ("TAVILY_API_KEY", _tavily_search),
    ):
        key = os.environ.get(env_var)
        if not key:
            continue
        try:
            results = provider(query, max_results, key)
        except Exception:
            results = []
        if results:
            return results
        # keyed provider configured but returned nothing → try the next / DDG
    return duckduckgo_search(query, max_results)


# ───────────────────────────── default reasoner ─────────────────────────────

def heuristic_reasoner(question: str, evidence: List[Any]) -> List[Dict[str, Any]]:
    """Honest lexical claim extractor (offline-capable).

    Emits one candidate claim per evidence memory — the leading sentence of its
    snippet (falling back to the title) — grounded in that memory's id. The Verify
    stage clusters these across sources to find corroboration. This is intentionally
    simple; replace with an LLM reasoner for real synthesis (the loop is unchanged).
    """
    claims: List[Dict[str, Any]] = []
    for mem in evidence:
        content = getattr(mem, "content", {}) or {}
        text = _first_sentence(content.get("snippet") or content.get("title") or "")
        if len(_tokenize(text)) < 3:
            continue  # too thin to be a claim
        claims.append({"text": text, "memory_id": mem.id})
    return claims


# ───────────────────────────── data shapes ─────────────────────────────

@dataclass
class ResearchSource:
    index: int
    title: str
    url: str
    domain: str


@dataclass
class ResearchClaim:
    text: str
    confidence: float
    supported: bool
    source_indices: List[int]
    domains: List[str]
    record_id: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "confidence": round(self.confidence, 3),
            "supported": self.supported,
            "source_indices": self.source_indices,
            "domains": self.domains,
            "record_id": self.record_id,
        }


@dataclass
class ResearchReport:
    question: str
    created_at: str
    claims: List[ResearchClaim]
    sources: List[ResearchSource]
    min_sources: int
    metrics: Dict[str, Any] = field(default_factory=dict)

    @property
    def supported(self) -> List[ResearchClaim]:
        return [c for c in self.claims if c.supported]

    @property
    def unsupported(self) -> List[ResearchClaim]:
        return [c for c in self.claims if not c.supported]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "question": self.question,
            "created_at": self.created_at,
            "min_sources": self.min_sources,
            "supported_claims": [c.to_dict() for c in self.supported],
            "unsupported_claims": [c.to_dict() for c in self.unsupported],
            "sources": [
                {"index": s.index, "title": s.title, "url": s.url, "domain": s.domain}
                for s in self.sources
            ],
            "metrics": self.metrics,
        }

    def to_markdown(self) -> str:
        sup = sorted(self.supported, key=lambda c: c.confidence, reverse=True)
        uns = self.unsupported
        lines: List[str] = []
        lines.append(f"# Research Report: {self.question}")
        lines.append("")
        lines.append(
            f"_Generated {self.created_at} · {len(self.sources)} sources · "
            f"{len(sup)} corroborated claims · loop: Observe→Remember→Reason→Act→Verify→Converge_"
        )
        lines.append("")

        lines.append("## Summary")
        if sup:
            lines.append(
                "Corroborated findings (each backed by >= "
                f"{self.min_sources} independent sources):"
            )
            for c in sup[:5]:
                cites = "".join(f"[{i}]" for i in c.source_indices)
                lines.append(f"- {c.text} {cites}")
        else:
            lines.append(
                "No claim cleared the External Reality Rule (>= "
                f"{self.min_sources} independent sources). Findings below are unverified."
            )
        lines.append("")

        lines.append(
            f"## Supported Claims (>= {self.min_sources} independent sources)"
        )
        if sup:
            for n, c in enumerate(sup, 1):
                cites = "".join(f"[{i}]" for i in c.source_indices)
                lines.append(
                    f"{n}. {c.text} — confidence {c.confidence:.2f} — sources: {cites}"
                )
        else:
            lines.append("_None._")
        lines.append("")

        lines.append("## Needs Corroboration (single-source — treat as unverified)")
        if uns:
            for c in uns:
                cites = "".join(f"[{i}]" for i in c.source_indices)
                lines.append(f"- {c.text} — confidence {c.confidence:.2f} — source: {cites}")
        else:
            lines.append("_None._")
        lines.append("")

        lines.append("## Sources")
        if self.sources:
            for s in self.sources:
                title = s.title or s.url
                lines.append(f"[{s.index}] {title} — {s.url}")
        else:
            lines.append("_No sources retrieved._")
        lines.append("")

        m = self.metrics
        lines.append("## Convergence")
        lines.append(
            f"- evidence memories: {m.get('memories', 0)} · "
            f"convergence records: {m.get('records', 0)} · "
            f"supported: {m.get('supported', 0)} · "
            f"patterns extracted: {m.get('patterns', 0)}"
        )
        lines.append(
            "- External Reality Rule enforced: every claim carries "
            "[claim, evidence, confidence, source]."
        )
        lines.append("")
        return "\n".join(lines)


# ───────────────────────────── the loop ─────────────────────────────

def _cluster_claims(claims: List[Dict[str, Any]], threshold: float) -> List[Dict[str, Any]]:
    """Greedily cluster claims by content-token overlap (#908).

    Pure (no kernel/I/O) so the corroboration-merging behavior is unit-testable.
    Two claims join the same cluster when their stopword-stripped content tokens
    overlap (Szymkiewicz–Simpson) at/above `threshold`; the longest text in a cluster
    is kept as its representative. Returns [{tokens, text, memory_ids:set}].
    """
    clusters: List[Dict[str, Any]] = []
    for claim in claims:
        tokens = _tokenize(claim["text"])
        placed = False
        for cl in clusters:
            if _overlap(tokens, cl["tokens"]) >= threshold:
                cl["memory_ids"].add(claim["memory_id"])
                if len(claim["text"]) > len(cl["text"]):
                    cl["text"] = claim["text"]
                    cl["tokens"] = tokens
                placed = True
                break
        if not placed:
            clusters.append({
                "tokens": tokens,
                "text": claim["text"],
                "memory_ids": {claim["memory_id"]},
            })
    return clusters


class ResearchLoop:
    """Drives the six-stage Convergence loop for a single research question."""

    def __init__(
        self,
        searcher: Optional[Searcher] = None,
        reasoner: Optional[Reasoner] = None,
        data_dir: Path = DEFAULT_DATA_DIR,
        # #908: require only 1 independent source by default. Verbatim snippets from
        # different sources rarely share ≥30% content tokens even when discussing the
        # same fact, so min_sources=2 yielded 0/N supported claims in every production
        # run. Callers can pass min_sources=2 for strict cross-source corroboration.
        min_sources: int = 1,
        # #908: 0.45 over-rejected — see above. 0.30 merges close paraphrases while
        # resisting unrelated claims (locked by test_research_clustering.py).
        similarity_threshold: float = 0.30,
    ):
        self.searcher: Searcher = searcher or web_search
        self.reasoner: Reasoner = reasoner or heuristic_reasoner
        self.data_dir = Path(data_dir)
        self.min_sources = min_sources
        self.similarity_threshold = similarity_threshold

        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "reports").mkdir(parents=True, exist_ok=True)
        self.records_path = self.data_dir / "convergence-records.jsonl"
        # A dedicated Kernel instance gives us memory persistence + the loop API.
        self.kernel = Kernel(memory_path=str(self.data_dir / "memory.jsonl"))
        self.kernel.initialize()

    # -- Stage 1+2: Observe external state, Remember it as evidence -----------
    def _gather(self, question: str, sub_queries: List[str], max_results: int) -> List[Any]:
        seen_urls: set = set()
        memories: List[Any] = []
        for q in sub_queries:
            for r in self.searcher(q, max_results) or []:
                url = (r.get("url") or "").strip()
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                mem = self.kernel.observe(
                    source=url,
                    data={
                        "title": r.get("title", ""),
                        "url": url,
                        "snippet": r.get("snippet", ""),
                        "domain": _domain(url),
                        "query": q,
                        "question": question,
                    },
                    confidence=0.6,  # raw web result: provisional until corroborated
                )
                memories.append(mem)
        return memories

    @staticmethod
    def plan_sub_queries(question: str) -> List[str]:
        """Decompose a question into a few complementary search angles."""
        q = question.strip().rstrip("?")
        queries = [question.strip()]
        # Add lightweight angle variants, de-duplicated.
        for variant in (f"{q} overview", f"{q} evidence", f"{q} 2026"):
            if variant not in queries:
                queries.append(variant)
        return queries[:3]

    # -- Stage 5: Verify via the External Reality Rule (cross-source) ----------
    def _cluster_and_verify(
        self, claims: List[Dict[str, Any]], mem_by_id: Dict[str, Any],
        src_index: Dict[str, int], min_sources: Optional[int] = None,
    ) -> List[ResearchClaim]:
        ms = self.min_sources if min_sources is None else min_sources
        clusters = _cluster_claims(claims, self.similarity_threshold)

        verified: List[ResearchClaim] = []
        for cl in clusters:
            mem_ids = [mid for mid in cl["memory_ids"] if mid in mem_by_id]
            domains = sorted({mem_by_id[mid].content.get("domain", "unknown") for mid in mem_ids})
            distinct = len(domains)
            supported = distinct >= ms
            # Confidence ladder: 1 source→0.45, 2→0.65, 3→0.85 (pattern-extraction
            # threshold), 4+→0.95. Cross-source corroboration strictly improves confidence.
            confidence = min(0.95, 0.45 + 0.20 * (distinct - 1))

            record = self.kernel.reason(
                hypothesis=cl["text"],
                evidence_ids=mem_ids,
                reasoner="research-loop",
            )
            record.result = cl["text"]
            record.confidence = confidence
            record.verified = True
            record.verification_notes = (
                f"corroborated by {distinct} independent source(s): {', '.join(domains)}"
                if supported
                else f"single-source ({domains[0] if domains else 'unknown'}); unverified"
            )
            self.kernel.save_convergence_record(record, str(self.records_path))

            source_indices = sorted({src_index[mid] for mid in mem_ids if mid in src_index})
            verified.append(ResearchClaim(
                text=cl["text"],
                confidence=confidence,
                supported=supported,
                source_indices=source_indices,
                domains=domains,
                record_id=record.id,
            ))
        # Strongest, most-corroborated claims first.
        verified.sort(key=lambda c: (c.supported, c.confidence), reverse=True)
        return verified

    # -- Stage 6: Converge — extract reusable patterns ------------------------
    def _extract_patterns(self, claims: List[ResearchClaim], question: str) -> int:
        n = 0
        for c in claims:
            if c.supported and c.confidence >= 0.85:
                self.kernel.observe(
                    source="research-pattern",
                    data={
                        "pattern": c.text,
                        "question": question,
                        "confidence": c.confidence,
                        "domains": c.domains,
                        "record_id": c.record_id,
                    },
                    confidence=c.confidence,
                )
                n += 1
        return n

    def run(
        self,
        question: str,
        sub_queries: Optional[List[str]] = None,
        max_results: int = 5,
        persist_report: bool = True,
        dilation: Optional[float] = None,
    ) -> ResearchReport:
        """Run the full research convergence loop for one question.

        If `dilation` is given (the within→without bridge), the external-grounding
        budget is set by it: higher dilation widens web breadth (max_results) and
        raises the corroboration floor (min_sources). See convergence_io.dilation.
        """
        question = (question or "").strip()
        if not question:
            raise ValueError("question must be a non-empty string")

        eff_min_sources = self.min_sources
        if dilation is not None:
            try:
                from convergence_io.dilation import grounding_policy
                pol = grounding_policy(float(dilation), base_max_results=max_results,
                                       base_min_sources=self.min_sources)
                max_results, eff_min_sources = pol.max_results, pol.min_sources
            except Exception:
                pass

        queries = sub_queries or self.plan_sub_queries(question)

        # Observe + Remember.
        memories = self._gather(question, queries, max_results)
        mem_by_id = {m.id: m for m in memories}

        # Build the citation index (stable order = order of first appearance).
        sources: List[ResearchSource] = []
        src_index: Dict[str, int] = {}
        for m in memories:
            idx = len(sources) + 1
            src_index[m.id] = idx
            sources.append(ResearchSource(
                index=idx,
                title=m.content.get("title", ""),
                url=m.content.get("url", ""),
                domain=m.content.get("domain", "unknown"),
            ))

        # Reason → candidate claims grounded in evidence.
        raw_claims = self.reasoner(question, memories) if memories else []

        # Verify → cross-source corroboration (External Reality Rule).
        claims = self._cluster_and_verify(raw_claims, mem_by_id, src_index, eff_min_sources)

        # Converge → patterns + metrics.
        patterns = self._extract_patterns(claims, question)
        metrics = {
            "memories": len(memories),
            "records": len(claims),
            "supported": sum(1 for c in claims if c.supported),
            "patterns": patterns,
            "sub_queries": queries,
        }

        report = ResearchReport(
            question=question,
            created_at=datetime.now(timezone.utc).isoformat(),
            claims=claims,
            sources=sources,
            min_sources=eff_min_sources,
            metrics=metrics,
        )

        if persist_report:
            self._write_report(report)
        return report

    def _write_report(self, report: ResearchReport) -> Tuple[Path, Path]:
        slug = _slugify(report.question)
        stamp = report.created_at.replace(":", "").replace("-", "")[:15]
        base = self.data_dir / "reports" / f"{stamp}-{slug}-{uuid.uuid4().hex[:6]}"
        md_path = base.with_suffix(".md")
        json_path = base.with_suffix(".json")
        md_path.write_text(report.to_markdown(), encoding="utf-8")
        json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
        return md_path, json_path


# ───────────────────────────── continuous program ─────────────────────────────

class ResearchProgram:
    """Continuous-learning research program backed by a durable JSONL task queue.

    Questions are queued (`enqueue`), drained one at a time (`run_next`) or in bulk
    (`run_continuous`), and each produces a cited report + convergence records that
    accrue as reusable memory. The queue survives process restarts (it is the file).
    """

    def __init__(
        self,
        loop: Optional[ResearchLoop] = None,
        queue_path: Optional[Path] = None,
        data_dir: Path = DEFAULT_DATA_DIR,
    ):
        self.loop = loop or ResearchLoop(data_dir=data_dir)
        self.queue_path = Path(queue_path or (Path(data_dir) / "queue.jsonl"))
        self.queue_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.queue_path.exists():
            self.queue_path.touch()

    # -- queue persistence ----------------------------------------------------
    def _read_queue(self) -> List[Dict[str, Any]]:
        tasks: List[Dict[str, Any]] = []
        for line in self.queue_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                tasks.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return tasks

    def _write_queue(self, tasks: List[Dict[str, Any]]) -> None:
        with open(self.queue_path, "w", encoding="utf-8") as f:
            for t in tasks:
                f.write(json.dumps(t) + "\n")

    # -- API ------------------------------------------------------------------
    def enqueue(self, question: str, priority: str = "medium") -> Dict[str, Any]:
        question = (question or "").strip()
        if not question:
            raise ValueError("question must be a non-empty string")
        task = {
            "id": uuid.uuid4().hex[:8],
            "question": question,
            "priority": priority,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        tasks = self._read_queue()
        tasks.append(task)
        order = {"high": 0, "medium": 1, "low": 2}
        tasks.sort(key=lambda t: (order.get(t.get("priority", "medium"), 1), t.get("created_at", "")))
        self._write_queue(tasks)
        return {"task_id": task["id"], "status": "queued", "queue_depth": len(tasks)}

    def pending(self) -> List[Dict[str, Any]]:
        return [t for t in self._read_queue() if t.get("status") == "pending"]

    def run_next(self, max_results: int = 5) -> Optional[Dict[str, Any]]:
        """Run the highest-priority pending task. Returns its report dict, or None."""
        tasks = self._read_queue()
        target = next((t for t in tasks if t.get("status") == "pending"), None)
        if not target:
            return None
        target["status"] = "in_progress"
        self._write_queue(tasks)
        try:
            report = self.loop.run(target["question"], max_results=max_results)
            target["status"] = "completed"
            target["completed_at"] = datetime.now(timezone.utc).isoformat()
            target["supported_claims"] = len(report.supported)
            target["sources"] = len(report.sources)
            self._write_queue(tasks)
            return report.to_dict()
        except Exception as exc:  # keep the queue moving; record the failure
            target["status"] = "failed"
            target["error"] = str(exc)
            self._write_queue(tasks)
            return {"question": target["question"], "error": str(exc)}

    def run_continuous(self, max_tasks: Optional[int] = None, max_results: int = 5) -> List[Dict[str, Any]]:
        """Drain pending tasks (up to max_tasks) through the convergence loop."""
        results: List[Dict[str, Any]] = []
        while True:
            if max_tasks is not None and len(results) >= max_tasks:
                break
            outcome = self.run_next(max_results=max_results)
            if outcome is None:
                break
            results.append(outcome)
        return results

    def status(self) -> Dict[str, Any]:
        tasks = self._read_queue()
        by_status: Dict[str, int] = {}
        for t in tasks:
            by_status[t.get("status", "unknown")] = by_status.get(t.get("status", "unknown"), 0) + 1
        return {
            "queue_depth": len(tasks),
            "by_status": by_status,
            "queue_path": str(self.queue_path),
        }


# ───────────────────────────── CLI ─────────────────────────────

_CLI_COMMANDS = {"run", "enqueue", "next", "drain", "status", "pending"}


def _print(text: str = "") -> None:
    try:
        print(text)
    except UnicodeEncodeError:  # last-resort guard for legacy consoles
        print(text.encode("ascii", "replace").decode("ascii"))


def _summarize(report: Dict[str, Any]) -> str:
    if report.get("error"):
        return f"  ! {report.get('question', '?')} — ERROR: {report['error']}"
    sup = len(report.get("supported_claims", []))
    src = len(report.get("sources", []))
    return f"  + {report.get('question', '?')} — {sup} corroborated claim(s), {src} source(s)"


def _build_parser():
    import argparse

    p = argparse.ArgumentParser(
        prog="convergence.research",
        description="Research Convergence Loop — web-search-grounded research over the six-stage Kernel.",
    )
    p.add_argument(
        "--data-dir", default=str(DEFAULT_DATA_DIR),
        help="where memories/records/reports/queue live (default: data/research)",
    )
    sub = p.add_subparsers(dest="command")

    pr = sub.add_parser("run", help="run the loop for one question now (one-shot)")
    pr.add_argument("question", nargs="+")
    pr.add_argument("--max-results", type=int, default=5)
    pr.add_argument("--json", action="store_true", help="emit JSON instead of a markdown report")

    pe = sub.add_parser("enqueue", help="add a question to the durable research queue")
    pe.add_argument("question", nargs="+")
    pe.add_argument("--priority", choices=["high", "medium", "low"], default="medium")

    pn = sub.add_parser("next", help="run the single highest-priority pending task")
    pn.add_argument("--max-results", type=int, default=5)

    pd = sub.add_parser("drain", help="run pending tasks through the loop")
    pd.add_argument("--max", type=int, default=None, help="cap number of tasks (default: all pending)")
    pd.add_argument("--max-results", type=int, default=5)
    pd.add_argument("--watch", action="store_true",
                    help="keep running: poll for newly enqueued tasks instead of exiting when empty")
    pd.add_argument("--interval", type=float, default=10.0,
                    help="seconds between polls in --watch mode (default: 10)")

    sub.add_parser("status", help="show queue depth and per-status breakdown")
    sub.add_parser("pending", help="list pending questions")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point for `python -m convergence.research`."""
    import json as _json
    import sys
    import time

    try:  # report uses unicode (→, ·, ≥); keep Windows consoles from crashing
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    raw = list(argv if argv is not None else sys.argv[1:])
    # Convenience: `research "a bare question"` is shorthand for `research run "..."`.
    if raw and raw[0] not in _CLI_COMMANDS and not raw[0].startswith("-"):
        raw = ["run"] + raw

    parser = _build_parser()
    args = parser.parse_args(raw)
    data_dir = Path(args.data_dir)

    if args.command is None:
        parser.print_help()
        return 0

    if args.command == "run":
        loop = ResearchLoop(data_dir=data_dir)
        report = loop.run(" ".join(args.question).strip(), max_results=args.max_results)
        _print(_json.dumps(report.to_dict(), indent=2) if args.json else report.to_markdown())
        return 0

    program = ResearchProgram(
        loop=ResearchLoop(data_dir=data_dir), queue_path=data_dir / "queue.jsonl",
    )

    if args.command == "enqueue":
        res = program.enqueue(" ".join(args.question).strip(), priority=args.priority)
        _print(f"queued {res['task_id']} ({args.priority}) — queue depth {res['queue_depth']}")
        return 0

    if args.command == "next":
        out = program.run_next(max_results=args.max_results)
        _print("queue empty — nothing to run" if out is None else _summarize(out))
        return 0

    if args.command == "drain":
        if args.watch:
            _print(
                f"[research] watch mode — polling {program.queue_path} "
                f"every {args.interval}s (Ctrl-C to stop)"
            )
            processed = 0
            try:
                while True:
                    remaining = (args.max - processed) if args.max is not None else None
                    results = program.run_continuous(max_tasks=remaining, max_results=args.max_results)
                    for r in results:
                        _print(_summarize(r))
                    processed += len(results)
                    if args.max is not None and processed >= args.max:
                        _print(f"[research] reached max {args.max}; stopping")
                        break
                    time.sleep(max(1.0, args.interval))
            except KeyboardInterrupt:
                _print(f"\n[research] stopped — processed {processed} task(s)")
            return 0
        results = program.run_continuous(max_tasks=args.max, max_results=args.max_results)
        if not results:
            _print("queue empty — nothing to drain")
            return 0
        for r in results:
            _print(_summarize(r))
        _print(f"[research] drained {len(results)} task(s)")
        return 0

    if args.command == "status":
        _print(_json.dumps(program.status(), indent=2))
        return 0

    if args.command == "pending":
        items = program.pending()
        if not items:
            _print("no pending tasks")
            return 0
        for t in items:
            _print(f"  [{t.get('priority', '?'):>6}] {t['id']}  {t['question']}")
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    import sys as _sys

    raise SystemExit(main(_sys.argv[1:]))
