# Σ₀ V10 Training Pipeline — Quickstart Guide

**Objective:** Grind real YouTube Shorts data → train XGBoost → plug weights into V10 scorer.

**Status:** Ready to run. Phases 1–4 implemented. Phase 5 (integration) is a one-line change.

---

## Installation

```bash
pip install xgboost numpy google-auth-oauthlib google-auth-httplib2 google-api-python-client
```

---

## Quick Start (5 minutes)

### 1. Generate Mock Data (Testing)

```bash
python scripts/youtube_shorts_collector_v2.py --limit 5000
# Output: data/youtube/raw_shorts_dataset.jsonl (5000 realistic mock videos)
```

### 2. Filter Gaming Subset

```bash
python scripts/filter_gaming_shorts.py
# Output: data/youtube/gaming_shorts.jsonl (~3000 gaming videos)
#         data/youtube/general_shorts.jsonl (~2000 general)
```

### 3. Extract Features

```bash
python lib/v10_feature_extractor.py
# Output: data/youtube/features_v10.jsonl
```

### 4. Train Model

```bash
python models/train_xgboost_v10.py
# Output: models/sigma0_v10_xgb.json
#         models/training_report.json
```

### 5. Verify Model

```bash
cat models/training_report.json
# See: feature importance, R² scores, model hyperparameters
```

**Total time:** ~30 seconds (mock data) to ~5 minutes (real API data).

---

## Production Setup (With Real YouTube Data)

### Prerequisites

1. **YouTube API Key**
   ```bash
   # Get from: https://console.cloud.google.com/
   export YOUTUBE_API_KEY="YOUR_KEY_HERE"
   ```

2. **Setup authentication** (for API rate limiting / quotas)
   ```bash
   # See: scripts/youtube_shorts_collector_v2.py line 71
   # Uncomment googleapiclient integration
   ```

### Run Full Pipeline (Once)

```bash
python scripts/v10_training_loop.py --once --interval 6
# Runs: collect → filter → extract → train
# Saves versioned model to models/v10/sigma0_v10_xgb_YYYYMMDD_HHMMSS.json
```

### Run Continuous Loop (Daemon)

```bash
# Terminal 1: Start daemon (every 6 hours)
python scripts/v10_training_loop.py --interval 6

# Terminal 2: Monitor logs
tail -f models/v10/training_log.jsonl | jq '.[] | "\(.timestamp) [\(.event_type)] \(.status)"'
```

---

## Data Flow

```
YouTube Shorts (API)
    ↓
youtube_shorts_collector_v2.py
    ↓
raw_shorts_dataset.jsonl (5000 videos)
    ├─→ filter_gaming_shorts.py
    │       ↓
    ├─ gaming_shorts.jsonl (≈3000)
    └─ general_shorts.jsonl (≈2000)
    ↓
v10_feature_extractor.py
    ↓
features_v10.jsonl (5000 feature vectors)
    ├─ Engagement metrics: views, likes, comments, rates
    └─ Σ₀ proxies: entropy, motion, hook, retention, velocity, surprise
    ↓
train_xgboost_v10.py
    ↓
sigma0_v10_xgb.json (trained model)
    ├─ 500 trees
    ├─ max_depth=6
    └─ feature importance scores
    ↓
→ Load into SigmaZeroV10Scorer (lib/sigma0-v10-scoring.js)
    ↓
creator dashboard analyzer (lib/analyzer-v10.js)
    ↓
Highlight scores for user videos
```

---

## Features Extracted (Σ₀ Aligned)

### Engagement Metrics (Ground Truth)

| Feature | Meaning | Range |
|---------|---------|-------|
| `views` | Total video views | [1, 10M+] |
| `likes` | Like count | [0, 100k+] |
| `comments` | Comment count | [0, 50k+] |
| `engagement_rate` | (likes + comments) / views | [0, 0.1] |
| `like_ratio` | likes / views | [0, 0.05] |
| `comment_ratio` | comments / views | [0, 0.01] |

### Σ₀ Structural Proxies

| Feature | Σ₀ Meaning | How Extracted |
|---------|-----------|---------------|
| `entropy_proxy` | Content diversity (low = collapse) | Title/description randomness + transitions |
| `motion_proxy` | Visual activity (low = static) | Action keywords (kill, clutch, epic) + velocity |
| `hook_strength` | Opening quality (weak = collapse) | First-3-word keyword hits, ALL-CAPS ratio |
| `retention_proxy` | Completion likelihood | Comment ratio + duration efficiency |
| `velocity_score` | Viral growth rate | log(views / days_old) |
| `surprise_gap` | Model calibration | abs(actual_engagement - expected) |

---

## Model Output

### sigma0_v10_xgb.json

XGBoost model ready to load:

