# Open-Video Research (Σ₀ editor flywheel)

Temporary analysis of **open-license / public-domain** video to learn *observable*
editing priors. Driven by [`scripts/open-video-research.js`](../../scripts/open-video-research.js).

**The rule: download → analyze → DELETE.** Source videos never persist. Only the
extracted features below are kept.

```
features/         # features.jsonl — one observable-feature record per analyzed clip (git-ignored; per-machine)
editing_priors/   # snapshots/history of aggregated priors (optional)
reports/          # hour_NN.md research notes you write while running the loop
```

The aggregated priors live at the repo root in
[`editing_priors.json`](../../editing_priors.json) (regenerate with `--aggregate`).

## What is and isn't measured

| Kept (observable) | NOT collected |
|---|---|
| hook strength (first 3s motion), cut rate, scene changes, motion avg/variance, audio peaks, facecam corner/bounds, safe-zone status | the source video, retention / completion / replays / watch-time (private creator analytics — see the doc) |

See [docs/SIGMA0-OPEN-VIDEO-RESEARCH.md](../../docs/SIGMA0-OPEN-VIDEO-RESEARCH.md) for the full method and honesty boundaries.
