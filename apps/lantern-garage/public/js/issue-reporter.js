/* Screenshot → GitHub issue reporter (header 📷 button).
 *
 * Clicking 📷 ALWAYS opens the modal (so something always shows). From there you can
 * attach a screenshot three ways — all optional:
 *   • Capture screen — getDisplayMedia (you pick a screen/window/tab).
 *   • Upload image   — file picker.
 *   • Paste          — Win+Shift+S then Ctrl+V (most reliable on Windows).
 * Submit POSTs { title, body, image, meta } to /api/github/issue, which files the
 * issue via `gh` and saves the PNG locally. We then copy the screenshot to the
 * clipboard and open the new issue so you can paste it in to embed it (GitHub's API
 * can't attach images itself) — the "hybrid" flow.
 */
(function () {
  "use strict";

  var state = { dataUrl: null, blob: null, pasteBound: false, title: "", body: "", describing: false, repo: "" };

  function $(id) { return document.getElementById(id); }
  function setStatus(msg, isErr) {
    var el = $("issue-status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isErr ? "#e25555" : "var(--muted)";
  }

  // Show a captured/pasted/uploaded image in the preview and remember it.
  // Attaching a shot kicks off Keystone's auto-report; clearing it resets the report.
  function setShot(dataUrl, blob) {
    state.dataUrl = dataUrl;
    state.blob = blob || null;
    var img = $("issue-shot-preview"), empty = $("issue-dropzone-empty"), clear = $("issue-shot-clear");
    if (dataUrl) {
      if (img) { img.src = dataUrl; img.style.display = "block"; }
      if (empty) empty.style.display = "none";
      if (clear) clear.style.display = "block";
      autoDescribe();
    } else {
      if (img) { img.removeAttribute("src"); img.style.display = "none"; }
      if (empty) empty.style.display = "";
      if (clear) clear.style.display = "none";
      resetReport();
    }
  }
  function clearShot() { setShot(null, null); setStatus(""); }

  // ── Keystone auto-report ────────────────────────────────────────────────────
  // The user never fills out title/body — Keystone reads the screenshot and writes
  // both. The user only reviews the read-only summary and clicks File issue.
  function setReady(ready) {
    var btn = $("issue-submit-btn");
    if (!btn) return;
    btn.disabled = !ready;
    btn.style.opacity = ready ? "1" : ".5";
  }
  function resetReport() {
    state.title = ""; state.body = "";
    var g = $("issue-summary-group");
    if (g) g.style.display = "none";
    setReady(false);
  }
  function renderSummary() {
    var g = $("issue-summary-group"), t = $("issue-summary-title"), b = $("issue-summary-body");
    if (t) t.textContent = state.title || "";
    if (b) b.textContent = state.body || "";
    if (g) g.style.display = state.title ? "" : "none";
  }
  // Parse the model reply into { title, body }. Prefers the "TITLE: …\nBODY: …"
  // contract; falls back to first-line-as-title.
  function parseIssueText(text) {
    var s = String(text || "").trim();
    var title = "", body = "";
    var mt = s.match(/^\s*TITLE:\s*(.+?)\s*$/im);
    var mb = s.match(/BODY:\s*([\s\S]*)$/i);
    if (mt) {
      title = mt[1];
      body = mb ? mb[1].trim() : s.replace(mt[0], "").replace(/^\s*BODY:\s*/i, "").trim();
    } else {
      var lines = s.split(/\n/);
      title = (lines.shift() || "").replace(/^#+\s*/, "");
      body = lines.join("\n").trim();
    }
    title = title.replace(/^["'`*#\s]+|["'`*\s]+$/g, "").slice(0, 200);
    if (!body) body = s;
    return { title: title, body: body };
  }
  function autoDescribe() {
    if (!state.dataUrl || state.describing) return;
    state.describing = true;
    resetReport();
    setStatus("Keystone is reading the screenshot and writing the report…");
    var prompt =
      "You are Keystone, an AI assistant filing a GitHub bug report for a user, based on a screenshot of the Keystone OS web app. " +
      "Page: " + (location.href || "unknown") + ". " +
      "Look at the screenshot and write a concise developer-facing bug report. " +
      "Respond in EXACTLY this format, nothing else:\n" +
      "TITLE: <one imperative line under 80 chars, no markdown>\n" +
      "BODY:\n<2-5 sentences describing what is visibly wrong or notable, what the user most likely expected, and any visible error text or UI state. Only describe what you can actually see; do not invent stack traces or repro steps you cannot observe.>";
    fetch("/api/vision/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt, image: state.dataUrl, mimeType: (state.blob && state.blob.type) || "image/png" })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.text) {
          var parsed = parseIssueText(d.text);
          state.title = parsed.title || "Issue reported from screenshot";
          state.body = parsed.body || "";
          renderSummary();
          setReady(true);
          setStatus("Report ready — review it and click File issue.");
        } else {
          fallbackReport((d && d.error) || "vision unavailable");
        }
      })
      .catch(function (e) {
        fallbackReport(e && e.message ? e.message : String(e));
      })
      .then(function () { state.describing = false; });
  }
  // If Keystone can't read the shot (no vision provider, etc.), still let the user
  // file — the screenshot is the main payload. Degrade to a page-derived report.
  function fallbackReport(reason) {
    var where = "";
    try { where = location.pathname + (location.hash || ""); } catch (e) { where = "the app"; }
    state.title = "Issue reported from screenshot on " + (where || "the app");
    state.body = "A user reported an issue with a screenshot. Automatic analysis was unavailable (" +
      String(reason || "vision unavailable").slice(0, 160) + "), so this report has no written description — see the attached screenshot.";
    renderSummary();
    setReady(true);
    setStatus("Keystone couldn't read the screenshot, but you can still file it with the image attached.");
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("read_failed")); };
      r.readAsDataURL(blob);
    });
  }

  // Down-scale an image blob so the payload stays reasonable (max ~1600px wide).
  function normalize(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () {
        var scale = Math.min(1, 1600 / (im.naturalWidth || 1600));
        if (scale >= 1 && blob.size < 3 * 1024 * 1024) { URL.revokeObjectURL(url); return resolve(blob); }
        var c = document.createElement("canvas");
        c.width = Math.round((im.naturalWidth || 1600) * scale);
        c.height = Math.round((im.naturalHeight || 900) * scale);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (out) { resolve(out || blob); }, "image/png");
      };
      im.onerror = function () { URL.revokeObjectURL(url); resolve(blob); };
      im.src = url;
    });
  }

  function acceptBlob(blob) {
    if (!blob) return;
    return normalize(blob)
      .then(function (b) { return blobToDataUrl(b).then(function (d) { setShot(d, b); }); })
      .catch(function () { setStatus("Couldn't read that image.", true); });
  }

  // ── Auto-capture the current page (no picker, no permission) ────────────────
  // Renders the live DOM to an image with html2canvas, so the user never has to
  // pick a screen/window/tab — clicking 📷 (or opening the modal) just screenshots
  // the page they're looking at. Our own modal + overlays are excluded.
  function autoCapturePage() {
    if (typeof window.html2canvas !== "function") {
      setStatus("Page capture isn't loaded — upload an image or paste (Ctrl+V) instead.", true);
      return;
    }
    setStatus("Capturing the page…");
    var bg = "";
    try { bg = getComputedStyle(document.body).backgroundColor; } catch (e) { /* default below */ }
    if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "#0e1117";
    // Render the visible viewport (not the full scroll height) — that's what the
    // user actually sees when they hit report.
    window.html2canvas(document.body, {
      backgroundColor: bg,
      useCORS: true,
      allowTaint: false,
      logging: false,
      scale: 1,
      width: window.innerWidth,
      height: window.innerHeight,
      x: window.scrollX,
      y: window.scrollY,
      scrollX: -window.scrollX,
      scrollY: -window.scrollY,
      ignoreElements: function (el) {
        return el.id === "issue-modal" || el.id === "drop-overlay";
      }
    }).then(function (canvas) {
      canvas.toBlob(function (blob) {
        if (blob) acceptBlob(blob);
        else setStatus("Couldn't render the page — upload an image or paste instead.", true);
      }, "image/png");
    }).catch(function (e) {
      setStatus("Couldn't capture the page (" + (e && e.message ? e.message : e) + "). Upload or paste instead.", true);
    });
  }

  function pickFile() { var f = $("issue-file-input"); if (f) f.click(); }

  function onPaste(e) {
    if (!$("issue-modal") || !$("issue-modal").classList.contains("open")) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image") === 0) {
        var blob = items[i].getAsFile();
        if (blob) { e.preventDefault(); acceptBlob(blob); return; }
      }
    }
  }

  function wire() {
    if (state.pasteBound) return;
    state.pasteBound = true;
    document.addEventListener("paste", onPaste);
    var f = $("issue-file-input");
    if (f) f.addEventListener("change", function () { if (f.files && f.files[0]) acceptBlob(f.files[0]); f.value = ""; });
    var dz = $("issue-dropzone");
    if (dz) {
      dz.addEventListener("click", function () { if (!state.dataUrl) pickFile(); });
      dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.style.borderColor = "var(--accent,#06b6d4)"; });
      dz.addEventListener("dragleave", function () { dz.style.borderColor = "var(--border)"; });
      dz.addEventListener("drop", function (e) {
        e.preventDefault(); dz.style.borderColor = "var(--border)";
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file && file.type.indexOf("image") === 0) acceptBlob(file);
      });
    }
  }

  function open() {
    wire();
    var m = $("issue-modal");
    if (m) m.classList.add("open");
    resetReport();
    // Screenshot the page the user is looking at, automatically — no picker.
    autoCapturePage();
  }
  function close() {
    var m = $("issue-modal");
    if (m) m.classList.remove("open");
    clearShot();
    resetReport();
  }

  // The clipboard only reliably accepts image/png — re-encode anything else (e.g. an
  // uploaded JPEG) to PNG. Returns a Promise<Blob> so it can be handed straight to
  // ClipboardItem, which keeps the write tied to the user gesture while it resolves.
  function toPngBlob(blob) {
    if (!blob) return Promise.reject(new Error("no_blob"));
    if (blob.type === "image/png") return Promise.resolve(blob);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () {
        var c = document.createElement("canvas");
        c.width = im.naturalWidth || 1280; c.height = im.naturalHeight || 720;
        c.getContext("2d").drawImage(im, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("encode_failed")); }, "image/png");
      };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error("img_load_failed")); };
      im.src = url;
    });
  }
  function copyToClipboard(blob) {
    try {
      if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem && blob) {
        return navigator.clipboard.write([new window.ClipboardItem({ "image/png": toPngBlob(blob) })]);
      }
    } catch (e) { /* ignore */ }
    return Promise.reject(new Error("clipboard_unavailable"));
  }

  function submit() {
    var btn = $("issue-submit-btn");
    var title = (state.title || "").trim();
    if (!state.dataUrl) { setStatus("Add a screenshot first — Keystone writes the report from it.", true); return; }
    if (state.describing) { setStatus("Keystone is still writing the report — one moment.", true); return; }
    if (!title) { setStatus("No report yet — try re-attaching the screenshot.", true); return; }

    // The server hosts the screenshot (in the fork) and files the issue with it
    // embedded in the body — fully automatic. We still copy to the clipboard inside
    // this click's gesture as a fallback, used only if the server can't embed.
    var copyResult = copyToClipboard(state.blob).then(function () { return true; }, function () { return false; });

    if (btn) btn.disabled = true;
    setStatus("Filing the issue and attaching the screenshot…");

    var payload = {
      title: title,
      body: (state.body || "").trim(),
      image: state.dataUrl || null,
      meta: { url: location.href, userAgent: navigator.userAgent, viewport: window.innerWidth + "x" + window.innerHeight }
    };

    fetch("/api/github/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data || res.data.ok === false) {
          throw new Error((res.data && (res.data.message || res.data.error)) || "request_failed");
        }
        var data = res.data;
        if (data.url) window.open(data.url, "_blank", "noopener");
        if (data.embedded) {
          setStatus("Filed issue #" + data.number + " — screenshot embedded in the body. Opening it now.");
          setTimeout(close, 3000);
          return;
        }
        // Embed failed server-side → fall back to the clipboard hand-off.
        return copyResult.then(function (copied) {
          setStatus(copied
            ? "Filed issue #" + data.number + " — couldn't auto-attach; screenshot copied, press Ctrl+V to add it."
            : "Filed issue #" + data.number + " — couldn't auto-attach; paste your screenshot into the issue.");
          setTimeout(close, 3800);
        });
      })
      .catch(function (err) {
        setStatus("Couldn't file the issue: " + (err && err.message ? err.message : err), true);
        if (state.title) setReady(true);
      });
  }

  window.issueReporter = {
    open: open, close: close, retake: autoCapturePage, submit: submit,
    pickFile: pickFile, clearShot: clearShot
  };
})();
