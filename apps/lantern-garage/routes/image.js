/**
 * Image Generation & Gallery Route
 *
 * POST /api/image/generate  — generate an image
 *   Body: { prompt?: string, version?: "v8"|"v9"|"v10", width?: number, height?: number, seed?: number }
 *   If OPENAI_API_KEY is set and useApi=true, calls DALL-E 3.
 *   Otherwise falls back to procedural Python generation.
 *
 * GET /api/image/list — list generated images in data/images/
 *
 * POST /api/image/upload — upload image from base64
 *   Body: { data: string (base64), name?: string }
 *   Returns: { id, filename, url, timestamp }
 *
 * GET /api/images — list gallery images with metadata
 *
 * DELETE /api/images/:id — remove image from gallery
 *
 * GET /api/image/pool/random — pick a random image from CAAD pool
 *   Priority: THREE_DOORS_IMAGE_POOL_DIR env var → data/images/caadi/
 *   Returns: { url: "/api/image/pool/serve?file=...&source=..." }
 *
 * GET /api/image/pool/serve?file=<name>&source=local|caadi — serve a pool image safely
 */
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const fs = require("fs");
const path = require("path");
const { saveImage, listImages, deleteImage } = require("../lib/image-handler");

const MAX_PROMPT_LEN = 1000;

