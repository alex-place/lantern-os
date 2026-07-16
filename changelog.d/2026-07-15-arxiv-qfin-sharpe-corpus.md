### Added

- research: the local arXiv corpus now covers quantitative finance — harvester keeps `q-fin.PM/TR/ST/RM/CP/MF/PR/GN` (SETS gains `q-fin`, new `--sets` flag backfills one set without re-crawling the others), and the `queryArxiv()` gate passes Sharpe/portfolio/trading-strategy questions, so `!research` grounds trading questions on local post-cutoff papers (~3.4k q-fin papers verified retrievable end-to-end via `scripts/arxiv_query.js`). Improves the Remember stage for the trading lane; same single corpus + BM25 index, no new memory system.
