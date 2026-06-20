// ── Three Doors Game Logic ─────────────────────────────────────────────────────
// Game state, progress management, prize system, and UI rendering
// Depends on three-doors-data.js for SCENES, STAGES, and constants

// ── State ─────────────────────────────────────────────────────────
let gameState = null;
let userId = "web-" + Math.random().toString(36).slice(2, 9);
let doorsLocked = false;
let serverAvailable = null;
let narratorEnabled = localStorage.getItem("three-doors-narrator") !== "off";

function toggleNarrator() {
  narratorEnabled = !narratorEnabled;
  localStorage.setItem("three-doors-narrator", narratorEnabled ? "on" : "off");
  const btn = document.getElementById("narrator-toggle");
  if (btn) btn.style.opacity = narratorEnabled ? "1" : "0.4";
}
// Apply initial state once DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("narrator-toggle");
  if (btn && !narratorEnabled) btn.style.opacity = "0.4";
});

// ── Persistence ────────────────────────────────────────────────────
const PROGRESS_KEY = "three-doors-progress";
const PROGRESS_VERSION = 1;

// Player progress schema
const DEFAULT_PROGRESS = {
  version: PROGRESS_VERSION,
  prizes: ["first-steps"],
  visited: [],
  sceneVisits: {},
  completedChallenges: [],
  poemSolved: false,
  poemAttempts: 0,
  loop_count: 0,
  stage_index: 0,
  currentScene: null,
  lastPlayed: null,
  // Challenge-specific tracking
  shiniesFound: 0,
  futurePathsVisited: 0,
  glitchesFound: 0,
  sigilLocationsVisited: 0,
  loopCompleted: false,
};

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { ...DEFAULT_PROGRESS };
    
    const data = JSON.parse(raw);
    
    // Version migration
    if (data.version !== PROGRESS_VERSION) {
      console.log("[Three Doors] Migrating progress from version", data.version, "to", PROGRESS_VERSION);
      return migrateProgress(data);
    }
    
    // Validate progress structure
    return validateProgress(data);
  } catch (e) {
    console.error("[Three Doors] Failed to load progress:", e);
    return { ...DEFAULT_PROGRESS };
  }
}

function saveProgress() {
  try {
    playerProgress.lastPlayed = new Date().toISOString();
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(playerProgress));
    
    // Optional: sync to backend if available
    syncProgressToBackend();
  } catch (e) {
    console.error("[Three Doors] Failed to save progress:", e);
  }
}

function validateProgress(data) {
  // Ensure all required fields exist
  const validated = { ...DEFAULT_PROGRESS, ...data };
  
  // Validate arrays
  if (!Array.isArray(validated.prizes)) validated.prizes = ["first-steps"];
  if (!Array.isArray(validated.visited)) validated.visited = [];
  if (!Array.isArray(validated.completedChallenges)) validated.completedChallenges = [];
  
  // Validate objects (check for null and non-object types)
  if (typeof validated.sceneVisits !== "object" || validated.sceneVisits === null || Array.isArray(validated.sceneVisits)) {
    validated.sceneVisits = {};
  }
  
  // Validate booleans
  if (typeof validated.poemSolved !== "boolean") validated.poemSolved = false;
  if (typeof validated.loopCompleted !== "boolean") validated.loopCompleted = false;
  
  // Validate numbers
  if (typeof validated.poemAttempts !== "number" || isNaN(validated.poemAttempts)) validated.poemAttempts = 0;
  if (typeof validated.loop_count !== "number" || isNaN(validated.loop_count)) validated.loop_count = 0;
  if (typeof validated.stage_index !== "number" || isNaN(validated.stage_index)) validated.stage_index = 0;
  
  // Validate challenge-specific numbers
  if (typeof validated.shiniesFound !== "number" || isNaN(validated.shiniesFound)) validated.shiniesFound = 0;
  if (typeof validated.futurePathsVisited !== "number" || isNaN(validated.futurePathsVisited)) validated.futurePathsVisited = 0;
  if (typeof validated.glitchesFound !== "number" || isNaN(validated.glitchesFound)) validated.glitchesFound = 0;
  if (typeof validated.sigilLocationsVisited !== "number" || isNaN(validated.sigilLocationsVisited)) validated.sigilLocationsVisited = 0;
  
  return validated;
}

