### Added
- **GPU training orchestration** (`apps/lantern-garage/routes/gpu-training.js`) — full
  REST API for the free-tier GPU rotation loop: `GET /api/gpu-training/providers`,
  `GET /api/gpu-training/status`, `POST /api/gpu-training/dispatch`, `POST /api/gpu-
  training/poll`, `POST /api/gpu-training/test`, and `GET|POST /api/gpu-training/keys`.
  Provider state is governed by `data/pcsf/gpu-training.pcsf.json` (Kaggle → Colab →
  SageMaker → Lightning AI → HuggingFace checkpoint transport, 102 h/week total free quota).
- **API key management UI** (`public/orchestration.html`) — collapsible panel lets Alex
  enter and save Kaggle, Lightning AI, Paperspace, and HuggingFace keys directly in the
  browser; keys are persisted to Windows User-scope env via PowerShell and loaded back
  into `process.env` on demand. Never string-interpolated: value is passed via child env
  `__GPU_KEY_VAL` to prevent injection.
- **HuggingFace checkpoint transport** — `HF_TOKEN` + `HF_TRAINING_REPO` wired into the
  Kaggle dispatch script and `lib/training-dispatcher.js`; every completed Kaggle run
  uploads a CSF-packed checkpoint to `lanternfounder/ouro-checkpoints` on HF Hub, enabling
  seamless hand-off to the next provider in rotation.
- **25,067-row FC training dataset** assembled from three permissive public sources —
  Hermes (8,920 rows, Apache-2.0), ToolACE (9,877 rows), xlam-irrelevance (6,051
  negatives, CC-BY-4.0) — plus 219 existing coding examples. Shuffled with seed=42,
  ~25% negatives (Hammer recipe: irrelevance negatives are what fix sub-3B over-
  triggering). Uploaded to `lanternfounder/ouro-checkpoints/training-data.jsonl` (64.9 MB);
  Kaggle dispatch now pulls from HF Hub instead of the cloned repo.
- **Kaggle dispatch: timestamped kernel slugs** — each `POST /dispatch` generates a
  unique `ouro-train-YYYYMMDDHHM` kernel ID + title to avoid Kaggle's 409 Conflict lock
  on kernels that errored or are still being cleaned up.

### Fixed
- `lib/training-dispatcher.js` Kaggle dispatch was training on the 243-row in-repo
  `training-data.jsonl` instead of the full assembled dataset; script now downloads
  `training-data.jsonl` from HF Hub at kernel startup.
- `HF_TRAINING_REPO` env var was mistakenly set to `alex-place/lantern-os` (the GitHub
  repo name); corrected to `lanternfounder/ouro-checkpoints` and persisted to User scope.
