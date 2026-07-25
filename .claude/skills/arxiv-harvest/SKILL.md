---
name: arxiv-harvest
description: Run the daily arXiv corpus harvest + index rebuild for F:\arxiv-corpus (BM25 corpus behind KEYSTONE_ARXIV_RETRIEVAL and the novelty-verification protocol). Use when the user types /arxiv-harvest, says "harvest arxiv", "update the arxiv corpus", "refresh the paper index", or when a citation-audit finds the local corpus stale. Replaces the removed KeystoneArxivHarvest scheduled task (operator, 2026-07-24) — on-demand now; run it at least weekly to keep novelty checks honest.
---

# arXiv harvest — keep the local research corpus fresh

The corpus lives at `F:\arxiv-corpus` (index/ + raw/ + pdfs/). The novelty-verification protocol
(docs/research/2026-07-23-ai-novelty-verification-protocol.md) depends on it being current —
a stale corpus silently weakens citation audits.

## Run

1. Preferred (the exact job the old task ran):
   `powershell -NonInteractive -ExecutionPolicy Bypass -File F:\arxiv-corpus\run-daily-harvest.ps1`
2. If F: or that script is unavailable, the repo fallback:
   `python scripts/arxiv_harvest.py` then `python scripts/arxiv_build_index.py`
3. Verify: `F:\arxiv-corpus\logs\` has a fresh entry and the index mtime advanced; report how many
   new papers landed and the new corpus size.
4. If the harvest errors on network, it needs egress — run outside the sandbox
   (dangerouslyDisableSandbox) or tell the user to run the command.

Never run two harvests concurrently (the index rebuild is not concurrent-safe).