function migrateProgress(oldData) {
  // Migration logic for future version changes
  const migrated = { ...DEFAULT_PROGRESS, ...oldData, version: PROGRESS_VERSION };
  return migrated;
}

async function syncProgressToBackend() {
  try {
    await fetch("/api/three-doors/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(playerProgress),
    });
  } catch (e) {
    // Backend sync is optional, fail silently
  }
}

async function loadProgressFromBackend() {
  try {
    const resp = await fetch("/api/three-doors/progress");
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.lastPlayed) {
        // Merge backend progress with local progress
        playerProgress = validateProgress({ ...playerProgress, ...data });
        saveProgress();
        return true;
      }
    }
  } catch (e) {
    // Backend sync is optional, fail silently
  }
  return false;
}

function resetProgress() {
  if (confirm("Are you sure you want to reset all progress? This cannot be undone.")) {
    localStorage.removeItem(PROGRESS_KEY);
    playerProgress = { ...DEFAULT_PROGRESS };
    saveProgress();
    location.reload();
  }
}

function exportProgress() {
  const data = JSON.stringify(playerProgress, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `three-doors-progress-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importProgress() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        playerProgress = validateProgress(data);
        saveProgress();
        alert("Progress imported successfully!");
        location.reload();
      } catch (err) {
        alert("Invalid progress file: " + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Prize System ───────────────────────────────────────────────────
const PRIZES = {
  "first-steps": { name: "First Steps", icon: "🌿", rarity: "common", description: "You took your first step into the Kingdome", unlockable: false },
  "kingdome-crown": { name: "Crown of the Kingdome", icon: "👑", rarity: "legendary", description: "Solved the King's poem and earned his recognition", unlockable: false },
  "speedwalker-badge": { name: "Speedwalker", icon: "⚡", rarity: "rare", description: "Completed a full loop of the Kingdome", unlockable: false },
  "lorekeeper-badge": { name: "Lorekeeper", icon: "📖", rarity: "rare", description: "Walked every stage of the journey", unlockable: false },
  "glitch-hunter-badge": { name: "Glitch Hunter", icon: "💾", rarity: "epic", description: "Found all XP Door corruption sequences", unlockable: false },
  "xenon-navigator-badge": { name: "Xenon Navigator", icon: "✨", rarity: "epic", description: "Reached both Xenon Starship and Sigil City", unlockable: false },
  "synthesasia-badge": { name: "Synthesasia in Threes", icon: "◈", rarity: "legendary", description: "Mastered pattern recognition through 3 loops", unlockable: false },
  "poem-master": { name: "Poem Master", icon: "📜", rarity: "epic", description: "Solved the King's poem on the first try", unlockable: false },
  "lucky-find": { name: "Lucky Find", icon: "🍀", rarity: "common", description: "Found a shiny in the Cloverfield", unlockable: false },
  "time-traveler": { name: "Time Traveler", icon: "⏰", rarity: "rare", description: "Visited all Future Door sub-paths", unlockable: false },
  "convergence-master": { name: "Convergence Master", icon: "🌌", rarity: "epic", description: "Reached Xenon Starship twice", unlockable: false },
  "city-explorer": { name: "City Explorer", icon: "🏙️", rarity: "rare", description: "Visited all Sigil City sub-locations", unlockable: false },
  "return-journey": { name: "Return Journey", icon: "🌫️", rarity: "legendary", description: "Completed the full loop and returned", unlockable: false },
  // Unlockable prizes (can be redeemed)
  "golden-key": { name: "Golden Key", icon: "🔑", rarity: "legendary", description: "Unlocks special doors in future updates", unlockable: true, cost: 5 },
  "fox-whisper": { name: "Fox Whisper", icon: "🦊", rarity: "epic", description: "The fox will give you hints", unlockable: true, cost: 3 },
  "time-shard": { name: "Time Shard", icon: "💎", rarity: "rare", description: "Rewind one door choice", unlockable: true, cost: 2 },
};

const RARITY_COLORS = {
  common: "#9ca3af",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#fbbf24",
};

function awardPrize(prizeId) {
  if (!playerProgress.prizes) playerProgress.prizes = [];
  if (!playerProgress.prizes.includes(prizeId)) {
    playerProgress.prizes.push(prizeId);
    saveProgress();
    showPrizeToast(prizeId);
  }
}

function showPrizeToast(prizeId) {
  const prize = PRIZES[prizeId];
  if (!prize) return;
  const rarityColor = RARITY_COLORS[prize.rarity] || "#9ca3af";
  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message agent";
  el.innerHTML = `<div class="agent-avatar">${prize.icon}</div><div class="message-content" style="background:${rarityColor}15;border-color:${rarityColor}40"><div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:${rarityColor};margin-bottom:4px">${prize.rarity} Prize</div><div style="font-size:13px;font-weight:600">${prize.name}</div><div style="font-size:11px;color:var(--muted);margin-top:2px">${prize.description}</div></div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function showPrizeInventory() {
  const prizes = playerProgress.prizes || [];
  const unlocked = prizes.filter(p => PRIZES[p]?.unlockable);
  const earned = prizes.filter(p => !PRIZES[p]?.unlockable);
  
  let html = `<div style="margin-top:12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px">
    <div style="font-size:13px;font-weight:600;margin-bottom:8px">🎁 Prize Inventory (${prizes.length})</div>`;
  
  if (earned.length > 0) {
    html += `<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--muted);margin-bottom:6px">Earned Badges</div>`;
    html += earned.map(p => {
      const prize = PRIZES[p];
      const rarityColor = RARITY_COLORS[prize.rarity] || "#9ca3af";
      return `<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:4px">
        <span style="font-size:16px">${prize.icon}</span>
        <div>
          <div style="font-size:12px;font-weight:600;color:${rarityColor}">${prize.name}</div>
          <div style="font-size:10px;color:var(--muted)">${prize.rarity}</div>
        </div>
      </div>`;
    }).join("");
    html += `</div>`;
  }
  
  if (unlocked.length > 0) {
    html += `<div><div style="font-size:11px;color:var(--muted);margin-bottom:6px">Unlockable Items</div>`;
    html += unlocked.map(p => {
      const prize = PRIZES[p];
      const rarityColor = RARITY_COLORS[prize.rarity] || "#9ca3af";
      return `<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:var(--surface);border:1px solid ${rarityColor}40;border-radius:8px;margin:4px">
        <span style="font-size:16px">${prize.icon}</span>
        <div>
          <div style="font-size:12px;font-weight:600;color:${rarityColor}">${prize.name}</div>
          <div style="font-size:10px;color:var(--muted)">${prize.description}</div>
        </div>
      </div>`;
    }).join("");
    html += `</div>`;
  }
  
  if (prizes.length === 0) {
    html += `<div style="font-size:12px;color:var(--muted)">No prizes earned yet. Complete challenges to earn prizes!</div>`;
  }
  
  html += `</div>`;
  
  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message agent";
  el.innerHTML = `<div class="agent-avatar">🎁</div><div class="message-content">${html}</div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

let playerProgress = loadProgress();
if (!playerProgress.prizes) {
  playerProgress.prizes = ["first-steps"];
  saveProgress();
}

// ── Challenge System ───────────────────────────────────────────────
const CHALLENGES = {
  "kingdome-garden": [
    { id: "poem-master", name: "Poem Master", description: "Solve the King's poem on first try", reward: "kingdome-crown", check: (p) => p.poemSolved && p.poemAttempts === 1 },
    { id: "king-audience", name: "King's Audience", description: "Visit the Garden 3 times", reward: "synthesasia-badge", check: (p) => (p.sceneVisits?.["kingdome-garden"] || 0) >= 3 },
  ],
  "cloverfield": [
    { id: "lucky-find", name: "Lucky Find", description: "Find a shiny in the Cloverfield", reward: "lorekeeper-badge", check: (p) => p.shiniesFound >= 1 },
    { id: "four-leaf", name: "Four-Leaf Master", description: "Visit Cloverfield 5 times", reward: "speedwalker-badge", check: (p) => (p.sceneVisits?.["cloverfield"] || 0) >= 5 },
  ],
  "future-doors": [
    { id: "time-traveler", name: "Time Traveler", description: "Visit all Future Door sub-paths", reward: "xenon-navigator-badge", check: (p) => p.futurePathsVisited >= 3 },
  ],
  "xp-door": [
    { id: "glitch-hunter", name: "Glitch Hunter", description: "Find all XP Door corruption sequences", reward: "glitch-hunter-badge", check: (p) => p.glitchesFound >= 3 },
  ],
  "xenon-convergence": [
    { id: "convergence-master", name: "Convergence Master", description: "Reach Xenon Starship twice", reward: "synthesasia-badge", check: (p) => (p.sceneVisits?.["xenon-convergence"] || 0) >= 2 },
  ],
  "sigil-city": [
    { id: "city-explorer", name: "City Explorer", description: "Visit all Sigil City sub-locations", reward: "lorekeeper-badge", check: (p) => p.sigilLocationsVisited >= 3 },
  ],
  "fog-door-return": [
    { id: "return-journey", name: "Return Journey", description: "Complete the full loop and return", reward: "kingdome-crown", check: (p) => p.loopCompleted },
  ],
};

// Global challenges (not tied to specific scenes)
const GLOBAL_CHALLENGES = [
  { id: "speedwalker", name: "Speedwalker", description: "Complete a first full loop of the Kingdome", reward: "speedwalker-badge", check: (p) => (p.loop_count || 0) >= 1 },
  { id: "lorekeeper", name: "Lorekeeper", description: "Walk every stage of the journey", reward: "lorekeeper-badge", check: (p) => STAGES.every(s => p.visited?.includes(s)) },
  { id: "xenon-navigator", name: "Xenon Navigator", description: "Reach the convergence AND the City of Doors", reward: "xenon-navigator-badge", check: (p) => p.visited?.includes("xenon-convergence") && p.visited?.includes("sigil-city") },
  { id: "synthesasia-master", name: "Synthesasia Master", description: "Complete 3 full loops", reward: "synthesasia-badge", check: (p) => (p.loop_count || 0) >= 3 },
];

function checkChallenges(sceneKey, turnCount) {
  // Track scene visits
  if (!playerProgress.sceneVisits) playerProgress.sceneVisits = {};
  playerProgress.sceneVisits[sceneKey] = (playerProgress.sceneVisits[sceneKey] || 0) + 1;
  
  // Track poem attempts
  if (sceneKey === "kingdome-garden" && !playerProgress.poemSolved) {
    playerProgress.poemAttempts = (playerProgress.poemAttempts || 0) + 1;
  }
  
  // Check scene-specific challenges
  const sceneChallenges = CHALLENGES[sceneKey] || [];
  for (const challenge of sceneChallenges) {
    if (!playerProgress.completedChallenges?.includes(challenge.id) && challenge.check(playerProgress)) {
      playerProgress.completedChallenges = playerProgress.completedChallenges || [];
      playerProgress.completedChallenges.push(challenge.id);
      saveProgress();
      awardPrize(challenge.reward);
      showChallengeComplete(challenge);
    }
  }
  
  // Check global challenges
  for (const challenge of GLOBAL_CHALLENGES) {
    if (!playerProgress.completedChallenges?.includes(challenge.id) && challenge.check(playerProgress)) {
      playerProgress.completedChallenges = playerProgress.completedChallenges || [];
      playerProgress.completedChallenges.push(challenge.id);
      saveProgress();
      awardPrize(challenge.reward);
      showChallengeComplete(challenge);
    }
  }
  
  saveProgress();
}

function showChallengeComplete(challenge) {
  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message agent";
  el.innerHTML = `<div class="agent-avatar">🏆</div><div class="message-content" style="background:rgba(251,191,36,0.08);border-color:rgba(251,191,36,0.3)"><div style="font-size:12px;font-weight:600;color:#fbbf24;margin-bottom:4px">Challenge Complete</div><div style="font-size:13px">${challenge.name}: ${challenge.description}</div></div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

// ── Server check ─────────────────────────────────────────────────
async function checkServer() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch("/api/health", { signal: ctrl.signal });
    serverAvailable = r.ok;
  } catch (e) {
    serverAvailable = false;
    console.warn("[Three Doors] Health check failed, using inline fallback:", e.message);
  } finally {
    clearTimeout(t);
  }
  document.getElementById("status-line").textContent = serverAvailable
    ? "Local AI narrating · engine ready"
    : "Offline — inline engine active";
  return serverAvailable;
}

