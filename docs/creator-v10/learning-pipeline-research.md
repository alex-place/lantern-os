# Creator Dashboard — Learning Pipeline Research

**Status:** research + first build increment shipped (analytics calibration module)
**Date:** 2026-06-19
**Scope:** how the creator dashboard should learn the "editing language" of high-performing short videos, grounded in what the repo actually contains today.

This document responds to a proposed three-layer training pipeline (viral structure
extraction → multimodal embeddings → human-preference/RLHF). The proposal is
directionally right, but a literal implementation collides with three hard walls
and with this repo's own honesty rules. Below is what exists, what's wrong with the
naïve version, the honest reframe, and the first piece built against it.

---

## 1. What exists today

The creator stack has **two halves that don't talk to each other.**

### Half A — Python "viral training" pipeline
`scripts/youtube_shorts_collector_v2.py` → `lib/v10_feature_extractor.py` →
`models/train_xgboost_v10.py`, with a 6-hour retrain daemon
(`scripts/v10_training_loop.py`).

- **Every "Σ₀ feature" is computed from *metadata text*, not video.** In
  `lib/v10_feature_extractor.py`:
  - `hook_strength` = ALL-CAPS ratio + `!` count in the **title**
  - `motion_proxy` = action **keywords** in the title + view velocity
  - `entropy_proxy` = title character randomness
  - `retention_proxy` = comment ratio + duration
  None of it decodes a single frame.
- The collector defaults to `use_cached_api=True` → **mock data**. The
  "5000 real Shorts, motion +34% views — VALIDATED" finding (commit `d1544d2f`)
  ran on synthetic data and **does not replicate** on real samples — see §6.

### Half B — JS V10 engine
`src/creator-intelligence/scoring/`.

- This half **measures real signals**: `apps/lantern-garage/lib/highlight-engine.js`
  runs ffmpeg motion/audio/scene/gameplay-density on the operator's **own**
  uploaded clip, and `viral-score-v10.js` scores from that real `HighlightTimeline`
  (exposed under `scoreV10.viral.signals`: `cutsPerMin`, `coverage`,
  `timeToFirstEventSec`, `gapCV`, `audioActivityPerMin`, …).
- But it has **no ground-truth outcomes**, so by design it labels everything
  `calibrated:false` / "structural estimate, not calibrated".

**Net:** the editing-language features the proposal wants exist *for the operator's
own clips* and are *faked-from-title for everyone else's.*

---

## 2. Why the proposal as literally written fails

The proposal's Layer 1 — "analyze thousands of top Shorts/TikToks/Reels; extract
hook duration, cut frequency, zoom events, caption style…" — hits three walls:

1. **No platform API returns editing features.** YouTube/TikTok/IG Data APIs give
   views/likes/title/duration only. Cut frequency, hook timing, and zoom events
   require decoding the actual pixels.
2. **Your own data already proved public virality is a *biased* reward.** The
   5000-shorts analysis found viral = **+35% collapse risk** — optimizing for other
   people's view counts optimizes for flashy-but-degenerate. A reward model trained
   on it learns the wrong objective.
3. **It would violate this repo's own rules.** `CLAUDE.md`'s **External Reality
   Rule** ("nothing accepted without evidence: claim, evidence, confidence, source")
   and the V10 honesty guards already *reject* feature numbers without measured
   provenance. Scraping editing features you cannot actually measure is exactly the
   fabrication the architecture forbids — and a standalone "viral editor brain" is
   the architectural sprawl the single-loop constraint forbids.

---

## 3. The honest reframe

Keep the proposal's three-layer *shape*. Fix the data source so it is honest and
locally buildable. **Stop trying to learn from videos you cannot measure; learn
from the two video sources you legitimately have — your own renders and your own
uploads — calibrated against your own analytics.**

