# YouTube Shorts Research Pipeline - 12 Hour Continuous Learning

**Objective:** Learn editing patterns from YouTube Shorts metadata to automatically generate 3 variant Shorts when users upload gaming videos to Lantern.

**Not scraping:** Metadata only. No video downloads, no cloning, no copyright infringement.

---

## Quick Start

```bash
# Install dependencies
pip install xgboost numpy requests

# Set YouTube API key
export YOUTUBE_API_KEY=your_api_key_here

# Run 12-hour research pipeline
python scripts/shorts_research_loop.py --hours 12

# Or test with shorter duration
python scripts/shorts_research_loop.py --hours 1
```

Expected runtime: **12 hours of continuous learning**

---

## What It Learns

### 1. Hook Strength
From first 2 seconds of Shorts:
- Title intensity (word count, punctuation)
- Caption availability & density
- Early visual activity
- Initial cut timing

### 2. Motion Score
Video pacing characteristics:
- Scene change frequency
- Frame-to-frame activity
- Gameplay density
- Action intensity

### 3. Entropy / Visual Variety
Diversity of visual elements:
- Transition variety
- Scene composition changes
- Color/lighting changes
- Pacing variation

### 4. Gaming Intensity
Gaming-specific metrics:
- HUD detection (health, ammo)
- Killfeed presence
- Minimap activity
- Facecam placement
- Gameplay % (vs. cutscenes)

### 5. Retention Estimate
Composite prediction:
```
retention = 0.35*hook + 0.25*motion + 0.20*entropy + 0.20*gaming
```

---

## Data Collection

### Search Categories (Continuous Loop)

```python
queries = [
    "most viewed youtube shorts",
    "gaming shorts",
    "minecraft shorts",
    "fortnite shorts",
    "roblox shorts",
    "warzone shorts",
    "cod shorts",
    "apex legends shorts",
    "stream highlight shorts",
    "funny gaming shorts",
    "viral gaming shorts",
    "best youtube shorts",
]
```

### What's Collected

Per video:
- `id` - YouTube video ID
- `title` - Video title
- `views` - View count
- `likes` - Like count
- `comments` - Comment count
- `duration` - Video length (seconds)
- `published` - Upload timestamp
- `channel` - Channel name
- `tags` - Extracted keywords
- `thumbnail` - Thumbnail URL (downloaded, not full video)
- `caption_available` - Boolean

### Storage

```
data/youtube/
├── raw_shorts.jsonl           # All collected metadata
├── gaming_shorts.jsonl        # Filtered gaming Shorts
├── shorts_features.jsonl      # Computed features (retention, scores)
└── thumbnail_cache/           # Downloaded thumbnails only
```

---

## Feature Extraction

For each collected Short, the pipeline computes:

```json
{
  "video_id": "dQw4w9WgXcQ",
  "title": "Insane Minecraft Clutch...",
  "views": 150000,
  "likes": 3500,
  "comments": 280,
  "duration": 45,
  "engagement_rate": 0.0253,
  "hook_strength": 0.75,
  "motion_score": 0.62,
  "entropy_score": 0.58,
  "gaming_score": 0.95,
  "retention_estimate": 0.72
}
```

---

## Model Training

### Continuous Training Schedule

- **Every 50 videos:** Compute feature statistics
- **Every 500 videos:** Assess model performance
- **Every 1000 videos:** Retrain XGBoost model

### Model Configuration

```python
xgboost.XGBRegressor(
    max_depth=8,              # Deeper trees for complex patterns
    n_estimators=300,         # More estimators with low learning rate
    learning_rate=0.05,       # Slow, stable learning
    subsample=0.8             # 80% sampling for stability
)
```

### Model Outputs

- `models/shorts_xgb_latest.json` - Trained XGBoost model
- `models/sigma0_weights.json` - Feature importance weights

---

## Sigma0 V10 Integration

### Feature Weights Feed Chain

```
Research Pipeline (12h)
    ↓
Collect & analyze 6,000+ Shorts
    ↓
Extract 6,000+ feature vectors
    ↓
Train 6+ XGBoost models
    ↓
models/shorts_xgb_latest.json
    ↓
Sigma0V10MLWeights.updateFromTrainedModel()
    ↓
models/sigma0_weights.json (updated weights)
    ↓
Next uploaded video → Auto-score with learned weights
```

### How User Upload Works

**User uploads 40-minute gaming video:**

