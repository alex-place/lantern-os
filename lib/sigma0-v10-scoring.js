// Σ₀ V10 Scoring Model — Data-Driven Engagement + Stability Optimization
// Scores video segments based on extracted features + Σ₀ collapse constraints

const { estimateRetentionProxy } = require("./feature-extractor-v10");

/**
 * SigmaZeroV10Scorer — Production scoring model for Creator Dashboard
 *
 * Core principle:
 * final_score = engagement_score × (1 - collapse_risk)
 *
 * This ensures:
 * - Flashy but empty clips get penalized
 * - Stable engaging clips get boosted
 * - Prevents "overcut noise spam optimization"
 */
class SigmaZeroV10Scorer {
  constructor(options = {}) {
    // Model weights (would be trained via gradient boosting)
    this.weights = {
      retentionProxy: options.retentionProxy || 0.30,
      cutDensity: options.cutDensity || 0.18,
      audioVariance: options.audioVariance || 0.15,
      narrativeEventDensity: options.narrativeEventDensity || 0.20,
      trendAlignment: options.trendAlignment || 0.17,
    };

    // Σ₀ stability thresholds
    this.collapseThreshold = options.collapseThreshold || 0.4;
    this.stabilityBonus = options.stabilityBonus || 0.15;

    // Gaming-specific overrides
    this.gamingEnabled = options.gamingEnabled !== false;
    this.gamingWeights = {
      hudClarity: 0.12,
      killEventAlignment: 0.15,
      reactionSpikeTiming: 0.10,
      abilityMomentDensity: 0.15,
    };

    // Hook engine (0-3s dominance)
    this.hookWeight = options.hookWeight || 0.25;
  }

  /**
   * Score a single segment
   *
   * Returns: { score: 0-1, reason: string, components: {...} }
   */
  scoreSegment(features, isGaming = false) {
    const {
      visual,
      audio,
      narrative,
      sigma0,
    } = features;

    // ── 1. Hook Engine (0–3 seconds) ──
    // MOST IMPORTANT: if hook score is below threshold, downrank regardless
    const hookScore =
      visual.motionIntensity * 0.3 +
      audio.peakSpikeDensity * 0.3 +
      narrative.surprise * 0.4;

    const hookThreshold = 0.4;
    if (hookScore < hookThreshold) {
      return {
        score: 0.0,
        reason: `Weak hook (${hookScore.toFixed(2)} < ${hookThreshold})`,
        components: { hookScore },
        downranked: true,
      };
    }

    // ── 2. Base Engagement Score ──
    const retentionProxy = estimateRetentionProxy(features);

    const engagementScore =
      retentionProxy * this.weights.retentionProxy +
      visual.cutDensity * this.weights.cutDensity +
      audio.rmsVariance * this.weights.audioVariance +
      narrative.payoffDensity * this.weights.narrativeEventDensity +
      0.5 * this.weights.trendAlignment; // 0.5 = neutral trend alignment

    // ── 3. Σ₀ Stability Filter ──
    // Collapse risk: low entropy + repetitive motion + flat audio = boring
    const collapseRisk = sigma0.collapseRisk;

    // Stability multiplier: penalize high-risk, boost low-risk
    const stabilityMultiplier = 1 - collapseRisk * 0.5; // 0.5–1.0 range

    // ── 4. Gaming-Specific Boost ──
    let gamingBoost = 0;
    if (isGaming && this.gamingEnabled && visual.hudDensity > 0.05) {
      // Gaming content detected
      gamingBoost =
        (1 - visual.facecamRatio) * 0.15 + // penalize facecam-heavy gaming
        visual.hudDensity * 0.10 + // boost HUD-rich gameplay
        narrative.payoffDensity * 0.08; // more events = more gaming action
    }

    // ── 5. Final Score ──
    let finalScore =
      (engagementScore * stabilityMultiplier) +
      gamingBoost;

    // Clamp to [0, 1]
    finalScore = Math.min(1.0, Math.max(0, finalScore));

    // ── Determine reason ──
    const reasons = [];
    if (hookScore > 0.7) reasons.push("strong hook");
    if (engagementScore > 0.7) reasons.push("high engagement");
    if (collapseRisk < 0.3) reasons.push("stable");
    if (gamingBoost > 0.05) reasons.push("gaming optimized");

    return {
      score: finalScore,
      reason: reasons.length > 0 ? reasons.join(" + ") : "moderate engagement",
      components: {
        hookScore,
        engagementScore,
        collapseRisk,
        stabilityMultiplier,
        gamingBoost,
        retentionProxy,
      },
      sigma0State: {
        visualEntropy: sigma0.visualEntropy,
        spectralSpread: sigma0.spectralSpread,
        eventDensity: sigma0.eventDensity,
        isStable: sigma0.isStable,
      },
    };
  }