| Layer | Proposal said | Honest version that fits the code |
|---|---|---|
| **1. Structure extraction** | Scrape 100k videos | Measure editing features on clips you *possess* (own renders, own uploads, a small curated reference set you actually have). Use platform APIs **metadata-only**, provenance-tagged. |
| **2. Multimodal embeddings** | CLIP/Whisper/VideoMAE | The real missing layer — and buildable: PySceneDetect → true cut frequency; Whisper → hook type / CTA / caption density; librosa → beat changes. Turns Half-B's proxies into *measured* features. |
| **3. Preference training** | RLHF on views/shares | Calibrate on your **own** YouTube Studio / TikTok analytics export (avg % viewed, retention curve, follows). The only honest reward. Feeds the existing "≥100 labeled edits → calibrated" threshold. |

The public-metadata XGBoost model (Half A) survives only as a **clearly-labeled weak
prior** — and, per finding #2, possibly inverted. It must never masquerade as a
retention predictor.

### Mapping to the Σ₀ single loop (`Observe → Remember → Reason → Act → Verify → Converge`)
- **Observe / Remember** — feature extraction (Layer 1+2) on owned clips, stored
  with provenance.
- **Reason** — the V10 scorer ranks variants from those features.
- **Verify / Converge** — Layer 3 calibration: do our structural signals actually
  predict our real outcomes? This is the loop's Verify stage applied to the scorer
  itself. This is an *extension* of the loop, not a new engine.

---

## 4. Prioritized roadmap

1. **[SHIPPED] Analytics calibration (Layer 3, step 1).** Import the operator's own
   analytics, join each posted short to its stored measured features, and report —
   honestly — whether our signals predict real performance. See §5.
2. **Layer 2 feature service.** Python service (PySceneDetect + Whisper + librosa)
   emitting *measured* editing features, ingested as `own_render`/`own_upload`
   provenance rows. Replaces the title-text proxies with real numbers.
3. **Quarantine Half A.** Relabel the metadata XGBoost output as a weak prior and
   fix the collector's mock-data default. The 5000-shorts finding has now been
   re-checked on real data and is **marked provisional** (§6).
4. **Close the loop.** Once ≥100 labeled outcomes exist, use the calibration
   correlations to re-weight `research/viral_patterns.json` (currently
   `calibrated:false`) and flip the V10 scorer's `calibrated` flag.

---

## 5. Shipped: analytics calibration module

`src/creator-intelligence/calibration/` — gated by the `calibration` feature flag
(`LANTERN_CI_CALIBRATION`, default **off**).

### Files
| File | Responsibility |
|---|---|
| `youtube-analytics-import.js` | Parse a YouTube Studio "Table data" CSV export into normalized outcome rows. Reports only metrics that physically appear; skips the `Total`/empty rows. |
| `outcome-store.js` | Append-only JSONL store of labeled outcomes + a confirmed-link map. Strict validator rejects empty labels, bad links, and non-numeric features. |
| `calibration-engine.js` | Link analytics rows → local entries, ingest confirmed links, report `readiness()` and honest feature↔outcome `correlations()`. |
| `index.js` | End-to-end convenience surface + `loadEntries()` / `importCsvFile()` disk loaders. |

### Data model (`data/creator-intelligence/outcomes/`, git-ignored)
- `outcomes.jsonl` — one labeled row per (entry × imported metrics):
  `{ entryId, videoRef, features, featureProvenance:"own_render", usableForCalibration, outcome, outcomeSource, linkMethod, linkConfidence }`
- `links.json` — confirmed `videoRef → entryId` map for idempotent re-imports.

### Honesty guarantees (all enforced in code, unit-tested)
- A row with **no real metric** is rejected (no empty labels).
- A **fuzzy** title match (< `AUTO_LINK_CONFIDENCE` = 0.92) is **never** written
  automatically — it surfaces under `needsConfirmation` for the operator to confirm.
- Features come only from the entry's measured `scoreV10.viral.signals` /
  `headline`; missing fields are **omitted, never zero-filled**.
- Graduated thresholds: `readiness` = `insufficient_data` until **100** usable rows;
  `correlations` reports nothing below **30**, and is explicitly
  `calibrated:false` ("directional") between 30 and 99.