```
1. VideoPipelineDebugger analyzes video
   ├─ Extracts segments
   └─ Computes hook/motion/entropy/gaming scores

2. Sigma0V10MLWeights.scoreSegments()
   ├─ Normalizes features using learned stats
   ├─ Applies trained weights
   └─ Produces ranked segments

3. antiCollapse() operator
   ├─ Detects uniform/collapsed scoring
   └─ Forces diversity if needed

4. generateVariants() produces 3 Shorts
   ├─ Variant A: Viral (high-motion peaks)
   ├─ Variant B: Balanced (hook + sustain)
   └─ Variant C: Cinematic (visual variety)

5. Render all 3 variants in parallel
   └─ Save to Creator Dashboard
```

---

## Variants Generated

### Variant A: Viral 🚀
- **Strategy:** Highest motion + gaming intensity
- **Best for:** Action clips, kills, clutches
- **Characteristics:** Fast cuts, high energy
- **Typical duration:** 15-30 seconds

### Variant B: Balanced ⚖️
- **Strategy:** Strong hook + sustained engagement
- **Best for:** Story-driven gameplay, progression clips
- **Characteristics:** Good intro, consistent pacing
- **Typical duration:** 30-45 seconds

### Variant C: Cinematic 🎬
- **Strategy:** Visual variety + smooth transitions
- **Best for:** Highlight reels, montages
- **Characteristics:** Diverse angles, artistic pacing
- **Typical duration:** 45-60 seconds

---

## Anti-Collapse Operator

**Problem:** If all segments score similarly, variants collapse to the same output.

**Solution:** Force diversity if score variance < 0.01

```javascript
if (scoreVariance < 0.01) {
  // Spread scores across segments
  segments.forEach((seg, idx) => {
    seg.score += (idx % 5) * 0.1;
  });
}
```

**Result:** Even weak videos produce 3 distinct variants.

---

## Runtime Behavior

### Typical 12-Hour Session

```
Hour 1:
  - Query 120 Shorts (12 queries × 50 batch size)
  - Extract 120 features
  - Total dataset: 120

Hour 2-3:
  - Query 240 Shorts
  - Extract 240 features
  - Total dataset: 360
  - Feature stats computed

Hour 4-12:
  - Query 960 Shorts
  - Extract 960 features
  - Train XGBoost (every 1000)
  - Total dataset: ~5,500 Shorts

Final Report:
  - 6,000 Shorts collected
  - ~6,000 features extracted
  - 6 models trained
  - Sigma0 weights updated
```

### Hourly Logging

```
[2025-06-16 10:00:00] Starting research pipeline...
[2025-06-16 10:05:12] CYCLE 1 | 0.0h elapsed | 12.0h remaining
[2025-06-16 10:05:12] 📡 Querying: 'most viewed youtube shorts'
[2025-06-16 10:05:18]   ✓ Collected 50 new shorts (gaming: 12)
[2025-06-16 10:05:20]   ✓ Extracted 50 feature vectors
[2025-06-16 10:05:22] 📊 Report: 50 shorts, 50 features computed
[2025-06-16 10:05:23] ⏰ Sleeping 5s before next query...
...
[2025-06-16 22:00:00] 🏁 RESEARCH PIPELINE COMPLETE
[2025-06-16 22:00:00] Total runtime: 43200s
[2025-06-16 22:00:00] Shorts collected: 6000
[2025-06-16 22:00:00] Features computed: 5998
[2025-06-16 22:00:00] Models trained: 6
```

---

## Output Files

After 12-hour run:

```
data/youtube/
├── raw_shorts.jsonl (6000 rows)
│   └─ All collected Shorts with metadata
├── gaming_shorts.jsonl (2400 rows)
│   └─ Filtered gaming category
└── shorts_features.jsonl (5998 rows)
    └─ Computed features (hook, motion, entropy, gaming, retention)

models/
├── shorts_xgb_latest.json
│   └─ Trained XGBoost regressor
└── sigma0_weights.json
    └─ Feature importance weights

reports/
├── research_1718500000.json
├── research_1718503600.json
├── ... (hourly reports)
└── research_1718543200.json (final)

shorts_research.log
└─ Complete execution log
```

---

## Integration Checklist

- [ ] YouTube API key set: `export YOUTUBE_API_KEY=...`
- [ ] Python dependencies: `pip install xgboost numpy`
- [ ] Verify script exists: `ls scripts/shorts_research_loop.py`
- [ ] Create data directories: `mkdir -p data/youtube models reports`
- [ ] Run test: `python scripts/shorts_research_loop.py --hours 0.1` (6 minutes)
- [ ] Monitor output: `tail -f shorts_research.log`
- [ ] Wire `Sigma0V10MLWeights` into video upload handler
- [ ] Test variant generation with test video

