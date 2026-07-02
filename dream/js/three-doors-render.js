// ── Three Doors Game Rendering ───────────────────────────────────────────────
// Canvas art, scene message rendering, image loading, and UI updates
// Depends on three-doors-data.js for SCENES and constants

// ── Canvas art ───────────────────────────────────────────────────
function drawScene(canvas, sceneKey) {
  const scene = SCENES[sceneKey];
  if (!scene) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pal = scene.palette;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, pal[5]); bg.addColorStop(0.5, pal[0]); bg.addColorStop(1, pal[1]);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const glow = ctx.createRadialGradient(cx, cy * 0.8, 0, cx, cy * 0.8, W * 0.5);
  glow.addColorStop(0, pal[3] + "66"); glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Door
  const dW = W * 0.2, dH = H * 0.6, dX = cx - dW / 2, dY = H * 0.18, dR = dW * 0.5;
  const doorGlow = ctx.createRadialGradient(cx, dY + dH * 0.3, 0, cx, dY + dH * 0.3, dW);
  doorGlow.addColorStop(0, pal[4] + "55"); doorGlow.addColorStop(1, "transparent");
  ctx.fillStyle = doorGlow; ctx.fillRect(0, 0, W, H);

  ctx.beginPath();
  ctx.moveTo(dX, dY + dH); ctx.lineTo(dX, dY + dR);
  ctx.arcTo(dX, dY, dX + dR, dY, dR);
  ctx.arcTo(dX + dW, dY, dX + dW, dY + dR, dR);
  ctx.lineTo(dX + dW, dY + dH); ctx.closePath();
  const df = ctx.createLinearGradient(dX, dY, dX, dY + dH);
  df.addColorStop(0, pal[4] + "dd"); df.addColorStop(1, pal[2] + "55");
  ctx.fillStyle = df; ctx.fill();
  ctx.strokeStyle = pal[4]; ctx.lineWidth = 1.5; ctx.stroke();

  // Particles
  for (let i = 0; i < 24; i++) {
    const px = (Math.sin(i * 2.3 + 1.1) * 0.45 + 0.5) * W;
    const py = (Math.cos(i * 1.7 + 0.4) * 0.45 + 0.5) * H;
    const r = Math.max(0.5, Math.sin(i * 0.9) * 2 + 1.5);
    const a = (Math.sin(i * 0.6) * 0.3 + 0.4);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = pal[4] + Math.floor(a * 255).toString(16).padStart(2, "0"); ctx.fill();
  }

  // Guide silhouette
  const fx = cx - dW * 1.0, fy = dY + dH - H * 0.05;
  ctx.fillStyle = "#f97316aa";
  ctx.beginPath(); ctx.ellipse(fx, fy, 20, 10, -0.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(fx + 16, fy - 7, 9, 7, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(fx + 22, fy - 13); ctx.lineTo(fx + 28, fy - 22); ctx.lineTo(fx + 17, fy - 16);
  ctx.fillStyle = "#f9731688"; ctx.fill();

  // Ground fog
  const fog = ctx.createLinearGradient(0, H * 0.75, 0, H);
  fog.addColorStop(0, "transparent"); fog.addColorStop(1, pal[0] + "cc");
  ctx.fillStyle = fog; ctx.fillRect(0, H * 0.75, W, H * 0.25);

  // Archetype label
  ctx.font = "bold 9px system-ui"; ctx.fillStyle = pal[4] + "88";
  ctx.textAlign = "right"; ctx.fillText(scene.archetype.toUpperCase(), W - 8, H - 7);
  ctx.textAlign = "left";
}

// ── Scene message rendering ───────────────────────────────────────
function appendSceneMsg(sceneKey, sceneData, geminiText, source) {
  removeTyping();
  const scene = SCENES[sceneKey] || {};
  const doors = sceneData.doors || scene.doors || [];
  const foxPresent = sceneData.fox_present ?? scene.fox ?? false;
  const history = sceneData.history || [];

  // Track visited scenes for challenges
  if (!playerProgress.visited) playerProgress.visited = [];
  if (!playerProgress.visited.includes(sceneKey)) {
    playerProgress.visited.push(sceneKey);
    saveProgress();
  }

  // Check challenges — the visit counter is skipped on a mere resume/redraw
  // (e.g. a page reload) since that doesn't represent a new visit; the
  // challenge checks themselves still run (idempotent).
  checkChallenges(sceneKey, history.length, !sceneData.resumed);

  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message agent doors-message";

  // Scene art
  const canvasId = "cvs-" + sceneKey + "-" + Date.now();
  const imgId = "img-" + sceneKey + "-" + Date.now();
  const descId = "desc-" + sceneKey + "-" + Date.now();

  // History breadcrumb
  const breadcrumb = history.length > 1
    ? `<div style="margin-bottom:8px">${history.map((h, i) => `<span class="history-pill">${h}</span>`).join("")}</div>`
    : "";

  // Display text: local LLM narration if available, else scene engine text
  const displayText = geminiText || (sceneData.text || scene.text || "");

  // The King's riddle is told once, inline, as part of the scene's own
  // narration (see the kingdome-garden text in three-doors-data.js) — it
  // used to also gate a separate Q&A panel that repeated the same lines
  // a second time. Doors are always shown; no gate, no duplicate.
  const doorHTML = `
      <div class="doors-section">
        <div class="doors-kicker">A, B, or C — choose your door</div>
        <div class="doors-banner">
          ${doors.map(d => `
            <button class="door-chip" onclick="chooseDoor('${d.label}', '${d.name.replace(/'/g, "\\'")}')">
              <div class="door-letter">${d.label}</div>
              <div class="door-info">
                <div class="door-name">${d.name}</div>
                <div class="door-desc">${d.description}</div>
              </div>
            </button>`).join("")}
        </div>
      </div>`;

  // One-line caption naming the moment (the skill's turn contract: the
  // painting is the scene; the caption names the beat).
  const lastChoice = (history.filter(h => h.startsWith("Chose ")).slice(-1)[0] || "").replace("Chose ", "");
  const sceneTitle = (scene.text || sceneData.text || "").match(/\*\*([^*]+)\*\*/)?.[1] || sceneKey.replace(/-/g, " ");
  const caption = lastChoice ? `${sceneTitle} — through ${lastChoice}` : sceneTitle;

  // Lantern's line: on resume it says what it always says, and means it.
  const lanternLine = sceneData.resumed
    ? `<div class="fox-line">🏮 <em>"You came back."</em></div>`
    : foxPresent ? `<div class="fox-line">🏮 Lantern, your guide, is with you.</div>` : "";

  // Opening beat only: introduce the companions in Alex's hand-drawn canon.
  const castStrip = sceneKey === "castle-balcony" && !sceneData.resumed
    ? `<div class="cast-strip" aria-label="The companions, as Alex draws them">
        <figure><img src="/assets/content/koh/reference-lantern-t.webp" alt="Lantern"><figcaption>Lantern</figcaption></figure>
        <figure><img src="/assets/content/koh/reference-eclipse-t.webp" alt="Eclipse"><figcaption>Eclipse</figcaption></figure>
        <figure><img src="/assets/content/koh/reference-keystone-t.webp" alt="Keystone"><figcaption>Keystone</figcaption></figure>
        <figure><img src="/assets/content/koh/reference-blinkbug-t.webp" alt="Blinkbug"><figcaption>Blinkbug</figcaption></figure>
      </div>`
    : "";

  // Sigil — City of Doors: every threshold made visible. Show the doors the
  // player has actually walked (built from playerProgress.walkedDoors).
  const walkedPaths = sceneKey === "sigil-city" && typeof buildWalkedPathsHTML === "function"
    ? buildWalkedPathsHTML()
    : "";

  el.innerHTML = `
    <div class="message-content">
      ${breadcrumb}
      <div class="scene-image">
        <img id="${imgId}" alt="Scene art" style="display:none"
          onload="this.style.display='';document.getElementById('${canvasId}').style.display='none';logThreeDoorsEvent('image_load', { sceneKey: '${sceneKey}', source: 'image' })">
        <canvas id="${canvasId}" width="800" height="450"></canvas>
      </div>
      <div class="scene-caption">${caption}</div>
      <div id="${descId}" class="scene-narration">${md(displayText)}</div>
      ${lanternLine}
      ${castStrip}
      ${walkedPaths}
      ${doorHTML}
    </div>`;

  // The newest scene is the current page of the story; earlier ones recede
  // so scrolling back reads like flipping back through a journal, not an
  // endless feed of equally-weighted chat turns.
  chat.querySelectorAll(".doors-message").forEach(prior => prior.classList.add("is-past"));

  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;

  // Refs are already valid the moment el.innerHTML was set (querySelector
  // works on a detached subtree) — no need to defer to a paint frame, and
  // doing so made image loading depend on requestAnimationFrame actually
  // firing, which browsers throttle or fully suspend in a backgrounded tab.
  // Kicking off the network request has nothing to do with painting.
  const cvsEl = el.querySelector(`#${canvasId}`);
  const imgEl = el.querySelector(`#${imgId}`);
  const descEl = el.querySelector(`#${descId}`);

  // Draw canvas placeholder immediately, then load image by priority:
  // 1. Curated R2 art or server generation (getSceneImageUrl)
  // 2. Pollinations fallback
  if (cvsEl) drawScene(cvsEl, sceneKey);
  const imageUrl = getSceneImageUrl(sceneKey);
  if (imageUrl && imgEl) {
    imgEl.onerror = () => loadPollinationsImage(imgId, canvasId, sceneKey);
    imgEl.onload = () => {
      if (cvsEl) cvsEl.style.display = "none";
      imgEl.style.display = "";
      logThreeDoorsEvent("image_load", { sceneKey, source: "curated" });
    };
    imgEl.src = imageUrl;
  } else {
    loadPollinationsImage(imgId, canvasId, sceneKey);
  }

  // Wire SD prompt copy for both img and canvas
  const sdPrompt = sceneData.image_prompt || SD_PROMPTS[sceneKey] || "";
  if (imgEl) {
    imgEl.title = sdPrompt;
    imgEl.style.cursor = "pointer";
    imgEl.onclick = () => {
      navigator.clipboard.writeText(sdPrompt).catch(() => {});
      imgEl.title = "Copied!";
      setTimeout(() => { imgEl.title = sdPrompt; }, 1500);
    };
  }
  if (cvsEl) {
    cvsEl.title = sdPrompt;
    cvsEl.style.cursor = "pointer";
    cvsEl.onclick = () => {
      navigator.clipboard.writeText(sdPrompt).catch(() => {});
      cvsEl.title = "Copied!";
      setTimeout(() => { cvsEl.title = sdPrompt; }, 1500);
    };
  }

  // Async-refresh scene description with LLM-generated variant
  if (descEl) refreshSceneText(sceneKey, descEl);

  // Show choice bar with labelled quick-picks + custom input
  const bar = document.getElementById("choice-bar");
  const input = document.getElementById("custom-door-input");
  const picks = document.getElementById("door-quick-picks");
  if (doors && doors.length) {
    bar.style.display = "";
    if (input) { input.value = ""; input.disabled = false; }
    if (picks) {
      picks.innerHTML = doors.map(d => `
        <button class="door-pick" onclick="chooseDoor('${d.label}','${d.name.replace(/'/g,"\\'")}')">
          <span class="door-letter">${d.label}</span>
          <div class="door-pick-name">${d.name}</div>
        </button>`).join("");
    }
  } else {
    bar.style.display = "none";
    if (picks) picks.innerHTML = "";
  }
  gameState = {
    scene_key: sceneKey, doors, history,
    stage_index: sceneData.stage_index, stage_count: sceneData.stage_count,
    loop_count: sceneData.loop_count,
    last_choice: sceneData.last_choice || "",
  };

  // Journey position lives in the stage breadcrumb bar (#status-line is
  // reserved for engine/narrator connectivity — see updateStatusLine()).
  if (typeof sceneData.stage_index === "number") {
    updateStageBreadcrumb(sceneData.stage_index, sceneData.loop_count ?? 0);
  }
}

