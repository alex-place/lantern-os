// ── Rate Limit Manager ──────────────────────────────────────────────────
// Handles 429 responses with exponential backoff and response caching

class RateLimitManager {
  constructor(options = {}) {
    this.providers = {}; // Track rate limits per provider
    this.cache = new Map(); // Response cache
    this.cacheExpiry = new Map(); // Cache expiration times
    this.maxRetries = options.maxRetries || 3;
    this.initialBackoffMs = options.initialBackoffMs || 1000;
    this.maxBackoffMs = options.maxBackoffMs || 60000;
    this.cacheDefaultTtlMs = options.cacheDefaultTtlMs || 300000; // 5 minutes
  }

  // Track rate limit info from response headers
  recordRateLimit(provider, headers) {
    if (!this.providers[provider]) {
      this.providers[provider] = {
        remaining: null,
        resetAt: null,
        retryAfterSeconds: null,
      };
    }

    const stats = this.providers[provider];

    // Standard RateLimit headers (varies by provider)
    if (headers["x-ratelimit-remaining"]) {
      stats.remaining = parseInt(headers["x-ratelimit-remaining"], 10);
    }
    if (headers["x-ratelimit-reset"]) {
      stats.resetAt = new Date(parseInt(headers["x-ratelimit-reset"], 10) * 1000);
    }
    if (headers["retry-after"]) {
      stats.retryAfterSeconds = parseInt(headers["retry-after"], 10);
    }

    // Anthropic-specific headers
    if (headers["anthropic-ratelimit-remaining-tokens"]) {
      stats.remaining = parseInt(headers["anthropic-ratelimit-remaining-tokens"], 10);
    }
    if (headers["anthropic-ratelimit-reset-tokens"]) {
      stats.resetAt = new Date(headers["anthropic-ratelimit-reset-tokens"]);
    }

    // OpenAI-specific headers
    if (headers["x-ratelimit-remaining-requests"]) {
      stats.remaining = parseInt(headers["x-ratelimit-remaining-requests"], 10);
    }
    if (headers["x-ratelimit-reset-requests"]) {
      const resetStr = headers["x-ratelimit-reset-requests"];
      stats.resetAt = new Date(resetStr.includes("-") ? resetStr : new Date(parseInt(resetStr) * 1000));
    }

    return stats;
  }

  // Check if rate limit is exceeded
  isRateLimited(provider) {
    const stats = this.providers[provider];
    if (!stats) return false;

    // If remaining is 0 or negative, we're rate limited
    if (stats.remaining !== null && stats.remaining <= 0) return true;

    // If reset time is in the future, we're rate limited
    if (stats.resetAt && stats.resetAt > new Date()) return true;

    return false;
  }

  // Get wait time before next request
  getWaitMs(provider) {
    const stats = this.providers[provider];
    if (!stats) return 0;

    let waitMs = 0;

    // Priority 1: Explicit retry-after header
    if (stats.retryAfterSeconds) {
      waitMs = stats.retryAfterSeconds * 1000;
    }
    // Priority 2: Calculate from reset time
    else if (stats.resetAt) {
      waitMs = Math.max(0, stats.resetAt.getTime() - Date.now());
    }

    return waitMs;
  }

  // Cache a response with TTL
  cacheResponse(key, response, ttlMs = null) {
    const expiryMs = ttlMs || this.cacheDefaultTtlMs;
    this.cache.set(key, response);
    this.cacheExpiry.set(key, Date.now() + expiryMs);
  }

  // Get cached response if not expired
  getCachedResponse(key) {
    const expiry = this.cacheExpiry.get(key);
    if (!expiry || expiry < Date.now()) {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      return null;
    }
    return this.cache.get(key);
  }

  // Clear expired cache entries
  clearExpiredCache() {
    const now = Date.now();
    for (const [key, expiry] of this.cacheExpiry.entries()) {
      if (expiry < now) {
        this.cache.delete(key);
        this.cacheExpiry.delete(key);
      }
    }
  }

  // Execute request with retry logic
  async executeWithRetry(provider, requestFn, options = {}) {
    const {
      cacheKey = null,
      cacheTtlMs = null,
      onRetry = null,
    } = options;

    // Check cache first
    if (cacheKey) {
      const cached = this.getCachedResponse(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }

    let lastError = null;
    let backoffMs = this.initialBackoffMs;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // Check if rate limited before request
        if (this.isRateLimited(provider)) {
          const waitMs = this.getWaitMs(provider);
          console.warn(`[rate-limit] Provider ${provider} rate limited, waiting ${waitMs}ms`);
          await new Promise(resolve => setTimeout(resolve, waitMs + 1000)); // Add 1s buffer
        }

        // Execute request
        const response = await requestFn();

        // Cache successful response
        if (cacheKey && response && !response.error) {
          this.cacheResponse(cacheKey, response, cacheTtlMs);
        }

        return response;
      } catch (error) {
        lastError = error;

        // Check if 429 rate limit error
        const is429 = error.message?.includes("429") ||
                      error.status === 429 ||
                      error.code === "rate_limit_exceeded";

        if (is429 && attempt < this.maxRetries - 1) {
          if (onRetry) {
            onRetry({
              provider,
              attempt,
              error: error.message,
              waitMs: backoffMs,
            });
          }

          console.warn(`[rate-limit] ${provider} 429 on attempt ${attempt + 1}, backing off ${backoffMs}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs); // Exponential backoff
        } else {
          throw error;
        }
      }
    }

    throw lastError || new Error(`Failed after ${this.maxRetries} retries`);
  }

  // Get provider stats
  getStats(provider = null) {
    if (provider) {
      return this.providers[provider] || {
        remaining: null,
        resetAt: null,
        retryAfterSeconds: null,
      };
    }

    // Return all providers
    return {
      providers: this.providers,
      cacheSize: this.cache.size,
      generatedAt: new Date().toISOString(),
    };
  }

  // Reset all limits (for testing)
  reset() {
    this.providers = {};
    this.cache.clear();
    this.cacheExpiry.clear();
  }
}

module.exports = { RateLimitManager };
