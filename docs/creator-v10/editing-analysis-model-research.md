# Editing & Analysis Model Research — Improvement Plan

**Status:** research (no code committed beyond this doc)
**Date:** 2026-06-19
**Scope:** concrete, implementable improvements to the two model families behind the
creator dashboard — the **analysis model** (perception: what's in the clip) and the
**editing model** (decision: how to cut/order it). Grounded in the current code and
in current short-form/highlight-detection methods. Builds on
[learning-pipeline-research.md](learning-pipeline-research.md) and the shipped
analytics-calibration module.

Every improvement here obeys the project's two non-negotiables: **no fabricated
metrics** (External Reality Rule) and **one loop, not a parallel engine** — each item
strengthens Observe/Reason/Verify, it does not add a new subsystem.

---

## A. Analysis model (perception)

### Current mechanism (verified in code)
`apps/lantern-garage/lib/highlight-engine.js` runs three ffmpeg passes (motion,
audio loudness, scene difference) over the operator's own clip and merges them into a
`HighlightTimeline`. `viral-score-v10.js → deriveSignals()` then turns that timeline
into the signals the scorer uses.

### Weaknesses (honest)
1. **"Cuts" are not cuts.** `deriveSignals` computes `cutsPerMin = highlights.length / durationMin`
   (`viral-score-v10.js:45`). That's *number of detected highlights*, not the clip's
   real shot-boundary rate. Pacing, retention, and caption-potential all lean on this
   proxy.
2. **Highlight selection is a hand-tuned composite** (gameplay-first weighting). It has
   no notion of *novelty* or *recurrence* — a loud-but-boring repeated moment scores
   like a genuinely surprising one.
3. **No speech understanding.** Hook *type*, CTA placement, and caption density are
   inferred from audio energy, not from what is actually said.
4. **No outcome grounding.** Signals are never checked against where viewers actually
   drop off.

### Improvements

**A1 — Real shot-boundary detection (measured `cutsPerMin`).**
Replace the highlight-count proxy with true shot boundaries. PySceneDetect's
`AdaptiveDetector` (rolling average of HSV frame differences) is the right choice for
gaming's fast motion; `ContentDetector` for talking-head. Best practice from the
project itself applies: *tune the threshold against your own samples* (generate the
stats file, don't trust the default 30 — ~27 is a better starting point). Output: a
measured `cutsPerMin`, `avgShotLengthSec`, and shot-length variance, all with
`own_render` provenance so the calibration set and `score-engine` `FEATURE_KEYS` get a
*real* number instead of a proxy. No new heavy dependency is strictly required — an
honest first cut can reuse the ffmpeg `select='gt(scene,...)'` scores already in the
pipeline; PySceneDetect is the accuracy upgrade.

**A2 — Unsupervised audio-visual recurrence for highlight scoring.**
Current SOTA for *label-free* highlight detection scores moments by how much they
stand out from the rest of the same video (and from a cluster of similar videos) —
"audio-visual recurrence." This fits the honesty rule perfectly: it is
**self-supervised on the user's own clip**, inventing no external labels. Concretely:
embed short windows (audio + visual), score each window by its distance from the
clip's typical window; surprising = far. This replaces "max(motion, audio, scene)"
with a novelty signal and directly attacks weakness #2. Start cheap (per-window
feature distance), upgrade to learned embeddings (VideoMAE/CLIP + audio) later.

**A3 — Speech layer (Whisper) → measured hook/CTA/caption features.**
Transcribe with Whisper; derive *measured* features: hook style (question / claim /
countdown) from the first-window text, CTA presence + timestamp, words-per-second
(true caption density), and silence gaps ("dead air" to cut). This is Layer 2 from the
pipeline research, and it converts three currently-faked features into real ones.

**A4 — Retention-curve alignment (the highest-leverage item).**
The analytics calibration set now exists. YouTube/TikTok expose a **second-by-second
retention curve**, and the platform's own ranking signal is *intro retention* (% past
3 s, target > 70%) and *% viewed*, not total watch time. So: ingest the retention
curve, align it to the edit timeline, and attribute **drop-off cliffs to the specific
edit at that timestamp**. A healthy curve is a gentle decline; a cliff means "something
happened here." This turns the analysis model from "guess what's good" into "learn,
from your own audience, exactly which edits shed viewers." It plugs straight into the
calibration module as a richer outcome than the single `avgPercentViewed` scalar.

---

## B. Editing model (decision)

### Current mechanism
`variant-engine-v10.js` selects and orders real highlight segments into 5 strategy
variants, each re-scored by `scoreVideoV10` and ranked by viral score. Weights are
heuristic priors in `research/viral_patterns.json` (`calibrated:false`).