module.exports = function imageRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, sendFile } = deps;

  // POST /api/image/ai-generate — generate an image, selecting the provider through the
  // OSS-first image-model-registry (Act stage). Returns the SAME contract as before —
  // { ok, url: "/images/<file>", model } — so the chat "draw me X" flow and Three Doors
  // (public/js/three-doors-images.js) keep working; they keyless-fall-back when ok is false.
  //
  // Phase 1: the local OSS lead (Flux/ComfyUI) has no driver yet and is unreachable, so the
  // chain resolves to OpenAI exactly as before (no behavior change). Once Phase 3 lands the
  // ComfyUI driver and the boot probe verifies it, the OSS provider leads automatically and
  // the closed one drops to a fallback (or is forbidden by IMAGE_OSS_ONLY=1).
  if (req.method === "POST" && url.pathname === "/api/image/ai-generate") {
    // collectRequestBody is promise-style (req, maxBytes, timeoutMs) — NOT a callback.
    (async () => {
      try {
        const raw = await collectRequestBody(req);
        const data = JSON.parse(raw || "{}");
        const prompt = String(data.prompt || "").slice(0, MAX_PROMPT_LEN * 4).trim();
        if (!prompt) { sendJson(res, { ok: false, error: "prompt required" }, 400); return; }

        const registry = require("../lib/image-model-registry");
        const taskType = data.taskType === "character" ? "character" : "scene";
        // Driver map: prompt flows via a JSON body field to each driver (never interpolated).
        const drivers = {
          openai: (p) => require("../lib/openai-image").generateImage(p, { size: data.size }),
          // ComfyUI/Flux driver lands in Phase 3 (#1847). True no-op until then so the chain
          // falls through cleanly rather than crashing.
          comfyui: async () => ({ ok: false, error: "comfyui provider not yet implemented (Phase 3)" }),
          pollinations: async () => ({ ok: false, error: "pollinations handled client-side" }),
        };

        const chain = registry.resolveImageChain(taskType);
        if (!chain.length) {
          // No provider reachable → graceful {ok:false}, never a 500. Client keyless-falls-back.
          sendJson(res, { ok: false, error: "no image provider available" }, 502);
          return;
        }

        let result = { ok: false, error: "no image provider available" };
        for (const provider of chain) {
          const driver = drivers[provider.kind];
          if (!driver) continue;
          result = await driver(prompt);
          if (result && result.ok) { result.provider = provider.id; break; }
        }
        sendJson(res, result, result && result.ok ? 200 : 502);
      } catch (err) {
        sendJson(res, { ok: false, error: err.message }, 500);
      }
    })();
    return true;
  }

  // POST /api/vision/analyze — answer about an uploaded image with a vision model (Claude
  // primary, gpt-4o-mini fallback; key server-side). Used by the chat when an image is attached.
  if (req.method === "POST" && url.pathname === "/api/vision/analyze") {
    (async () => {
      try {
        const raw = await collectRequestBody(req, 16 * 1024 * 1024); // image base64 is large
        const data = JSON.parse(raw || "{}");
        const prompt = String(data.prompt || "").slice(0, MAX_PROMPT_LEN * 4);
        const image = data.image || "";
        if (!image) { sendJson(res, { ok: false, error: "image required" }, 400); return; }
        const { analyzeImage } = require("../lib/vision");
        const result = await analyzeImage(prompt, image, { mimeType: data.mimeType });
        sendJson(res, result, result.ok ? 200 : 502);
      } catch (err) {
        sendJson(res, { ok: false, error: err.message }, 500);
      }
    })();
    return true;
  }

  // Legacy Python-subprocess path (the live UI uses /api/image/ai-generate). Two
  // fixes landed together (#2500): the handler used the promise-style
  // collectRequestBody as if it took a callback, so it NEVER responded (every POST
  // hung to client timeout); and it shelled out via execSync, which both blocked
  // the whole event loop for up to 120s and interpolated user input into a shell
  // string. Now: awaited body, async execFile with an argv array (no shell).
  if (req.method === "POST" && url.pathname === "/api/image/generate") {
    (async () => {
      try {
        const body = await collectRequestBody(req);
        const data = JSON.parse(body || "{}");
        const prompt = (data.prompt || "").slice(0, MAX_PROMPT_LEN).trim();
        const useApi = data.useApi === true && process.env.OPENAI_API_KEY;
        const version = String(data.version || "v8");
        const width = Number(data.width) || 1024;
        const height = Number(data.height) || 768;
        const seed = Number.isFinite(Number(data.seed)) ? Number(data.seed) : Math.floor(Math.random() * 100000);
        if (!/^v\d{1,3}$/.test(version)) {
          sendJson(res, { error: "invalid version" }, 400);
          return;
        }

        const args = useApi
          ? ["scripts/image_generator.py", "--api", "--prompt", prompt]
          : ["scripts/image_generator.py", version, "--width", String(width), "--height", String(height), "--seed", String(seed)];
        const { stdout } = await execFileAsync("python", args, {
          cwd: deps.repoRoot || process.cwd(),
          encoding: "utf8",
          timeout: useApi ? 60000 : 120000,
          env: { ...process.env },
        });
        const match = stdout.match(/saved:\s*(.+)/);
        const imgPath = match ? match[1].trim() : null;

        sendJson(res, useApi
          ? { mode: "api", prompt, path: imgPath, seed, output: stdout.slice(-500) }
          : { mode: "procedural", version, width, height, seed, prompt: prompt || null, path: imgPath, output: stdout.slice(-500) });
      } catch (err) {
        sendJson(res, { error: err.message, stderr: err.stderr?.toString().slice(-500) }, 500);
      }
    })();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/image/list") {
    try {
      const imgDir = path.join(deps.repoRoot || process.cwd(), "data", "images");
      const files = fs.readdirSync(imgDir)
        .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map((f) => {
          const stat = fs.statSync(path.join(imgDir, f));
          return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
        .slice(0, 50);
      sendJson(res, { images: files, dir: imgDir });
    } catch (err) {
      sendJson(res, { images: [], error: err.message });
    }
    return true;
  }

  // Gallery API: Upload image from base64. Same dead-callback fix as
  // /api/image/generate above (#2500): collectRequestBody is promise-style, so the
  // old callback form never ran and every upload hung. 16MB cap for image payloads.
  if (req.method === "POST" && url.pathname === "/api/image/upload") {
    (async () => {
      try {
        const body = await collectRequestBody(req, 16 * 1024 * 1024);
        const data = JSON.parse(body || "{}");
        const base64 = data.data || "";
        const name = data.name || "image.png";

        if (!base64) {
          sendJson(res, { error: "Missing image data" }, 400);
          return;
        }

        const buffer = Buffer.from(base64.replace(/^data:image\/[^;]+;base64,/, ""), "base64");
        const result = saveImage(buffer, name);

        sendJson(res, result);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    })();
    return true;
  }

  // Gallery API: List gallery images
  if (req.method === "GET" && url.pathname === "/api/images") {
    try {
      const imgDir = path.join(deps.repoRoot || process.cwd(), "data", "images");
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
      const images = fs.readdirSync(imgDir)
        .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
        .map(f => {
          const stat = fs.statSync(path.join(imgDir, f));
          const id = f.split(".")[0];
          return { id, filename: f, url: `/images/${f}`, size: stat.size, timestamp: stat.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      sendJson(res, { images, count: images.length }, 200);
    } catch (err) {
      sendJson(res, { error: err.message, images: [] }, 500);
    }
    return true;
  }

  // Gallery API: Delete image
  if (req.method === "DELETE" && url.pathname.match(/^\/api\/images\/(.+)$/)) {
    const imageId = url.pathname.match(/^\/api\/images\/(.+)$/)[1];
    try {
      const success = deleteImage(imageId);
      if (success) {
        sendJson(res, { success: true, id: imageId }, 200);
      } else {
        sendJson(res, { error: "Image not found" }, 404);
      }
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // Serve gallery images
  if (req.method === "GET" && url.pathname.startsWith("/images/")) {
    try {
      const filename = url.pathname.slice("/images/".length);
      if (filename.includes("..") || filename.includes("/")) {
        sendJson(res, { error: "forbidden" }, 403);
        return true;
      }
      const imagePath = path.join(deps.repoRoot || process.cwd(), "data", "images", filename);
      if (!fs.existsSync(imagePath)) {
        sendJson(res, { error: "not found" }, 404);
        return true;
      }
      sendFile(res, imagePath);
      return true;
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  return false;
};
