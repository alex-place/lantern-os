/**
 * Convergance Merge Trainer — !convergance integration for auto merge resolver
 *
 * Allows unisona.ai technical coordinator to:
 * 1. Query merge resolver performance metrics
 * 2. Analyze patterns from decision logs
 * 3. Generate recommendations for improvement
 * 4. Apply learned insights back to resolver
 *
 * Usage in !convergance:
 * User: "How can we improve our merge resolver?"
 * unisona.ai: [uses this trainer to analyze + provide insights]
 */

const AutoMergeResolver = require('./auto-merge-resolver');

class ConverganceMergeTrainer {
  constructor() {
    this.resolver = new AutoMergeResolver();
    this.analysisHistory = [];
  }

  /**
   * Main entry point: analyze resolver and generate insights
   * Called by unisona.ai technical coordinator via !convergance
   */
  analyzeAndImprove() {
    const analysis = {
      timestamp: new Date().toISOString(),
      currentMetrics: this.resolver.patterns.successMetrics,
      decisionLog: this.resolver.exportDecisionLog(),
      performanceGaps: this.identifyPerformanceGaps(),
      recommendedImprovements: this.generateRecommendations(),
      converganceQuery: this.resolver.generateConverganceQuery(),
    };

    this.analysisHistory.push(analysis);
    return analysis;
  }

  /**
   * Identify where resolver is underperforming
   */
  identifyPerformanceGaps() {
    const decisions = this.resolver.decisions;
    if (decisions.length === 0) {
      return {
        status: 'insufficient_data',
        message: 'Need more merge decisions to identify gaps',
        minRequired: 10,
      };
    }

    const gaps = [];
    const failureRate = 1 - this.resolver.patterns.successMetrics.learningAccuracy;

    // Gap 1: Low accuracy
    if (failureRate > 0.2) {
      gaps.push({
        type: 'lowAccuracy',
        severity: 'high',
        description: `Merge resolver accuracy is ${((1 - failureRate) * 100).toFixed(1)}% (target: 90%)`,
        affectedDecisions: decisions.filter(d => d.outcome !== 'merged').length,
      });
    }

    // Gap 2: Risky file handling
    const riskyFileFailures = decisions.filter(
      d => d.outcome !== 'merged' && d.riskLevel === 'high'
    );
    if (riskyFileFailures.length > 0) {
      gaps.push({
        type: 'riskyFileHandling',
        severity: 'medium',
        description: `High-risk file changes have ${((riskyFileFailures.length / decisions.length) * 100).toFixed(1)}% failure rate`,
        examples: riskyFileFailures.slice(0, 3),
      });
    }

    // Gap 3: Agent lane conflicts
    const laneBranches = decisions.reduce((acc, d) => {
      const lane = this.extractLane(d.branch);
      if (!acc[lane]) acc[lane] = { total: 0, failed: 0 };
      acc[lane].total++;
      if (d.outcome !== 'merged') acc[lane].failed++;
      return acc;
    }, {});

    for (const [lane, stats] of Object.entries(laneBranches)) {
      const failRate = stats.failed / stats.total;
      if (failRate > 0.15) {
        gaps.push({
          type: 'laneConflict',
          severity: 'medium',
          description: `${lane} lane has ${(failRate * 100).toFixed(1)}% merge failure rate`,
          laneStats: stats,
        });
      }
    }

    return gaps;
  }

  /**
   * Generate specific recommendations based on analysis
   */
  generateRecommendations() {
    const gaps = this.identifyPerformanceGaps();
    const recommendations = [];

    for (const gap of gaps) {
      if (gap.type === 'lowAccuracy') {
        recommendations.push({
          priority: 'P0',
          action: 'Review conflict detection logic',
          detail: 'Current conflict threshold may be too lenient. Consider reducing maxConflicts from 2 to 1.',
          implementation: {
            type: 'threshold',
            key: 'maxConflicts',
            currentValue: 2,
            suggestedValue: 1,
          },
        });

        recommendations.push({
          priority: 'P0',
          action: 'Improve test status checking',
          detail: 'Several merges passed with skipped tests. Require at least one passing test per file changed.',
          implementation: {
            type: 'pattern',
            key: 'testRequirements',
            update: { minPassingTests: 1, blockOnSkipped: true },
          },
        });
      }

      if (gap.type === 'riskyFileHandling') {
        recommendations.push({
          priority: 'P1',
          action: 'Strengthen risky file review',
          detail: 'CLAUDE.md, SECURITY.md, package.json changes need human review. Consider auto-requesting code review.',
          implementation: {
            type: 'pattern',
            key: 'filePatterns',
            update: { requireHumanReview: true },
          },
        });
      }

      if (gap.type === 'laneConflict') {
        recommendations.push({
          priority: 'P1',
          action: `Audit ${gap.laneStats} merge workflow`,
          detail: `This agent lane has higher-than-average failure rate. Review monoworkstream rules or add lane-specific logic.`,
          implementation: {
            type: 'pattern',
            key: 'agentLanePatterns',
            update: { needsAudit: true },
          },
        });
      }
    }

    return recommendations;
  }

