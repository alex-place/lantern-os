/**
 * Dashboard UI Helper Functions
 * Common utilities for alerts, formatting, and DOM manipulation
 */

class DashboardUI {
  constructor() {
    this._alertContainer = null;
  }

  /**
   * Initialize alert container if not already done
   */
  _initAlertContainer() {
    if (!this._alertContainer) {
      const container = document.createElement('div');
      container.id = 'dashboard-alerts';
      container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        max-width: 400px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      `;
      document.body.appendChild(container);
      this._alertContainer = container;
    }
  }

  /**
   * Show alert message with auto-dismiss
   */
  showAlert(type, message, duration = 5000) {
    this._initAlertContainer();

    const alert = document.createElement('div');
    const colors = {
      info: '#0891b2',
      success: '#16a34a',
      warning: '#f59e0b',
      error: '#dc2626'
    };

    alert.style.cssText = `
      background: ${colors[type] || colors.info};
      color: white;
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 14px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      animation: slideIn 0.3s ease-out;
    `;
    alert.textContent = message;

    this._alertContainer.appendChild(alert);

    if (duration > 0) {
      setTimeout(() => {
        alert.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => alert.remove(), 300);
      }, duration);
    }

    return alert;
  }

  showSuccess(message, duration = 3000) {
    return this.showAlert('success', message, duration);
  }

  showError(message, duration = 5000) {
    return this.showAlert('error', message, duration);
  }

  showWarning(message, duration = 4000) {
    return this.showAlert('warning', message, duration);
  }

  showInfo(message, duration = 3000) {
    return this.showAlert('info', message, duration);
  }

  /**
   * Show loading state in element
   */
  showLoading(element, message = 'Loading...') {
    if (!element) return;
    element.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; color: var(--muted);">
        <div style="width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite;"></div>
        <span>${message}</span>
      </div>
    `;
  }

  /**
   * Hide loading state
   */
  hideLoading(element) {
    if (element) element.innerHTML = '';
  }

  /**
   * Format ISO timestamp to readable format
   */
  formatTimestamp(iso, includeTime = true) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (includeTime) {
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    }
  }

  /**
   * Format milliseconds to human-readable duration
   */
  formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 3600000)}h`;
  }

  /**
   * Format number as percentage
   */
  formatPercent(value, decimals = 0) {
    if (typeof value !== 'number') return '—';
    return `${value.toFixed(decimals)}%`;
  }

  /**
   * Format number with thousand separators
   */
  formatNumber(value) {
    if (typeof value !== 'number') return '—';
    return value.toLocaleString();
  }

  /**
   * Create a status badge element
   */
  createStatusBadge(status) {
    const colors = {
      'online': '#4ade80',
      'idle': '#0ea5e9',
      'working': '#f59e0b',
      'offline': '#6b7280',
      'healthy': '#4ade80',
      'degraded': '#f59e0b',
      'critical': '#dc2626',
      'completed': '#4ade80',
      'pending': '#6b7280',
      'failed': '#dc2626',
      'active': '#f59e0b'
    };

    const badge = document.createElement('span');
    badge.style.cssText = `
      display: inline-block;
      padding: 4px 8px;
      background: ${colors[status] || '#6b7280'}22;
      color: ${colors[status] || '#6b7280'};
      border: 1px solid ${colors[status] || '#6b7280'};
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: capitalize;
    `;
    badge.textContent = status;
    return badge;
  }

  /**
   * Toggle visibility of element
   */
  toggle(element, show = null) {
    if (!element) return;
    if (show === null) {
      show = element.style.display === 'none';
    }
    element.style.display = show ? '' : 'none';
  }

  /**
   * Set element content with fade animation
   */
  setContent(element, content, animate = true) {
    if (!element) return;
    if (animate) {
      element.style.opacity = '0.5';
      setTimeout(() => {
        if (typeof content === 'string') {
          element.innerHTML = content;
        } else {
          element.innerHTML = '';
          element.appendChild(content);
        }
        element.style.opacity = '1';
      }, 100);
    } else {
      if (typeof content === 'string') {
        element.innerHTML = content;
      } else {
        element.innerHTML = '';
        element.appendChild(content);
      }
    }
  }
}

// Export singleton instance
const dashboardUI = new DashboardUI();

// Add CSS animations to document
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(400px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(400px); opacity: 0; }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
