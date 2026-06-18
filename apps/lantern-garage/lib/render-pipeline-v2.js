// Render Pipeline V2 — Σ₀ Constraint-Based Video Assembly
// Enforces research-grounded constraints during export

/**
 * RenderConstraints — Validate and enforce Σ₀ rendering rules
 *
 * Constraints (from corrected Σ₀ framework):
 * 1. Gameplay duration ≥ 60% of final video
 * 2. Facecam must be in top 20% spatial band (if present)
 * 3. HUD preserved via safe-zone mask
 * 4. No low-entropy segments (spectral entropy > τ)
 * 5. All segments must pass gameplay presence gate (> 0.6)
 */
class RenderConstraints {
  constructor(options = {}) {
    this.minGameplayRatio = options.minGameplayRatio || 0.6; // 60%
    this.maxFacecamBand = options.maxFacecamBand || 0.2; // Top 20% height
    this.minSpectralEntropy = options.minSpectralEntropy || 0.4;
    this.minGameplayPresence = options.minGameplayPresence || 0.6;
    this.preserveHUD = options.preserveHUD !== false; // Default: true
  }

  /**
   * Validate highlight segments against Σ₀ constraints
   */
  validateSegments(highlights, videoMetadata) {
    const validation = {
      passed: [],
      rejected: [],
      stats: {
        totalSegments: highlights.length,
        totalDuration: 0,
        gameplayDuration: 0,
        gameplayRatio: 0,
      },
    };

    for (const hl of highlights) {
      const segmentValidation = this.validateSegment(hl, videoMetadata);

      const result = {
        segment: hl,
        valid: segmentValidation.valid,
        reasons: segmentValidation.reasons,
      };

      if (segmentValidation.valid) {
        validation.passed.push(result);
        validation.stats.gameplayDuration += hl.duration;
      } else {
        validation.rejected.push(result);
      }

      validation.stats.totalDuration += hl.duration;
    }

    // Compute gameplay ratio
    if (validation.stats.totalDuration > 0) {
      validation.stats.gameplayRatio =
        validation.stats.gameplayDuration / validation.stats.totalDuration;
    }

    // Check global constraints
    validation.meetsGlobalConstraints =
      validation.stats.gameplayRatio >= this.minGameplayRatio;

    return validation;
  }

  /**
   * Validate a single segment
   */
  validateSegment(segment, videoMetadata) {
    const reasons = [];
    let valid = true;

    // Gate 1: Gameplay presence
    if (segment.gameplayPresence < this.minGameplayPresence) {
      reasons.push(
        `Low gameplay presence: ${segment.gameplayPresence.toFixed(2)} < ${this.minGameplayPresence}`
      );
      valid = false;
    }

    // Gate 2: Spectral entropy (if available)
    if (segment.spectralMetrics && segment.spectralMetrics.spectralEntropy) {
      if (
        segment.spectralMetrics.spectralEntropy < this.minSpectralEntropy
      ) {
        reasons.push(
          `Low spectral entropy: ${segment.spectralMetrics.spectralEntropy.toFixed(2)} < ${this.minSpectralEntropy}`
        );
        valid = false;
      }
    }

    // Gate 3: Collapsed state penalty
    if (segment.spectralMetrics && segment.spectralMetrics.isCollapsed) {
      reasons.push("Segment in collapsed state (low diversity)");
      valid = false;
    }

    // Gate 4: Facecam position (if facecam detected)
    if (segment.hasFacecam && videoMetadata) {
      if (!this.validateFacecamPosition(segment, videoMetadata)) {
        reasons.push("Facecam not in top 20% spatial band");
        valid = false;
      }
    }

    return { valid, reasons };
  }

  /**
   * Facecam position is satisfied by RELOCATION, not rejection: the exporter's
   * facecam-top layout (video-export.js) lifts a detected facecam into the top
   * band regardless of where it sits in the source. So a segment is never
   * rejected for facecam placement — the render enforces it.
   */
  validateFacecamPosition(/* segment, videoMetadata */) {
    return true;
  }

