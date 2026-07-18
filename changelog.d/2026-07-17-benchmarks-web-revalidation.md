### Changed
- **Benchmarks registry + artifact re-validated against live web SOTA (2026-07-17).** A 5-way parallel
  web fan-out (cross-checked against the local arXiv corpus) refreshed every competitor row in
  `docs/BENCHMARKS.md` and the published Benchmarks artifact. Our own measured numbers are unchanged
  (no eval run since 2026-07-08); the movement is all in the field. Four corrections the cross-check
  caught:
  - **SimpleQA-Verified SOTA jumped 55.6 → 77.5 F1** (Gemini 3.1 Pro Preview) — Gemini 2.5 Pro and GPT-5
    fell out of the live Kaggle top-10; the "~55 is the ceiling" framing was stale.
  - **HumanEval's live board went stale** — flagships (Claude Sonnet 4.5, DeepSeek R1) stopped
    self-reporting, so llm-stats now tops at OSS MiniCPM-SALA 95.1 with a 2024 Claude at #3; our old
    97.6/97.4 no longer appear there.
  - **HaluEval 98.6% detection SOTA is largely a teacher-forced artifact** (PARALLAX, arXiv:2605.17028):
    a text-similarity baseline hits 0.98 and top probes collapse 0.96→0.62 on live text — right where
    our unsupervised Ouro canary (≤0.66) already sits.
  - **"OpenAI Memory 52.9%" mislabel** on LongMemEval fixed — it's a LoCoMo number; OpenAI doesn't run
    LongMemEval. Podium (MemPalace 96.6 / OMEGA 95.4 / ByteRover 92.8) confirmed but flagged as vendor
    self-reports under clashing protocols (Mem0 93%→31.8% standardized).
- **`docs/benchmarks.html` added** — the artifact now has a repo-tracked source (it previously lived
  only as a published claude.ai artifact with no version control).
