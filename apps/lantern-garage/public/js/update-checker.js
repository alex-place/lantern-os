/**
 * UpdateChecker — polls local version vs GitHub master and shows update banner.
 * Works on both local dev server and GitHub Pages static deploys.
 */
(function () {
  // Read the LOCAL, server-cached endpoint — never api.github.com from the browser.
  // The server makes the (rate-limited) GitHub call at most ~4x/hour and caches it, so
  // a 5-min client poll of the local endpoint is cheap and leaks nothing externally. #879
  const POLL_INTERVAL_MS = 5 * 60_000;
  const UPDATE_API = (typeof serverBase !== "undefined" ? serverBase : "") + "/api/update-status";

  let remoteCommit = null;
  let dismissed = sessionStorage.getItem("lantern_update_dismissed");

  function createBanner() {
    if (document.getElementById("lantern-update-banner")) return;

    const banner = document.createElement("div");
    banner.id = "lantern-update-banner";
    banner.innerHTML = `
      <span class="lantern-update-text">Keystone OS update available on <code>master</code></span>
      <button class="lantern-update-btn" id="lantern-update-action" title="Update now">Update & Restart</button>
      <button class="lantern-update-dismiss" id="lantern-update-dismiss" title="Dismiss">&times;</button>
    `;
    document.body.prepend(banner);

    document.getElementById("lantern-update-action").addEventListener("click", async () => {
      const btn = document.getElementById("lantern-update-action");
      btn.disabled = true;
      btn.textContent = "Updating...";

      if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
        // Local dev — auto-update via POST to action endpoint
        try {
          const r = await fetch("/api/actions/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          const d = await r.json();
          if (d.ok && d.restart_scheduled) {
            banner.querySelector(".lantern-update-text").innerHTML =
              `<span style="color:var(--green)">Updated to <code>${d.version.tag}</code>. Restarting server...</span>`;
            btn.style.display = "none";
            document.getElementById("lantern-update-dismiss").style.display = "none";
            // Server will restart; wait 4s then reload
            setTimeout(() => window.location.reload(true), 4000);
          } else {
            const failed = d.steps.filter(s => !s.ok).map(s => s.step).join(", ");
            banner.querySelector(".lantern-update-text").innerHTML =
              `<span style="color:var(--danger)">Update failed: ${failed}</span>`;
            btn.textContent = "Retry";
            btn.disabled = false;
          }
        } catch (e) {
          banner.querySelector(".lantern-update-text").innerHTML =
            `<span style="color:var(--danger)">Network error: ${e.message}</span>`;
          btn.textContent = "Retry";
          btn.disabled = false;
        }
      } else {
        // GitHub Pages — hard refresh
        window.location.reload(true);
      }
    });

    document.getElementById("lantern-update-dismiss").addEventListener("click", () => {
      banner.remove();
      sessionStorage.setItem("lantern_update_dismissed", remoteCommit || "true");
    });
  }

  function removeBanner() {
    const banner = document.getElementById("lantern-update-banner");
    if (banner) banner.remove();
  }

  // Read the server's cached update status from the LOCAL endpoint. The server already
  // resolved local-vs-remote (behind/ahead) against api.github.com on its own slow,
  // rate-limited, backoff-aware timer — the browser makes ZERO external calls. On a
  // static deploy with no server (GitHub Pages) the endpoint 404s and we simply do
  // nothing rather than phoning GitHub from the browser. #879
  async function check() {
    let status = null;
    try {
      const r = await fetch(UPDATE_API, { signal: AbortSignal.timeout(5000) });
      if (r.ok) status = await r.json();
    } catch {
      status = null;
    }

    if (!status || !status.ok) {
      // No server / transient error → leave the banner as-is; never call GitHub here.
      return;
    }

    remoteCommit = status.remote || null;
    if (status.updateAvailable && remoteCommit && dismissed !== remoteCommit) {
      createBanner();
    } else {
      removeBanner();
    }
  }

  // Inject styles once
  if (!document.getElementById("lantern-update-styles")) {
    const style = document.createElement("style");
    style.id = "lantern-update-styles";
    style.textContent = `
      #lantern-update-banner {
        position: fixed;
        top: 0; left: 0; right: 0;
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 10px 16px;
        background: linear-gradient(90deg, var(--surface2), var(--accent-dim) 60%, var(--surface2));
        border-bottom: 1px solid var(--accent);
        color: var(--text);
        font-family: "Segoe UI", system-ui, sans-serif;
        font-size: 0.9rem;
        box-shadow: var(--shadow-hover);
        animation: lanternBannerSlide 0.35s ease-out;
      }
      @keyframes lanternBannerSlide {
        from { transform: translateY(-100%); }
        to   { transform: translateY(0); }
      }
      #lantern-update-banner .lantern-update-text code {
        background: rgba(255,66,77,0.12);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: monospace;
        color: var(--gold);
      }
      #lantern-update-banner .lantern-update-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      }
      #lantern-update-banner .lantern-update-btn:hover {
        background: var(--accent-hover);
      }
      #lantern-update-banner .lantern-update-dismiss {
        background: transparent;
        color: var(--muted);
        border: none;
        font-size: 1.3rem;
        line-height: 1;
        cursor: pointer;
        margin-left: 4px;
        padding: 0 4px;
      }
      #lantern-update-banner .lantern-update-dismiss:hover {
        color: var(--text);
      }
      /* Push page content down when banner is present */
      body:has(#lantern-update-banner) {
        padding-top: 44px;
      }
    `;
    document.head.appendChild(style);
  }

  // Initial check + periodic poll
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", check);
  } else {
    check();
  }
  setInterval(check, POLL_INTERVAL_MS);
})();
