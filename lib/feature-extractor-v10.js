// Feature Extractor V10 — Σ₀ Video Signal Analysis
// Extracts temporal, visual, audio, and narrative features for scoring model

const { spawn } = require("child_process");

/**
 * FeatureExtractorV10 — Extract engagement signals from video
 *
 * Signals extracted:
 * 1. Temporal: cuts per second, zoom frequency, motion intensity
 * 2. Audio: RMS energy variance, silence ratio, peak spikes
 * 3. Narrative: hook time-to-event, payoff density (events per 5s)
 * 4. Gaming-specific: HUD density, ability activation, kill events
 */
class FeatureExtractorV10 {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 5; // fps
    this.windowSize = options.windowSize || 5.0; // seconds for payoff density
    this.audioSampleRate = options.audioSampleRate || 16000;
  }

  /**
   * Extract all features from a video segment
   */
  async extractSegmentFeatures(videoPath, startSec, endSec) {
    const duration = endSec - startSec;

    const [visualFeatures, audioFeatures, narrativeFeatures] = await Promise.all([
      this.extractVisualFeatures(videoPath, startSec, endSec),
      this.extractAudioFeatures(videoPath, startSec, endSec),
      this.extractNarrativeFeatures(videoPath, startSec, endSec),
    ]);

    return {
      segment: { startSec, endSec, duration },
      visual: visualFeatures,
      audio: audioFeatures,
      narrative: narrativeFeatures,
      sigma0: this.computeSigma0Features(visualFeatures, audioFeatures, narrativeFeatures),
    };
  }

  /**
   * Visual features: cuts, zoom, motion
   */
  async extractVisualFeatures(videoPath, startSec, endSec) {
    // In production: analyze frame-by-frame for:
    // - Scene changes (histogram difference)
    // - Zoom/scale changes (optical flow)
    // - Motion intensity (frame difference)

    return {
      cutDensity: 0.0, // cuts per second
      zoomFrequency: 0.0, // zoom events per 5s
      motionIntensity: 0.0, // 0-1 normalized
      facecamRatio: 0.0, // 0-1 proportion of frame
      hudDensity: 0.0, // 0-1 HUD coverage (gaming)
    };
  }

  /**
   * Audio features: energy, silence, peaks
   */
  async extractAudioFeatures(videoPath, startSec, endSec) {
    // In production: analyze audio waveform for:
    // - RMS energy variance (dramatic changes)
    // - Silence ratio (quiet moments)
    // - Peak spikes (sudden loud events)

    return {
      rmsVariance: 0.0, // 0-1 normalized variance
      silenceRatio: 0.0, // proportion of silence
      peakSpikeDensity: 0.0, // spike events per second
      audioChangeRate: 0.0, // frequency of level shifts
    };
  }

  /**
   * Narrative features: hook time, event density
   */
  async extractNarrativeFeatures(videoPath, startSec, endSec) {
    // In production: detect narrative structure via:
    // - Hook detection (first interesting event)
    // - Event clustering
    // - Payoff density (interesting moments per window)
    // - Transcript analysis (if available)

    return {
      hookTimeToEvent: 0.0, // seconds to first interesting moment
      payoffDensity: 0.0, // events per 5s window
      eventSpacing: 0.0, // regularity of events
      surprise: 0.0, // 0-1 unpredictability score
    };
  }

  /**
   * Compute Σ₀ stability features from extracted signals
   *
   * Collapse risk indicators:
   * - Low entropy (repetitive visual patterns)
   * - Low spectral spread (motion concentration)
   * - Flat audio (no variation)
   * - Low event density (boring)
   */
  computeSigma0Features(visual, audio, narrative) {
    // Entropy proxy: lower cut density + motion + audio changes = higher entropy
    const visualEntropy = Math.min(
      1.0,
      visual.cutDensity * 0.3 + visual.motionIntensity * 0.4 + audio.audioChangeRate * 0.3
    );

    // Spectral spread proxy: avoid motion concentration in one area
    const spectralSpread = Math.min(
      1.0,
      (1 - Math.abs(visual.motionIntensity - 0.5) * 2) * 0.6 + // balanced motion
      (1 - visual.facecamRatio) * 0.4 // not dominated by one element
    );

    // Event density: payoff per time window
    const eventDensity = narrative.payoffDensity; // 0-1

    // Collapse risk: low entropy, low spread, low events = high risk
    const collapseRisk = Math.max(
      0,
      (1 - visualEntropy) * 0.35 +
        (1 - spectralSpread) * 0.35 +
        (1 - eventDensity) * 0.30
    );

    return {
      visualEntropy: Math.min(1.0, Math.max(0, visualEntropy)),
      spectralSpread: Math.min(1.0, Math.max(0, spectralSpread)),
      eventDensity: Math.min(1.0, Math.max(0, eventDensity)),
      collapseRisk: Math.min(1.0, Math.max(0, collapseRisk)),
      isStable: collapseRisk < 0.4, // threshold for "stable" state
    };
  }

  /**
   * Gaming-specific features
   * Detect: HUD clarity, kill events, ability moments, etc.
   */
  extractGamingFeatures(videoPath, startSec, endSec) {
    // Placeholder: in production, use vision model to detect:
    // - Kill markers ("+100 XP", "+$400", etc.)
    // - Reaction moments
    // - UI events
    // - Ability activations

    return {
      hudClarity: 0.0, // 0-1 HUD visibility
      killEventAlignment: 0.0, // 0-1 kill event prominence
      reactionSpikeTiming: 0.0, // alignment of reaction to gameplay event
      abilityMomentDensity: 0.0, // ability/impact events per window
    };
  }
}

/**
 * Feature vector for model input
 * Combines all signals into a fixed-dimension vector
 */
function featuresToVector(features) {
  const { visual, audio, narrative, sigma0 } = features;

  return [
    // Visual: 5 features
    visual.cutDensity,
    visual.zoomFrequency,
    visual.motionIntensity,
    visual.facecamRatio,
    visual.hudDensity,

    // Audio: 4 features
    audio.rmsVariance,
    audio.silenceRatio,
    audio.peakSpikeDensity,
    audio.audioChangeRate,

    // Narrative: 4 features
    Math.min(narrative.hookTimeToEvent / 3.0, 1.0), // normalize to 0-1
    narrative.payoffDensity,
    narrative.eventSpacing,
    narrative.surprise,

    // Σ₀: 4 features
    sigma0.visualEntropy,
    sigma0.spectralSpread,
    sigma0.eventDensity,
    sigma0.collapseRisk,
  ];
}

/**
 * Retention proxy estimation (when actual retention unavailable)
 *
 * Estimate via:
 * - Cut density (more cuts = more retention)
 * - Motion intensity (keep viewers engaged)
 * - Audio variation (prevent monotone)
 * - Event density (maintain interest)
 */
function estimateRetentionProxy(features) {
  const { visual, audio, narrative, sigma0 } = features;

  const retentionScore =
    visual.cutDensity * 0.25 +
    visual.motionIntensity * 0.20 +
    audio.audioChangeRate * 0.15 +
    narrative.payoffDensity * 0.25 +
    (1 - sigma0.collapseRisk) * 0.15; // stability bonus

  return Math.min(1.0, Math.max(0, retentionScore));
}

module.exports = {
  FeatureExtractorV10,
  featuresToVector,
  estimateRetentionProxy,
};
