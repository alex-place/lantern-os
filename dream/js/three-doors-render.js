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
  // (page reload, poem-answer redraw) since those don't represent a new
  // visit; the challenge checks themselves still run (idempotent).
  checkChallenges(sceneKey, history.length, !sceneData.resumed);

  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message agent doors-message";

  const sourceBadge = source === "local"
    ? `<span class="source-badge gemini">Local LLM</span>`
    : source === "engine"
    ? `<span class="source-badge engine">Engine</span>`
    : `<span class="source-badge offline">Offline</span>`;

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

  // Poem gate: intercept kingdome-garden if not yet solved
  const poemSolved = playerProgress.poemSolved;
  const isPoemScene = sceneKey === "kingdome-garden" && !poemSolved;

  let doorHTML = "";
  if (isPoemScene) {
    doorHTML = `
      <div style="margin-top:12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">The King asks:</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:10px;font-style:italic">
          I am before the first door and after the last.<br>
          I hold what was given and return what was asked.<br>
          Three walked out, three walked in, but only one remained —<br>
          what was lost at the beginning is the thing that was gained.
        </div>
        <input id="poem-answer" type="text" placeholder="Speak your answer..." style="width:100%;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:13px;margin-bottom:8px" onkeydown="if(event.key==='Enter')submitPoem()">
        <button onclick="submitPoem()" style="width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:6px">Answer the King</button>
        <button onclick="skipPoem()" style="width:100%;padding:8px;background:none;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:12px;color:var(--muted);cursor:pointer">Skip — just show me the doors</button>
      </div>`;
  } else {
    doorHTML = `
      <div style="margin-top:12px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;letter-spacing:0.03em">Choose a door to continue</div>
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
  }

  el.innerHTML = `
    <div class="agent-avatar mandala-avatar">
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:44px;height:44px;display:block">
        <!-- Outer ring -->
        <circle cx="50" cy="50" r="48" fill="none" stroke="var(--accent)" stroke-width="1" opacity="0.4"/>
        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent)" stroke-width="0.8" opacity="0.3"/>
        <!-- 12-pointed petals -->
        <g stroke="var(--accent)" stroke-width="1.2" fill="none" opacity="0.7">
          <path d="M50,10 Q45,25 50,35 Q55,25 50,10" />
          <path d="M70,20 Q60,28 55,38 Q65,32 70,20" />
          <path d="M85,35 Q72,40 62,45 Q75,42 85,35" />
          <path d="M90,50 Q75,50 65,50 Q80,50 90,50" />
          <path d="M85,65 Q72,60 62,55 Q75,58 85,65" />
          <path d="M70,80 Q60,72 55,62 Q65,68 70,80" />
          <path d="M50,90 Q45,75 50,65 Q55,75 50,90" />
          <path d="M30,80 Q40,72 45,62 Q35,68 30,80" />
          <path d="M15,65 Q28,60 38,55 Q25,58 15,65" />
          <path d="M10,50 Q25,50 35,50 Q20,50 10,50" />
          <path d="M15,35 Q28,40 38,45 Q25,42 15,35" />
          <path d="M30,20 Q40,28 45,38 Q35,32 30,20" />
        </g>
        <!-- Inner hexagram -->
        <g fill="var(--accent)" opacity="0.8">
          <circle cx="50" cy="50" r="3"/>
          <circle cx="50" cy="35" r="1.5"/>
          <circle cx="60" cy="43" r="1.5"/>
          <circle cx="60" cy="57" r="1.5"/>
          <circle cx="50" cy="65" r="1.5"/>
          <circle cx="40" cy="57" r="1.5"/>
          <circle cx="40" cy="43" r="1.5"/>
        </g>
      </svg>
    </div>
    <div class="message-content">
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:4px">
        Keystone ${sourceBadge}
      </div>
      ${breadcrumb}
      <div class="scene-image">
        <img id="${imgId}" alt="Scene art" style="display:none"
          onload="this.style.display='';document.getElementById('${canvasId}').style.display='none';logThreeDoorsEvent('image_load', { sceneKey: '${sceneKey}', source: 'image' })">
        <canvas id="${canvasId}" width="800" height="450"></canvas>
        <div class="sd-badge">SD prompt — hover to copy</div>
      </div>
      <div id="${descId}" style="font-size:14px;line-height:1.6;margin-bottom:10px">${md(displayText)}</div>
      ${foxPresent ? `<div class="fox-line">🏮 Keystone, your guide, is with you.</div>` : ""}
      ${doorHTML}
    </div>`;

  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;

  // Capture refs directly — avoids getElementById timing race in rAF
  const cvsEl = el.querySelector(`#${canvasId}`);
  const imgEl = el.querySelector(`#${imgId}`);
  const descEl = el.querySelector(`#${descId}`);

  // Draw canvas placeholder immediately, then load image by priority:
  // 1. CAAD local pool (THREE_DOORS_IMAGE_POOL_DIR) or repo caadi/
  // 2. Dedicated three-doors PNG (LOCAL_PNG_SCENES)
  // 3. Pollinations / server generation
  requestAnimationFrame(async () => {
    const cvs = cvsEl;
    if (cvs) drawScene(cvs, sceneKey);
    const img = imgEl;

    // Priority 1: CAAD pool (server picks from local pool or caadi/, lore-aware)
    try {
      const r = await fetch(`/api/three-doors/image-pool/random?sceneKey=${encodeURIComponent(sceneKey)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.ok && d.url && img) {
          img.onerror = () => tryLocalThenPollinations(imgId, canvasId, sceneKey);
          img.onload = () => {
            if (cvs) cvs.style.display = "none";
            img.style.display = "";
            logThreeDoorsEvent("image_load", { sceneKey, source: `pool:${d.source}`, reason: d.reason });
          };
          img.src = d.url;
          return;
        }
      }
    } catch { /* fall through to local PNGs */ }

    tryLocalThenPollinations(imgId, canvasId, sceneKey);
  });

  function tryLocalThenPollinations(iId, cId, sk) {
    const i = document.getElementById(iId);
    if (LOCAL_PNG_SCENES.has(sk) && i) {
      i.onerror = () => loadPollinationsImage(iId, cId, sk);
      i.src = getSceneImageUrl(sk);
      return;
    }
    loadPollinationsImage(iId, cId, sk);
  }

  // Wire SD prompt copy for both img and canvas
  requestAnimationFrame(() => {
    const img = imgEl;
    const cvs = cvsEl;
    const sdPrompt = sceneData.image_prompt || SD_PROMPTS[sceneKey] || "";

    if (img) {
      img.title = sdPrompt;
      img.style.cursor = "pointer";
      img.onclick = () => {
        navigator.clipboard.writeText(sdPrompt).catch(() => {});
        img.title = "Copied!";
        setTimeout(() => { img.title = sdPrompt; }, 1500);
      };
    }

    if (cvs) {
      cvs.title = sdPrompt;
      cvs.style.cursor = "pointer";
      cvs.onclick = () => {
        navigator.clipboard.writeText(sdPrompt).catch(() => {});
        cvs.title = "Copied!";
        setTimeout(() => { cvs.title = sdPrompt; }, 1500);
      };
    }
  });

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
async function refreshSceneText(sceneKey, textEl) {
  if (!textEl) return;
  const scene = SCENES[sceneKey];
  if (!scene) return;
  const loopCount = gameState?.loop_count ?? 0;
  const archetype = scene.archetype || "mystical";
  const history = (gameState?.history || []).filter(h => h.startsWith("Chose ")).slice(-3).join(", ") || "just arrived";
  const loopNote = loopCount > 0 ? ` Loop ${loopCount + 1} — the space feels rewritten, familiar but altered.` : "";
  const prompt = `You are Keystone, the dreaming guide. Describe the scene "${sceneKey}" (archetype: ${archetype}) in 3 evocative sentences. The dreamer arrived via: ${history}.${loopNote} Be symbolic and sensory — never the same twice. End on a threshold feeling. Scene core: ${scene.text.replace(/\*\*/g,"").replace(/\*/g,"").slice(0,200)}`;
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