### Improvements

**B1 — Hook-first assembly against the > 70% intro-retention target.**
Make the first 1–3 s a hard constraint, not a soft score: the opening segment must be
the strongest *novelty* moment (A2) or a strong spoken hook (A3). Current code rewards
an early event; the change is to *guarantee* a high-intro-retention opener because that
is the single measured lever the algorithm rewards most.

**B2 — Drop-off-aware cutting (needs A4 + calibration).**
Once retention curves are aligned, penalize segment *types* that historically precede
cliffs in the operator's own data, and favor those that hold a flat curve. This is the
editing model consuming the Verify stage — the first genuinely *calibrated* editing
decision, gated behind the same ≥100-outcome threshold as everything else.

**B3 — Curiosity-stacking / open-loop ordering.**
Order segments so each delivers one payoff while opening the next loop, rather than
front-loading all payoffs. Implementable now as an ordering heuristic over the existing
segment scores; validate later via B2.

**B4 — Calibrated re-weighting of the priors.**
Today `viral_patterns.json` weights are fixed guesses. Once `calibration.correlations()`
is calibrated, use the measured feature↔outcome correlations to *re-weight* the
components (with shrinkage toward the priors, never a hard overwrite), and flip
`calibrated:true`. This closes the loop: Observe (A1–A3) → Reason (score/variant) →
Verify (A4/calibration) → Converge (B4).

---

## Prioritization