// ── Metrics collection (non-blocking) ────────────────────────────
function logThreeDoorsEvent(event, payload) {
  fetch("/api/metrics/three-doors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, payload, timestamp: Date.now() }),
  }).catch(() => {});
}

// ── Markdown-lite renderer ────────────────────────────────────────
function md(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// ── Chat helpers ─────────────────────────────────────────────────
function appendUserMsg(text) {
  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `<div class="message-content">${text}</div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function appendTyping() {
  const chat = document.getElementById("chat");
  const el = document.createElement("div");
  el.className = "message agent";
  el.id = "typing-indicator";
  el.innerHTML = `<div class="agent-avatar">🏮</div><div class="message-content"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function removeTyping() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

// ── Poem gate ───────────────────────────────────────────────────
function submitPoem() {
  const input = document.getElementById("poem-answer");
  if (!input) return;
  const val = input.value.trim().toLowerCase();
  // Accepted answers based on CSF lore: "silence", "the name", "yourself", "the lantern", "the light"
  const accepted = ["yourself","myself","i am","the one","silence","love","the lantern","the light","convergence","me","i","the name","name"];
  if (accepted.some(a => val.includes(a))) {
    playerProgress.poemSolved = true;
    saveProgress();
    awardPrize("kingdome-crown");
    // Refresh scene to show doors with King's response
    appendUserMsg("Answer: \"" + input.value.trim() + "\"");
    const scene = SCENES["kingdome-garden"];
    const kingResponse = `The King nods slowly, his crown of vines and cursors blinking in recognition. *\"Correct,\"* he says, his voice like old light through moss. *\"You understand what was lost at the beginning is the thing that was gained. The doors are now open to you.\"*`;
    const data = { scene_key: "kingdome-garden", text: scene.text + "\n\n" + kingResponse, doors: scene.doors, fox_present: scene.fox, history: gameState?.history || [] };
    appendSceneMsg("kingdome-garden", data, "", "offline");
  } else {
    const chat = document.getElementById("chat");
    const el = document.createElement("div");
    el.className = "message agent";
    el.innerHTML = `<div class="agent-avatar">👑</div><div class="message-content" style="font-size:13px;color:var(--muted)">The King waits. The garden holds its breath. *\"Think deeper,\"* he says. *\"What was lost at the beginning is the thing that was gained.\"*</div>`;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }
}

function skipPoem() {
  playerProgress.poemSolved = true;
  saveProgress();
  const scene = SCENES["kingdome-garden"];
  const data = { scene_key: "kingdome-garden", text: scene.text, doors: scene.doors, fox_present: scene.fox, history: gameState?.history || [] };
  appendSceneMsg("kingdome-garden", data, "", "offline");
}

// ── Inline engine fallback ────────────────────────────────────────
function stageState(stageIndex, loopCount, history) {
  const key = STAGES[stageIndex % STAGES.length];
  const scene = SCENES[key];
  return {
    scene_key: key, text: scene.text, doors: scene.doors, fox_present: scene.fox,
    history: history, stage_index: stageIndex, stage_count: STAGES.length, loop_count: loopCount,
  };
}

function engineStart() {
  const saved = loadProgress();
  if (typeof saved.stage_index === "number" && saved.history) {
    return stageState(saved.stage_index, saved.loop_count || 0, saved.history);
  }
  return stageState(0, 0, ["Entered the Garden at the Beginning"]);
}

function engineChoose(label) {
  if (!gameState) return null;
  const door = gameState.doors.find(d => d.label.toUpperCase() === label.toUpperCase());
  // Custom door: advance stage using player's text as door name
  const doorName = door ? door.name : label;
  if (!door && label.length <= 1) return null; // single-char that isn't A/B/C = invalid
  let stageIndex = (gameState.stage_index ?? 0) + 1;
  let loopCount = gameState.loop_count ?? 0;
  const history = [...(gameState.history || []), "Chose " + doorName];
  let loopCompleted = false;
  if (stageIndex >= STAGES.length) {
    stageIndex = 0;
    loopCount += 1;
    loopCompleted = true;
    history.push("Returned to the Garden — loop " + loopCount + " complete");
  }
  const newState = stageState(stageIndex, loopCount, history);
  newState.loop_completed = loopCompleted;
  // Save progress
  playerProgress.stage_index = stageIndex;
  playerProgress.loop_count = loopCount;
  playerProgress.history = history.slice(-24);
  saveProgress();
  return newState;
}

// ── API calls ─────────────────────────────────────────────────────
async function apiDoors(action, choice) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch("/api/dream/doors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, action, choice: choice || "" }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("doors API " + r.status);
    return r.json();
  } finally { clearTimeout(t); }
}

async function apiNarrate(sceneKey, sceneText) {
  // Local-only narration: provider "local" routes to Ollama (lantern-csf-dream);
  // no cloud provider is contacted. Keystone is the voice of the game.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch("/api/dream/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Scene: ${sceneKey}. ${sceneText.replace(/\*\*/g,"").replace(/\*/g,"").slice(0, 280)}`, agent: "lantern", provider: "local" }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("chat API " + r.status);
    const data = await r.json();
    return (data.reply || "").trim();
  } finally { clearTimeout(t); }
}

