/**
 * feature-runtime.js — Client-side Feature Runtime Host
 *
 * Implements the 5-phase boot sequence for index.html as a runtime shell:
 *
 * 1. Boot CEG    — initialize runtime, load feature registry from server
 * 2. Read Graph  — GET /api/features/state → active feature set
 * 3. Evaluate    — PCSF state determines which features are active
 * 4. Render      — project active features into DOM (nav, panels, cards)
 * 5. Subscribe   — SSE stream re-evaluates PCSF, hot-swaps features live
 *
 * 3 update mechanisms:
 *   Feature Flag     — flag enabled/disabled via POST /api/features/flag
 *   Runtime Convergence — latency/health changes trigger PCSF re-evaluation
 *   Hot-Swap         — feature_v1 → feature_v2 without page reload
 *
 * Usage (index.html):
 *   <script src="/js/feature-runtime.js"></script>
 *   <script>FeatureRuntime.boot();</script>
 */

"use strict";

const FeatureRuntime = (() => {
  // ── State ──────────────────────────────────────────────────────────────────

  let _features = [];
  let _systemState = {};
  let _eventSource = null;
  let _hotSwapHandlers = {};   // id → render function
  let _renderTarget = null;    // DOM element to inject feature cards into
  let _booted = false;

  // ── 1. Boot ────────────────────────────────────────────────────────────────

  async function boot(options = {}) {
    if (_booted) return;
    _booted = true;

    _renderTarget = options.renderTarget
      || document.getElementById("feature-graph-mount")
      || document.getElementById("nav-links")
      || null;

    try {
      await load();
      render();
      subscribe();
    } catch (err) {
      console.warn("[FeatureRuntime] boot failed — degraded mode:", err.message);
      _renderFallback();
    }
  }

  // ── 2. Load feature graph from server ─────────────────────────────────────

  async function load() {
    const r = await fetch("/api/features/state", {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`/api/features/state ${r.status}`);
    const data = await r.json();
    _features = data.features || [];
    _systemState = data.systemState || {};
    return data;
  }

  // ── 3 + 4. Evaluate and Render ────────────────────────────────────────────

  function render() {
    const active = _features.filter((f) => f.state === "active");
    _dispatchEvent("feature-graph-update", { features: _features, active, systemState: _systemState });

    if (_renderTarget) {
      _injectFeatureCards(active);
    }
    _updateStatusBar();
  }

  function _injectFeatureCards(activeFeatures) {
    // Only inject cards that don't already have a DOM element
    for (const feature of activeFeatures) {
      const existing = document.querySelector(`[data-feature-id="${feature.id}"]`);
      if (existing) {
        _applyFeatureState(existing, feature);
        continue;
      }

      // Check for custom hot-swap handler first
      if (_hotSwapHandlers[feature.implementation]) {
        _hotSwapHandlers[feature.implementation](feature, _renderTarget);
        continue;
      }

      // Default: inject a nav link card
      const el = _makeFeatureCard(feature);
      _renderTarget.appendChild(el);
    }

    // Mark inactive features as suspended
    const inactive = _features.filter((f) => f.state === "inactive");
    for (const feature of inactive) {
      const el = document.querySelector(`[data-feature-id="${feature.id}"]`);
      if (el) {
        el.setAttribute("data-feature-state", "suspended");
        el.classList.add("feature-suspended");
      }
    }
  }

  function _makeFeatureCard(feature) {
    const a = document.createElement("a");
    a.href = feature.href || "#";
    a.className = "feature-card";
    a.setAttribute("data-feature-id", feature.id);
    a.setAttribute("data-feature-state", "active");
    a.setAttribute("data-implementation", feature.implementation || "");
    a.innerHTML = `
      <span class="feature-icon">${feature.icon || "◆"}</span>
      <span class="feature-label">${feature.label}</span>
    `;
    return a;
  }

  function _applyFeatureState(el, feature) {
    el.setAttribute("data-feature-state", feature.state);
    el.classList.toggle("feature-active", feature.state === "active");
    el.classList.toggle("feature-suspended", feature.state !== "active");
  }

  function _updateStatusBar() {
    const bar = document.getElementById("feature-runtime-status");
    if (!bar) return;
    const active = _features.filter((f) => f.state === "active").length;
    bar.textContent = `${active}/${_features.length} features active`;
    bar.setAttribute("data-health", _systemState.health || 1);
  }

  function _renderFallback() {
    // Degrade gracefully: show static links if runtime fails
    const fallback = document.getElementById("feature-fallback");
    if (fallback) fallback.style.display = "";
  }

  // ── 5. Subscribe to SSE stream for live updates ──────────────────────────

  function subscribe() {
    if (_eventSource) {
      _eventSource.close();
    }

    _eventSource = new EventSource("/api/features/stream");

    _eventSource.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        const prev = _features.map((f) => `${f.id}:${f.state}`).join(",");
        _features = data.features || _features;
        _systemState = data.systemState || _systemState;
        const curr = _features.map((f) => `${f.id}:${f.state}`).join(",");

        // Only re-render if something changed
        if (prev !== curr) {
          _hotSwap(data);
          render();
        }
      } catch (e) {
        console.warn("[FeatureRuntime] SSE parse error:", e);
      }
    };

    _eventSource.onerror = () => {
      // Reconnect after 30s on error
      setTimeout(() => {
        if (_eventSource && _eventSource.readyState === EventSource.CLOSED) {
          subscribe();
        }
      }, 30_000);
    };
  }

  // ── Hot-swap ──────────────────────────────────────────────────────────────

  /**
   * σ: feature_v1 → feature_v2
   * Replace a feature's DOM representation without page reload.
   * Called when PCSF re-evaluation changes a feature's implementation id.
   */
  function _hotSwap(newData) {
    const newFeatures = newData.features || [];
    for (const newF of newFeatures) {
      const oldF = _features.find((f) => f.id === newF.id);
      if (!oldF) continue;
      if (oldF.implementation === newF.implementation) continue;

      // Implementation changed — execute hot-swap
      console.log(`[FeatureRuntime] hot-swap ${newF.id}: ${oldF.implementation} → ${newF.implementation}`);
      const el = document.querySelector(`[data-feature-id="${newF.id}"]`);

      if (_hotSwapHandlers[newF.implementation]) {
        // Custom handler handles the swap
        if (el) el.remove();
        _hotSwapHandlers[newF.implementation](newF, _renderTarget);
      } else if (el) {
        // Default: update the existing card's implementation attribute
        el.setAttribute("data-implementation", newF.implementation);
        el.setAttribute("data-feature-state", newF.state);
      }

      _dispatchEvent("feature-hot-swap", {
        id: newF.id,
        from: oldF.implementation,
        to: newF.implementation,
      });
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a custom renderer for a feature implementation.
   * Called before boot() to override default card rendering.
   * handler(feature, mountEl) → void
   */
  function registerHandler(implementationId, handler) {
    _hotSwapHandlers[implementationId] = handler;
  }

  /**
   * Toggle a feature flag at runtime (requires operator auth).
   */
  async function setFlag(flag, enabled) {
    const r = await fetch("/api/features/flag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flag, enabled }),
    });
    const data = await r.json();
    if (data.features) {
      _features = data.features;
      render();
    }
    return data;
  }

  function getActiveFeatures() {
    return _features.filter((f) => f.state === "active");
  }

  function getAllFeatures() {
    return [..._features];
  }

  function getSystemState() {
    return { ..._systemState };
  }

  function _dispatchEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  return { boot, load, render, subscribe, registerHandler, setFlag, getActiveFeatures, getAllFeatures, getSystemState };
})();

// Auto-boot when DOM is ready if not in module context
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => FeatureRuntime.boot());
  } else {
    FeatureRuntime.boot();
  }
}