---

## API Rate Limits

YouTube API quota management:

- **Default quota:** 10,000 units/day
- **Per query cost:** ~100 units
- **This pipeline:** ~600 units/hour = 7,200 units/12h

**Safe operation:** Well within quota

**If hitting limits:**
- Reduce `--batch-size` (default 50, try 25)
- Increase sleep between queries
- Split into multiple 6-hour sessions

---

## Integration with VideoPipelineDebugger

```javascript
// When user uploads video:
const debugger = new VideoPipelineDebugger();
const result = await debugger.processVideo(videoPath, videoId);

// Score using ML weights:
const scorer = new Sigma0V10MLWeights();
const analysis = scorer.analyzeAndScore(result.renderConfig);

// Generate variants:
const variants = analysis.variants;  // A, B, C

// Render all 3:
variants.forEach(variant => {
  renderShort(videoPath, variant);
});
```

---

## Testing the Pipeline

### Quick Test (6 minutes)
```bash
python scripts/shorts_research_loop.py --hours 0.1
```

### Verify Output
```bash
# Check that files were created
ls -lh data/youtube/
ls -lh models/
ls -lh reports/

# View sample features
head -5 data/youtube/shorts_features.jsonl | jq '.'

# Check final report
cat reports/research_*.json | jq '.stats'
```

### Monitor in Real-Time
```bash
# In separate terminal:
tail -f shorts_research.log
```

---

## Expected Results After 12 Hours

✅ **6,000 Shorts analyzed** from YouTube metadata  
✅ **~6,000 feature vectors** computed  
✅ **6+ XGBoost models** trained  
✅ **Sigma0 weights** updated with learned patterns  
✅ **Variant generation** now understands hook/motion/entropy/gaming  

**When next video uploaded:**
- Automatically scored using learned patterns
- 3 variants generated (Viral, Balanced, Cinematic)
- All available in Creator Dashboard

---

## What NOT to Do

❌ Do NOT download full video files  
❌ Do NOT clone or reproduce creators' edits  
❌ Do NOT attempt to re-upload others' content  
❌ Do NOT bypass YouTube API limits  

**What we DO:**
✅ Learn statistical patterns from metadata  
✅ Extract structural characteristics (timing, pacing)  
✅ Apply learned patterns to Lantern's own editing  
✅ Generate original Shorts respecting API limits  

---

## Troubleshooting

### "API key not set"
```bash
export YOUTUBE_API_KEY=your_key_here
python scripts/shorts_research_loop.py --hours 12
```

### "No modules named 'xgboost'"
```bash
pip install xgboost numpy
```

### "Research pipeline slow"
- Check `tail -f shorts_research.log` for API errors
- Verify internet connection
- Reduce batch-size: `--batch-size 25`

### "No features extracted"
- Check `data/youtube/raw_shorts.jsonl` exists
- Verify line count: `wc -l data/youtube/raw_shorts.jsonl`
- Check for parsing errors in log

### "XGBoost not training"
- Need 100+ features minimum
- Check feature file: `wc -l data/youtube/shorts_features.jsonl`
- Wait for first 1000 videos to collect

---

## Next Steps

1. **Set API key:** `export YOUTUBE_API_KEY=...`
2. **Run test:** `python scripts/shorts_research_loop.py --hours 1`
3. **Monitor:** `tail -f shorts_research.log`
4. **Verify:** Check `data/youtube/` and `models/` directories
5. **Integrate:** Wire `Sigma0V10MLWeights` into upload handler
6. **Test upload:** Upload video, verify 3 variants generated
7. **Run full 12h:** `python scripts/shorts_research_loop.py --hours 12`

---

## Summary

**This pipeline:**
- ✅ Learns from real YouTube Shorts
- ✅ Extracts 5 key features
- ✅ Trains ML models automatically
- ✅ Updates Sigma0 with learned weights
- ✅ Generates 3 variants for every upload
- ✅ Respects copyright + API limits
- ✅ Runs continuously for 12 hours
- ✅ Produces 6,000+ analyzed Shorts

**Result:** Lantern's editor becomes smarter, generating better Shorts automatically based on real YouTube patterns.

Ready to run. Start with test, monitor logs, integrate weights, deploy.