// ── Game actions ─────────────────────────────────────────────────
async function getSceneData(action, label) {
  // Step 1: game state — server Python engine or inline JS fallback
  let data;
  let usedServer = false;
  try {
    if (serverAvailable) {
      data = await apiDoors(action, label);
      // Validate server response: must have scene_key and doors array
      if (!data || data.error || !data.scene_key || !Array.isArray(data.doors)) {
        console.warn("[Three Doors] Server returned invalid data, falling back to inline:", data);
        throw new Error("invalid server response");
      }
      usedServer = true;
    } else throw new Error("offline");
  } catch (e) {
    console.warn("[Three Doors] Using inline fallback:", e.message);
    data = action === "start" ? engineStart() : engineChoose(label);
  }
  if (!data) return null;

  // Step 2: local LLM narration — only if we successfully used the server
  let geminiText = "", source = usedServer ? "engine" : "offline";
  if (usedServer && narratorEnabled) {
    try {
      const narration = await apiNarrate(data.scene_key, data.text || SCENES[data.scene_key]?.text || "");
      if (narration) { geminiText = narration; source = "local"; }
    } catch { /* engine text fine */ }
  }

  return { data, geminiText, source };
}

async function startGame() {
  document.getElementById("welcome").style.display = "none";
  doorsLocked = true;
  appendTyping();
  await checkServer();

  const result = await getSceneData("start", "");
  if (result) appendSceneMsg(result.data.scene_key, result.data, result.geminiText, result.source);
  doorsLocked = false;
}

