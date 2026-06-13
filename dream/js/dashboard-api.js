/**
 * Unified Dashboard API Client
 * Provides cached, deduplicated access to all operational dashboard endpoints
 * Features:
 * - Request deduplication (same request in flight → share result)
 * - Smart caching with TTL per endpoint
 * - Exponential backoff retry (3 attempts)
 * - AbortSignal timeout (8s default)
 * - Automatic error normalization
 */

class DashboardAPI {
  constructor(baseUrl = "/") {
    this.baseUrl = baseUrl;
    this._cache = new Map();
    this._pending = new Map();
    this._retryConfig = {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000
    };
    this._timeouts = {
      default: 8000,
      system: 10000,
      leaderboard: 5000
    };
  }

  /**
   * Get unified system overview (queue, agents, providers, mesh, leaderboard)
   */
  async getSystemStatus() {
    return this._fetchCached('/api/system/overview', { ttl: 30000 });
  }

  /**
   * Get queue status only (pending, assigned, completed, failed)
   */
  async getQueueStatus() {
    return this._fetchCached('/api/queue/status', { ttl: 5000 });
  }

  /**
   * Get queue-specific agent slot data
   */
  async getQueueAgents() {
    return this._fetchCached('/api/queue/agents', { ttl: 5000 });
  }

  /**
   * Get pending work items
   */
  async getQueuePending(limit = 10) {
    return this._fetchCached(`/api/queue/list/pending`, { ttl: 5000 });
  }

  /**
   * Get Tesseract fleet status
   */
  async getAgentStatus() {
    return this._fetchCached('/api/agents/status', { ttl: 5000 });
  }

  /**
   * Get leaderboard data by task type
   */
  async getLeaderboard(taskType = 'all', topN = 10) {
    return this._fetchCached(`/api/agent-performance/leaderboard?taskType=${taskType}&topN=${topN}`, { ttl: 10000 });
  }

  /**
   * Get provider health status
   */
  async getProviderHealth() {
    return this._fetchCached('/api/agent-performance/provider-health', { ttl: 15000 });
  }

  /**
   * Invalidate cache for a specific endpoint
   */
  invalidateCache(endpoint) {
    this._cache.delete(endpoint);
  }

  /**
   * Clear all caches
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Internal: Cached fetch with deduplication
   */
  async _fetchCached(endpoint, options = {}) {
    const { ttl = 30000 } = options;

    // Check cache first
    const cached = this._cache.get(endpoint);
    if (cached && (Date.now() - cached.timestamp) < ttl) {
      return cached.data;
    }

    // Check if request is already pending
    if (this._pending.has(endpoint)) {
      return this._pending.get(endpoint);
    }

    // Fetch with retry logic
    const promise = this._fetchWithRetry(endpoint);
    this._pending.set(endpoint, promise);

    try {
      const data = await promise;
      // Cache the result
      this._cache.set(endpoint, { data, timestamp: Date.now() });
      return data;
    } finally {
      this._pending.delete(endpoint);
    }
  }

  /**
   * Internal: Fetch with exponential backoff retry
   */
  async _fetchWithRetry(endpoint) {
    let lastError = null;

    for (let attempt = 0; attempt < this._retryConfig.maxRetries; attempt++) {
      try {
        const url = endpoint.startsWith('http') ? endpoint : (this.baseUrl === '/' ? '' : this.baseUrl) + endpoint;
        const timeoutMs = this._timeouts.system; // Default timeout

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const json = await response.json();
          return json.data || json; // Handle both {ok, data} and direct responses
        } catch (err) {
          clearTimeout(timeoutId);
          throw err;
        }
      } catch (error) {
        lastError = error;

        // Don't retry if it's an abort or last attempt
        if (attempt === this._retryConfig.maxRetries - 1) {
          break;
        }

        // Exponential backoff
        const delay = Math.min(
          this._retryConfig.initialDelayMs * Math.pow(2, attempt),
          this._retryConfig.maxDelayMs
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Return error response instead of throwing
    return {
      error: lastError?.message || 'Unknown error',
      status: 'error',
      timestamp: new Date().toISOString()
    };
  }
}

// Export singleton instance
const dashboardAPI = new DashboardAPI();
