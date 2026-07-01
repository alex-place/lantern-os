// ── Three Doors Image Loading ─────────────────────────────────────────────────
// Pollinations.ai async image loader, training data collection, LoRA training
// Depends on three-doors-data.js for SCENES, SD_PROMPTS, and constants

// ── Pollinations.ai async image loader ───────────────────────────
// Shows canvas art immediately; swaps in AI-generated image when ready.
// Also collects images + prompts as LoRA training data.
const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt/";
const pollinationsCache = {}; // keyed by sceneKey_loopCount for fresh art each loop
let trainingImageCount = 0;

// Shared direct Node DALL-E / gpt-image-2 call (POST /api/image/ai-generate,
// see lib/openai-image.js) — used for scenes with no curated R2 art AND for
// dynamic/custom doors (a player-named door, or a novelty-routed "deep"
// scene) that have no fixed art of their own. Returns null on any failure
// so callers can fall through to Pollinations without special-casing.
async function tryDalleGenerate(sceneKey, prompt) {
  try {
    const response = await fetch("/api/image/ai-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, size: "1024x1024" }),
    });
    const data = await response.json();
    if (data.ok && data.url) return { url: data.url, model: data.model };
  } catch (e) {
    logThreeDoorsEvent('image_error', { sceneKey, error: e.message });
  }
  return null;
}

async function loadPollinationsImage(imgId, canvasId, sceneKey) {
  const loopCount = gameState?.loop_count ?? 0;
  const cacheKey = `${sceneKey}_L${loopCount}`;
  if (pollinationsCache[cacheKey]) return; // already loaded this scene+loop
  const scene = SCENES[sceneKey];
  const sdPrompt = scene?.image_prompt || SD_PROMPTS?.[sceneKey] || (scene?.text?.slice(0, 120) || sceneKey);
  const loopFlair = loopCount > 0 ? `, revisited ${loopCount > 1 ? "again " : ""}with new eyes` : "";
  const seed = Math.floor(Math.random() * 999983) + 1;
  const fullPrompt = buildDynamicImagePrompt(sceneKey, seed, gameState);

  const img = document.getElementById(imgId);
  const cvs = document.getElementById(canvasId);
  if (!img && !cvs) return;

  // Scenes with no curated R2 art (DALLE_GENERATED_SCENES ∪ legacy
  // SERVER_GENERATED_SCENES — both now go through the same direct Node
  // DALL-E / gpt-image-2 call, no Python subprocess, no dead GET endpoint;
  // see lib/openai-image.js): try that first.
  if (DALLE_GENERATED_SCENES.has(sceneKey) || SERVER_GENERATED_SCENES.has(sceneKey)) {
    const dalleImg = await tryDalleGenerate(sceneKey, fullPrompt);
    if (dalleImg) {
      pollinationsCache[cacheKey] = dalleImg.url;
      logThreeDoorsEvent('image_load', { sceneKey, source: dalleImg.model || 'dalle', loop: loopCount });
      if (cvs) cvs.style.display = "none";
      if (img) { img.src = dalleImg.url; img.style.display = ""; }
      collectTrainingImage(sceneKey, fullPrompt, dalleImg.url);
      return;
    }
  }

  // Fallback: Pollinations free API (no key required)
  const pollinationsUrl = POLLINATIONS_BASE + encodeURIComponent(fullPrompt) + `?width=800&height=450&nologo=true&model=flux&seed=${seed}`;
  try {
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      pollinationsCache[cacheKey] = pollinationsUrl;
      logThreeDoorsEvent('image_load', { sceneKey, source: 'pollinations', loop: loopCount, seed });
      if (cvs) cvs.style.display = "none";
      if (img) { img.src = pollinationsUrl; img.style.display = ""; }
      collectTrainingImage(sceneKey, fullPrompt, pollinationsUrl);
    };
    probe.onerror = () => {}; // canvas stays visible
    probe.src = pollinationsUrl;
  } catch { /* silent */ }
}

async function collectTrainingImage(sceneKey, prompt, imageUrl) {
  try {
    const r = await fetch("/api/dream/training/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sceneKey,
        prompt,
        imageUrl,
        playerChoice: gameState?.last_choice || "",
        loopCount: gameState?.loop_count || 0,
        stageIndex: gameState?.stage_index || 0,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    trainingImageCount = data.total || trainingImageCount + 1;
    updateTrainingBadge();
  } catch { /* silent — training collection is best-effort */ }
}

function updateTrainingBadge() {
  const badge = document.getElementById("training-badge");
  const count = document.getElementById("training-count");
  if (!badge || !count) return;
  count.textContent = trainingImageCount;
  badge.style.display = trainingImageCount > 0 ? "" : "none";
  badge.title = trainingImageCount >= 15
    ? `${trainingImageCount} images collected — click to start LoRA training!`
    : `${trainingImageCount}/15 images collected for LoRA training`;
  badge.style.borderColor = trainingImageCount >= 15 ? "var(--accent)" : "var(--border)";
}

async function showTrainingStatus() {
  try {
    const r = await fetch("/api/dream/training/status");
    const data = await r.json();
    trainingImageCount = data.imageCount || trainingImageCount;
    updateTrainingBadge();
    const ready = data.imageCount >= data.minImagesForTraining;
    const msg = [
      `📸 Training dataset: ${data.imageCount} images`,
      data.lastCheckpoint ? `✓ Last checkpoint: ${data.lastCheckpoint}` : "",
      data.trainingActive ? "⚙️  Training in progress..." : "",
      ready && !data.trainingActive ? `\n▶ Ready to train! (${data.imageCount}/${data.minImagesForTraining} images)` : "",
      !ready ? `Need ${data.minImagesForTraining - data.imageCount} more images — keep exploring!` : "",
    ].filter(Boolean).join("\n");
    if (ready && !data.trainingActive && confirm(msg + "\n\nStart LoRA training now?")) {
      startLoraTraining();
    } else {
      alert(msg);
    }
  } catch (e) {
    alert(`Training status unavailable: ${e.message}`);
  }
}

async function startLoraTraining() {
  try {
    const r = await fetch("/api/dream/training/start", { method: "POST" });
    const data = await r.json();
    if (data.error) { alert(`Training error: ${data.error}`); return; }
    alert(`Training started! PID ${data.pid}\nLog: ${data.logPath}\nThis runs in the background — keep playing to add more training data.`);
    const badge = document.getElementById("training-badge");
    if (badge) badge.textContent = "⚙️ training";
  } catch (e) {
    alert(`Could not start training: ${e.message}`);
  }
}

// Load training count on boot
fetch("/api/dream/training/status").then(r => r.json()).then(d => {
  trainingImageCount = d.imageCount || 0;
  updateTrainingBadge();
}).catch(() => {});
