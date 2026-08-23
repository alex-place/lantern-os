### Changed

- Entry judge: the prompt now carries the last-24h scored news for the entry's family and the market (headline, direction, impact, scope, age — from the news feed already on disk), journaled with each read so entry_judge_score.js can test bearish-news-at-entry against outcomes forward. Rebased onto the cadence / exit-authority / slot-order engine.