### Usage
```js
const ci = require("./src/creator-intelligence");
const env = { LANTERN_CI_CALIBRATION: "1" };

// Import a YouTube Studio CSV export; auto-links exact title matches.
const report = ci.calibration.importCsvFile("/path/to/yt-studio-table.csv", {
  // optionally confirm fuzzy/unmatched ones by hand:
  manualLinks: [{ videoRef: "abc123", entryId: "entry-178..." }],
}, env);
// report.needsConfirmation  -> fuzzy matches awaiting confirmation
// report.readiness          -> insufficient_data until 100 labeled outcomes

// Once enough data exists, see which structural signals predict real retention:
ci.calibration.correlations({}, env);
// -> { calibrated, sampleSize, correlations: [{feature, metric, r, n}, ...] }
```

### Tests
`tests/test_creator_calibration.js` (9 checks): CSV parsing (quoted commas,
percents, `m:ss` durations, Total/empty skipping), link proposal (exact→auto,
partial→needs_confirmation, none→unmatched), store validation, ingest
(confirmed-only + feature join + idempotent links), and the
insufficient_data→directional→calibrated threshold progression including exact
Pearson recovery (`r = 1`). Run: `node tests/test_creator_calibration.js`.

### Wired (Phase 2)
- **Route:** `apps/lantern-garage/routes/creator-calibration.js` —
  `GET /api/creator/calibration/status|entries|correlations|recommendations` and
  `POST /api/creator/calibration/import` (`{csvText, manualLinks?, dryRun?}`).
  Flag-gated (clear 403 when off), 5 MB payload cap, no temp file / no multipart
  (the browser reads the CSV client-side and posts text).
- **UI:** `apps/lantern-garage/public/calibration.html` (linked from the dashboard
  header) — tier badge (insufficient / directional / calibrated), readiness
  progress, sample size, an upload-and-confirm flow (exact matches auto-link;
  fuzzy matches wait for confirmation), a correlations table, and **calibrated
  insights kept visually separate from structural estimates** (item 3).
- `calibratedRecommendations()` returns `insufficient_data` until ≥100 usable
  outcomes; only then does it turn strong (|r|≥0.3) real correlations into
  plain-language advice, each carrying its r and n.

### Still open
Per-entry "this short's calibrated outlook" panel (entry.html), and using the
correlations to actually re-weight `research/viral_patterns.json` once calibrated.

---

## 6. Investigation: the Jun-15 "5000 shorts" study was synthetic

**Finding: confirmed synthetic; headline conclusions do not replicate on real data.**

- `analyze_shorts.py` reads `data/youtube/raw_shorts_dataset.jsonl`. Those rows are
  mock output from `youtube_shorts_collector_v2._mock_api_data` — `video_id`
  `"vid_000000"`, `channel_id` `"UCchannel_0"`, hardcoded titles ("Elden Ring Boss
  Fail"), `views` drawn from `lognormvariate`. The collector defaults to
  `use_cached_api=True` and the CLI `--use-mock` defaults to `True`.
- Real samples (`source="youtube_api_real"`, genuine 11-char IDs) only exist in the
  later `top5000_shorts.jsonl` — collected **after** the study.

**Real-data rerun** (`scripts/rerun_shorts_real.py`, same methodology, 790 real rows
— note the file labeled "top5000" actually holds 790 real samples):

| Comparison (top 25% by views vs rest) | Synthetic (Jun-15) | Real (Jun-17) | Verdict |
|---|---|---|---|
| Motion proxy, high vs low | 0.541 vs 0.404 (**+34%**) | 0.795 vs 0.718 (**+11%**) | direction holds, magnitude ~3× inflated |
| Collapse risk, viral vs not | 0.449 vs 0.334 (**+35%**) | 0.456 vs 0.462 (**−1%**) | **does not replicate** |

**Consequences:**
- The "viral shorts trade stability for flashiness → the stability filter is
  justified" conclusion is **unsupported by real data** and is hereby marked
  **provisional/retracted**. Do not cite it.
- The motion→views signal is real but weak (+11%), and `motion_proxy` is a
  title/metadata keyword heuristic, not a measured editing feature — so even this
  validates the metadata *prior*, not the "editing language" thesis.
- Action: the collector's mock default should be flipped (or mock runs clearly
  quarantined to a `*_mock.jsonl` path) so a synthetic dataset can never again be
  mistaken for a real one.
