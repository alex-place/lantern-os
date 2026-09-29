"""
Build the base grounding index.

Turns the grounding docs (GROUNDING_DOCS below) into a compact, retrievable corpus the
LLM (and the deterministic/near router) can ground on — one record per doc
*section*, with a heading path and a trimmed snippet. Output:

    data/knowledge/index.jsonl   # [{id, doc, path, heading, level, text, tokens}]
    data/knowledge/index.meta.json

Run:
    python scripts/build_knowledge_index.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "data" / "knowledge"

MAX_SECTION_CHARS = 1200

# The grounding corpus used to be scraped from the Knowledge Center library page.
# That page was retired (operator, 2026-09-29), so the corpus is pinned here: the
# CORE required-reading docs plus every doc that was already vetted into the index
# and survived the same cleanup. Add a doc to GROUNDING_DOCS to ground chat on it;
# keep ops runbooks with infrastructure detail out of it (chat can quote any line).
CORE_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", "QUICKSTART.md"]
GROUNDING_DOCS = [
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "QUICKSTART.md",
    "PROVIDERS.md",
    "SKILLS.md",
    "SECURITY.md",
    "docs/ARCHITECTURE.md",
    "docs/adr/README.md",
    "docs/BENCHMARKS.md",
    "docs/CONVERGANCE-SIGMA0-BRIEFING.md",
    "docs/MEMORY-RETRIEVAL.md",
    "docs/SIGMA0-OURO-CODER.md",
    "docs/SIGMA0-EV-GATE.md",
    "docs/KEYSTONE-PRODUCT.md",
    "docs/convergence-io/README.md",
    "CONTRIBUTING.md",
    "docs/EXPLORE-FEED.md",
    "docs/PRIVACY_GOVERNANCE.md",
    "docs/KEYSTONE-LIMITATIONS.md",
    "docs/KEYSTONE-BRAND-GUIDELINES.md",
    "docs/ACCESSIBILITY.md",
    "docs/ACTION-POOLING-AND-BATCHING.md",
    "docs/CHAT-EVAL-RECIPE.md",
    "CODE_OF_CONDUCT.md",
    "UX_STANDARDS.md",
    "docs/CONVERGENCE-LOOP.md",
    "docs/CHATGPT-CONNECTOR-SETUP.md",
    "docs/CLAUDE-CHATGPT-MCP-SETUP.md",
    "docs/GOOGLE-OAUTH.md",
    "docs/mcp-client-setup.md",
    "docs/PATREON-OAUTH.md",
    "docs/KEYSTONE-MCP.md",
    "docs/DREAM-JOURNAL-QUICKSTART.md",
    "docs/MCP-CONNECTOR.md",
    "docs/USER-PROFILES.md",
    "docs/investing-2k-plan-collapse-certificate.md",
    "docs/KALSHI-API-SPEC.md",
    "docs/PORTFOLIO-SETUP.md",
    "docs/trading-api-reference.md",
    "docs/TRADER-ANALYSIS-2026-07.md",
    "docs/UNISONA-SHARPE-CERTIFICATE.md",
    "docs/adr/0006-dual-boot-worktree-topology.md",
    "docs/ARXIV-CORPUS.md",
    "docs/convergence-core-mapping.md",
    "docs/SURFACE-BOUNDARY.md",
    "docs/AGENT.md",
    "THIRD-PARTY-NOTICES.md",
    "docs/KEYSTONE-COCKPIT.md",
    "docs/SIGMA0-MODEL-ADAPTER.md",
    "docs/convergence-io/AAPF.md",
    "docs/adr/0001-record-architecture-decisions.md",
    "docs/adr/0002-single-convergence-core.md",
    "docs/adr/0003-one-canonical-csf-module.md",
    "docs/adr/0004-append-only-memory.md",
    "docs/adr/0005-interchangeable-model-providers.md",
    "docs/adr/0007-monoworkstream-one-pr-lane-per-agent.md",
    "docs/adr/0009-one-routing-contract-cloud-primary-coding.md",
    "docs/adr/0012-nested-adaptive-reason.md",
    "docs/adr/0014-unisona-desktop-launcher.md",
    "docs/adr/0015-qwen-teacher-verified-distillation.md",
    "docs/adr/0016-provider-agnostic-oss-auth.md",
    "docs/adr/0018-web-tier-split-and-cloud-multi-tenancy.md",
    "docs/adr/0019-ibkr-connectivity-client-portal-gateway.md",
    "docs/adr/0020-ibkr-live-order-placement.md",
    "docs/adr/0021-serving-substrate-retain-ouro-custom-loop.md",
    "docs/adr/0022-ibkr-per-user-self-service-oauth.md",
    "docs/adr/0025-rlvr-dreaming-continual-updates-double-gated.md",
    "docs/adr/0026-ternary-serving-artifact-distillation-target.md",
    "docs/adr/0027-one-click-broker-oauth2.md",
    "docs/adr/0028-managed-strategy-sharpe-gate-tax-aware.md",
    "docs/adr/0029-ibkr-streaming-challenger-duel.md",
    "docs/adr/0030-spiral-verified-cascade-harness.md",
    "docs/adr/0031-spiral-coder-arc-agi2-efficiency-target.md",
    "docs/adr/0032-real-money-trading-onboarding.md",
    "docs/adr/0033-apex-max-acceptable-risk-trader.md",
    "docs/adr/0034-moe-core-admission-switched-system-gate.md",
    "docs/convergence-io/CCF.md",
    "docs/convergence-io/CEG.md",
    "docs/CONVERGENCE-ROUTING-ARCHITECTURE.md",
    "docs/CSF-FORMAT-SPECIFICATION.md",
    "docs/convergence-io/DILATION.md",
    "docs/convergence-io/DCF.md",
    "docs/adr/0010-verify-gated-continual-learning-last-resort.md",
    "docs/MCP-DREAM-CHAT-TOOL-PARITY.md",
    "docs/convergence-io/NAP.md",
    "docs/convergence-io/PCSF.md",
    "docs/PATENT-CORPUS.md",
    "docs/adr/0008-end-product-personal-ai-wrapper.md",
    "docs/adr/0011-proprietary-sigma0-base-model.md",
    "docs/adr/0013-subsystem-register-one-loop-gate.md",
    "docs/SUPERFLEET-SWARM-DESIGN.md",
    "docs/adr/0017-surprise-gated-decoding.md",
    "docs/adr/0023-default-profile-foregrounds-the-loop.md",
    "docs/adr/0024-sigma0-frontier-training-program.md",
    "docs/research/question-machine.md",
    "docs/SIGMA0-COLLAPSE-CERTIFICATE.md",
    "docs/research/regulatory-oracle-grounding.md",
    "docs/OSS-BASELINE.md",
    "docs/CONVERGENCE-ORACLE-DESIGN.md",
    "docs/research/convergence-oracle.md",
    "docs/research/explore-content-machine.md",
    "docs/SERVING-ARCHITECTURE-2026.md",
    "docs/SERVING-DEEP-MODE-GUIDE.md",
    "docs/creator-v10/learning-pipeline-research.md",
    "docs/creator-v10/editing-analysis-model-research.md",
    "docs/creator-v10/editing-discovery-engine.md",
    "docs/creator-v10/caption-engine-v3.md",
    "docs/creator-dashboard.md",
    "docs/creator-v10/creator-intelligence-architecture.md",
    "docs/creator-v10/export-validator.md",
    "docs/FACECAM_DETECTION.md",
    "docs/creator-v10/research-dataset-schema.md",
    "docs/creator-v10/safe-zone-v2.md",
    "docs/creator-v10/variant-engine-v2.md",
]

# External (out-of-repo) sources — Human Flourishing Frameworks. RETIRED in the
# grounding rework: HFF is a separate project with no bearing on chat, trading,
# or model research, and it was taking 34 of the library's cards plus 34 entries in the
# Explore/grounding metadata. The card surface no longer renders them, so the index no
# longer advertises them either — leaving them here would let chat cite an unrelated
# corpus. data/knowledge/external-sources.json stays on disk for the record; set
# KEYSTONE_INDEX_EXTERNAL=1 to fold it back in.
EXTERNAL_SOURCES = OUT_DIR / "external-sources.json"


def external_docs() -> list[dict]:
    if os.environ.get("KEYSTONE_INDEX_EXTERNAL") != "1":
        return []
    if not EXTERNAL_SOURCES.exists():
        return []
    try:
        data = json.loads(EXTERNAL_SOURCES.read_text(encoding="utf-8"))
    except Exception:
        return []
    out = []
    for e in data if isinstance(data, list) else []:
        if isinstance(e, dict) and e.get("doc") and e.get("url"):
            out.append(e)
    return out


def knowledge_base_docs() -> list[str]:
    docs = list(CORE_DOCS)
    for d in GROUNDING_DOCS:
        if d not in docs:
            docs.append(d)
    # keep only docs that exist on disk
    return [d for d in docs if (REPO / d).exists()]


def strip_frontmatter(md: str) -> str:
    """Drop a leading YAML frontmatter block (--- ... ---) so doc metadata
    (author/created/updated) doesn't get indexed as the (intro) section."""
    if md.startswith("﻿"):
        md = md[1:]
    m = re.match(r"^---\n.*?\n---\n?", md, re.DOTALL)
    return md[m.end():] if m else md


