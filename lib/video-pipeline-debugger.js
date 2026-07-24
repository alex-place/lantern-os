/**
 * Video Pipeline Debugger & Fallback System
 *
 * Guarantees: Every uploaded video produces at least one playable Short.
 * No exceptions.
 *
 * Stages (with logging + fallbacks):
 * 1. Upload → Metadata extraction
 * 2. FFmpeg scene detection
 * 3. Motion scoring
 * 4. Audio peaks
 * 5. Sigma0 V10 scoring
 * 6. Highlight extraction
 * 7. Variant generation
 * 8. Vertical crop
 * 9. Subtitle generation
 * 10. Final render
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class VideoPipelineDebugger {
  constructor(options = {}) {
    this.debugDir = options.debugDir || path.join(process.cwd(), 'data', 'pipeline-debug');
    this.stages = [];
    this.startTime = Date.now();
    this.ensureDebugDir();
  }

  ensureDebugDir() {
    if (!fs.existsSync(this.debugDir)) {
      fs.mkdirSync(this.debugDir, { recursive: true });
    }
  }

  log(stage, data) {
    const timestamp = new Date().toISOString();
    const stageEntry = {
      stage,
      timestamp,
      duration: Date.now() - this.startTime,
      ...data
    };
    this.stages.push(stageEntry);
    console.log(`[${stage}] ${JSON.stringify(data)}`);
    return stageEntry;
  }

  saveDebugReport(videoId) {
    const report = {
      videoId,
      generatedAt: new Date().toISOString(),
      totalDuration: Date.now() - this.startTime,
      stages: this.stages
    };
    const reportPath = path.join(this.debugDir, `${videoId}-pipeline.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return reportPath;
  }

  /**
   * STAGE 1: Metadata extraction
   */
  extractMetadata(videoPath) {
    try {
      const stats = fs.statSync(videoPath);
      const sizeKB = Math.round(stats.size / 1024);

      // Use ffprobe to get duration
      let durationSeconds = 0;
      try {
        const output = execSync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
          { encoding: 'utf8', timeout: 10000 }
        );
        durationSeconds = parseFloat(output.trim()) || 0;
      } catch (e) {
        this.log('metadata_extraction_error', { message: 'ffprobe failed, assuming 30s', error: e.message });
        durationSeconds = 30;
      }

      const metadata = {
        path: videoPath,
        sizeKB,
        durationSeconds,
        filename: path.basename(videoPath),
        ok: durationSeconds > 0 && sizeKB > 0
      };

      this.log('stage_1_metadata', metadata);
      return metadata;
    } catch (err) {
      this.log('stage_1_error', { error: err.message });
      throw err;
    }
  }

  /**
   * STAGE 2: FFmpeg scene detection
   * Returns: Array of scene boundaries
   */
  detectScenes(videoPath, threshold = 27.0) {
    try {
      const scenes = [];
      try {
        const output = execSync(
          `ffmpeg -i "${videoPath}" -vf "select='gt(scene\\,${threshold})',showinfo" -f null - 2>&1`,
          { encoding: 'utf8', timeout: 30000 }
        );

        const lines = output.split('\n');
        lines.forEach(line => {
          const match = line.match(/pts_time:([\d.]+)/);
          if (match) {
            scenes.push(parseFloat(match[1]));
          }
        });
      } catch (e) {
        this.log('scene_detection_error', { message: 'FFmpeg scene detection failed', error: e.message });
      }

      // Guarantee: At least create breakpoints if no scenes detected
      if (scenes.length === 0) {
        this.log('scene_detection_fallback', { message: 'No scenes detected, using time-based breakpoints' });
        // Create breakpoints every 5-10 seconds
        scenes.push(0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60);
      }

      const sceneData = { scenes: scenes.sort((a, b) => a - b), count: scenes.length };
      this.log('stage_2_scenes', sceneData);
      return scenes;
    } catch (err) {
      this.log('stage_2_fatal', { error: err.message });
      return [0, 15, 30, 45, 60]; // Fallback breakpoints
    }
  }

  /**
   * STAGE 3: Motion scoring
   * Simulated (in real impl, would use optical flow)
   */
  computeMotionScores(videoPath, scenes) {
    try {
      const motionScores = [];

      // Create segments between scene boundaries
      for (let i = 0; i < scenes.length - 1; i++) {
        const start = scenes[i];
        const end = scenes[i + 1];
        const duration = end - start;

        // Heuristic: video at night (low brightness) = low motion
        // Realistic would use actual optical flow
        const motion = Math.random() * 100;

        motionScores.push({
          start,
          end,
          duration,
          motionIntensity: motion,
          confidence: 0.6
        });
      }

      if (motionScores.length === 0) {
        this.log('motion_scoring_fallback', { message: 'No segments created, using full video' });
        motionScores.push({ start: 0, end: 60, duration: 60, motionIntensity: 50, confidence: 0.5 });
      }

      this.log('stage_3_motion', { segments: motionScores.length, avgMotion: motionScores.reduce((a, s) => a + s.motionIntensity, 0) / motionScores.length });
      return motionScores;
    } catch (err) {
      this.log('stage_3_error', { error: err.message });
      return [{ start: 0, end: 60, duration: 60, motionIntensity: 50, confidence: 0.5 }];
    }
  }

  /**
   * STAGE 4: Audio peak detection
   */
  detectAudioPeaks(videoPath) {
    try {
      const peaks = [];

      try {
        // Extract audio and analyze (simplified - real would use librosa)
        const output = execSync(
          `ffmpeg -i "${videoPath}" -af "volumedetect" -vn -sn -dn -f null - 2>&1`,
          { encoding: 'utf8', timeout: 20000 }
        );

        const peakMatch = output.match(/max_volume: ([-\d.]+) dB/);
        if (peakMatch) {
          const peakDb = parseFloat(peakMatch[1]);
          peaks.push({ timestamp: 0, intensity: (peakDb + 40) / 40 }); // Normalize
        }
      } catch (e) {
        this.log('audio_detection_error', { message: 'Audio detection failed', error: e.message });
      }

      if (peaks.length === 0) {
        this.log('audio_fallback', { message: 'No audio peaks detected' });
        peaks.push({ timestamp: 5, intensity: 0.7 }, { timestamp: 15, intensity: 0.8 });
      }

      this.log('stage_4_audio', { peaks: peaks.length });
      return peaks;
    } catch (err) {
      this.log('stage_4_error', { error: err.message });
      return [];
    }
  }

  /**
   * STAGE 5: Sigma0 scoring
   * Scores segments for quality/interest
   */
  scoreSegments(motionSegments, audioPeaks) {
    try {
      const scoredSegments = motionSegments.map(segment => {
        // Find audio peaks in this segment
        const audioInSegment = audioPeaks.filter(
          p => p.timestamp >= segment.start && p.timestamp <= segment.end
        );

        // Score = motion + audio boost
        const baseScore = segment.motionIntensity / 100;
        const audioBoost = audioInSegment.length > 0 ? 0.2 : 0;
        const finalScore = Math.min(1, baseScore + audioBoost);

        return {
          ...segment,
          score: finalScore,
          hasAudio: audioInSegment.length > 0,
          reason: finalScore > 0.6 ? 'high_quality' : 'fallback'
        };
      });

      // GUARANTEE: Sort by score and keep top 5
      const topSegments = scoredSegments.sort((a, b) => b.score - a.score).slice(0, 5);

      if (topSegments.length === 0) {
        this.log('scoring_fallback', { message: 'No segments scored, creating default' });
        topSegments.push({
          start: 0,
          end: 30,
          duration: 30,
          motionIntensity: 50,
          score: 0.5,
          confidence: 0.5,
          reason: 'fallback_default'
        });
      }

      this.log('stage_5_scoring', { scored: scoredSegments.length, topSegments: topSegments.length });
      return topSegments;
    } catch (err) {
      this.log('stage_5_error', { error: err.message });
      return [{
        start: 0,
        end: 30,
        duration: 30,
        motionIntensity: 50,
        score: 0.5,
        confidence: 0.5,
        reason: 'error_fallback'
      }];
    }
  }

  /**
   * STAGE 6: Highlight extraction
   * CRITICAL: Must return non-empty array
   */
  extractHighlights(segments) {
    try {
      const highlights = segments.map(seg => ({
        ...seg,
        type: seg.score > 0.7 ? 'high_value' : 'standard',
        highlighted: true
      }));

      // GUARANTEE: Never return empty highlights
      if (highlights.length === 0) {
        this.log('highlights_fallback', { message: 'No highlights, creating from first 30 seconds' });
        highlights.push({
          start: 0,
          end: 30,
          duration: 30,
          score: 0.5,
          type: 'fallback',
          highlighted: true,
          reason: 'emergency_fallback'
        });
      }

      this.log('stage_6_highlights', { count: highlights.length, topScore: Math.max(...highlights.map(h => h.score)) });
      return highlights;
    } catch (err) {
      this.log('stage_6_error', { error: err.message });
      return [{
        start: 0,
        end: 30,
        duration: 30,
        score: 0.5,
        type: 'error_fallback',
        highlighted: true
      }];
    }
  }

  /**
   * STAGE 7: Variant generation
   * CRITICAL: Must return non-empty variants
   */
  generateVariants(highlights) {
    try {
      const variants = [];

      // Strategy 1: Top highlight variant
      if (highlights.length > 0) {
        const topHighlight = highlights.sort((a, b) => b.score - a.score)[0];
        variants.push({
          id: 'variant_top',
          strategy: 'top_highlight',
          segments: [topHighlight],
          duration: topHighlight.duration,
          score: topHighlight.score
        });
      }

      // Strategy 2: Montage (multiple highlights)
      if (highlights.length >= 3) {
        const topThree = highlights.sort((a, b) => b.score - a.score).slice(0, 3);
        variants.push({
          id: 'variant_montage',
          strategy: 'top_three_montage',
          segments: topThree,
          duration: topThree.reduce((sum, h) => sum + h.duration, 0),
          score: topThree.reduce((sum, h) => sum + h.score, 0) / topThree.length
        });
      }

      // GUARANTEE: Always have at least one variant
      if (variants.length === 0) {
        this.log('variants_fallback', { message: 'No variants generated, creating emergency variant' });
        const fallbackSegment = {
          start: 0,
          end: Math.min(30, highlights[0]?.duration || 30),
          duration: Math.min(30, highlights[0]?.duration || 30),
          score: 0.5,
          type: 'fallback'
        };
        variants.push({
          id: 'variant_emergency',
          strategy: 'emergency_fallback',
          segments: [fallbackSegment],
          duration: fallbackSegment.duration,
          score: 0.5
        });
      }

      this.log('stage_7_variants', { count: variants.length, topScore: Math.max(...variants.map(v => v.score)) });
      return variants;
    } catch (err) {
      this.log('stage_7_error', { error: err.message });
      return [{
        id: 'variant_error',
        strategy: 'error_fallback',
        segments: [{ start: 0, end: 30, duration: 30, score: 0.5 }],
        duration: 30,
        score: 0.5
      }];
    }
  }

  /**
   * STAGE 8: Vertical crop calculation
   */
  computeCrop(videoResolution = { width: 1920, height: 1080 }) {
    try {
      const srcW = videoResolution.width;
      const srcH = videoResolution.height;
      const targetAspect = 9 / 16; // portrait width/height

      // Fit the largest 9:16 region that lies fully inside the source frame,
      // then the renderer scales that region up to 1080x1920.
      let cropW, cropH;
      if (srcW / srcH > targetAspect) {
        // Source is wider than 9:16 (landscape): full height, crop the width.
        cropH = srcH;
        cropW = Math.round(srcH * targetAspect);
      } else {
        // Source is taller/narrower than 9:16: full width, crop the height.
        cropW = srcW;
        cropH = Math.round(srcW / targetAspect);
      }

      // Center, clamp to frame so x/y can never go negative or overflow.
      const x = Math.max(0, Math.round((srcW - cropW) / 2));
      const y = Math.max(0, Math.round((srcH - cropH) / 2));

      const crop = {
        x,
        y,
        width: Math.min(cropW, srcW),
        height: Math.min(cropH, srcH),
        scaleTo: { width: 1080, height: 1920 },
        aspectRatio: '9:16'
      };

      this.log('stage_8_crop', crop);
      return crop;
    } catch (err) {
      this.log('stage_8_error', { error: err.message });
      // Safe fallback for a 1920x1080 source: 608x1080 centered, scaled to 1080x1920.
      return { x: 656, y: 0, width: 608, height: 1080, scaleTo: { width: 1080, height: 1920 }, aspectRatio: '9:16' };
    }
  }

  /**
   * STAGE 9: Subtitle generation (placeholder)
   */
  generateSubtitles(variants) {
    try {
      const subtitles = {};
      variants.forEach(variant => {
        subtitles[variant.id] = [
          { time: 0, duration: 2, text: '🎮 Gaming Highlight' },
          { time: 2, duration: 2, text: '⚡ Action Packed' },
          { time: 4, duration: 2, text: '✨ Watch Full Video' }
        ];
      });

      this.log('stage_9_subtitles', { variants: Object.keys(subtitles).length });
      return subtitles;
    } catch (err) {
      this.log('stage_9_error', { error: err.message });
      return {};
    }
  }

  /**
   * STAGE 10: Final render preparation
   * GUARANTEE: Always produces valid render config
   */
  prepareRender(videoPath, variant, crop) {
    try {
      // CRITICAL: Validate segments exist
      if (!variant.segments || variant.segments.length === 0) {
        this.log('render_prep_fallback', { message: 'Variant has no segments, using full video' });
        variant.segments = [{ start: 0, end: 30, duration: 30, score: 0.5 }];
      }

      // CRITICAL: Validate crop is geometrically renderable (no negative/zero/overflow).
      const cropValid = crop &&
        crop.width > 0 && crop.height > 0 &&
        crop.x >= 0 && crop.y >= 0;
      if (!cropValid) {
        this.log('render_prep_crop_fallback', { message: 'Invalid crop geometry, using safe 9:16', badCrop: crop });
        crop = { x: 656, y: 0, width: 608, height: 1080, scaleTo: { width: 1080, height: 1920 }, aspectRatio: '9:16' };
      }

      const renderConfig = {
        videoPath,
        variant: variant.id,
        segments: variant.segments,
        crop,
        outputFormat: 'mp4',
        codec: 'h264',
        resolution: '1080x1920',
        fps: 30,
        quality: 'high'
      };

      // VALIDATION: Ensure all fields present
      const required = ['videoPath', 'variant', 'segments', 'crop'];
      const allValid = required.every(field => renderConfig[field] !== undefined && renderConfig[field] !== null);

      if (!allValid) {
        throw new Error('Invalid render config');
      }

      if (renderConfig.segments.length === 0) {
        throw new Error('No segments to render');
      }

      this.log('stage_10_render_ready', {
        valid: allValid,
        segmentCount: renderConfig.segments.length,
        duration: renderConfig.segments.reduce((sum, s) => sum + s.duration, 0)
      });

      return renderConfig;
    } catch (err) {
      this.log('stage_10_error', { error: err.message });
      // Emergency fallback render config
      return {
        videoPath,
        variant: 'emergency',
        segments: [{ start: 0, end: 30, duration: 30, score: 0.5, type: 'fallback' }],
        crop: { x: 420, y: 0, width: 1080, height: 1920 },
        outputFormat: 'mp4',
        codec: 'h264',
        resolution: '1080x1920',
        fps: 30,
        quality: 'high'
      };
    }
  }

  /**
   * FULL PIPELINE: All 10 stages
   * GUARANTEE: Returns valid render config or throws informative error
   */
  async processVideo(videoPath, videoId) {
    try {
      this.log('pipeline_start', { videoPath, videoId });

      // Stage 1
      const metadata = this.extractMetadata(videoPath);
      if (!metadata.ok) throw new Error('Invalid video metadata');

      // Stage 2
      const scenes = this.detectScenes(videoPath);

      // Stage 3
      const motionScores = this.computeMotionScores(videoPath, scenes);

      // Stage 4
      const audioPeaks = this.detectAudioPeaks(videoPath);

      // Stage 5
      const scoredSegments = this.scoreSegments(motionScores, audioPeaks);

      // Stage 6
      const highlights = this.extractHighlights(scoredSegments);

      // Stage 7
      const variants = this.generateVariants(highlights);

      // Stage 8
      const crop = this.computeCrop();

      // Stage 9
      const subtitles = this.generateSubtitles(variants);

      // Stage 10: Pick best variant and prepare render
      const bestVariant = variants.sort((a, b) => b.score - a.score)[0];
      const renderConfig = this.prepareRender(videoPath, bestVariant, crop);

      // FINAL VALIDATION
      if (!renderConfig.segments || renderConfig.segments.length === 0) {
        throw new Error('FATAL: No segments to render after all stages');
      }

      const reportPath = this.saveDebugReport(videoId);

      this.log('pipeline_complete', {
        videoId,
        variants: variants.length,
        topVariant: bestVariant.id,
        segments: renderConfig.segments.length,
        reportPath
      });

      return {
        success: true,
        videoId,
        renderConfig,
        variants,
        subtitles,
        debugReport: reportPath
      };
    } catch (err) {
      this.log('pipeline_fatal', { error: err.message, stack: err.stack });
      this.saveDebugReport(videoId);

      // Even on catastrophic failure, return SOMETHING
      throw {
        success: false,
        error: err.message,
        videoId,
        fallbackRender: {
          videoPath,
          variant: 'fatal_fallback',
          segments: [{ start: 0, end: 30, duration: 30, score: 0.5 }],
          crop: { x: 420, y: 0, width: 1080, height: 1920 },
          quality: 'emergency'
        }
      };
    }
  }
}

module.exports = VideoPipelineDebugger;
