# Safe Zone V2.5 — Confidence-Measured Caption Placement

**Date:** 2026-06-18
**Goal:** Consistent caption/overlay placement on 9:16 shorts — never over the facecam, the YouTube Shorts UI, the kill-feed, or the action — gated by a measured confidence score.

## Why

V2 detected facecam/HUD and planned a crop, but caption placement was inconsistent (sometimes clean, sometimes over the UI/gameplay). V2.5 makes placement **multi-region aware, measured, and self-validating**: it only ships a placement that scores ≥ 0.85.

## Files

| File | Role |
|---|---|
| `apps/lantern-garage/lib/safezone-priors.json` | Fixed Shorts-UI exclusion zones, caption candidate zones, facecam band, confidence weights, EMA params |
| `apps/lantern-garage/lib/safezone-confidence.js` | The 5-component confidence score (pure, testable) |
| `apps/lantern-garage/lib/safe-zone-v25.js` | Orchestrator: detect → candidate retry loop → EMA smoothing |
| `tests/test_safezone_v25.js` | Deterministic validation suite (10 tests) |
| `safezone-debug/` | Debug overlay images (zones drawn on a real frame) |

## Confidence model

```
confidence = 0.25·faceSeparation + 0.25·gameplaySeparation
           + 0.20·uiSeparation   + 0.15·motionStability + 0.15·ocrClearance
```

Each component is `1 − worst overlap` with the relevant region set (1 = fully clear). **Honesty:** every component is a real geometric measurement, and the result carries a `measured` map — `ocrClearance` and `motionStability` are only `true` when the caller actually supplies OCR boxes / a previous placement. When OCR isn't run, clearance defaults to a **conservative 0.85 (not 1.0)** so a number is never inflated by an unmeasured input.

## Multi-region awareness (output 9:16 space)

- **Shorts UI** (fixed): top status, right action rail (like/comment/share/remix), bottom metadata — from `safezone-priors.json`.
- **Facecam**: in the facecam-top layout the cam is the **top band**, so captions avoid that band (output-space-correct — not the source rect).
- **Gameplay**: the action-center zone (+ any HUD/extra regions the caller passes).
- **OCR**: pass `ocrBoxes` (kill-feed/subtitles/scoreboard) and they become hard avoid-zones — verified: a kill-feed in the lower band pushes the caption up to `upper_safe`.

## Retry loop + anti-collapse (Σ₀)

`planCaptionSafeZone` scores **every** candidate zone and picks the best that clears the threshold. Because the candidates are diverse (lower / center / upper / above-facecam), captions can't all collapse onto one bad location — the Σ₀⁻¹ anti-collapse idea applied to placement. If none clears 0.85 it returns the best with `belowThreshold: true` (caller can widen captions / re-crop).

## Temporal consistency

`smoothZone(prev, next)` applies EMA (`alpha 0.35`) so the zone doesn't jitter frame-to-frame; it **re-seeds (snaps)** on a scene cut / facecam move / crop change (`reseedOn`).

## Verification

- **Real gameplay clip:** chose `mid_lower` at **confidence 0.978** — `faceSep/gameplaySep/uiSep = 1.0`, OCR + motion flagged unmeasured. Debug overlay (`safezone-debug/frame_real_conf0.978.png`) shows the green caption zone cleanly clear of the yellow facecam band, red Shorts-UI zones, and orange action-center.
- **Validation suite (`tests/test_safezone_v25.js`):** 10/10 pass. Scenario confidence **avg 0.978 · worst 0.976**. Covers facecam-left/right, fullscreen, heavy-HUD + OCR collision, split-camera, anti-collapse, EMA, scene-cut reseed, and the unmeasured-OCR honesty guard.

## Recommended defaults (Creator Dashboard render)

- Captions → `mid_lower` candidate (the green zone) by default; the loop relocates only when a real region (facecam band / OCR text / HUD) conflicts.
- Threshold `0.85`; EMA `alpha 0.35`; reseed on scene cut.

## NOT done — honest gaps (need assets I don't have here)

- **`easyocr` / `tesseract` and `cv2`/ONNX saliency are pluggable inputs, not bundled.** The scorer consumes `ocrBoxes` (and a saliency map can drive candidate ranking) — wire a real OCR/saliency pass to make `ocrClearance` a *measured* component on live frames.
- **The ≥0.85-across-COD/Minecraft/Roblox/Fortnite acceptance is NOT verified** — there are no such test videos in this repo. The synthetic suite proves the *placement logic*; per-game confidence needs real footage.
- **Per-scene segmentation** is a documented extension: `analyzeVideoSafeZones` currently plans from the clip's aggregate regions; a scene-cut splitter would call `planCaptionSafeZone` per scene and chain them with `smoothZone`.
- **Priors are hand-set, not yet learned** from `data/cc/` + `data/outcomes/` — those folders aren't populated here. The `captionCandidateZones` / weights in `safezone-priors.json` are the place to feed learned priors later.