  /**
   * Score multiple segments and extract highlights
   *
   * Logic:
   * 1. Score all segments
   * 2. Filter by dynamic threshold (top N percentile)
   * 3. Merge contiguous high-score segments
   * 4. Enforce minimum count (multi-peak enforcement)
   */
  findHighlights(segmentFeatures, isGaming = false, options = {}) {
    const {
      dynamicPercentile = 92, // Top 8%
      minHighlights = 2,
      maxHighlights = 10,
      mergeThresholdSec = 0.5,
    } = options;

    // Score all segments
    const scored = segmentFeatures.map((features, idx) => ({
      index: idx,
      features,
      ...this.scoreSegment(features, isGaming),
    }));

    // Dynamic threshold: top N percentile
    const scores = scored.map(s => s.score).sort((a, b) => b - a);
    const thresholdIdx = Math.ceil(scores.length * (1 - dynamicPercentile / 100));
    const threshold = scores[Math.max(0, thresholdIdx)];

    // Filter high-score segments
    const highScore = scored.filter(s => s.score >= threshold && s.score > 0.3);

    if (highScore.length === 0) {
      return {
        highlights: [],
        count: 0,
        reason: "No segments above threshold",
      };
    }

    // Merge contiguous segments
    const merged = this.mergeSegments(highScore, mergeThresholdSec);

    // Enforce multi-peak: at least minHighlights, at most maxHighlights
    let final = merged;
    if (final.length < minHighlights) {
      // Promote next-best segments
      const candidates = scored
        .filter(s => !final.find(h => h.index === s.index) && s.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, minHighlights - final.length);
      final = [...final, ...candidates];
    } else if (final.length > maxHighlights) {
      // Trim to top scoring
      final = final.sort((a, b) => b.score - a.score).slice(0, maxHighlights);
    }

    // Sort by time
    final.sort((a, b) => (a.segment?.startSec || 0) - (b.segment?.startSec || 0));

    return {
      highlights: final.map(h => ({
        start: h.segment?.startSec || 0,
        end: h.segment?.endSec || 0,
        score: h.score,
        reason: h.reason,
        sigma0: h.sigma0State,
      })),
      count: final.length,
      threshold,
      reason: `${final.length} highlights (threshold: ${threshold.toFixed(3)})`,
    };
  }

  /**
   * Merge adjacent high-score segments
   */
  mergeSegments(segments, thresholdSec = 0.5) {
    if (segments.length === 0) return [];

    const sorted = [...segments].sort(
      (a, b) => (a.segment?.startSec || 0) - (b.segment?.startSec || 0)
    );

    const merged = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const current = sorted[i];

      const prevEnd = prev.segment?.endSec || 0;
      const currentStart = current.segment?.startSec || 0;

      if (currentStart - prevEnd <= thresholdSec) {
        // Merge: extend previous segment
        merged[merged.length - 1] = {
          ...prev,
          segment: {
            startSec: prev.segment?.startSec || 0,
            endSec: current.segment?.endSec || 0,
            duration: (current.segment?.endSec || 0) - (prev.segment?.startSec || 0),
          },
          score: Math.max(prev.score, current.score), // Take higher score
        };
      } else {
        merged.push(current);
      }
    }

    return merged;
  }
}

module.exports = {
  SigmaZeroV10Scorer,
};
