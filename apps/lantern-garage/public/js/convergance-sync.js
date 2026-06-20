/*
 * Keystone Dream Chat command compatibility shim.
 *
 * Some operators type the older/misspelled !convergance command while asking
 * for a convergence sync. The canonical command remains !convergence because
 * dream-chat.js already owns that path and posts to /api/actions/run-loop.
 */
(function () {
  "use strict";

  const LEGACY_CONVERGANCE_RE = /^!convergance(?:\s+(?:sync|loop|run))?\s*$/i;
  const CANONICAL_CONVERGENCE = "!convergence";

  function normalizeConverganceCommand(value) {
    const text = String(value || "").trim();
    if (LEGACY_CONVERGANCE_RE.test(text)) return CANONICAL_CONVERGENCE;
    return value;
  }

  function normalizeInput(input) {
    const next = normalizeConverganceCommand(input.value);
    if (next !== input.value) input.value = next;
  }

  function installConverganceSyncAlias() {
    const input = document.getElementById("input");
    const sendBtn = document.getElementById("send-btn");
    if (!input) return false;
    if (window.__lanternConverganceSyncAliasInstalled) return true;
    window.__lanternConverganceSyncAliasInstalled = true;

    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" && !event.shiftKey) normalizeInput(input);
      },
      true
    );

    if (sendBtn) {
      sendBtn.addEventListener("click", () => normalizeInput(input), true);
    }

    const originalSendMessage = window.sendMessage;
    if (typeof originalSendMessage === "function") {
      window.sendMessage = function (...args) {
        normalizeInput(input);
        return originalSendMessage.apply(this, args);
      };
    }

    return true;
  }

  window.normalizeConverganceCommand = normalizeConverganceCommand;

  if (!installConverganceSyncAlias()) {
    window.addEventListener("DOMContentLoaded", installConverganceSyncAlias, { once: true });
    setTimeout(installConverganceSyncAlias, 0);
  }
})();
