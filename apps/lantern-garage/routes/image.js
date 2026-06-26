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
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { saveImage, listImages, deleteImage } = require("../lib/image-handler");

const MAX_PROMPT_LEN = 1000;

module.exports = function imageRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, sendFile } = deps;

  // POST /api/image/ai-generate — generate an image via the OpenAI Images API (Node, no python).
  // Saves locally and returns { ok, url: "/images/<file>", model }. The chat's "draw me X" flow
  // calls this first (OpenAI quality) and falls back to a keyless source when ok is false.
  if (req.method === "POST" && url.pathname === "/api/image/ai-generate") {
    // collectRequestBody is promise-style (req, maxBytes, timeoutMs) — NOT a callback.
    (async () => {
      try {
        const raw = await collectRequestBody(req);
        const data = JSON.parse(raw || "{}");
        const prompt = String(data.prompt || "").slice(0, MAX_PROMPT_LEN * 4).trim();
        if (!prompt) { sendJson(res, { ok: false, error: "prompt required" }, 400); return; }
        const { generateImage } = require("../lib/openai-image");
        const result = await generateImage(prompt, { size: data.size });
        sendJson(res, result, result.ok ? 200 : 502);
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

  if (req.method === "POST" && url.pathname === "/api/image/generate") {
    collectRequestBody(req, async (body) => {
      try {
        const data = JSON.parse(body || "{}");
        const prompt = (data.prompt || "").slice(0, MAX_PROMPT_LEN).trim();
        const useApi = data.useApi === true && process.env.OPENAI_API_KEY;
        const version = data.version || "v8";
        const width = data.width || 1024;
        const height = data.height || 768;
        const seed = data.seed ?? Math.floor(Math.random() * 100000);

        if (useApi) {
          // Call Python script in API mode
          const safePrompt = prompt.replace(/"/g, '\\"');
          const cmd = `python scripts/image_generator.py --api --prompt "${safePrompt}"`;
          const output = execSync(cmd, {
            cwd: deps.repoRoot || process.cwd(),
            encoding: "utf8",
            timeout: 60000,
            env: { ...process.env },
          });
          const match = output.match(/saved:\s*(.+)/);
          const imgPath = match ? match[1].trim() : null;
          sendJson(res, {
            mode: "api",
            prompt,
            path: imgPath,
            seed,
            output: output.slice(-500),
          });
          return;
        }

        // Procedural generation
        const cmd = `python scripts/image_generator.py ${version} --width ${width} --height ${height} --seed ${seed}`;
        const output = execSync(cmd, {
          cwd: deps.repoRoot || process.cwd(),
          encoding: "utf8",
          timeout: 120000,
          env: { ...process.env },
        });
        const match = output.match(/saved:\s*(.+)/);
        const imgPath = match ? match[1].trim() : null;

        sendJson(res, {
          mode: "procedural",
          version,
          width,
          height,
          seed,
          prompt: prompt || null,
          path: imgPath,
          output: output.slice(-500),
        });
      } catch (err) {
        sendJson(res, { error: err.message, stderr: err.stderr?.toString() }, 500);
      }
    });
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

  // Gallery API: Upload image from base64
  if (req.method === "POST" && url.pathname === "/api/image/upload") {
    collectRequestBody(req, (body) => {
      try {
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
    });
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
