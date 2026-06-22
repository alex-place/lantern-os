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
  let remoteInfo = {};
  let dismissed = sessionStorage.getItem("lantern_update_dismissed");

  function bannerText() {
    const sha = remoteCommit ? remoteCommit.slice(0, 8) : "";
    const msg = remoteInfo.remoteMessage || "";
    const date = remoteInfo.remoteDate
      ? new Date(remoteInfo.remoteDate).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : "";
    let detail = sha ? `<code>${sha}</code>` : "";
    if (date) detail += ` &middot; ${date}`;
    if (msg)  detail += ` &middot; ${msg}`;
    return `Keystone OS update available on <code>master</code>${detail ? " — " + detail : ""}`;
  }

  function createBanner() {
    if (document.getElementById("lantern-update-banner")) return;

    const banner = document.createElement("div");
    banner.id = "lantern-update-banner";
    banner.innerHTML = `
      <span class="lantern-update-text">${bannerText()}</span>
      <button class="lantern-update-btn" id="lantern-update-action" title="Update now">Update &amp; Restart</button>
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
    remoteInfo = { remoteMessage: status.remoteMessage || null, remoteDate: status.remoteDate || null };
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
        padding: 0 16px;
        height: 44px;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
        box-shadow: 0 1px 0 var(--border);
        color: var(--text);
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        font-size: 0.85rem;
        animation: lanternBannerSlide 0.25s ease-out;
      }
      @keyframes lanternBannerSlide {
        from { transform: translateY(-100%); }
        to   { transform: translateY(0); }
      }
      #lantern-update-banner .lantern-update-text {
        flex: 1;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--muted);
      }
      #lantern-update-banner .lantern-update-text code {
        background: var(--surface2);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 0.8rem;
        color: var(--accent);
        border: 1px solid var(--border);
      }
      #lantern-update-banner .lantern-update-btn {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
        white-space: nowrap;
        text-align: center;
        flex-shrink: 0;
      }
      #lantern-update-banner .lantern-update-btn:hover {
        background: var(--accent-hover);
      }
      #lantern-update-banner .lantern-update-dismiss {
        background: transparent;
        color: var(--muted);
        border: none;
        font-size: 1.2rem;
        line-height: 1;
        cursor: pointer;
        padding: 0 2px;
        flex-shrink: 0;
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
