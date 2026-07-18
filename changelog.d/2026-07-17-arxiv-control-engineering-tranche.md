### Added
- **arXiv corpus: curated control-engineering tranche** — event-/self-triggered control papers
  (eess.SY / math.OC; the "schedule interventions from measured decay rates" canon, 2008→2026)
  ingested by id with PDFs, grounding Verify-stage scheduling (chat), rebalance-band timing
  (trade), Q-exit / event-triggered learning (model), and watcher/poller cadences (project).
- `scripts/arxiv_add_papers.py` — curated-add companion to the harvester: ids in, authoritative
  metadata from the arXiv API, same shards/schema/dedup, optional `--pdfs` + `--reindex`.

### Changed
- `lib/arxiv-index.js` retrieval gate now fires on control-engineering questions
  (event-triggered / self-triggered / Lyapunov / model-predictive / rebalancing terms), so the
  tranche is reachable from chat; `docs/ARXIV-CORPUS.md` documents the curated-tranche contract.