  /**
   * Extract agent lane from branch name
   */
  extractLane(branch) {
    if (!branch) return 'unknown';
    const match = branch.match(/^([a-z]+)\//);
    return match ? match[1] : 'other';
  }

  /**
   * Apply recommendations to resolver (called after unisona.ai approval)
   */
  applyRecommendations(recommendations) {
    const appliedCount = recommendations.length;
    const updates = {
      thresholdUpdates: [],
      patternUpdates: [],
      timestamp: new Date().toISOString(),
    };

    for (const rec of recommendations) {
      if (rec.implementation.type === 'threshold') {
        const { key, suggestedValue } = rec.implementation;
        this.resolver.patterns.converganceThresholds[key] = suggestedValue;
        updates.thresholdUpdates.push({ key, newValue: suggestedValue });
      } else if (rec.implementation.type === 'pattern') {
        const { key, update } = rec.implementation;
        this.resolver.patterns[key] = {
          ...this.resolver.patterns[key],
          ...update,
        };
        updates.patternUpdates.push({ key, update });
      }
    }

    this.resolver.savePatterns();

    return {
      status: 'applied',
      appliedCount,
      updates,
      message: `Applied ${appliedCount} improvements to merge resolver`,
    };
  }

  /**
   * Get resolver status for unisona.ai reporting
   */
  getResolverStatus() {
    const metrics = this.resolver.patterns.successMetrics;
    const topPatterns = Object.entries(this.resolver.converganceHeuristics)
      .sort((a, b) => b[1].successRate - a[1].successRate)
      .slice(0, 5)
      .map(([key, val]) => ({
        pattern: key,
        successRate: `${(val.successRate * 100).toFixed(1)}%`,
        attempts: val.attempts,
      }));

    return {
      systemName: 'Auto Merge Resolver',
      status: metrics.learningAccuracy >= 0.8 ? 'healthy' : 'needs_training',
      accuracy: `${(metrics.learningAccuracy * 100).toFixed(1)}%`,
      totalDecisions: metrics.totalAttempts,
      successfulMerges: metrics.successfulMerges,
      failedMerges: metrics.failedMerges,
      topPatterns,
      lastAnalysis: this.analysisHistory[this.analysisHistory.length - 1]?.timestamp,
      nextAction: metrics.learningAccuracy < 0.8 ? 'Schedule !convergance training' : 'Monitor for drift',
    };
  }

  /**
   * Generate !convergance training prompt for unisona.ai
   */
  generateTrainingPrompt() {
    const analysis = this.analyzeAndImprove();
    const gaps = analysis.performanceGaps;
    const recommendations = analysis.recommendedImprovements;

    if (gaps.length === 0) {
      return {
        prompt: 'Auto merge resolver is performing well. Monitor for pattern drift.',
        context: 'No significant gaps identified',
      };
    }

    const gapSummary = gaps
      .map(g => `${g.type}: ${g.description}`)
      .join('\n');

    const recSummary = recommendations
      .slice(0, 3)
      .map(r => `- [${r.priority}] ${r.action}`)
      .join('\n');

    return {
      prompt: `Auto Merge Resolver Training Request:

Identified Gaps:
${gapSummary}

Recommended Improvements:
${recSummary}

Please analyze and confirm which recommendations to apply.`,
      context: {
        currentAccuracy: `${(analysis.currentMetrics.learningAccuracy * 100).toFixed(1)}%`,
        totalDecisions: analysis.currentMetrics.totalAttempts,
        gaps: gaps.map(g => ({ type: g.type, severity: g.severity })),
        recommendations: recommendations.slice(0, 3),
      },
    };
  }

  /**
   * Process unisona.ai response with approved improvements
   */
  processKeystoneResponse(keystoneAnalysis) {
    // keystoneAnalysis: { approved: [], rejected: [], insights: [] }
    const result = {
      timestamp: new Date().toISOString(),
      approved: keystoneAnalysis.approved || [],
      rejected: keystoneAnalysis.rejected || [],
      appliedImprovements: [],
    };

    // Apply approved recommendations
    if (keystoneAnalysis.approved && keystoneAnalysis.approved.length > 0) {
      const applyResult = this.applyRecommendations(keystoneAnalysis.approved);
      result.appliedImprovements = applyResult.updates;
    }

    // Log any new insights
    if (keystoneAnalysis.insights && keystoneAnalysis.insights.length > 0) {
      result.newInsights = keystoneAnalysis.insights;
    }

    return result;
  }

  /**
   * Export full training history for audit
   */
  exportTrainingHistory() {
    return {
      analysisHistory: this.analysisHistory,
      currentResolverState: this.resolver.patterns,
      converganceHeuristics: this.resolver.converganceHeuristics,
      exportDate: new Date().toISOString(),
    };
  }
}

module.exports = ConverganceMergeTrainer;
