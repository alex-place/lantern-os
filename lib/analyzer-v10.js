// Analyzer V10 Integration — Σ₀ Video Analysis Pipeline
// Replaces current highlight detection with data-driven, stability-aware system

const { FeatureExtractorV10, featuresToVector } = require("./feature-extractor-v10");
const { SigmaZeroV10Scorer } = require("./sigma0-v10-scoring");
const fs = require("fs");
const path = require("path");

/**
 * AnalyzerV10 — Complete Σ₀ analysis pipeline
 *
 * Pipeline:
 * 1. Segment video into chunks
 * 2. Extract features (visual, audio, narrative, Σ₀)
 * 3. Score segments with stability constraints
 * 4. Merge into highlights with multi-peak enforcement
 * 5. Select thumbnail frame
 * 6. Return analysis with Σ₀ state
 */
class AnalyzerV10 {
  constructor(options = {}) {
    this.featureExtractor = new FeatureExtractorV10(options);
    this.scorer = new SigmaZeroV10Scorer(options);
    this.segmentDuration = options.segmentDuration || 0.5; // 500ms chunks
    this.isGaming = options.isGaming !== false;
  }

  /**
   * Main analysis entry point
   *
   * Args:
   *   videoPath: path to video file
   *   videoDuration: total duration in seconds
   *   ctx: progress context (stage, log, liveStats, progress)
   *
   * Returns:
   *   {
   *     highlights: [...],
   *     finalVideoPath: string,
   *     thumbnailFrame: string,
   *     sigma0State: {...}
   *   }
   */
  async analyzeVideo(videoPath, videoDuration, ctx) {
    ctx.stage("analysis");
    ctx.log("Starting Σ₀ V10 analysis");

    // ── 1. Segment video ──
    ctx.stage("frame_scan");
    ctx.log("Segmenting video");

    const segments = this.segmentVideo(videoDuration);
    const totalSegments = segments.length;

    ctx.liveStats({ totalSegments, processedSegments: 0 });

    // ── 2. Extract features ──
    ctx.stage("features");
    ctx.log("Extracting visual, audio, narrative features");

    const allFeatures = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const features = await this.featureExtractor.extractSegmentFeatures(
        videoPath,
        segment.start,
        segment.end
      );
      allFeatures.push(features);

      if (i % 10 === 0) {
        ctx.liveStats({
          processedSegments: i + 1,
          totalSegments,
        });
      }
    }

    ctx.log(`Extracted features for ${allFeatures.length} segments`);

    // ── 3. Score segments ──
    ctx.stage("scoring");
    ctx.log("Scoring segments with Σ₀ stability constraints");

    const highlights = this.scorer.findHighlights(
      allFeatures,
      this.isGaming,
      {
        dynamicPercentile: 92,
        minHighlights: 2,
        maxHighlights: 10,
      }
    );

    ctx.log(`Found ${highlights.count} highlights`);

    // ── 4. Select thumbnail ──
    ctx.stage("thumbnail");
    ctx.log("Selecting thumbnail frame");

    const thumbnailIdx = this.selectThumbnailFrame(allFeatures);
    const thumbnailSegment = segments[thumbnailIdx];
    const thumbnailFrame = `frame_${Math.floor(thumbnailSegment.start * 1000)}.jpg`;

    ctx.log(`Selected thumbnail: ${thumbnailFrame}`);

    // ── 5. Compute Σ₀ state ──
    const sigma0State = this.computeAggregateState(allFeatures);

    ctx.log(`Σ₀ State: collapse_risk=${sigma0State.collapseRiskAvg.toFixed(3)}, stability=${sigma0State.stability}`);

    return {
      highlights: highlights.highlights,
      finalVideoPath: "", // Would be populated by render engine
      thumbnailFrame,
      sigma0State,
      analysisMetadata: {
        segmentsAnalyzed: allFeatures.length,
        featureVersion: "v10",
        modelVersion: "sigma0-v10",
        analysisTimestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Segment video into fixed-duration chunks
   */
  segmentVideo(duration) {
    const segments = [];
    const segmentDuration = this.segmentDuration; // 500ms

    for (let start = 0; start < duration; start += segmentDuration) {
      segments.push({
        start,
        end: Math.min(start + segmentDuration, duration),
      });
    }

    return segments;
  }

  /**
   * Select best thumbnail frame
   *
   * Criteria: max entropy + motion energy
   * NOT: first frame (old bug), NOT: metadata frame
   */
  selectThumbnailFrame(features) {
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const score =
        f.sigma0.visualEntropy * 0.5 +
        f.visual.motionIntensity * 0.3 +
        f.visual.zoomFrequency * 0.2;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    return bestIdx;
  }

  /**
   * Compute aggregate Σ₀ state for video
   */
  computeAggregateState(features) {
    const collapseRisks = features.map(f => f.sigma0.collapseRisk);
    const entropies = features.map(f => f.sigma0.visualEntropy);
    const spreads = features.map(f => f.sigma0.spectralSpread);

    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const max = (arr) => Math.max(...arr);

    const collapseRiskAvg = avg(collapseRisks);
    const stabilityScore = 1 - collapseRiskAvg;

    return {
      collapseRiskAvg,
      maxCollapseRisk: max(collapseRisks),
      stabilityScore,
      stability: collapseRiskAvg < 0.4 ? "stable" : collapseRiskAvg < 0.6 ? "marginal" : "unstable",
      entropyAvg: avg(entropies),
      spreadAvg: avg(spreads),
    };
  }
}

/**
 * Integration wrapper for job-worker
 *
 * Replaces analyzeVideoForHighlights call
 */
async function analyzeVideoV10(videoPath, options = {}, onProgress = () => {}) {
  const analyzer = new AnalyzerV10({
    isGaming: options.gaming !== false,
    segmentDuration: options.segmentDuration || 0.5,
  });

  // Context object for progress reporting
  const ctx = {
    stage: (stageId) => onProgress(0, stageId),
    log: (msg) => onProgress(0, "", msg),
    liveStats: (stats) => onProgress(0, "", "", stats),
    progress: (pct, msg) => onProgress(pct, "", msg),
  };

  // Get video duration
  const metadata = await getVideoMetadata(videoPath);
  if (!metadata) {
    throw new Error(`Could not read video: ${videoPath}`);
  }

  // Run analysis
  const analysis = await analyzer.analyzeVideo(videoPath, metadata.duration, ctx);

  // Convert to HighlightTimeline format for backwards compatibility
  return {
    videoPath,
    duration: metadata.duration,
    fps: 30,
    highlights: analysis.highlights,
    metadata: {
      analyzedAt: new Date().toISOString(),
      version: "10.0",
      ...analysis.analysisMetadata,
    },
    sigma0: analysis.sigma0State,
    thumbnailFrame: analysis.thumbnailFrame,
  };
}

/**
 * Placeholder: get video metadata
 * Would use ffprobe in production
 */
async function getVideoMetadata(videoPath) {
  return { duration: 60, width: 1920, height: 1080 };
}

module.exports = {
  AnalyzerV10,
  analyzeVideoV10,
};