// Stage breadcrumb — 7 dots showing current position + loop counter
const STAGE_LABELS = ["Garden","Present","Future","XP","Xenon","Sigil","Fog"];
function updateStageBreadcrumb(stageIndex, loopCount) {
  const bar = document.getElementById("stage-breadcrumb");
  const crumbs = document.getElementById("stage-crumbs");
  const badge = document.getElementById("stage-loop-badge");
  if (!bar || !crumbs) return;

  bar.style.display = "flex";
  badge.textContent = "Loop " + (loopCount + 1);

  crumbs.innerHTML = STAGE_LABELS.map((label, i) => {
    const active = i === stageIndex;
    const visited = i < stageIndex || (loopCount > 0 && i > stageIndex);
    const cls = active ? "gate-step-dot active" : visited ? "gate-step-dot visited" : "gate-step-dot";
    const dot = `<span class="${cls}" title="Stage ${i + 1}: ${label}"><span class="dot"></span>${label}</span>`;
    if (i === 0) return `<span class="gate-step">${dot}</span>`;
    const lineCls = i <= stageIndex ? "gate-step-line filled" : "gate-step-line";
    return `<span class="gate-step"><span class="${lineCls}"></span>${dot}</span>`;
  }).join("");
}

// ── Async scene text refresh — unique LLM take on each visit ─────
// Every door has a persistent theme + meta-lesson (SCENES[key].theme/.lesson)
// that never changes — that's the canon. The actual prose is regenerated on
// every visit so it's never the same twice, informed by the dreamer's own
// history (a rough stand-in for "preferences" until there's a real profile).
// The static scene.text still renders first (instant, no loading flash) and
// this replaces it once the LLM responds — text as fallback, not truth.
async function refreshSceneText(sceneKey, textEl) {
  if (!textEl) return;
  const scene = SCENES[sceneKey];
  if (!scene) return;
  const loopCount = gameState?.loop_count ?? 0;
  const theme = scene.theme || scene.archetype || "a threshold";
  const lesson = scene.lesson || "";
  const recentChoices = (gameState?.history || []).filter(h => h.startsWith("Chose ")).slice(-3).join(", ") || "just arrived";
  const loopNote = loopCount > 0
    ? ` This is loop ${loopCount + 1} — familiar, but seen with new eyes; don't repeat earlier phrasing.`
    : "";
  const taste = (playerProgress?.prizes || []).filter(p => p !== "first-steps").slice(-3).join(", ");
  const tasteNote = taste ? ` The dreamer has shown a taste for: ${taste} — let that color the imagery if it fits.` : "";
  const prompt = `You are Lantern, the dreaming guide, narrating the scene "${sceneKey}" inside the Kingdome of Hearts.
Persistent theme (canon, never changes): ${theme}
Meta-lesson underneath the scene (canon, never changes — let it show through the imagery, don't state it outright): ${lesson}
Write 3-4 evocative, sensory sentences of fresh prose for this specific visit — always true to the theme and lesson above, but never the same words twice. The dreamer arrived via: ${recentChoices}.${loopNote}${tasteNote} End on a threshold feeling that makes the next choice feel alive.`;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch("/api/dream/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt, agent: "lantern" }),
      signal: ctrl.signal,
    });
    if (!r.ok) return;
    const data = await r.json();
    const fresh = (data.reply || "").trim();
    if (fresh.length < 40) return;
    textEl.style.transition = "opacity 0.6s";
    textEl.style.opacity = "0";
    setTimeout(() => { textEl.innerHTML = md(fresh); textEl.style.opacity = "1"; }, 600);
  } catch { /* static text stays */ }
}
