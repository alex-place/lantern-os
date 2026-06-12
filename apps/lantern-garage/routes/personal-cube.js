/**
 * Personal Development Cube API
 * 
 * Provides personal development data for alex-place:
 * - GitHub state (issues, PRs, workflows)
 * - Provider status (API keys, rate limits, costs)
 * - Environment status (server, tests, git, disk, network)
 * - Current priorities (tasks, blockers, next actions)
 * - Personal metrics (time, progress, efficiency)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async function(req, res, deps) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/cubes/alex/personal' && req.method === 'GET') {
    try {
      const cubeData = {
        github: await getGitHubState(deps.repoRoot),
        providers: await getProviderStatus(),
        environment: await getEnvironmentStatus(deps.repoRoot),
        priorities: await getCurrentPriorities(),
        metrics: await getPersonalMetrics(),
        timestamp: new Date().toISOString()
      };
      
      deps.sendJson(res, cubeData);
    } catch (error) {
      console.error('[personal-cube] Error fetching personal data:', error);
      deps.sendJson(res, { error: 'Failed to fetch personal cube data' }, 500);
    }
  }
};

/**
 * Get GitHub state for alex-place
 */
async function getGitHubState(repoRoot) {
  try {
    // Get open issues
    const issuesOutput = execSync('gh issue list --repo alex-place/lantern-os --limit 10 --json number,title,state,labels', { encoding: 'utf-8' });
    const issues = JSON.parse(issuesOutput);
    
    // Get open PRs
    const prsOutput = execSync('gh pr list --repo alex-place/lantern-os --limit 5 --json number,title,state,headRefName', { encoding: 'utf-8' });
    const prs = JSON.parse(prsOutput);
    
    // Get workflow status
    const workflowsOutput = execSync('gh run list --repo alex-place/lantern-os --limit 5 --json databaseId,name,status,conclusion,createdAt', { encoding: 'utf-8' });
    const workflows = JSON.parse(workflowsOutput);
    
    // Get current branch
    const branch = execSync('git branch --show-current', { encoding: 'utf-8', cwd: repoRoot }).trim();
    
    // Get git status
    const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: repoRoot });
    const isDirty = status.length > 0;
    
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
      branch,
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
  
  // Check Ollama status
  try {
    const ollamaResponse = await fetch('http://127.0.0.1:11434/api/tags');
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
    
    // Git status
    const gitStatus = execSync('git status --porcelain', { encoding: 'utf-8', cwd: repoRoot });
    const isDirty = gitStatus.length > 0;
    
    // Disk space
    const diskSpace = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf-8' });
    
    // Network status
    const networkStatus = 'connected'; // Simplified
    
    return {
      server: {
        running: serverRunning,
        port: 4177,
        uptime: process.uptime()
      },
      tests: testResults,
      git: {
        isDirty,
        branch: execSync('git branch --show-current', { encoding: 'utf-8', cwd: repoRoot }).trim()
      },
      disk: {
        available: 'unknown', // Parse from diskSpace
        used: 'unknown'
      },
      network: {
        status: networkStatus,
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
    const issuesOutput = execSync('gh issue list --repo alex-place/lantern-os --label "p0,p1,p2" --limit 10 --json number,title,labels', { encoding: 'utf-8' });
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
