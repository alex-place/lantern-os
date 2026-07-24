/**
 * Personal Development Cube API
 *
 * Provides personal development data for alex-place:
 * - GitHub state (issues, PRs, workflows)
 * - Provider status (API keys, rate limits, costs)
 * - Environment status (server, tests, git, disk, network)
 * - Current priorities (tasks, blockers, next actions)
 * - Personal metrics (time, progress, efficiency)
 *
 * NOTE (#2492): this endpoint shells out to `gh` and `git`. Those run via async
 * `execFile` (NOT `execSync`) so they never block the single-process event loop —
 * a blocking build here froze every other request for seconds on each chat load.
 * Results are cached for 60s and concurrent cold builds are de-duplicated, so the
 * every-5-minute client poll is almost always served from memory.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 60_000;
let _cache = null;      // last successful cube payload
let _cacheAt = 0;       // Date.now() when it was built
let _inflight = null;   // in-progress build promise (thundering-herd guard)

// Run a command OFF the event loop and return stdout. Never pass a shell string —
// execFile takes (bin, args[]) so there's no shell to block or inject into.
async function sh(bin, args, opts = {}) {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

async function buildCube(repoRoot) {
  const [github, providers, environment, priorities, metrics] = await Promise.all([
    getGitHubState(repoRoot),
    getProviderStatus(),
    getEnvironmentStatus(repoRoot),
    getCurrentPriorities(),
    getPersonalMetrics(),
  ]);
  return { github, providers, environment, priorities, metrics, timestamp: new Date().toISOString() };
}

module.exports = async function(req, res, url, deps) {
  const pathname = url.pathname;

  if (pathname === '/api/cubes/alex/personal' && req.method === 'GET') {
    try {
      const now = Date.now();
      if (_cache && now - _cacheAt < CACHE_TTL_MS) {
        deps.sendJson(res, { ..._cache, cached: true });
        return true;
      }
      // Coalesce concurrent cold builds so a burst of callers triggers ONE build.
      if (!_inflight) {
        _inflight = buildCube(deps.repoRoot)
          .then((data) => { _cache = data; _cacheAt = Date.now(); return data; })
          .finally(() => { _inflight = null; });
      }
      const cubeData = await _inflight;
      deps.sendJson(res, cubeData);
    } catch (error) {
      console.error('[personal-cube] Error fetching personal data:', error);
      // Prefer stale-but-useful data over a hard failure.
      if (_cache) deps.sendJson(res, { ..._cache, stale: true });
      else deps.sendJson(res, { error: 'Failed to fetch personal cube data' }, 500);
    }
    return true;
  }

  return false;
};

/**
 * Get GitHub state for alex-place
 */
async function getGitHubState(repoRoot) {
  try {
    // All independent — run them concurrently rather than one blocking call at a time.
    const [issuesOutput, prsOutput, workflowsOutput, branchOut, statusOut] = await Promise.all([
      sh('gh', ['issue', 'list', '--repo', 'alex-place/lantern-os', '--limit', '10', '--json', 'number,title,state,labels']),
      sh('gh', ['pr', 'list', '--repo', 'alex-place/lantern-os', '--limit', '5', '--json', 'number,title,state,headRefName']),
      sh('gh', ['run', 'list', '--repo', 'alex-place/lantern-os', '--limit', '5', '--json', 'databaseId,name,status,conclusion,createdAt']),
      sh('git', ['branch', '--show-current'], { cwd: repoRoot }),
      sh('git', ['status', '--porcelain'], { cwd: repoRoot }),
    ]);

    const issues = JSON.parse(issuesOutput);
    const prs = JSON.parse(prsOutput);
    const workflows = JSON.parse(workflowsOutput);
    const isDirty = statusOut.length > 0;

    return {
      issues: issues.map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        labels: i.labels.map(l => l.name)
      })),
      prs: prs.map(p => ({
        number: p.number,
        title: p.title,
        state: p.state,
        branch: p.headRefName
      })),
      workflows: workflows.map(w => ({
        id: w.databaseId,
        name: w.name,
        status: w.status,
        conclusion: w.conclusion,
        createdAt: w.createdAt
      })),
      branch: branchOut.trim(),
      isDirty,
      lastSync: new Date().toISOString()
    };
  } catch (error) {
    console.error('[personal-cube] Error fetching GitHub state:', error);
    return { error: 'Failed to fetch GitHub state' };
  }
}

/**
 * Get provider API status
 */
