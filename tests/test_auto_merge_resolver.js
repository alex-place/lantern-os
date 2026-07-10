/**
 * Test Auto Merge Resolver
 *
 * Tests the auto merge resolver and convergance training system
 * Run: npm run test:api --prefix apps/lantern-garage (after starting server)
 */

const AutoMergeResolver = require('../apps/lantern-garage/lib/auto-merge-resolver');
const ConverganceMergeTrainer = require('../apps/lantern-garage/lib/convergance-merge-trainer');

describe('AutoMergeResolver', () => {
  let resolver;

  beforeEach(() => {
    resolver = new AutoMergeResolver();
  });

  test('initializes with default patterns', () => {
    expect(resolver.patterns).toBeDefined();
    expect(resolver.patterns.agentLanePatterns).toBeDefined();
    expect(resolver.patterns.converganceThresholds).toBeDefined();
  });

  test('analyzes valid PR for merge readiness', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
      commits: [{ message: 'feat: add feature' }],
      conflicts: [],
      tests: { passed: 5, failed: 0, skipped: 0 },
    };

    const decision = resolver.analyzeMergeReadiness(prData);

    expect(decision).toBeDefined();
    expect(decision.mergeable).toBe(true);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.7);
    expect(decision.reason).toBeDefined();
    expect(decision.suggestedAgent).toBe('claude');
  });

  test('blocks merge with failing tests', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
      commits: [{ message: 'feat: add feature' }],
      conflicts: [],
      tests: { passed: 2, failed: 1, skipped: 0 },
    };

    const decision = resolver.analyzeMergeReadiness(prData);

    expect(decision.mergeable).toBe(false);
    expect(decision.confidence).toBeLessThan(0.7);
  });

  test('blocks merge with slop commits', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
      commits: [{ message: 'wip' }],
      conflicts: [],
      tests: { passed: 5, failed: 0 },
    };

    const decision = resolver.analyzeMergeReadiness(prData);

    expect(decision.mergeable).toBe(false);
  });

  test('warns on risky file modifications', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['SECURITY.md', 'src/lib/test.js'],
      commits: [{ message: 'feat: update security docs' }],
      conflicts: [],
      tests: { passed: 5, failed: 0 },
    };

    const decision = resolver.analyzeMergeReadiness(prData);

    expect(decision.confidence).toBeLessThan(1.0);
    const fileCheck = decision.checks.find(c => c.name === 'fileRisk');
    expect(fileCheck.status).toBe('warn');
  });

  test('records merge decision for training', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
      commits: [{ message: 'feat: add feature' }],
    };

    const decision = { mergeable: true, confidence: 0.95, suggestedAgent: 'claude' };

    resolver.recordMergeDecision(prData, decision, 'merged');

    expect(resolver.patterns.successMetrics.totalAttempts).toBe(1);
    expect(resolver.patterns.successMetrics.successfulMerges).toBe(1);
  });

  test('updates success metrics correctly', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
    };
    const decision = { mergeable: true, confidence: 0.9, suggestedAgent: 'claude' };

    resolver.recordMergeDecision(prData, decision, 'merged');
    resolver.recordMergeDecision(prData, decision, 'conflict');
    resolver.recordMergeDecision(prData, decision, 'merged');

    expect(resolver.patterns.successMetrics.totalAttempts).toBe(3);
    expect(resolver.patterns.successMetrics.successfulMerges).toBe(2);
    expect(resolver.patterns.successMetrics.learningAccuracy).toBeCloseTo(
      2 / 3,
      1
    );
  });

  test('learns from successful merges', () => {
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
    };
    const decision = { mergeable: true, confidence: 0.9, suggestedAgent: 'claude' };

    // Record multiple successful merges
    for (let i = 0; i < 5; i++) {
      resolver.recordMergeDecision(prData, decision, 'merged');
    }

    const pattern = resolver.converganceHeuristics['claude:1'];
    expect(pattern).toBeDefined();
    expect(pattern.attempts).toBe(5);
    expect(pattern.successes).toBe(5);
    expect(pattern.successRate).toBe(1.0);
  });

  test('detects direct master push attempt', () => {
    const prData = {
      branch: 'master',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
      commits: [{ message: 'feat: direct push' }],
    };

    const decision = resolver.analyzeMergeReadiness(prData);

    expect(decision.mergeable).toBe(false);
    expect(decision.reason).toContain('Direct push to master blocked');
  });
});

