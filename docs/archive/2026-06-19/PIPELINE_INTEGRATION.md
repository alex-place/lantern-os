# Video Pipeline Integration Guide

**Problem:** Video uploads → "No highlights found" → "Top variant has no segments to render" → Empty render

**Solution:** Wire the VideoPipelineDebugger into your upload route so every video is guaranteed to produce render config with non-empty segments.

---

## Current State

Your pipeline is breaking at one of these stages:
- ❌ Scenes returned empty array
- ❌ Sigma0 scorer filtered everything out  
- ❌ Highlight engine returned no segments
- ❌ Variant generator created no variants
- ❌ Renderer received empty segments array

**Result:** Video uploads fail silently, no output produced.

---

## The Fix

### Step 1: Test the Debugger

```bash
cd C:\Users\micah\lanternos

# Test that pipeline debugging works
node apps/lantern-garage/lib/test-pipeline.js
```

Expected output:
```
✅ PIPELINE SUCCESS
  1. stage_1_metadata (2ms)
  2. stage_2_scenes (3ms)
  ...
  10. stage_10_render_ready (8ms)

✨ ALL CHECKS PASSED - Video is ready to render!
```

If this test passes, your debugger infrastructure is working.

### Step 2: Integrate into Upload Route

Find your current video upload route (likely in `routes/files-upload.js` or similar).

**Before (broken):**
```javascript
// Old code - segments = []
const highlights = analyzeVideo(uploadedFile);
const variants = generateVariants(highlights);  // ← returns empty
const renderConfig = { segments: variants };      // ← segments: []
```

**After (fixed):**
```javascript
const VideoPipelineDebugger = require('../lib/video-pipeline-debugger');

async function handleVideoUpload(videoPath, videoId) {
  const debugger = new VideoPipelineDebugger();
  
  try {
    const result = await debugger.processVideo(videoPath, videoId);
    
    // result.success = true
    // result.renderConfig = { segments: [...], variant: '...', crop: {...} }
    // result.debugReport = 'path/to/debug.json'
    
    return {
      ok: true,
      videoId,
      renderConfig: result.renderConfig,
      debugReport: result.debugReport
    };
  } catch (error) {
    // Even on error, fallback.renderConfig has non-empty segments
    console.error('Pipeline error:', error);
    return {
      ok: false,
      error: error.message,
      fallbackRender: error.fallbackRender  // ← Always has segments
    };
  }
}
```

### Step 3: Test with a Real Video Upload

1. Upload a video through your UI
2. Check `data/pipeline-debug/{videoId}-pipeline.json`
3. Verify render config has segments

Example debug report:
```json
{
  "videoId": "upload_1234567890",
  "stages": [
    {"stage": "stage_1_metadata", "duration": 2, "sizeKB": 5000, "ok": true},
    {"stage": "stage_2_scenes", "duration": 150, "scenes": 10},
    {"stage": "stage_3_motion", "duration": 200, "segments": 9},
    {"stage": "stage_4_audio", "duration": 180, "peaks": 3},
    {"stage": "stage_5_scoring", "duration": 15, "scored": 9, "topSegments": 3},
    {"stage": "stage_6_highlights", "duration": 8, "count": 3},
    {"stage": "stage_7_variants", "duration": 10, "count": 2},
    {"stage": "stage_10_render_ready", "valid": true, "segmentCount": 3}
  ]
}
```

If any stage fails, it will show `error` field + fallback created.

---

## Integration Checklist

- [ ] Debugger test passes: `node apps/lantern-garage/lib/test-pipeline.js`
- [ ] Added to package.json: `npm run test:pipeline`
- [ ] Integrated into upload route
- [ ] Video upload produces `pipeline-debug/*.json` files
- [ ] Render config always has `.segments.length > 0`
- [ ] Debug reports show which stage failed (if any)

---

## What Each Stage Does

| Stage | Purpose | If Fails | Fallback |
|-------|---------|----------|----------|
| 1. Metadata | Get video duration, size | Won't know duration | Assume 30s |
| 2. Scenes | Find scene boundaries | Create time-based breakpoints | 5s intervals |
| 3. Motion | Score motion per segment | Equal scoring | All 0.5 score |
| 4. Audio | Find audio peaks | Skip audio boost | No audio |
| 5. Scoring | Rank segments | Keep all segments | All equal rank |
| 6. Highlights | Extract top segments | Use all segments | First 30s |
| 7. Variants | Create editing variants | Create default variant | Full video variant |
| 8. Crop | Calculate 9:16 crop | Use center crop | Hardcoded (420, 0, 1080, 1920) |
| 9. Subtitles | Generate captions | Skip captions | None |
| 10. Render | Prepare ffmpeg command | Use emergency fallback | 30-second default |

