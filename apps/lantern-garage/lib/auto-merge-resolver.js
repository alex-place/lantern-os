/**
 * Auto Merge Resolver — Self-training via !convergance patterns
 *
 * System that learns from PR routing decisions, branch patterns, and merge outcomes
 * to continuously improve merge decision-making. Integrates with unisona.ai technical
 * coordinator via !convergance workflow for pattern analysis.
 *
 * Tracks:
 * - Merge attempts (success/failure, time, branch info)
 * - Pattern recognition (agent lane conflicts, code change impact)
 * - Convergance routing decisions (which agent should handle)
 * - Self-training metrics (confidence, accuracy, pattern drift)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');
const MERGE_LOG = path.join(DATA_DIR, 'auto-merge-decisions.jsonl');
const PATTERN_CACHE = path.join(DATA_DIR, 'merge-patterns.json');

class AutoMergeResolver {
  constructor() {
    this.decisions = [];
    this.patterns = this.loadPatterns();
    this.converganceHeuristics = {};
    this.loadDecisionLog();
  }

  /**
   * Load historical merge decisions for pattern analysis
   */
  loadDecisionLog() {
    if (!fs.existsSync(MERGE_LOG)) return;
    try {
      const lines = fs.readFileSync(MERGE_LOG, 'utf-8').split('\n').filter(Boolean);
      this.decisions = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (e) {
      console.error('Failed to load merge decision log:', e.message);
    }
  }

  /**
   * Load or initialize pattern cache
   */
  loadPatterns() {
    if (!fs.existsSync(PATTERN_CACHE)) {
      return this.initDefaultPatterns();
    }
    try {
      return JSON.parse(fs.readFileSync(PATTERN_CACHE, 'utf-8'));
    } catch (e) {
      return this.initDefaultPatterns();
    }
  }

  /**
   * Default merge decision patterns based on monoworkstream rules
   */
  initDefaultPatterns() {
    return {
      agentLanePatterns: {
        'claude/': { canMerge: 'all', priority: 5 },
        'gemini/': { canMerge: 'all', priority: 5 },
        'codex/': { canMerge: 'all', priority: 5 },
        'devin/': { canMerge: 'all', priority: 5 },
        'grok/': { canMerge: 'all', priority: 5 },
        'openai/': { canMerge: 'all', priority: 5 },
        'gh-pages': { canMerge: 'github-action', priority: 10 },
        'master': { canMerge: 'pr-only', priority: 15 },
      },
      filePatterns: {
        'CLAUDE.md': { risky: true, needsReview: true },
        'AGENTS.md': { risky: true, needsReview: true },
        'SECURITY.md': { risky: true, needsReview: true },
        'package.json': { risky: true, needsReview: true },
        'requirements.txt': { risky: true, needsReview: true },
        '.github/workflows': { risky: true, needsReview: true },
      },
      converganceThresholds: {
        minConfidence: 0.7,
        maxConflicts: 2,
        maxTimeMinutes: 60,
      },
      successMetrics: {
        totalAttempts: 0,
        successfulMerges: 0,
        failedMerges: 0,
        learningAccuracy: 0.8,
      },
    };
  }

  /**
   * Analyze a PR/branch for merge readiness
   * Returns { mergeable, confidence, reason, suggestedAgent }
   */
  analyzeMergeReadiness(prData) {
    const {
      branch,
      files,
      commits,
      conflicts,
      tests,
      targetBranch = 'master',
      author,
    } = prData;

    const checks = [];
    let confidence = 1.0;
    let suggestedAgent = this.getAgentFromBranch(branch);

    // Check 1: Branch naming convention
    const branchCheck = this.checkBranchNaming(branch);
    checks.push(branchCheck);
    confidence *= branchCheck.confidence;

    // Check 2: File risk assessment
    const fileCheck = this.checkFileRisk(files);
    checks.push(fileCheck);
    confidence *= fileCheck.confidence;

    // Check 3: Conflict detection
    const conflictCheck = this.checkConflicts(conflicts);
    checks.push(conflictCheck);
    confidence *= conflictCheck.confidence;

    // Check 4: Test status
    const testCheck = this.checkTestStatus(tests);
    checks.push(testCheck);
    confidence *= testCheck.confidence;

    // Check 5: Commit quality
    const commitCheck = this.checkCommitQuality(commits);
    checks.push(commitCheck);
    confidence *= commitCheck.confidence;

    // Check 6: Convergance pattern matching
    const converganceCheck = this.checkConvergancePattern(
      branch,
      files,
      targetBranch
    );
    checks.push(converganceCheck);
    confidence *= converganceCheck.confidence;

    const mergeable = confidence >= this.patterns.converganceThresholds.minConfidence;
    const reason = this.synthesizeReason(checks);

    return {
      mergeable,
      confidence: Math.round(confidence * 100) / 100,
      reason,
      suggestedAgent,
      checks: checks.map(c => ({ name: c.name, status: c.status })),
    };
  }

  /**
   * Check branch naming follows monoworkstream rules
   */
  checkBranchNaming(branch) {
    if (!branch || typeof branch !== 'string') {
      return { name: 'branchNaming', status: 'fail', confidence: 0 };
    }

    const isExempt = ['gh-pages', 'master', 'dev'].includes(branch);
    if (isExempt) {
      return { name: 'branchNaming', status: 'pass', confidence: 1.0 };
    }

    for (const [prefix, pattern] of Object.entries(
      this.patterns.agentLanePatterns
    )) {
      if (branch.startsWith(prefix)) {
        return { name: 'branchNaming', status: 'pass', confidence: 0.95 };
      }
    }

    return {
      name: 'branchNaming',
      status: 'warn',
      confidence: 0.5,
      detail: 'Branch does not match agent lane pattern',
    };
  }

  /**
   * Check if PR modifies risky files
   */
  checkFileRisk(files) {
    if (!files || !Array.isArray(files)) {
      return { name: 'fileRisk', status: 'pass', confidence: 1.0 };
    }

    let maxRisk = 0;
    const riskyFiles = [];

    for (const file of files) {
      const filename = path.basename(file);
      const pattern = this.patterns.filePatterns[filename];
      if (pattern && pattern.risky) {
        maxRisk = 1;
        riskyFiles.push(filename);
      }
    }

    if (maxRisk) {
      return {
        name: 'fileRisk',
        status: 'warn',
        confidence: 0.7,
        detail: `Risky files: ${riskyFiles.join(', ')}`,
      };
    }

    return { name: 'fileRisk', status: 'pass', confidence: 1.0 };
  }

  /**
   * Check for merge conflicts
   */
  checkConflicts(conflicts) {
    const conflictCount = (conflicts || []).length;
    if (conflictCount > this.patterns.converganceThresholds.maxConflicts) {
      return {
        name: 'conflicts',
        status: 'fail',
        confidence: 0,
        detail: `Too many conflicts: ${conflictCount}`,
      };
    }

    if (conflictCount > 0) {
      return {
        name: 'conflicts',
        status: 'warn',
        confidence: 0.6,
        detail: `${conflictCount} conflict(s) found`,
      };
    }

    return { name: 'conflicts', status: 'pass', confidence: 1.0 };
  }

  /**
   * Check test status
   */
  checkTestStatus(tests) {
    if (!tests) {
      return {
        name: 'testStatus',
        status: 'warn',
        confidence: 0.8,
        detail: 'No test data available',
      };
    }

    const { passed, failed, skipped } = tests;

    if (failed && failed > 0) {
      return {
        name: 'testStatus',
        status: 'fail',
        confidence: 0,
        detail: `${failed} test(s) failed`,
      };
    }

    if (!passed || passed === 0) {
      return {
        name: 'testStatus',
        status: 'warn',
        confidence: 0.7,
        detail: 'No passing tests',
      };
    }

    return {
      name: 'testStatus',
      status: 'pass',
      confidence: 1.0,
      detail: `${passed} test(s) passed`,
    };
  }

  /**
   * Check commit message quality (no slop commits)
   */
  checkCommitQuality(commits) {
    if (!commits || !Array.isArray(commits)) {
      return { name: 'commitQuality', status: 'pass', confidence: 1.0 };
    }

    const slopPatterns = [/^wip$/i, /^temp$/i, /^placeholder$/i, /^test$/i];
    const shortMessages = commits.filter(c => (c.message || '').length < 8);
    const slopMessages = commits.filter(c =>
      slopPatterns.some(p => p.test(c.message || ''))
    );

    if (slopMessages.length > 0) {
      return {
        name: 'commitQuality',
        status: 'fail',
        confidence: 0,
        detail: `${slopMessages.length} slop commit(s)`,
      };
    }

    if (shortMessages.length > 0) {
      return {
        name: 'commitQuality',
        status: 'warn',
        confidence: 0.8,
        detail: `${shortMessages.length} short commit message(s)`,
      };
    }

    return { name: 'commitQuality', status: 'pass', confidence: 1.0 };
  }

  /**
   * Check against learned convergance patterns
   */
  checkConvergancePattern(branch, files, targetBranch) {
    const agent = this.getAgentFromBranch(branch);
    const hasOpenPR = this.checkForOpenPRInLane(agent);

    if (hasOpenPR && targetBranch === 'master') {
      return {
        name: 'convergancePattern',
        status: 'fail',
        confidence: 0,
        detail: `${agent} lane already has open PR (monoworkstream rule)`,
      };
    }

    const directPushAttempt = branch === targetBranch && !['github-action'].includes(agent);
    if (directPushAttempt) {
      return {
        name: 'convergancePattern',
        status: 'fail',
        confidence: 0,
        detail: 'Direct push to master blocked — must use PR',
      };
    }

    // Learn from pattern match
    const patternScore = this.scoreConverganceMatch(branch, files);
    const confidence = Math.max(0.5, Math.min(1.0, patternScore));

    return {
      name: 'convergancePattern',
      status: confidence >= 0.8 ? 'pass' : 'warn',
      confidence,
      detail: `Pattern match score: ${(patternScore * 100).toFixed(0)}%`,
    };
  }

  /**
   * Score how well a branch/file combo matches learned patterns
   */
  scoreConverganceMatch(branch, files) {
    const agent = this.getAgentFromBranch(branch);
    const patternKey = `${agent}:${(files || []).length}`;
    const pattern = this.converganceHeuristics[patternKey];

    if (!pattern) {
      return 0.7; // neutral score for unseen pattern
    }

    return pattern.successRate || 0.7;
  }

  /**
   * Get agent from branch prefix
   */
  getAgentFromBranch(branch) {
    for (const [prefix] of Object.entries(
      this.patterns.agentLanePatterns
    )) {
      if (branch.startsWith(prefix)) {
        return prefix.replace('/', '');
      }
    }
    return 'unknown';
  }

  /**
   * Check if agent lane already has open PR (simplified)
   * In production, would query GitHub API
   */
  checkForOpenPRInLane(agent) {
    // Placeholder: would integrate with GitHub API
    return false;
  }

  /**
   * Synthesize human-readable reason from checks
   */
  synthesizeReason(checks) {
    const failures = checks.filter(c => c.status === 'fail');
    if (failures.length > 0) {
      return failures.map(f => f.detail || f.name).join('; ');
    }

    const warnings = checks.filter(c => c.status === 'warn');
    if (warnings.length > 0) {
      return `Warnings: ${warnings.map(w => w.detail || w.name).join('; ')}`;
    }

    return 'Ready to merge';
  }

  /**
   * Record a merge decision for self-training
   */
  recordMergeDecision(prData, decision, outcome) {
    const record = {
      timestamp: new Date().toISOString(),
      branch: prData.branch,
      targetBranch: prData.targetBranch || 'master',
      files: (prData.files || []).length,
      commits: (prData.commits || []).length,
      decision: decision.mergeable,
      confidence: decision.confidence,
      outcome: outcome, // 'merged', 'conflict', 'test-fail', 'blocked'
      converganceAgent: decision.suggestedAgent,
    };

    // Append to log
    try {
      fs.appendFileSync(MERGE_LOG, JSON.stringify(record) + '\n');
    } catch (e) {
      console.error('Failed to log merge decision:', e.message);
    }

    // Update success metrics
    this.updateSuccessMetrics(outcome);

    // Self-train from outcome
    this.selfTrainFromOutcome(record, outcome);
  }

  /**
   * Update success/failure metrics
   */
  updateSuccessMetrics(outcome) {
    this.patterns.successMetrics.totalAttempts++;

    if (outcome === 'merged') {
      this.patterns.successMetrics.successfulMerges++;
    } else {
      this.patterns.successMetrics.failedMerges++;
    }

    // Recalculate accuracy
    if (this.patterns.successMetrics.totalAttempts > 0) {
      this.patterns.successMetrics.learningAccuracy =
        this.patterns.successMetrics.successfulMerges /
        this.patterns.successMetrics.totalAttempts;
    }

    this.savePatterns();
  }

  /**
   * Self-train heuristics based on merge outcome
   */
  selfTrainFromOutcome(record, outcome) {
    const { branch, files, converganceAgent } = record;
    const patternKey = `${converganceAgent}:${files}`;

    if (!this.converganceHeuristics[patternKey]) {
      this.converganceHeuristics[patternKey] = {
        attempts: 0,
        successes: 0,
        successRate: 0.5,
      };
    }

    const pattern = this.converganceHeuristics[patternKey];
    pattern.attempts++;

    if (outcome === 'merged') {
      pattern.successes++;
    }

    pattern.successRate = pattern.successes / pattern.attempts;
  }

  /**
   * Save patterns and heuristics to cache
   */
  savePatterns() {
    try {
      fs.writeFileSync(
        PATTERN_CACHE,
        JSON.stringify(this.patterns, null, 2)
      );
    } catch (e) {
      console.error('Failed to save pattern cache:', e.message);
    }
  }

  /**
   * Generate !convergance query for system improvement
   * Returns a prompt suitable for unisona.ai technical coordinator
   */
  generateConverganceQuery() {
    const stats = this.patterns.successMetrics;
    const accuracy = (stats.learningAccuracy * 100).toFixed(1);

    return {
      query: `Analyze merge resolver patterns for improvement. Current accuracy: ${accuracy}%. Successful: ${stats.successfulMerges}/${stats.totalAttempts}. Identify patterns to improve next 5 merges.`,
      context: {
        totalAttempts: stats.totalAttempts,
        successRate: accuracy,
        topPatterns: Object.entries(this.converganceHeuristics)
          .sort((a, b) => b[1].successRate - a[1].successRate)
          .slice(0, 5)
          .map(([key, pattern]) => ({
            pattern: key,
            successRate: (pattern.successRate * 100).toFixed(1) + '%',
            attempts: pattern.attempts,
          })),
      },
    };
  }

  /**
   * Apply improvements from !convergance analysis
   */
  applyConverganceInsights(insights) {
    // insights: { recommendations: [], patternUpdates: {} }
    if (!insights || !insights.recommendations) {
      return;
    }

    insights.recommendations.forEach(rec => {
      // Update thresholds, patterns, or heuristics based on recommendation
      if (rec.type === 'threshold') {
        this.patterns.converganceThresholds[rec.key] = rec.value;
      } else if (rec.type === 'pattern') {
        this.patterns[rec.key] = { ...this.patterns[rec.key], ...rec.value };
      }
    });

    this.savePatterns();
  }

  /**
   * Export decision log for convergance analysis
   */
  exportDecisionLog() {
    return {
      decisions: this.decisions,
      metrics: this.patterns.successMetrics,
      patterns: this.converganceHeuristics,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = AutoMergeResolver;