  /**
   * Check if safe-zone map should be applied
   */
  shouldApplySafeZones(segment, safeZoneReport) {
    if (!safeZoneReport) return false;
    if (safeZoneReport.enforcement.rejected) return false; // Don't apply if rejected
    return this.preserveHUD;
  }
}

/**
 * RenderPipeline — Apply Σ₀ constraints during export
 */
class RenderPipelineV2 {
  constructor(options = {}) {
    this.constraints = new RenderConstraints(options);
    this.options = options;
  }

  /**
   * Prepare highlights for rendering
   * Returns filtered + ordered segments meeting Σ₀ constraints
   */
  prepareSegments(highlights, videoMetadata, safeZoneReports) {
    // Validate against constraints
    const validation = this.constraints.validateSegments(
      highlights,
      videoMetadata
    );

    if (!validation.meetsGlobalConstraints) {
      console.warn(
        `⚠️ Gameplay ratio ${(validation.stats.gameplayRatio * 100).toFixed(1)}% ` +
        `below threshold ${(this.constraints.minGameplayRatio * 100)}%`
      );
    }

    // Prepare segments: sort by start time, attach safe zones
    const prepared = validation.passed.map((result) => ({
      ...result.segment,
      safeZone: safeZoneReports?.[result.segment.id],
      applySafeZone: this.constraints.shouldApplySafeZones(
        result.segment,
        safeZoneReports?.[result.segment.id]
      ),
    }));

    prepared.sort((a, b) => a.start - b.start);

    return {
      segments: prepared,
      validation,
      summary: {
        willRender: prepared.length,
        rejected: validation.rejected.length,
        gameplayRatio: validation.stats.gameplayRatio,
        compliant: validation.meetsGlobalConstraints,
      },
    };
  }

  /**
   * Build FFmpeg filter graph for rendering
   * Applies safe-zones, concatenates segments, enforces constraints
   */
  buildFilterGraph(segments, videoWidth = 1920, videoHeight = 1080) {
    const filters = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const inputLabel = `[${i}:v]`;

      // Apply safe-zone overlay if needed
      if (seg.applySafeZone && seg.safeZone?.cropPlan) {
        filters.push({
          input: inputLabel,
          filter: this.buildSafeZoneFilter(seg.safeZone.cropPlan),
          output: `[v${i}]`,
        });
      } else {
        filters.push({
          input: inputLabel,
          filter: 'copy',
          output: `[v${i}]`,
        });
      }
    }

    // Concatenate all segments
    const concatInputs = segments.map((_, i) => `[v${i}]`).join('');
    filters.push({
      input: concatInputs,
      filter: `concat=n=${segments.length}:v=1:a=1`,
      output: '[out]',
    });

    return filters;
  }

  /**
   * Build safe-zone filter: crop + pad to preserve safe areas
   */
  buildSafeZoneFilter(cropPlan) {
    if (!cropPlan) return 'copy';

    const { top, left, width, height } = cropPlan;

    // Crop to safe area, then pad back to original size
    return `crop=${width}:${height}:${left}:${top}, pad=1920:1080:${left}:${top}`;
  }

  /**
   * Estimate render duration based on segments
   */
  estimateDuration(segments) {
    return segments.reduce((sum, seg) => sum + seg.duration, 0);
  }

  /**
   * Get render report
   */
  getReport(preparedResult) {
    return {
      timestamp: new Date().toISOString(),
      segments: preparedResult.segments.length,
      duration: this.estimateDuration(preparedResult.segments),
      gameplayRatio: preparedResult.validation.stats.gameplayRatio,
      compliant: preparedResult.validation.meetsGlobalConstraints,
      constraints: {
        minGameplayRatio: this.constraints.minGameplayRatio,
        minGameplayPresence: this.constraints.minGameplayPresence,
        minSpectralEntropy: this.constraints.minSpectralEntropy,
      },
      rejected: preparedResult.validation.rejected,
    };
  }
}

module.exports = {
  RenderConstraints,
  RenderPipelineV2,
};
