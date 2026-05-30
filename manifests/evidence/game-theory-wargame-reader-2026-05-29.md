# Game Theory / Wargame Reader Pack - 2026-05-29

Status: local-file Lantern Reader and RAG intake artifact.

Scope: only the five user-named PDFs in `C:\Users\alexp\Downloads`. No broad
drive search is promoted here.

Extraction method: Python `pypdf` metadata, page counts, SHA256 hashes, and top
term signal from the first 12 pages. Repo output is summary-only and does not copy book text.

## Source Receipts

| Local file | Pages | Bytes | SHA256 | Intake state |
|---|---:|---:|---|---|
| `C:\Users\alexp\Downloads\OsborneRubinsteinMasterpiece.pdf` | 368 | 2238460 | `70733E532FFBCD7A010F5C9FC041DDB07EAB56F9CAACD860E2AD4578FCCD22C8` | summarized only |
| `C:\Users\alexp\Downloads\Prajit-K.-Dutta-Strategies-and-Games_-Theory-and-Practice-The-MIT-Press-1999.pdf` | 384 | 2915456 | `9FC8B1618747F3579F0959CB35D938352B29E65273576753C092C0474B9A9AE6` | summarized only |
| `C:\Users\alexp\Downloads\Complete-Wargames-Handbook-Dunnigan.pdf` | 292 | 2084404 | `49624486B7B26DF25BDE8C1BF362118B798B24081FF4C30B35FFD4E5DBF0C78E` | summarized only |
| `C:\Users\alexp\Downloads\AD1038115.pdf` | 29 | 3057204 | `2B4D7BF6EE3B208A5E3A302E2B287259F018805DE55B58D7C7EB6D4B433B4204` | summarized only |
| `C:\Users\alexp\Downloads\martin_j-_osborne-an_introduction_to_game_theory-oxford_university_press_usa2003.pdf` | 685 | 6582307 | `D5C9774E7D45F971CB2E20D90004F8A2A0DA95A5DBB93227B7D58092D6DD2A0D` | summarized only |

Total local source pages: 1758.

## Compressed Signals

| Source | Signal for Lantern / BETTER |
|---|---|
| Osborne and Rubinstein game-theory text | Core strategy substrate: Nash reasoning, extensive-form games, bargaining, repeated interaction, mixed strategies, and information structure. |
| Dutta strategy-and-games text | Application bridge: examples, auctions, information, case studies, and model-to-practice translation. |
| Dunnigan wargames handbook | Simulation design substrate: rules, scenarios, adjudication, player behavior, and tabletop/computer wargame constraints. |
| AD1038115 wargame/training paper | Public-safe defense-training signal: wargames as structured simulation for understanding force, training, and decision phenomena, not as weapon instruction. |
| Osborne introduction text | Teaching/reference substrate: equilibrium, extensive form, repeated games, subgame reasoning, and economic examples. |

## Lantern Convergence Decision

Promote these PDFs as a strategy-model reader pack, not as raw repo content.

Lantern should absorb them as:

- `game_theory_strategy_reference`;
- `wargame_simulation_reference`;
- `hft_spread_game_model_reference`;
- `adversarial_decision_training_reference`;
- `reader_pack_summary_only`.

Lantern should not use these PDFs to claim:

- live trading edge exists;
- autonomous HFT should execute without human approval;
- wargame material is operational military guidance;
- copyrighted books may be republished into the repo;
- higher confidence exists without current market/orderbook validation.

## Applied To Kalshi / HFT

The useful link to the Kalshi report is strategic, not executable:

- spreads become a maker/taker game, not merely a cost;
- orderbook depth, queue position, cancel risk, and fees become payoff terms;
- adverse selection becomes the opponent model;
- manual approval remains the final move before any real account action;
- paper-trading and simulation are the first HFT lane.

## Reader Link

Open through the Lantern Reader:

```text
http://127.0.0.1:4177/view?path=manifests/evidence/game-theory-wargame-reader-2026-05-29.md
```

## Next Safe Action

Build a small paper-trading simulator that scores spread-capture candidates
against orderbook depth, fee assumptions, fill probability, and max-loss rules.
Do not connect authenticated trading credentials until the simulator and human
approval gate are validated.
