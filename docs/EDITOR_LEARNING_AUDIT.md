# Editor Learning Audit — where Σ₀ V10 scores, ranks, and now adapts

Audit of the V10 editing brain: every weight, threshold, ranking equation, and
fallback rule — and exactly where open-video research priors now feed in.

## Scoring pipeline

```
job-worker → scoreVideoV10(analysis, opts)              src/creator-intelligence/scoring/score-v10.js
   ├─ viralScoreV10(analysis)        8-component structural score   viral-score-v10.js
   ├─ gamingScoreV10(viral, opts)    inferred gaming bonuses        gaming-score-v10.js
   ├─ retentionPredictV10(viral)     completion/share proxy         retention-predictor-v10.js
   └─ editorGradeV10(viral, crop)    A–F grade + safe-zone compliance editor-grade.js

variant-engine-v10.js  builds cut-lists, scores each variant with scoreVideoV10, ranks them
highlight-engine.js    detects the raw motion/scene/audio events the scores are built from
```

## 1. Viral score weights (`research/viral_patterns.json`)

`calibrated: false` — explicitly "DESIGN PARAMETERS, not statistics learned from a proprietary dataset."

| Component | Weight | Equation (from `viral-score-v10.js`) |
|---|---|---|
| hook | **0.15** | `t≤targetMaxSec → 1`, else `(6 − t)/(6 − targetMaxSec)`; `t` = time to first highlight |
| retention | **0.20** | `0.6·min(1, cutsPerMin/12) + 0.4·coverage` |
| emotion | **0.15** | `0.5·min(1, audioActivity/10) + 0.5·audioPeak` |
| surprise | **0.20** | `min(1, multiSignalSpikesPerMin/6)` |
| pacing | **0.10** | `0.6·density + 0.4·(1 − gapCV)` |
| rewatch | **0.10** | `0.7·endPayoff + 0.3·lateSurprise` |
| visualClarity | **0.05** | `1 − 0.5·excessMotionFraction` |
| captionPotential | **0.05** | `0.6·min(1, strongBeats/6) + 0.4·min(1, audioActivity/10)` |

`viralScore = Σ weightᵢ · scoreᵢ` (weights sum to 1). `dataPenalty = 0.15` when 0 highlights.

### Hardcoded thresholds (`signals`)
- `hookSpeed.targetMaxSec = 1.5` (full hook credit under 1.5s; reaches 0 at the hard cap 6.0s)
- `sceneDensity.goodBandPerMin = [12, 40]`, `saturateAtPerMin = 60` (the `12` floor drives retention + pacing density)

## 2. Gaming bonuses (`research/gaming_patterns.json`)
Inferred from audio/scene/motion proxies (NOT OCR/telemetry). Each capped individually + a combined `bonusCapTotal`:
- kill `min(1, multiSignalSpikesPerMin/8)·cap`
- clutch `endPayoff·(0.5+0.5·coverage)·cap`
- reaction `audioPeak·cap` **only if a facecam region is present** (else 0)
- victory `endPayoff·cap`

## 3. Highlight detection (`highlight-engine.js`)
- `detectMotion` fps 5, threshold 0.15 (frame RGB diff)
- `detectSceneChanges` threshold 0.3 (histogram χ²) — emits only frames above threshold (= cuts)
- `detectAudioSpikes` threshold 0.7 (RMS + transient)
- `mergeDetections` → gameplay-first highlights; conversation penalized; min/max highlight 2.0s / 60s

## 4. Variant ranking & fallbacks (`variant-engine-v10.js`)
- `selectSegments` greedily fills `targetSec`, requiring `picked ≥ 2` before stopping
- variants ranked by `viralScore` desc, ties broken by `editorGrade.composite`
- **Never-zero / min-2 guarantee (PR #713):** if `highlights < 2`, top up with explicitly-tagged
  fallback windows (score 0.5, `"fallback"` tag) — real detected peaks are used first (they *are*
  the strongest motion/scene/audio events from `mergeDetections`); temporal windows only fill the gap.
  A clip too short for a 2nd window stays as-is. Verified ≥2 across 0/1/3-highlight and short-clip cases.

---

## Where research priors now feed in (this PR)

`editing-priors-adapter.js` blends the learned open-video priors (`editing_priors.json`) into the
viral-score **weights** — gated at **`samples > 25`**, bounded, renormalized to sum 1:

| Learned prior | Neutral midpoint | Effect (bounded) |
|---|---|---|
| `opening_hook_strength` (0..1) | 0.5 | strong corpus hooks → **hook** weight up to ±30% |
| `motion_target` (0..1) | 0.4 | busier corpus → **surprise** + **pacing** up to ±15% |
| `avg_audio_peaks` | 2 | louder corpus → **emotion** up to ±15% |

**What is deliberately NOT auto-tuned:** the signal **thresholds** (`targetMaxSec`,
`goodBandPerMin`). The research extractor's units differ from the scorer's (e.g. research
`cut_rate` is raw scene-changes/sec; the scorer's `cutsPerMin` is highlights/min), so recentering
those bands automatically would be guesswork. They should be recalibrated only against real
**first-party** outcomes (`retention-predictor-v10.js`), not third-party CC video.

**Honesty:** these are bounded *directional* nudges in the same class as `viral_patterns.json`'s
own design parameters — not a fitted model. With the shipped seed (`samples: 0`) nothing changes
(`priorInformed: false`); the editor only adapts once a real corpus exists. Inspect any adaptation
via `research/weight_deltas.json` (`npm run research-calibrate`).

### Verified
- `samples: 0` → all weight deltas 0, `priorInformed: false`.
- synthetic `samples: 30` (strong hooks) → hook 0.15→0.166, surprise +0.008, renormalized; same clip's
  `viralScore` moves 0.688 → 0.694. The editor is no longer static.
