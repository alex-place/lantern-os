# Σ₀ Open-Video Research Loop

A continuous, low-copyright-risk flywheel that improves the Σ₀ editor by learning
**observable editing priors** from open-license / public-domain video — then
**deleting the source**. It never retains video, and it never claims metrics it
cannot measure.

Driver: [`scripts/open-video-research.js`](../scripts/open-video-research.js).

---

## The loop

```
download (temp)  →  analyze  →  extract features  →  store features  →  DELETE video
```

The delete is in a `finally` block, so the source is removed **even if analysis
throws**. A caller-owned `--local` file is the only exception (we never delete a
file we didn't fetch).

```bash
# Remote open-license URL (needs yt-dlp): fetch → analyze → delete
node scripts/open-video-research.js "https://archive.org/details/<id>"

# A file already on disk: analyze, do NOT delete it
node scripts/open-video-research.js /path/to/clip.mp4 --local

# Roll up everything collected into editing_priors.json
node scripts/open-video-research.js --aggregate
```

## Approved sources (open license only)

| Source | Use |
|---|---|
| Internet Archive (archive.org) | public-domain gameplay / esports / speedruns / retro |
| YouTube **Creative Commons** (license = CC-BY, reuse allowed) | store `{title, creator, license, url, attribution}` |
| PeerTube instances | gaming / commentary / shorts |
| Wikimedia Commons video | CC / public-domain clips |

`yt-dlp` is required for remote fetch. If it's absent the script says so plainly
(`{"ok":false,"reason":"yt-dlp not installed (ENOENT)"}`) rather than pretending
to download. Attribution travels with each feature record.

## What gets extracted (observable signals only)

Reuses the real analyzers — `highlight-engine.js` (`detectMotion`,
`detectSceneChanges`, `detectAudioSpikes`) and `safe-zone-v2.js`
(`analyzeForCrop`):

| Feature | How |
|---|---|
| `opening_hook_strength` | mean motion in the first 3s, normalized to the clip's peak |
| `cut_rate_per_sec`, `scene_changes` | histogram-difference scene cuts ÷ duration |
| `motion.avg` / `motion.variance` | normalized motion busy-ness and spikiness |
| `audio_peaks` | transient / loudness spikes |
| `facecam` | corner + bounds + confidence from the V2 detector |
| `safezone_status` | whether a safe-zone solution was found |

Motion is normalized per-clip so priors compare across videos (busy-ness 0..1),
not absolute pixel deltas.

## Honesty boundary (important)

**This loop learns *editing priors*, not a retention model.** Public APIs/yt-dlp
expose **views / likes / comments / duration**. They do **not** expose
**retention, completion rate, replays, or watch-time** — those are *private
creator analytics*. So this research **cannot** report "what correlated with
retention" for third-party videos; any such claim would be fabricated.

- **Open-license videos → observable editing priors** (this doc).
- **Retention / completion correlations → only from your own published Shorts**,
  where you actually have the analytics. That is a separate, first-party path
  (`retention-predictor-v10.js`), not this loop.

This split matches the project's external-reality rule: every claim needs
evidence; we don't invent the evidence we lack.

## Σ₀ integration

- **`editing_priors.json`** (repo root) is the learned store. It ships with
  `samples: 0` and all-null values — the editor uses its built-in defaults until
  the loop has analyzed a real corpus. Nulls are honest emptiness, not findings.
- **Never-zero / min-2 segments**: `variant-engine-v10.js` now guarantees **≥ 2
  segments** per variant. If real highlights are sparse it tops up with
  explicitly-tagged fallback windows (score 0.5, `"fallback"` tag) — never
  fabricating quality. A clip too short to yield a 2nd window stays as-is.
- **Next wiring (not yet done):** have `score-v10.js` / `highlight-engine.js`
  read `editing_priors.json` to bias hook scoring, target cut rate, and default
  facecam corner once `samples > 0`.

## Status / verification (2026-06-18)

- ✅ Flywheel verified end-to-end on a local clip: source existed → analyzed →
  **deleted**; real features extracted (hook 0.33, cut-rate 3.39, motion-avg
  0.23, facecam bottom-left @0.64).
- ✅ `--aggregate` writes `editing_priors.json`.
- ✅ Min-2 guarantee tested across 0/1/3-highlight and short-clip cases (all ≥ 2).
- ✅ `yt-dlp`-missing path reports honestly.
- ⏳ **No live corpus has been collected** (`yt-dlp` is not installed in this
  environment). `editing_priors.json` is therefore the empty seed. Install
  `yt-dlp`, point the script at open-license URLs, then `--aggregate`.
- ❌ No hour-by-hour "findings" or retention correlations are included, by design
  (see the honesty boundary).
