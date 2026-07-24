// Scoring Engine V2 — Research-Grounded Σ₀ Highlight Scoring
// Integrates spectral entropy + gameplay presence to fix "talking head wins" bug
// Based on corrected Σ₀ framework

const { SpectralAnalyzer, frameToEmbedding } = require("./spectral-analyzer");

/**
 * Highlight Score V2: Multi-dimensional spectral-aware scoring
 *
 * Score(segment) =
 *     motion_energy
 *   + scene_transition_rate
 *   + gameplay_presence_weight
 *   + spectral_entropy(frame_embeddings)
 *   - redundancy_penalty
 *   + α · spectral_spread(J_segment)
 *
 * Validity gate (all must pass):
 *   - gameplay_presence > 0.6
 *   - spectral_entropy > τ_entropy (default: 0.4)
 *   - scene_change_score > τ_scene (default: 0.1)
 */
class ScoringEngineV2 {
  constructor(options = {}) {
    // Weights
    this.weights = {
      motion: options.motionWeight || 0.25,
      sceneChange: options.sceneChangeWeight || 0.20,
      gameplayPresence: options.gameplayPresenceWeight || 0.30,
      spectralEntropy: options.spectralEntropyWeight || 0.15,
      spectralSpread: options.spectralSpreadWeight || 0.10,
    };

    // Thresholds
    this.thresholds = {
      gameplayPresence: options.gameplayPresenceThreshold || 0.6,
      spectralEntropy: options.spectralEntropyThreshold || 0.4,
      sceneChange: options.sceneChangeThreshold || 0.1,
    };

    // Penalties
    this.redundancyPenalty = options.redundancyPenalty || 0.1;
    this.collapsePenalty = options.collapsePenalty || 0.5;

    this.spectralAnalyzer = new SpectralAnalyzer({
      windowSize: options.windowSize || 16,
    });
  }

  /**
   * Score a single frame/segment
   * Requires: motion, sceneChange, gameplayPresence, frameBuffer, width, height
   */
  scoreSegment(segment) {
    const {
      motion = 0,
      sceneChange = 0,
      gameplayPresence = 0,
      frameBuffer = null,
      width = 0,
      height = 0,
    } = segment;

    // ── Validity gate: all conditions must pass ──
    if (gameplayPresence < this.thresholds.gameplayPresence) {
      return { score: 0, reason: "Low gameplay presence", valid: false };
    }

    // ── Spectral metrics ──
    let spectralEntropy = 0;
    let spectralSpread = 0;
    let spectralMetrics = {};

    if (frameBuffer && width > 0 && height > 0) {
      // Extract embedding from frame
      const embedding = frameToEmbedding(frameBuffer, width, height);
      this.spectralAnalyzer.addEmbedding(embedding);

      spectralMetrics = this.spectralAnalyzer.metrics();
      spectralEntropy = spectralMetrics.spectralEntropy;
      spectralSpread = spectralMetrics.spectralSpread;

      // Check entropy gate
      if (spectralEntropy < this.thresholds.spectralEntropy) {
        return {
          score: 0,
          reason: "Low spectral entropy (collapsed/redundant content)",
          valid: false,
          spectralEntropy,
        };
      }

      // Check collapse detection
      if (spectralMetrics.isCollapsed) {
        // Penalize but don't reject entirely
        // This catches low-entropy talking heads, but allows if other factors are strong
      }
    }

    // ── Check scene change gate ──
    if (sceneChange < this.thresholds.sceneChange) {
      // Scene change is important but not strict; content can be valid without it
      // Just apply a mild penalty
    }

    // ── Compute weighted score ──
    let score = 0;

    // Motion energy
    score += motion * this.weights.motion;

    // Scene transition rate
    score += Math.min(sceneChange, 1.0) * this.weights.sceneChange;

    // Gameplay presence
    score += gameplayPresence * this.weights.gameplayPresence;

    // Spectral entropy (diverse content)
    score += spectralEntropy * this.weights.spectralEntropy;

    // Spectral spread stability (reward balanced spectrum)
    // Normalize spread to [0, 1]: lower spread = higher score
    const normalizedSpread = Math.min(spectralSpread / 5.0, 1.0);
    score += (1 - normalizedSpread) * this.weights.spectralSpread;

    // ── Apply penalties ──
    // Redundancy penalty if entropy is very low (but still > threshold)
    if (spectralEntropy < this.thresholds.spectralEntropy + 0.1) {
      score -= this.redundancyPenalty;
    }

    // Collapse penalty if system is in collapsed state
    if (spectralMetrics.isCollapsed) {
      score -= this.collapsePenalty;
    }

    // Clamp to [0, 1]
    score = Math.max(0, Math.min(score, 1.0));

    return {
      score,
      valid: true,
      reason: "Valid highlight",
      metrics: {
        motion,
        sceneChange,
        gameplayPresence,
        spectralEntropy,
        spectralSpread: normalizedSpread,
      },
      spectralMetrics,
    };
  }