```python
import xgboost as xgb
model = xgb.XGBRegressor()
model.load_model('models/sigma0_v10_xgb.json')

# Predict on new videos
features = [log_views, like_ratio, comment_ratio, ..., is_gaming]
score = model.predict([features])[0]
```

### training_report.json

```json
{
  "timestamp": "2026-06-15T10:30:00",
  "model_file": "models/sigma0_v10_xgb.json",
  "n_estimators": 500,
  "max_depth": 6,
  "learning_rate": 0.05,
  "feature_names": [
    "log_views", "like_ratio", "comment_ratio", ..., "is_gaming"
  ],
  "feature_importance": {
    "comment_ratio": 0.32,
    "entropy_proxy": 0.18,
    "motion_proxy": 0.15,
    "like_ratio": 0.12,
    ...
  },
  "status": "trained"
}
```

---

## Integration into V10 Scorer

### Current State

`lib/sigma0-v10-scoring.js` has hardcoded placeholder weights:

```javascript
this.weights = {
  retentionProxy: 0.30,
  cutDensity: 0.18,
  audioVariance: 0.15,
  narrativeEventDensity: 0.20,
  trendAlignment: 0.17,
};
```

### After Training

1. Load the trained model:

```javascript
// In lib/sigma0-v10-scoring.js
const XGBoost = require('xgboost');
const model = XGBoost.load('models/sigma0_v10_xgb.json');
```

2. Replace `scoreSegment()` with:

```javascript
scoreSegment(features, isGaming = false) {
  const vector = featuresToVector(features);
  const modelScore = model.predict([vector])[0];
  
  // Combine with Σ₀ penalty
  const collapseRisk = features.sigma0.collapseRisk;
  const finalScore = modelScore * (1 - collapseRisk * 0.5);
  
  return { score: finalScore, ... };
}
```

---

## Troubleshooting

### "No training data"

```bash
# Check features were generated
wc -l data/youtube/features_v10.jsonl
# Should be ≥ 1000

# Check they're valid JSON
head -1 data/youtube/features_v10.jsonl | python -m json.tool
```

### "Model training failed"

```bash
# Check logs
tail -20 models/v10/training_log.jsonl | jq '.[-1]'

# Verify feature distribution
python -c "
import json
with open('data/youtube/features_v10.jsonl') as f:
    records = [json.loads(line) for line in f]
    print(f'Samples: {len(records)}')
    print(f'Target range: [{min(r[\"target\"] for r in records):.2f}, {max(r[\"target\"] for r in records):.2f}]')
"
```

### "XGBoost not installed"

```bash
pip install xgboost numpy
python -c "import xgboost; print(xgboost.__version__)"
```

---

## Production Checklist

- [ ] YouTube API key set up and quota verified
- [ ] Real data collection running (not mock)
- [ ] ≥5,000 Shorts collected
- [ ] ≥1,000 gaming subset verified
- [ ] Model training loss decreasing (R² > 0.3)
- [ ] Feature importance makes sense (entropy, engagement high)
- [ ] Continuous loop running (every 6 hours)
- [ ] Versioned models in `models/v10/` (timestamped)
- [ ] Integration into `lib/sigma0-v10-scoring.js` done
- [ ] A/B test: V10 vs. old heuristic scorer

---

## Monitoring

### Watch Training Progress

```bash
# Live log
tail -f models/v10/training_log.jsonl | jq '.'

# Summary
python -c "
import json
with open('models/v10/training_log.jsonl') as f:
    events = [json.loads(line) for line in f]
    by_type = {}
    for e in events:
        t = e['event_type']
        by_type[t] = by_type.get(t, 0) + (1 if e['status'] == 'success' else 0)
    print(by_type)
"
```

### Model Performance Over Time

```bash
# Compare model versions
ls -lh models/v10/sigma0_v10_xgb_*.json

# Load latest
latest=$(ls -t models/v10/sigma0_v10_xgb_*.json | head -1)
echo "Latest model: $latest"
```

---

## Next Steps

1. **Run once:** `python scripts/v10_training_loop.py --once`
2. **Verify:** `cat models/training_report.json`
3. **Monitor:** Keep daemon running
4. **Integrate:** Plug weights into V10 scorer
5. **Deploy:** Replace old highlight detection

---

## References

- **Data collection:** `scripts/youtube_shorts_collector_v2.py` (Phase 1)
- **Gaming filter:** `scripts/filter_gaming_shorts.py` (Phase 1B)
- **Feature extraction:** `lib/v10_feature_extractor.py` (Phase 2)
- **Model training:** `models/train_xgboost_v10.py` (Phase 3)
- **Continuous loop:** `scripts/v10_training_loop.py` (Phase 4)
- **V10 Scorer:** `lib/sigma0-v10-scoring.js` (uses trained weights)

**Theory:** [docs/SIGMA0-V10-THEORY-GROUNDING.md](SIGMA0-V10-THEORY-GROUNDING.md)