describe('ConverganceMergeTrainer', () => {
  let trainer;

  beforeEach(() => {
    trainer = new ConverganceMergeTrainer();
  });

  test('generates training prompt', () => {
    const prompt = trainer.generateTrainingPrompt();

    expect(prompt).toBeDefined();
    expect(prompt.prompt).toBeDefined();
    expect(prompt.context).toBeDefined();
  });

  test('identifies performance gaps', () => {
    // Record some failed merges
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
    };
    const decision = { mergeable: true, confidence: 0.9, suggestedAgent: 'claude' };

    // Simulate failures
    for (let i = 0; i < 3; i++) {
      trainer.resolver.recordMergeDecision(prData, decision, 'conflict');
    }
    for (let i = 0; i < 2; i++) {
      trainer.resolver.recordMergeDecision(prData, decision, 'merged');
    }

    const analysis = trainer.analyzeAndImprove();
    const gaps = analysis.performanceGaps;

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some(g => g.type === 'lowAccuracy')).toBe(true);
  });

  test('generates recommendations for improvement', () => {
    // Simulate low accuracy
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
    };
    const decision = { mergeable: true, confidence: 0.9, suggestedAgent: 'claude' };

    for (let i = 0; i < 5; i++) {
      trainer.resolver.recordMergeDecision(prData, decision, 'conflict');
    }

    const analysis = trainer.analyzeAndImprove();
    const recommendations = analysis.recommendedImprovements;

    expect(recommendations.length).toBeGreaterThan(0);
    expect(
      recommendations.some(r => r.priority === 'P0')
    ).toBe(true);
  });

  test('applies recommendations to resolver', () => {
    const recommendations = [
      {
        priority: 'P0',
        action: 'Review conflict detection logic',
        implementation: {
          type: 'threshold',
          key: 'maxConflicts',
          suggestedValue: 1,
        },
      },
    ];

    const result = trainer.applyRecommendations(recommendations);

    expect(result.status).toBe('applied');
    expect(result.appliedCount).toBe(1);
    expect(trainer.resolver.patterns.converganceThresholds.maxConflicts).toBe(1);
  });

  test('exports resolver status', () => {
    const status = trainer.getResolverStatus();

    expect(status).toBeDefined();
    expect(status.systemName).toBe('Auto Merge Resolver');
    expect(status.status).toBeDefined();
    expect(status.accuracy).toBeDefined();
    expect(status.topPatterns).toBeDefined();
  });

  test('processes unisona.ai response', () => {
    const keystoneAnalysis = {
      approved: [
        {
          priority: 'P0',
          action: 'Test action',
          implementation: {
            type: 'threshold',
            key: 'minConfidence',
            suggestedValue: 0.75,
          },
        },
      ],
      rejected: [],
      insights: ['Consider monitoring for pattern drift'],
    };

    const result = trainer.processKeystoneResponse(keystoneAnalysis);

    expect(result.status).toBeDefined();
    expect(result.approved.length).toBe(1);
    expect(result.appliedImprovements.length).toBeGreaterThan(0);
  });

  test('exports training history', () => {
    // Record some decisions
    const prData = {
      branch: 'claude/feature-x',
      targetBranch: 'master',
      files: ['src/lib/test.js'],
    };
    const decision = { mergeable: true, confidence: 0.9, suggestedAgent: 'claude' };

    trainer.resolver.recordMergeDecision(prData, decision, 'merged');
    trainer.analyzeAndImprove();

    const history = trainer.exportTrainingHistory();

    expect(history).toBeDefined();
    expect(history.analysisHistory).toBeDefined();
    expect(history.currentResolverState).toBeDefined();
    expect(history.converganceHeuristics).toBeDefined();
  });
});
