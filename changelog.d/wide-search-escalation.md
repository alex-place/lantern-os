### Added
- **Wide Web Search view** (`/wide-search.html`) — a Σ₀ research pass widened across an
  escalating-fidelity ladder: fan out angled sub-queries → search them all (MCP → DDG →
  Wikipedia) → prune the pool with the cheap/local model first → escalate only the
  survivors to a stronger model for a grounded answer with inline `[n]` citations.
  Streamed over SSE (`GET /api/research/wide-search`) so the ladder rises live; engine in
  `lib/wide-search.js`. Improves the **Reason** + **Verify** stages (better recall,
  cheap-first compute, every claim mapped to a source).
- **Autowork wide grounding** — `lib/autowork-research.js` `researchIssue()` can now use the
  wide fan-out for its web-grounding step instead of a single narrow query — **on by
  default** for the whole fleet (`AUTOWORK_WIDE_SEARCH=0` falls back to narrow). Returns
  up to 5 cited sources plus a synthesized `webSummary` + `webConfidence` in
  `researchContext`; the fan-out / low-pass / high-pass sub-steps are logged under the
  research phase. Honest no-sources fallback preserved (confidence 0.1, no fabrication).