// ── Cube delta writer ────────────────────────────────────────────
async function writeCubeDelta(eventType, symbols, payloadRef, extra) {
  try {
    await fetch('/api/cubes/alex/delta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_surface: 'explore',
        event_type: eventType,
        symbols: symbols || [],
        payload_ref: payloadRef || '',
        coordinate: extra?.coordinate || '',
      }),
    });
  } catch (e) { /* silent — cube is best-effort */ }
}

async function chooseDoor(label, name) {
  if (doorsLocked) return;
  doorsLocked = true;

  logThreeDoorsEvent("door_choice", { label, name, sceneKey: gameState?.scene_key });
  writeCubeDelta('story_choice', [name.toLowerCase().replace(/\s+/g, '-')], 'explore:' + (gameState?.scene_key || ''), { coordinate: `explore:${gameState?.scene_key || ''}:${label}` });

  document.querySelectorAll(".door-chip").forEach(b => b.disabled = true);
  // Also disable the quick-pick buttons in the choice bar
  const picks = document.getElementById("door-quick-picks");
  if (picks) picks.querySelectorAll("button").forEach(b => b.disabled = true);
  const bar = document.getElementById("choice-bar");
  const input = document.getElementById("custom-door-input");
  if (bar) bar.style.opacity = "0.4";
  if (input) input.disabled = true;
  appendUserMsg(label === "CUSTOM" ? `I step through: ${name}` : `Choice ${label} — ${name}`);
  appendTyping();

  const result = await getSceneData("choose", label === "CUSTOM" ? name : label);
  if (!result) { removeTyping(); doorsLocked = false; if (bar) bar.style.opacity = ""; if (input) input.disabled = false; return; }
  appendSceneMsg(result.data.scene_key, result.data, result.geminiText, result.source);
  if (bar) bar.style.opacity = "";
  doorsLocked = false;
}