def split_sections(md: str):
    """Split markdown into (level, heading, body) sections by ATX headings.

    Fenced code blocks are tracked so that `#` comment lines *inside* a ```code```
    block (e.g. `# Run the tests`) are NOT mistaken for markdown headings. Without
    this, real sections got truncated to a bare opening fence (`text: "```bash"`,
    1 token) and bogus headings were minted from shell comments / URLs, which then
    leaked into chat answers as junk ("is ollama running\n```bash")."""
    lines = md.splitlines()
    sections, cur_head, cur_level, buf = [], "(intro)", 0, []
    in_fence = False
    fence_re = re.compile(r"^\s*(```|~~~)")
    for ln in lines:
        if fence_re.match(ln):
            in_fence = not in_fence
            buf.append(ln)
            continue
        m = None if in_fence else re.match(r"^(#{1,4})\s+(.*)", ln)
        if m:
            if buf:
                sections.append((cur_level, cur_head, "\n".join(buf).strip()))
            cur_level, cur_head, buf = len(m.group(1)), m.group(2).strip(), []
        else:
            buf.append(ln)
    if buf:
        sections.append((cur_level, cur_head, "\n".join(buf).strip()))
    return [(lv, h, b) for lv, h, b in sections if b]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    docs = knowledge_base_docs()
    records = []
    for rel in docs:
        p = REPO / rel
        if not p.exists():
            continue
        # Normalize CRLF→LF first: most repo docs are CRLF, and the `^---\n`
        # frontmatter strip (and section splitter) silently failed on `---\r\n`,
        # which leaked YAML frontmatter (author/status/date) into the grounding
        # corpus as an "(intro)" section. Normalizing fixes both.
        raw = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        md = strip_frontmatter(raw)
        for lv, heading, body in split_sections(md):
            text = re.sub(r"\n{3,}", "\n\n", body)[:MAX_SECTION_CHARS]
            rid = hashlib.sha1(f"{rel}#{heading}".encode()).hexdigest()[:12]
            records.append({
                "id": rid, "doc": rel, "path": f"{rel}#{heading}",
                "heading": heading, "level": lv, "text": text,
                "tokens": max(1, len(text) // 4),
            })

    idx = OUT_DIR / "index.jsonl"
    with open(idx, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # External sources: card-only (no text in the committed index). Appended to the
    # doc list + carried in doc_meta so KC/Explore can render+link them upstream.
    ext = external_docs()
    doc_meta = {}
    all_docs = list(docs)
    for e in ext:
        d = e["doc"]
        if d not in all_docs:
            all_docs.append(d)
        doc_meta[d] = {
            "url": e["url"],
            "source": e.get("source", "External"),
            "title": e.get("title") or d.split("/")[-1],
            "external": True,
            "topics": e.get("topics") or ["research"],
        }

    meta = {
        "built_at": time.time(),
        "docs": all_docs,
        "doc_meta": doc_meta,
        "sections": len(records),
        "external": len(ext),
        "sha256": hashlib.sha256(idx.read_bytes()).hexdigest(),
    }
    (OUT_DIR / "index.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"knowledge index: {len(records)} sections from {len(docs)} in-repo docs "
          f"+ {len(ext)} external card-only docs -> {idx}")
    print(f"  sha256={meta['sha256'][:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
