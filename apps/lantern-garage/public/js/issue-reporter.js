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

  var state = { dataUrl: null, blob: null, pasteBound: false, title: "", body: "", describing: false, repo: "", describeFailed: false, describeReason: "" };

  // ── DOM / console error capture ─────────────────────────────────────────────
  // Buffer recent JS errors so the filed report includes them (url + dom errors).
  // Listeners are installed as soon as this script loads; they cover interactive
  // errors. Capped ring buffer so a noisy page can't bloat the payload.
  var errorLog = [];
  function pushError(kind, msg) {
    try {
      var line = "[" + new Date().toISOString().slice(11, 19) + "] " + kind + ": " + String(msg).slice(0, 500);
      if (errorLog[errorLog.length - 1] !== line) errorLog.push(line); // de-dupe consecutive
      if (errorLog.length > 25) errorLog.shift();
    } catch (e) { /* ignore */ }
  }
  window.addEventListener("error", function (e) {
    if (e && e.message) pushError("error", e.message + (e.filename ? " @ " + e.filename + ":" + e.lineno + ":" + e.colno : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    pushError("unhandledrejection", (r && (r.stack || r.message)) || String(r || "unhandled rejection"));
  });
  (function () {
    var _ce = window.console && console.error;
    if (typeof _ce === "function") {
      console.error = function () {
        try { pushError("console.error", Array.prototype.map.call(arguments, function (a) { return (a && a.stack) || String(a); }).join(" ")); } catch (e) {}
        return _ce.apply(console, arguments);
      };
    }
  })();

  // Page URL + captured DOM/console errors, appended to every report so they're
  // visible in the filed issue body (not just in meta).
  function buildEnvSection() {
    var lines = ["", "---", "", "**Page:** " + (location.href || "(unknown)"),
      "**Viewport:** " + window.innerWidth + "×" + window.innerHeight,
      "**User agent:** " + navigator.userAgent];
    if (errorLog.length) {
      lines.push("", "**Console / DOM errors captured (" + errorLog.length + "):**", "```");
      lines.push.apply(lines, errorLog);
      lines.push("```");
    } else {
      lines.push("", "_No console/DOM errors captured this session._");
    }
    return lines.join("\n");
  }

  // ── Self-contained modal ────────────────────────────────────────────────────
  // The modal markup ships in dream-chat.html; on pages that don't include it (e.g.
  // the home page) inject it + its styles once so the 📷 button works anywhere.
  var MODAL_CSS =
    ".modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;z-index:1000;opacity:0;pointer-events:none;transition:opacity .2s}" +
    ".modal-overlay.open{opacity:1;pointer-events:auto}" +
    ".modal-content{width:100%;max-width:600px;background:var(--surface,#11161d);border-radius:16px 16px 0 0;max-height:80vh;overflow-y:auto;margin:0 auto;transform:translateY(100%);transition:transform .3s ease}" +
    ".modal-overlay.open .modal-content{transform:translateY(0)}" +
    ".modal-header{display:flex;align-items:center;justify-content:space-between;padding:20px;border-bottom:1px solid var(--border,#2a323d);position:sticky;top:0;background:var(--surface,#11161d)}" +
    ".modal-header h2{font-size:18px;font-weight:600}" +
    ".modal-close{width:32px;height:32px;border-radius:6px;border:none;background:transparent;color:var(--muted,#8a94a3);cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;transition:all .2s}" +
    ".modal-close:hover{background:var(--surface2,#1a212b);color:var(--text,#e6edf3)}" +
    ".modal-body{padding:20px;display:flex;flex-direction:column;gap:16px}" +
    ".form-group{display:flex;flex-direction:column;gap:6px}" +
    ".form-label{font-size:13px;font-weight:500;color:var(--muted,#8a94a3);text-transform:uppercase;letter-spacing:.5px}" +
    ".form-input{background:var(--surface2,#1a212b);border:1px solid var(--border,#2a323d);border-radius:8px;padding:10px 12px;color:var(--text,#e6edf3);font-family:inherit;font-size:14px;outline:none;transition:all .2s}" +
    ".form-input:focus{border-color:var(--accent,#06b6d4)}";

  var MODAL_HTML =
    '<div class="modal-overlay" id="issue-modal" role="dialog" aria-modal="true" aria-labelledby="issue-title" onclick="if(event.target===event.currentTarget) window.issueReporter.close()">' +
      '<div class="modal-content"><div class="modal-header"><h2 id="issue-title">📷 Report an issue</h2>' +
        '<button class="modal-close" aria-label="Close" onclick="window.issueReporter.close()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="form-group"><label class="form-label">Screenshot <span style="text-transform:none;font-weight:400;color:var(--muted)">— Keystone writes the report from this</span></label>' +
          '<div id="issue-dropzone" tabindex="0" style="border:1px dashed var(--border);border-radius:10px;padding:14px;text-align:center;cursor:pointer;background:var(--surface2)">' +
            '<img id="issue-shot-preview" alt="Screenshot preview" style="display:none;width:100%;border-radius:8px;max-height:38vh;object-fit:contain">' +
            '<div id="issue-dropzone-empty"><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:8px">' +
              '<button type="button" id="issue-capture-btn" class="form-input" style="width:auto;cursor:pointer;background:var(--surface)" onclick="event.stopPropagation();window.issueReporter.retake()">📷 Capture this page</button>' +
              '<button type="button" class="form-input" style="width:auto;cursor:pointer;background:var(--surface)" onclick="event.stopPropagation();window.issueReporter.pickFile()">⬆ Upload image</button></div>' +
              '<div style="font-size:12px;color:var(--muted)">the page is captured automatically — or press <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> then <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste a region</div></div></div>' +
          '<div id="issue-shot-clear" style="display:none;text-align:right;margin-top:6px">' +
            '<button type="button" class="form-input" style="width:auto;cursor:pointer;background:var(--surface2);font-size:12px;padding:4px 10px" onclick="window.issueReporter.retake()">↻ Retake</button>' +
            '<button type="button" class="form-input" style="width:auto;cursor:pointer;background:var(--surface2);font-size:12px;padding:4px 10px;margin-left:6px" onclick="window.issueReporter.clearShot()">✕ Remove</button></div>' +
          '<input type="file" id="issue-file-input" accept="image/*" style="display:none"></div>' +
        '<div class="form-group" id="issue-summary-group" style="display:none"><label class="form-label">Keystone\'s report <span style="text-transform:none;font-weight:400;color:var(--muted)">(auto-written)</span></label>' +
          '<div id="issue-summary" style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--surface2)">' +
            '<div id="issue-summary-title" style="font-weight:600;font-size:14px;color:var(--text)"></div>' +
            '<div id="issue-summary-body" style="color:var(--muted);font-size:13px;margin-top:6px;white-space:pre-wrap;line-height:1.5"></div></div></div>' +
        '<div id="issue-status" style="font-size:13px;color:var(--muted);min-height:18px" aria-live="polite"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="form-input" style="width:auto;cursor:pointer;background:var(--surface2)" onclick="window.issueReporter.close()">Cancel</button>' +
          '<button id="issue-submit-btn" class="form-input" style="width:auto;cursor:pointer;background:var(--accent,#06b6d4);color:#04121a;font-weight:600;opacity:.5" onclick="window.issueReporter.submit()" disabled>File issue</button>' +
        '</div></div></div></div>';

  function ensureModal() {
    if (document.getElementById("issue-modal")) return;
    if (!document.getElementById("issue-reporter-styles")) {
      var st = document.createElement("style");
      st.id = "issue-reporter-styles";
      st.textContent = MODAL_CSS;
      document.head.appendChild(st);
    }
    var wrap = document.createElement("div");
    wrap.innerHTML = MODAL_HTML;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  }

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
    state.title = ""; state.body = ""; state.describeFailed = false; state.describeReason = "";
    var g = $("issue-summary-group");
    if (g) g.style.display = "none";
    var ud = $("issue-userdesc-group");
    if (ud) ud.style.display = "none";
    var ta = $("issue-user-desc");
    if (ta) ta.value = "";
    setReady(false);
  }
  // Lazily insert an editable description field. Shown only when AI auto-description
  // is unavailable, so a vision-down report still carries the reporter's own words
  // instead of being filed as a contentless screenshot (the #1567 noise class).
  // Injected in JS so it works for both modal sources (the copy shipped in
  // dream-chat.html and the one this script injects elsewhere).
  function ensureUserDescField() {
    var existing = $("issue-user-desc");
    if (existing) return existing;
    var anchor = $("issue-status");
    if (!anchor || !anchor.parentNode) return null;
    var group = document.createElement("div");
    group.className = "form-group";
    group.id = "issue-userdesc-group";
    group.style.display = "none";
    group.innerHTML =
      '<label class="form-label">Describe the issue <span style="text-transform:none;font-weight:400;color:var(--muted)">— Keystone couldn\'t read the screenshot, so tell us what\'s wrong</span></label>' +
      '<textarea id="issue-user-desc" class="form-input" rows="3" placeholder="What went wrong? What did you expect to happen?" style="resize:vertical;font-family:inherit"></textarea>';
    anchor.parentNode.insertBefore(group, anchor);
    var ta = group.querySelector("#issue-user-desc");
    ta.addEventListener("input", function () {
      var v = ta.value.trim();
      state.body = v;
      setReady(!!v);
    });
    return ta;
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
    // No AI description available. Don't auto-file a contentless report (that produced
    // empty, unactionable issues like #1567). Require the reporter to describe it first.
    state.body = "";
    state.describeFailed = true;
    state.describeReason = String(reason || "vision unavailable").slice(0, 160);
    renderSummary();
    var ta = ensureUserDescField();
    var grp = $("issue-userdesc-group");
    if (grp) grp.style.display = "";
    if (ta) { ta.value = ""; try { ta.focus(); } catch (e) { /* focus best-effort */ } }
    setReady(false);   // stays disabled until the user types a description
    setStatus("Keystone couldn't read the screenshot (" + state.describeReason + "). Add a short description, then file.");
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
  // html2canvas 1.4.1 (the latest release) can't parse modern CSS color syntax:
  // `color-mix()` and the `color(srgb …)` serialization Chrome emits for it throw
  // "unsupported color function". The home page leans on color-mix() heavily, so
  // capture would fail outright. We resolve those tokens to rgba() in the cloned
  // DOM (see onclone below) before html2canvas ever reads them.
  function colorSrgbToRgba(token) {
    // token: "color(srgb 0.1 0.2 0.3 / 0.5)" — only the srgb form Chrome emits here.
    var inner = token.slice(token.indexOf("srgb") + 4, token.lastIndexOf(")")).trim();
    var parts = inner.split("/");
    var rgb = parts[0].trim().split(/\s+/).map(Number);
    var a = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
    var to255 = function (n) { return Math.max(0, Math.min(255, Math.round((n || 0) * 255))); };
    return "rgba(" + to255(rgb[0]) + "," + to255(rgb[1]) + "," + to255(rgb[2]) + "," + (isNaN(a) ? 1 : a) + ")";
  }
  function resolveMix(token) {
    // Let the live browser resolve color-mix() to a concrete rgb via a throwaway node.
    try {
      var d = document.createElement("span");
      d.style.backgroundColor = token;
      d.style.position = "fixed"; d.style.left = "-9999px";
      document.body.appendChild(d);
      var v = getComputedStyle(d).backgroundColor;
      document.body.removeChild(d);
      if (v && v.indexOf("color") === -1) return v;          // got plain rgb(a)
      if (v && v.indexOf("color(srgb") > -1) return colorSrgbToRgba(v);
    } catch (e) { /* fall through */ }
    return "rgba(0,0,0,0)";
  }
  function sanitizeColorValue(v) {
    return v
      .replace(/color-mix\([^)]*\)/g, resolveMix)
      .replace(/color\(srgb[^)]*\)/g, colorSrgbToRgba);
  }
  var CAPTURE_COLOR_PROPS = ["color", "background-color", "box-shadow",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    "outline-color"];
  function sanitizeCloneColors(clonedDoc) {
    try {
      var win = clonedDoc.defaultView || window;
      var els = clonedDoc.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        var cs = win.getComputedStyle(els[i]);
        for (var p = 0; p < CAPTURE_COLOR_PROPS.length; p++) {
          var v = cs.getPropertyValue(CAPTURE_COLOR_PROPS[p]);
          if (v && (v.indexOf("color-mix") > -1 || v.indexOf("color(") > -1)) {
            els[i].style.setProperty(CAPTURE_COLOR_PROPS[p], sanitizeColorValue(v));
          }
        }
      }
    } catch (e) { /* best-effort: capture still falls back on hard failure */ }
  }

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
      },
      onclone: function (clonedDoc) { sanitizeCloneColors(clonedDoc); }
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
    ensureModal();
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
    // When AI couldn't read the screenshot, require the reporter's own words so we
    // don't file an empty, unactionable issue (#1567).
    var userBody = (state.body || "").trim();
    if (state.describeFailed && !userBody) {
      setStatus("Add a short description first — Keystone couldn't read the screenshot.", true);
      var ta = $("issue-user-desc"); if (ta) { try { ta.focus(); } catch (e) { /* best-effort */ } }
      return;
    }

    // The server hosts the screenshot (in the fork) and files the issue with it
    // embedded in the body — fully automatic. We still copy to the clipboard inside
    // this click's gesture as a fallback, used only if the server can't embed.
    var copyResult = copyToClipboard(state.blob).then(function () { return true; }, function () { return false; });

    if (btn) btn.disabled = true;
    setStatus("Filing the issue and attaching the screenshot…");

    // On the AI-unavailable path, mark the description as reporter-written so it's clear
    // in the issue that no automatic analysis ran.
    var bodyText = state.describeFailed
      ? (userBody + "\n\n_Automatic screenshot analysis was unavailable (" + (state.describeReason || "vision unavailable") + ") — description written by the reporter._")
      : userBody;

    var payload = {
      title: title,
      // Always include the page URL + captured DOM/console errors in the body so they
      // land in the filed issue, in addition to meta.
      body: (bodyText + "\n" + buildEnvSection()).trim(),
      image: state.dataUrl || null,
      meta: { url: location.href, userAgent: navigator.userAgent, viewport: window.innerWidth + "x" + window.innerHeight, errors: errorLog.slice() }
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