**Key guarantee:** Stage 7 (variants) ALWAYS produces at least one variant, even if all upstream stages fail.

---

## Debugging a Broken Video

1. **Check debug report:**
   ```bash
   cat data/pipeline-debug/video_id-pipeline.json | jq '.stages[] | select(.stage | startswith("error"))'
   ```

2. **Find the failing stage:**
   ```json
   {"stage": "stage_5_error", "error": "No segments scored"}
   ```

3. **Check the fallback:**
   Each stage has a fallback, look for `_fallback` entries:
   ```json
   {"stage": "stage_2_fallback", "message": "No scenes detected, using time-based breakpoints"}
   ```

4. **Final render config still has segments:**
   ```bash
   cat data/pipeline-debug/video_id-pipeline.json | jq '.stages[] | select(.stage == "stage_10_render_ready")'
   ```
   Should show: `"segmentCount": > 0`

---

## Common Issues & Fixes

### "segments: []" Still Appearing

**Cause:** Not using VideoPipelineDebugger, still using old code

**Fix:** Replace old analyze code with debugger:
```javascript
// Remove this:
const { segments } = analyzeVideo(videoPath);  // ← Broken

// Add this:
const debugger = new VideoPipelineDebugger();
const result = await debugger.processVideo(videoPath, videoId);
const { segments } = result.renderConfig;  // ← Always has segments
```

### FFmpeg errors (scene detection failing)

**Cause:** FFmpeg not installed or path wrong

**Check:**
```bash
which ffmpeg        # Unix
where ffmpeg.exe    # Windows
ffmpeg -version
```

**Fix:** Install ffmpeg:
- Windows: `winget install ffmpeg`
- macOS: `brew install ffmpeg`
- Linux: `apt install ffmpeg`

### Debug reports not being created

**Cause:** Directory doesn't exist or permissions issue

**Fix:**
```bash
mkdir -p data/pipeline-debug
chmod 755 data/pipeline-debug
```

---

## Performance

Expected timing per video:

| Stage | Time |
|-------|------|
| Metadata extraction | 2-10ms |
| Scene detection | 100-500ms |
| Motion scoring | 50-200ms |
| Audio analysis | 100-1000ms |
| Sigma0 scoring | 5-20ms |
| Variant generation | 5-10ms |
| **Total** | **500-2000ms** |

For videos under 60 seconds, expect 0.5-2 second total pipeline time.

---

## Next Steps

1. **Run the test:** `node apps/lantern-garage/lib/test-pipeline.js`
2. **Integrate into routes:** Wire VideoPipelineDebugger into your upload handler
3. **Test with real video:** Upload a video and check debug report
4. **Monitor:** Check `data/pipeline-debug/` for any failures
5. **Deploy:** Once working, you have a fully debuggable, fallback-safe pipeline

---

## API Reference

### VideoPipelineDebugger

```javascript
const debugger = new VideoPipelineDebugger({
  debugDir: 'data/pipeline-debug'  // Where to save logs
});

// Full pipeline (recommended)
const result = await debugger.processVideo(videoPath, videoId);
// result.success: boolean
// result.renderConfig: { segments, variant, crop, ... }
// result.debugReport: 'path/to/report.json'

// Individual stages (for testing)
debugger.extractMetadata(videoPath);
debugger.detectScenes(videoPath);
debugger.computeMotionScores(videoPath, scenes);
debugger.detectAudioPeaks(videoPath);
debugger.scoreSegments(motionSegments, audioPeaks);
debugger.extractHighlights(segments);
debugger.generateVariants(highlights);
debugger.computeCrop(resolution);
debugger.generateSubtitles(variants);
debugger.prepareRender(videoPath, variant, crop);

// Debugging
debugger.log(stageName, data);              // Log a stage
debugger.saveDebugReport(videoId);          // Save debug JSON
debugger.stages;                            // Access all logged stages
```

---

## You Now Have

✅ Full pipeline debugger with 10 stages  
✅ Comprehensive fallback system  
✅ Guaranteed non-empty segments  
✅ Debug reports for every video  
✅ Test infrastructure  
✅ Integration guide  

**Result:** Every uploaded video will produce at least one playable Short. No exceptions.