| # | Item | Effort | Unblocks | Honesty risk |
|---|------|--------|----------|--------------|
| 1 | **A1** real shot boundaries | low (reuse ffmpeg) → med (PySceneDetect) | real `cutsPerMin` everywhere | none |
| 2 | **A4** retention-curve alignment | med | B2, true calibration | none (own data) |
| 3 | **A3** Whisper speech features | med | real hook/CTA/caption | none |
| 4 | **A2** recurrence highlight scoring | med→high | better selection | none (self-supervised) |
| 5 | **B1** hook-first assembly | low | intro-retention gains | none |
| 6 | **B4** calibrated re-weighting | low (after #2) | `calibrated:true` | gated by data |

**Recommended order:** A1 → A4 → A3 → B1 → A2 → B2/B4. A1 and A4 are the foundation:
A1 makes the headline pacing feature real; A4 + the shipped calibration set make the
*editing* decisions answerable to the operator's actual audience instead of priors.

## Validation (consistent with the honesty rule)
- A1: compare measured shot boundaries to a hand-counted sample of the operator's own
  clips (tune threshold on those samples, per PySceneDetect guidance).
- A2/A3/A4: store as `own_render` measured features; they earn trust only when the
  calibration correlations show they track real outcomes — never asserted as predictive
  before that.
- B2/B4: stay behind the existing ≥100-labeled-outcome gate; until then the dashboard
  keeps showing structural estimates labeled "not calibrated."

## Sources
- [Unsupervised Video Highlight Detection by Learning from Audio and Visual Recurrence (arXiv 2407.13933)](https://arxiv.org/abs/2407.13933)
- [The Effective Highlight-Detection Model for Video Clips Using Spatial–Perceptual (MDPI Electronics 2025)](https://www.mdpi.com/2079-9292/14/18/3640)
- [Deep Unsupervised Multi-View Detection of Video Game Stream Highlights (arXiv 1807.09715)](https://arxiv.org/pdf/1807.09715)
- [PySceneDetect — Detection Algorithms (ContentDetector vs AdaptiveDetector vs ThresholdDetector)](https://www.scenedetect.com/docs/latest/api/detectors.html)
- [PySceneDetect threshold tuning discussion (issue #246)](https://github.com/Breakthrough/PySceneDetect/issues/246)
- [Ideal YouTube Shorts length & format for retention (OpusClip)](https://www.opus.pro/blog/ideal-youtube-shorts-length-format-retention)
- [How the YouTube Shorts algorithm works in 2025 — intro retention (Shortimize)](https://www.shortimize.com/blog/how-does-youtube-shorts-algorithm-work)

---

## Progress log (autonomous research loop)

- **2026-06-19 — A1 DONE (real shot boundaries).** `highlight-engine.js` now aggregates
  the already-detected scene cuts into a measured `shotBoundaries` block
  (`cutsPerMin`, `avgShotLengthSec`, `shotLengthCV`, count, source `ffmpeg_scene_hsv`,
  `measured` flag) via the pure, testable `computeShotMetrics()`. `viral-score-v10.js
  deriveSignals` prefers the measured cut rate when present and flags
  `cutsPerMinMeasured`, falling back to the highlight-count proxy otherwise;
  `avgShotLengthSec` is exposed and added to the calibration feature keys. Tests:
  `tests/test_shot_metrics.js` (8/8) + calibration regression (12/12).
  No new dependency — reuses existing ffmpeg scene detection (PySceneDetect remains the
  future accuracy upgrade). **Next: A4 (retention-curve alignment).**
  *Note:* work moved to an isolated git worktree (`lantern-os-calib`) after the shared
  tree switched branches mid-edit twice.
- **2026-06-19 — A4 DONE (retention-curve alignment).** New
  `retention-curve-import.js` parses a YouTube "Audience retention" CSV into a
  normalized curve (ratio or % auto-detected); `retention-analysis.js` computes the
  metrics the platforms actually reward — intro retention (3s/ratio), mean retention,
  and the steepest drop-off **cliff** — and `attributeCliffToSegments()` maps that
  cliff to the exact edit segment it lands in, so the editing model can learn which
  edits shed viewers. `retentionOutcomeMetrics()` exposes intro/mean/maxCliffDrop as
  numeric outcomes that flow into the calibration correlations; the recommender knows
  a bigger cliff is worse (`maxCliffDrop` not higher-is-better). Exposed via the
  calibration namespace. Tests: `tests/test_retention_curve.js` (10/10) + A1 (8/8) +
  calibration (12/12). Honesty: sparse/unknown curves yield nulls, never guesses.
  **Next: A3 (Whisper speech → measured hook/CTA/caption features).**
- **2026-06-19 — A3 DONE (speech features).** New `apps/lantern-garage/lib/speech-features.js`:
  `parseWhisperJson()` (tolerant of `{segments}` or bare array) + pure
  `deriveSpeechFeatures(segments, durationSec)` → measured `hookStyle`
  (question/countdown/shock/reaction/text), `wordsPerSec` (real caption density),
  `speechCoverage`, CTA presence/timestamp/position, and `deadAirMaxSec` (largest gap
  to cut). `viral-score-v10.js deriveSignals` surfaces these when
  `analysis.metadata.speech.measured`; numeric ones (`wordsPerSec`, `speechCoverage`,
  `deadAirMaxSec`) added to the calibration feature keys. The Whisper invocation is a
  thin `transcribeToSpeechFeatures()` wrapper that honestly returns `measured:false`
  when the CLI/model is absent (not unit-tested). Tests: `tests/test_speech_features.js`
  (6/6) + A1 (8/8) + A4 (10/10) + calibration (12/12). **Next: B1 (hook-first variant
  assembly against the >70% intro-retention target).** *Pipeline wiring note:* the
  analysis job-worker does not yet call `transcribeToSpeechFeatures` to populate
  `metadata.speech` — that integration (+ optional whisper dependency) is the
  remaining glue for A3 to run end-to-end on uploads.
- **2026-06-19 — B1 DONE (hook-first variant assembly).** `variant-engine-v10.js`:
  `maximum_rewatch` previously opened with the WEAKEST segment (ascending) and
  `story_arc` opened with whatever was chronologically first — both tank intro
  retention (the platform's #1 lever). Now rewatch opens with a strong hook AND still
  ends on the single strongest payoff; story_arc is a cold open (strongest first, then
  chronological). retention/excitement/balanced already opened strong. Every variant
  now exposes `introStrength` (the opener's real segment score, 0-1) — a structural
  hook-strength proxy, explicitly NOT a calibrated intro-retention %. Tests:
  `tests/test_variant_hookfirst.js` (5/5) + A1/A4/A3/calibration regressions all green.
  **Next: A2 (unsupervised audio-visual recurrence highlight scoring).**
- **2026-06-19 — A2 DONE (recurrence novelty).** New `apps/lantern-garage/lib/recurrence-novelty.js`:
  `noveltyScores()` scores each time-window by its robust z-distance (median+MAD) from
  the clip's OWN typical window, in the **salient direction only** (a quiet/still window
  is not a highlight). Label-free / self-supervised — replaces "max(motion,audio,scene)"
  so a loud-but-repeated moment no longer scores like a genuinely surprising one.
  `recurrenceHighlights()` merges high-novelty windows into candidate spans;
  `framesToWindows()` bins the existing motion/audio/scene frame series. HONESTY hard
  guarantee (tested): a UNIFORM clip yields zero novelty everywhere — no min-max
  stretching, no manufactured contrast; <4 windows → no scores. Tests:
  `tests/test_recurrence_novelty.js` (6/6) + all prior regressions green.
  *Wiring note:* not yet fused into `mergeDetections` (would add a `novel` tag /
  blend into the gameplay-first composite) — that integration is the remaining glue.
  **Next: B2 (drop-off-aware cutting — needs the A4 retention curves + calibration).**
- **2026-06-19 — B2 DONE (drop-off-aware cutting).** New
  `src/creator-intelligence/calibration/dropoff-model.js`: `buildDropoffProfile()`
  learns, from cliff-labeled outcomes (A4 attributes each cliff to the segment it
  lands in), a per-tag penalty = normalized cumulative cliff magnitude.
  `dropoffPenalty(segment, profile)` returns the segment's riskiest-tag penalty.
  STRICTLY gated: <100 cliff-labeled outcomes → insufficient_data and penalty 0
  (no-op). `variant-engine-v10.js` now exposes per-variant `dropoffPenalty` and, ONLY
  when a calibrated profile is supplied, discounts the rank key by it
  (`viralScore*(1-0.3*penalty)`) — identical to the prior pure-score rank otherwise.
  Tests: `tests/test_dropoff_model.js` (5/5, incl. no-op-without-profile and
  re-rank-with-profile) + all prior regressions green. *Wiring note:* ingest doesn't
  yet populate `cliffSegment` on outcome rows (needs the retention curve + the entry's
  rendered segment list at import) — that glue feeds real data into this gate.
  **Next: B4 (calibrated re-weighting of research/viral_patterns.json).**
- **2026-06-19 — B4 DONE (calibrated re-weighting). PLAN A1–B4 COMPLETE.** New
  `src/creator-intelligence/calibration/weight-calibration.js`: `calibrateWeights()`
  maps each of the 8 score components to its driving feature signals
  (`COMPONENT_FEATURES`), reads their |r| against the target retention outcome
  (`avgPercentViewed`) from `ci.calibration.correlations`, and blends the priors
  toward the evidence — redistributing ONLY the evidenced components' prior mass, with
  sample-size SHRINKAGE (λ = n/(n+200), capped 0.5). Gated: uncalibrated correlations
  or no mapped-feature evidence → priors returned UNCHANGED with insufficient_data.
  Output is a PROPOSAL; persisting to viral_patterns.json / flipping calibrated:true is
  a separate gated step (not auto-run). Tests: `tests/test_weight_calibration.js` (5/5) +
  full regression sweep green (shot 8, retention 10, speech 6, variant 5, recurrence 6,
  dropoff 5, calibration 12).
  **Next (open-ended deepening): wire A2 noveltyScores into highlight-engine
  mergeDetections (a `novel` tag/blend, with tests).**
- **2026-06-19 — A2 WIRED into mergeDetections (open-ended #i).** `highlight-engine.js`
  now bins its motion/audio/scene frame series into windows (`framesToWindows`),
  scores them (`noveltyScores`), and adds an additive `novel` tag (+0.08 score) to any
  highlight overlapping a window with novelty ≥ 0.5. Fully GUARDED: with <4 windows
  noveltyScores returns [] so `novelHit` is always false and behavior is byte-identical
  to before (verified). A `novel` highlight now also counts as multi-signal, which the
  surprise/pacing scorers already reward. Tests: `tests/test_merge_novel.js` (3/3,
  incl. the too-few-windows guard + unchanged empty-input contract) + full sweep green
  (shot 8, retention 10, speech 6, variant 5, recurrence 6, dropoff 5, weight 5,
  calibration 12). **Next: open-ended #ii — wire A3 transcribeToSpeechFeatures into the
  analysis job-worker to populate timeline.metadata.speech (best-effort, non-fatal).**
- **2026-06-19 — A3 WIRED into the job-worker (open-ended #ii).** New
  `maybeAttachSpeech(timeline, videoPath, durationSec, opts)` in `speech-features.js`:
  flag-gated (`LANTERN_CI_SPEECH=1`, default OFF), fully non-fatal, with an injectable
  `transcribe` fn for testing. `job-worker.js processAnalyzeJob` calls it after analysis
  and before `toJSON()` so V10 scoring picks up `metadata.speech` — wrapped in try/catch
  and a no-op when disabled or when Whisper is absent (timeline byte-identical). Tests:
  `tests/test_speech_attach.js` (4/4) + full sweep green (9 suites). **Next: open-ended
  #iii — wire A4 retention import + cliffSegment attribution into the calibration import
  flow so B2 gets real cliff-labeled data.**
- **2026-06-19 — A4→B2 data path WIRED (open-ended #iii).** New pure
  `enrichFromCurve(points, segments, durationSec)` in `retention-analysis.js` →
  `{outcomeMetrics, cliffSegment{tags,drop,atTimeSec,segmentIndex}}`. `ingest()` accepts
  an additive `retentionByEntryId` map and, per written row, merges the retention
  metrics into `outcome` and attaches `cliffSegment` (rows without a curve are
  untouched). `index.js importCsvText` threads an optional
  `retentionByEntryId:{entryId:{curveText|points, segments, durationSec}}` (parses each
  curve to points). This closes the loop end-to-end: real retention curve → cliff→edit
  attribution → ingested outcome row → consumable by B2's `buildDropoffProfile` (verified
  in-test). Tests: `tests/test_retention_enrich.js` (5/5, incl. additive no-curve case +
  B2 consumption) + full sweep green (10 suites). *Remaining glue:* the HTTP route/UI
  still upload only the analytics table CSV — per-video retention CSVs + the rendered
  segment list aren't collected there yet (programmatic path is complete and tested).
  **Next: open-ended #iv — make B4 callable (a gated `proposeCalibratedWeights` helper /
  endpoint) and add edge-case tests.**
- **2026-06-19 — B4 made callable (open-ended #iv).** `calibration/index.js`:
  `proposeCalibratedWeights(opts)` loads the shipped priors (`viral_patterns.json`
  weights) + the live `correlations()` and returns `calibrateWeights(...)` — gated, so
  with an empty/undersized outcome set it returns insufficient_data and the priors
  UNCHANGED. Also exposes `priorWeights()` (fresh copy). Surfaced as flag-gated
  `ci.calibration.weights` and a new `GET /api/creator/calibration/weights` route. Tests:
  `tests/test_propose_weights.js` (3/3) + flag-gate smoke (off→calibration_flag_off,
  on→insufficient_data with priors) + full sweep green (11 suites).
  **Status: the editing/analysis models, their live-pipeline wiring, and the full
  calibration loop (Observe→Reason→Verify→Converge) are all implemented and gated. The
  branch is at a natural reviewable stopping point (12 commits beyond base 01d2221c).
  Remaining work is UI surfacing (introStrength/novel/speech badges; retention-CSV
  upload) + test hardening — lower-value polish; the loop will continue with small
  validation iterations.**
- **2026-06-19 — UI: surface B1 introStrength on variant cards (open-ended polish).**
  `entry.html` Ranked-Variants cards now show a `Hook*` metric = `introStrength`×100,
  rendered ONLY when the variant carries `introStrength` (old entries unaffected) and
  grouped under the existing "* structural estimate, not calibrated" note — honest, not
  a calibrated retention %. Additive one-line template guard; full module sweep green
  (11 suites). Fixed the stale "(15 commits)" note to the real count (12).
- **2026-06-19 — UI: surface A1 measured cut rate + A3 speech on the V10 score panel
  (open-ended polish).** `entry.html renderScoreV10` now adds a "Measured:" line built
  from `viral.signals`, shown ONLY when actually measured this clip: A1
  `cutsPerMinMeasured` → "X cuts/min", A3 `speechMeasured` → "hook: <style>", "X
  words/s", "CTA (<position>)". Rendered in full-text colour to distinguish from the
  greyed structural-estimate disclaimer; absent (old entries / flags off) → nothing,
  never inferred. Additive/guarded; full module sweep green (12 suites, 72 checks).
  Remaining: a `novel`-tag indicator on a per-highlight list, and the retention-CSV
  upload affordance — both low value.
- **2026-06-19 — API: expose #iii retention curves through the import route
  (open-ended polish).** `routes/creator-calibration.js` POST /import now passes an
  optional `retentionByEntryId` ({entryId:{curveText|points, segments, durationSec}})
  through to `importCsvText` — completing the HTTP surface for the A4→B2 data path
  (previously programmatic-only). Validated defensively downstream (rows without a
  curve unaffected); whole body already size-capped. Additive 3-line passthrough; full
  sweep green (12 suites). A retention-upload *UI* on calibration.html is the only
  remaining (low-value) item; the model/data/loop work is otherwise complete.

---

## Upstream-rebase note (PR to alex-place/lantern-os master)

This branch was rebased from the fork's master onto **upstream** `alex-place/master`, which
had diverged ~43 commits (incl. the **gameplay-first v10** `mergeDetections` that returns
`{highlights, density}`, a restructured site-nav, etc.). All modules + clean additive edits
applied; the only commit **deferred** was the A2→`mergeDetections` *wiring* — upstream's
`mergeDetections` is a different algorithm, so fusing the `novel` tag there is a fresh code
change best done as a follow-up. The tested `recurrence-novelty` module still ships
(`test_recurrence_novelty` green); it is simply not yet imported by `highlight-engine`.
Result on upstream: **14 commits, 11 test suites green.**