async function getProviderStatus() {
  const providers = {
    anthropic: {
      configured: !!process.env.ANTHROPIC_API_KEY,
      rateLimitRemaining: 'unknown',
      costThisMonth: 0
    },
    gemini: {
      configured: !!process.env.GEMINI_API_KEY,
      rateLimitRemaining: 'unknown',
      costThisMonth: 0
    },
    openai: {
      configured: !!process.env.OPENAI_API_KEY,
      rateLimitRemaining: 'unknown',
      costThisMonth: 0
    },
    xai: {
      configured: !!process.env.XAI_API_KEY,
      rateLimitRemaining: 'unknown',
      costThisMonth: 0
    },
    ollama: {
      configured: true, // Always available if Ollama is running
      models: [],
      status: 'unknown'
    }
  };

  // Check Ollama status — bounded so a down/hung Ollama can't slow the build.
  try {
    const ollamaResponse = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (ollamaResponse.ok) {
      const ollamaData = await ollamaResponse.json();
      providers.ollama.models = ollamaData.models?.map(m => m.name) || [];
      providers.ollama.status = 'running';
    } else {
      providers.ollama.status = 'stopped';
    }
  } catch (error) {
    providers.ollama.status = 'unavailable';
  }

  return providers;
}

/**
 * Get development environment status
 */
async function getEnvironmentStatus(repoRoot) {
  try {
    // Server status
    const serverRunning = process.env.PORT === '4177';

    // Test results (last test run)
    const testResultsPath = path.join(repoRoot, 'test-results', '.last-run.json');
    let testResults = null;
    if (fs.existsSync(testResultsPath)) {
      testResults = JSON.parse(fs.readFileSync(testResultsPath, 'utf-8'));
    }

    // Git status + branch (concurrent, non-blocking).
    const [gitStatus, branchOut] = await Promise.all([
      sh('git', ['status', '--porcelain'], { cwd: repoRoot }),
      sh('git', ['branch', '--show-current'], { cwd: repoRoot }),
    ]);
    const isDirty = gitStatus.length > 0;

    return {
      server: {
        running: serverRunning,
        port: 4177,
        uptime: process.uptime()
      },
      tests: testResults,
      git: {
        isDirty,
        branch: branchOut.trim()
      },
      disk: {
        // The old `wmic logicaldisk` shell-out was removed (#2492): it was slow,
        // Windows-only, deprecated, and its output was never parsed — disk always
        // reported 'unknown'. Kept as 'unknown' to preserve the response shape.
        available: 'unknown',
        used: 'unknown'
      },
      network: {
        status: 'connected', // Simplified
        latency: 'unknown'
      },
      lastCheck: new Date().toISOString()
    };
  } catch (error) {
    console.error('[personal-cube] Error fetching environment status:', error);
    return { error: 'Failed to fetch environment status' };
  }
}

/**
 * Get current priorities from GitHub issues
 */
async function getCurrentPriorities() {
  try {
    // Get issues with priority labels
    const issuesOutput = await sh('gh', ['issue', 'list', '--repo', 'alex-place/lantern-os', '--label', 'p0,p1,p2', '--limit', '10', '--json', 'number,title,labels']);
    const issues = JSON.parse(issuesOutput);

    // Prioritize by priority
    const priorities = issues.map(issue => {
      const priorityLabel = issue.labels.find(l => l.name.startsWith('p'));
      const priority = priorityLabel ? priorityLabel.name : 'p3';
      return {
        number: issue.number,
        title: issue.title,
        priority,
        status: 'open'
      };
    }).sort((a, b) => {
      const priorityOrder = { p0: 0, p1: 1, p2: 2, p3: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    return {
      active: priorities,
      blockers: priorities.filter(p => p.priority === 'p0'),
      nextActions: priorities.slice(0, 3),
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    console.error('[personal-cube] Error fetching priorities:', error);
    return { error: 'Failed to fetch priorities' };
  }
}

/**
 * Get personal metrics
 */
async function getPersonalMetrics() {
  try {
    // Time spent (simplified - would need actual tracking)
    const timeSpent = {
      today: 0,
      thisWeek: 0,
      thisMonth: 0
    };

    // Tasks completed
    const tasksCompleted = {
      today: 0,
      thisWeek: 0,
      thisMonth: 0
    };

    // Workflow efficiency
    const efficiency = {
      codingTime: 0,
      blockedTime: 0,
      efficiency: 0
    };

    return {
      timeSpent,
      tasksCompleted,
      efficiency,
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    console.error('[personal-cube] Error fetching personal metrics:', error);
    return { error: 'Failed to fetch personal metrics' };
  }
}
