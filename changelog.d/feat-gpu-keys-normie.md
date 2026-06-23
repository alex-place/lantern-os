### Added
- Orchestration GPU Training panel now has a **"Connect your free GPU accounts"**
  section: per-provider cards (Hugging Face, Kaggle, Lightning AI, Modal, Vast.ai,
  RunPod, Paperspace) with plain-English blurbs, "Get your key ↗" links, friendly
  field labels, masked saved-state, and inline Save. Wires the existing
  `GET/POST /api/gpu-training/keys` backend that previously had no UI. Keys stay
  on-machine (Windows user env), never uploaded.

### Changed
- Rewrote the GPU Training section copy in normie language (what training is, what
  each key is for, Auto-rotate explained) and grouped it into clear
  Status / Connect accounts / Start a run / Recent runs subsections.

### Fixed
- GPU Dispatch/Poll/Refresh buttons were dead — their inline `onclick` handlers
  referenced functions trapped inside the page IIFE (undefined on `window`). The
  GPU handlers are now exposed on `window`, so the buttons work.