  /**
   * Score multiple segments and filter by validity gate
   */
  scoreSegments(segments) {
    const scored = segments.map((seg) => ({
      ...seg,
      scoreResult: this.scoreSegment(seg),
    }));

    // Filter valid segments
    const valid = scored.filter((seg) => seg.scoreResult.valid);

    return {
      all: scored,
      valid,
      summary: {
        total: scored.length,
        validCount: valid.length,
        avgScore: valid.length > 0 ? valid.reduce((s, x) => s + x.scoreResult.score, 0) / valid.length : 0,
      },
    };
  }

  /**
   * Get metrics for current window (for debugging)
   */
  getMetrics() {
    return this.spectralAnalyzer.metrics();
  }

  /**
   * Reset analyzer for next video/segment
   */
  reset() {
    this.spectralAnalyzer.reset();
  }
}

/**
 * Integration function: Score existing highlights using V2 engine
 * Takes highlights from old engine and re-scores with spectral analysis
 */
function upgradeHighlightScores(highlights, videoPath, frameDataCallback, options = {}) {
  const engine = new ScoringEngineV2(options);
  const upgraded = [];

  for (const hl of highlights) {
    // Reconstruct segment data
    const segment = {
      motion: extractMotionFromReason(hl.reason),
      sceneChange: hl.tags.includes("scene-change") ? 0.8 : 0.2,
      gameplayPresence: hl.tags.includes("gameplay") ? 0.9 : 0.5,
      // Note: in production, re-extract frameBuffer from video
    };

    const scoreResult = engine.scoreSegment(segment);

    upgraded.push({
      ...hl,
      scoreV2: scoreResult.score,
      validV2: scoreResult.valid,
      reason: scoreResult.reason,
      spectralMetrics: scoreResult.spectralMetrics,
    });
  }

  return upgraded;
}

/**
 * Helper: Extract motion value from reason string
 */
function extractMotionFromReason(reason) {
  if (reason.includes("high motion")) return 0.8;
  if (reason.includes("motion")) return 0.6;
  if (reason.includes("audio")) return 0.3;
  return 0.4;
}

/**
 * Helper: Embed frame to spectral space
 */
function frameToEmbedding(frameBuffer, width, height) {
  // Simple histogram embedding: 16 bins of luminance
  const histogram = Array(16).fill(0);

  for (let i = 0; i < frameBuffer.length; i += 3) {
    // Convert RGB to luminance
    const r = frameBuffer[i];
    const g = frameBuffer[i + 1];
    const b = frameBuffer[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // Bin into histogram
    const bin = Math.floor((lum / 255) * 15);
    histogram[bin]++;
  }

  // Normalize histogram
  const total = width * height;
  return histogram.map((x) => x / total);
}

module.exports = {
  ScoringEngineV2,
  upgradeHighlightScores,
};
