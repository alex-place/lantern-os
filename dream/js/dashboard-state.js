/**
 * Dashboard State Manager
 * Lightweight pub-sub pattern for managing shared state across tabs
 * Prevents redundant updates and coordinates refresh cycles
 */

class DashboardState {
  constructor() {
    this._state = {};
    this._subscribers = new Map();
    this._refreshSchedules = new Map();
    this._lastUpdate = new Map();
  }

  /**
   * Subscribe to state changes
   * Returns unsubscribe function
   */
  subscribe(key, callback) {
    if (!this._subscribers.has(key)) {
      this._subscribers.set(key, []);
    }
    this._subscribers.get(key).push(callback);

    // Return unsubscribe function
    return () => {
      const subs = this._subscribers.get(key);
      if (subs) {
        const idx = subs.indexOf(callback);
        if (idx >= 0) subs.splice(idx, 1);
      }
    };
  }

  /**
   * Update state and notify subscribers
   */
  updateState(key, newData) {
    this._state[key] = newData;
    this._lastUpdate.set(key, Date.now());

    // Notify all subscribers for this key
    const subs = this._subscribers.get(key);
    if (subs) {
      subs.forEach(callback => {
        try {
          callback(newData);
        } catch (err) {
          console.error(`Error in subscriber for ${key}:`, err);
        }
      });
    }
  }

  /**
   * Get current state value
   */
  getState(key) {
    return this._state[key];
  }

  /**
   * Schedule a refresh cycle (fetch → update state → notify)
   */
  scheduleRefresh(key, fetchFn, interval = 5000) {
    // Cancel existing schedule
    if (this._refreshSchedules.has(key)) {
      clearInterval(this._refreshSchedules.get(key));
    }

    // Initial fetch
    this._performRefresh(key, fetchFn);

    // Set up recurring refresh
    const id = setInterval(() => {
      this._performRefresh(key, fetchFn);
    }, interval);

    this._refreshSchedules.set(key, id);

    // Return cancel function
    return () => {
      clearInterval(this._refreshSchedules.get(key));
      this._refreshSchedules.delete(key);
    };
  }

  /**
   * Internal: Perform a single refresh
   */
  async _performRefresh(key, fetchFn) {
    try {
      const data = await fetchFn();
      this.updateState(key, { ...data, status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
      this.updateState(key, {
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Cancel a scheduled refresh
   */
  cancelRefresh(key) {
    if (this._refreshSchedules.has(key)) {
      clearInterval(this._refreshSchedules.get(key));
      this._refreshSchedules.delete(key);
    }
  }

  /**
   * Get time since last update for a key
   */
  getTimeSinceUpdate(key) {
    const lastUpdate = this._lastUpdate.get(key);
    if (!lastUpdate) return Infinity;
    return Date.now() - lastUpdate;
  }
}

// Export singleton instance
const dashboardState = new DashboardState();
