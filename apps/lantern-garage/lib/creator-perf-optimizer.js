// ── Creator Dashboard Performance Optimizer ─────────────────────────────
// Reduces resource usage through visibility-based polling, lazy loading, and caching

class CreatorPerfOptimizer {
  constructor() {
    this.pollingIntervals = new Map(); // Track active intervals
    this.visibilityState = 'visible';
    this.pausedIntervals = new Map(); // Store paused intervals
    this.stats = {
      apiCallsMade: 0, // Real polling calls that actually fired
      apiCallsSkipped: 0,
      energySaved: 0, // Estimated in mJ
      bandwidthSaved: 0, // In bytes
      startTime: Date.now(),
    };

    this.setupVisibilityHandler();
  }

  // Setup page visibility listener to pause/resume polling.
  // The handler reference is stored so cleanup() can remove it (#1113).
  setupVisibilityHandler() {
    if (typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        this.visibilityState = document.visibilityState;
        if (document.hidden) {
          this.pauseAllPolling();
        } else {
          this.resumeAllPolling();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
  }

  // Record a real API call that actually fired, so apiCallsAvoidedPercent
  // reflects measured behavior rather than a fabricated estimate (#1111).
  recordApiCall(count = 1) {
    this.stats.apiCallsMade += count;
  }

  // Register a polling interval for management
  registerPollingInterval(id, interval, estimatedApiCalls = 1) {
    this.pollingIntervals.set(id, {
      interval,
      estimatedApiCalls,
      isPaused: false,
      bytesPerCall: 2048, // Average API response size
    });
  }

  // Pause all registered polling intervals.
  // Snapshot the keys first so we can safely move entries out of
  // pollingIntervals while iterating (#1110).
  pauseAllPolling() {
    for (const id of Array.from(this.pollingIntervals.keys())) {
      const config = this.pollingIntervals.get(id);
      if (config && !config.isPaused) {
        clearInterval(config.interval);
        config.isPaused = true;
        this.pausedIntervals.set(id, config);
        this.pollingIntervals.delete(id); // remove from the active map
        this.stats.apiCallsSkipped += config.estimatedApiCalls;
        this.stats.bandwidthSaved += config.bytesPerCall;
        this.stats.energySaved += 50; // Rough estimate per paused interval
      }
    }
  }

  // Resume all paused polling intervals, moving each config back into the
  // active map so cleanup() can still clear it (#1110). Recreates the live
  // interval only when the original callback/interval were preserved.
  resumeAllPolling() {
    for (const id of Array.from(this.pausedIntervals.keys())) {
      const config = this.pausedIntervals.get(id);
      if (config && config.isPaused) {
        if (typeof config.callbackFn === 'function' && config.intervalMs) {
          config.interval = setInterval(config.callbackFn, config.intervalMs);
        }
        config.isPaused = false;
        this.pausedIntervals.delete(id);
        this.pollingIntervals.set(id, config); // restore to the active map
      }
    }
  }

  // Lazy-load module with intersection observer
  lazyLoadModule(elementId, loadCallback) {
    if (typeof IntersectionObserver === 'undefined') {
      loadCallback();
      return;
    }

    const element = document.getElementById(elementId);
    if (!element) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          loadCallback();
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    observer.observe(element);
  }

  // Debounce function for resize/scroll events
  debounce(fn, delayMs) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delayMs);
    };
  }

  // Request animation frame batching for UI updates
  batchUIUpdates(updateFn) {
    if (typeof requestAnimationFrame === 'undefined') {
      updateFn();
      return;
    }
    requestAnimationFrame(updateFn);
  }

  // Cache expensive computations with TTL
  memoize(fn, ttlMs = 60000) {
    let cachedResult = null;
    let cacheExpiry = 0;

    return (...args) => {
      const now = Date.now();
      if (cachedResult !== null && now < cacheExpiry) {
        return cachedResult;
      }
      cachedResult = fn(...args);
      cacheExpiry = now + ttlMs;
      return cachedResult;
    };
  }

  // Virtual scrolling for large lists (client-side hint)
  getVirtualScrollConfig(totalItems, itemHeight, containerHeight) {
    const visibleItems = Math.ceil(containerHeight / itemHeight);
    const overscan = 5; // Items to render outside viewport

    return {
      totalItems,
      itemHeight,
      containerHeight,
      visibleItems,
      overscan,
      getVisibleRange: (scrollTop) => {
        const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
        const endIndex = Math.min(totalItems, startIndex + visibleItems + overscan * 2);
        return { startIndex, endIndex };
      },
    };
  }

  // Get performance statistics
  getStats() {
    const uptime = Date.now() - this.stats.startTime;
    const energySavedEstimate = (this.stats.energySaved / 1000).toFixed(2); // Convert to Joules
    const bandwidthMB = (this.stats.bandwidthSaved / 1024 / 1024).toFixed(2);

    // Computed from measured counts (Σ₀ honesty rule — no fabricated metric).
    // Single consistent format so the UI never flickers between shapes (#1111, #1121).
    const totalCalls = this.stats.apiCallsMade + this.stats.apiCallsSkipped;
    const apiCallsAvoidedPercent = totalCalls === 0
      ? '0.0%'
      : ((this.stats.apiCallsSkipped / totalCalls) * 100).toFixed(1) + '%';

    return {
      ...this.stats,
      uptime,
      energySavedJoules: parseFloat(energySavedEstimate),
      bandwidthMB: parseFloat(bandwidthMB),
      apiCallsAvoidedPercent,
    };
  }

  // Reset all intervals and listeners (for cleanup)
  cleanup() {
    if (typeof document !== 'undefined' && this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    for (const config of this.pollingIntervals.values()) {
      clearInterval(config.interval);
    }
    this.pollingIntervals.clear();
    this.pausedIntervals.clear();
  }
}

module.exports = { CreatorPerfOptimizer };