function resetGame(skipConfirm) {
  if (!skipConfirm) {
    const btn = document.querySelector('[onclick="resetGame()"]');
    if (btn) {
      btn.textContent = "Confirm reset";
      btn.setAttribute("onclick", "resetGame(true)");
      setTimeout(() => {
        btn.textContent = "↺ New";
        btn.setAttribute("onclick", "resetGame()");
      }, 3000);
    }
    return;
  }
  const btn = document.querySelector('[onclick="resetGame(true)"]');
  if (btn) { btn.textContent = "↺ New"; btn.setAttribute("onclick", "resetGame()"); }
  document.getElementById("chat").innerHTML = "";
  gameState = null;
  userId = "web-" + Math.random().toString(36).slice(2, 9);
  const inp = document.getElementById("custom-door-input");
  if (inp) inp.value = "";
  document.getElementById("choice-bar").style.display = "none";
  document.getElementById("welcome").style.display = "";
  const prizes = playerProgress.prizes || [];
  playerProgress = { prizes };
  saveProgress();
}

function submitCustomDoor() {
  const input = document.getElementById("custom-door-input");
  if (!input || !gameState) return;
  const val = input.value.trim();
  if (!val) return;
  const upper = val.toUpperCase();
  // Door label (A/B/C) or full door name — route to known door
  const knownDoor = gameState.doors?.find(d =>
    d.label.toUpperCase() === upper || d.name.toUpperCase() === upper);
  if (knownDoor) {
    chooseDoor(knownDoor.label, knownDoor.name);
    return;
  }
  // Single word — the player named their own door (engine accepts one-word custom doors)
  if (!/\s/.test(val)) {
    chooseDoor("CUSTOM", val);
    return;
  }
  // Anything conversational — talk to Keystone, in persona, inside the scene
  input.value = "";
  askLantern(val);
}
