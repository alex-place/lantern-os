### Added

- **spiral: measured that retrieval-based self-improvement HURTS a 0.5B coder (→ VTD is the path).**
  `experiments/tiny_model_selfimprove.js` builds a verified corpus from SEEN problems and measures
  the tiny model (`qwen2.5-coder:0.5b`) on HELD-OUT problems, baseline vs top-k retrieved
  verified-solution few-shot (leakage-controlled; retrieval from SEEN only). Result on-box, zero
  spend: **baseline 6/6 → +retrieval 2/6** (regressed 4, rescued 0). The raw generations show the
  mechanism: the tiny model *copies the retrieved template's structure* (e.g. shown `min_distance`,
  it wrote an edit-distance-shaped answer to `longest_common_subsequence`, dropping the `+1`) —
  weak in-context learning at this scale means a relevant-but-different example contaminates the
  algorithm. Conclusion: for a model this tiny, coding capability cannot be carried in context; it
  must be baked into the WEIGHTS (Verified-Trace Distillation). A real caveat to the CLAUDE.md
  "improve via retrieval, not retraining" principle at 0.5B, with evidence.
