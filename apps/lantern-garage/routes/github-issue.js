/**
 * GitHub issue reporter route (#screenshot-button).
 *
 *   POST /api/github/issue
 *     body: { title, body, image?: <dataURL or base64 PNG>, meta?: {...} }
 *     → { ok, number, url, screenshot }   (201)  | { ok:false, error } (4xx/5xx)
 *
 * Files a GitHub issue against the project repo via the `gh` CLI (same path the
 * autowork pipeline already uses — see lib/self-edit-engine.js#createIssueFromTask),
 * and saves the attached screenshot under data/issue-screenshots/ as a local,
 * append-only artifact. GitHub's REST API / `gh` can't embed inline images, so the
 * browser copies the screenshot to the clipboard and opens the returned issue URL —
 * the user pastes it in to embed it (the "hybrid" flow).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { sendJson, collectRequestBody } = require("../lib/http-utils");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const GH_REPO = process.env.GH_REPO || "alex-place/lantern-os";
const SHOT_DIR = path.join(REPO_ROOT, "data", "issue-screenshots");
// Where screenshots are hosted so they can be embedded in the issue body. GitHub's
// API can't upload native attachments, so we commit the PNG to a dedicated branch
// in the user's fork (write access) and reference its raw URL with ![](…).
const ASSET_REPO = process.env.GH_ASSET_REPO || "";   // empty → derive from git remote origin
const ASSET_BRANCH = process.env.GH_ASSET_BRANCH || "issue-assets";

// ~12 MB of base64 covers a full-screen PNG with headroom; reject larger.
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";
}

// Decode a data URL or bare base64 PNG/JPEG → Buffer + extension. Returns null on junk.
function decodeImage(image) {
  if (typeof image !== "string" || !image) return null;
  const m = image.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  const ext = m ? (m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase()) : "png";
  const b64 = m ? m[2] : image.replace(/^data:[^,]*,/, "");
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? { buf, ext } : null;
  } catch {
    return null;
  }
}

function ghIssueCreate(title, body) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", SKIP_MONOWORKSTREAM: "1" };
    execFile(
      "gh",
      ["issue", "create", "--repo", GH_REPO, "--title", title, "--body", body.slice(0, 60000)],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000, windowsHide: true, env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(((stderr || "") + (err.message || "")).slice(0, 300)));
        const out = String(stdout || "").trim();
        const url = (out.match(/https:\/\/github\.com\/[^\s]+\/issues\/\d+/) || [])[0] || out;
        const number = parseInt((url.match(/\/issues\/(\d+)/) || [])[1], 10);
        if (!number) return reject(new Error("issue_create_failed: " + out.slice(0, 200)));
        resolve({ number, url });
      }
    );
  });
}

// Run a `gh` subcommand and parse its JSON stdout. Rejects on non-zero exit.
function ghJson(args, inputFile) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", SKIP_MONOWORKSTREAM: "1" };
    const a = inputFile ? args.concat(["--input", inputFile]) : args;
    execFile("gh", a, { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(((stderr || "") + (err.message || "")).slice(0, 300)));
        try { resolve(stdout ? JSON.parse(stdout) : {}); } catch { resolve({ raw: String(stdout || "") }); }
      });
  });
}

// The fork we host screenshots in. Explicit env wins; otherwise read `origin` —
// that's the user's fork (push access), distinct from the upstream we file against.
function resolveAssetRepo() {
  if (ASSET_REPO) return Promise.resolve(ASSET_REPO);
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout || "").match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/i);
        resolve(m ? m[1] : null);
      });
  });
}

// Make sure the assets branch exists (create it off the fork's default branch once).
async function ensureAssetBranch(repo, branch) {
  try { await ghJson(["api", `repos/${repo}/git/ref/heads/${branch}`]); return; }
  catch (e) { /* not found → create below */ }
  const info = await ghJson(["api", `repos/${repo}`]);
  const def = (info && info.default_branch) || "master";
  const ref = await ghJson(["api", `repos/${repo}/git/ref/heads/${def}`]);
  const sha = ref && ref.object && ref.object.sha;
  if (!sha) throw new Error("no_default_branch_sha");
  await ghJson(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`]);
}

// Commit the PNG to the fork via the Contents API and return its raw URL. Base64
// goes through a temp JSON file (--input) to dodge Windows command-line length limits.
async function uploadScreenshot(repo, branch, relPath, buf, title) {
  await ensureAssetBranch(repo, branch);
  const payload = { message: `screenshot: ${title}`.slice(0, 200), branch, content: buf.toString("base64") };
  const tmp = path.join(os.tmpdir(), `lantern-issue-asset-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  try {
    const res = await ghJson(["api", "-X", "PUT", `repos/${repo}/contents/${relPath}`], tmp);
    return (res && res.content && res.content.download_url) || null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

module.exports = async function githubIssueRoute(req, res, url, deps) {
  const json = (deps && deps.sendJson) || sendJson;
  // GET → tell the client which repo to file against, so it can build GitHub's
  // prefilled "New issue" URL (where the user pastes the screenshot into the body).
  if (url.pathname === "/api/github/issue" && req.method === "GET") {
    json(res, { ok: true, repo: GH_REPO });
    return true;
  }
  if (url.pathname !== "/api/github/issue" || req.method !== "POST") return false;

  let payload;
  try {
    payload = JSON.parse((await collectRequestBody(req, MAX_BODY_BYTES)) || "{}");
  } catch (e) {
    json(res, { ok: false, error: /too_large/.test(e.message) ? "screenshot_too_large" : "bad_request" }, 413);
    return true;
  }

  const title = String(payload.title || "").trim().slice(0, 256);
  const desc = String(payload.body || "").trim();
  if (!title) {
    json(res, { ok: false, error: "title_required" }, 400);
    return true;
  }

  // Persist the screenshot locally (append-only artifact) AND host it in the fork so
  // it can be embedded directly in the issue body.
  let shotRel = null;
  let embedUrl = null;
  const decoded = decodeImage(payload.image);
  if (decoded) {
    const fname = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(title)}.${decoded.ext}`;
    try {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, fname), decoded.buf);
      shotRel = path.join("data", "issue-screenshots", fname).replace(/\\/g, "/");
    } catch { /* non-fatal — file the issue anyway */ }
    try {
      const assetRepo = await resolveAssetRepo();
      if (assetRepo) {
        embedUrl = await uploadScreenshot(assetRepo, ASSET_BRANCH, "issue-screenshots/" + fname, decoded.buf, title);
      }
    } catch (e) {
      // Couldn't host it (no write access / offline) — fall back to the paste hint
      // below; the issue still gets filed.
      console.warn("[issue] screenshot embed failed:", e.message);
    }
  }

  // Compose the issue body: embedded screenshot + user text + captured context.
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  const lines = [];
  if (embedUrl) lines.push(`![screenshot](${embedUrl})`, "");
  if (desc) lines.push(desc, "");
  lines.push("---", "<sub>Filed from Keystone OS chat 📷 screenshot reporter.</sub>", "");
  if (meta.url) lines.push(`- **Page:** ${String(meta.url).slice(0, 500)}`);
  if (meta.userAgent) lines.push(`- **Agent:** ${String(meta.userAgent).slice(0, 300)}`);
  if (meta.viewport) lines.push(`- **Viewport:** ${String(meta.viewport).slice(0, 40)}`);
  lines.push(`- **When:** ${new Date().toISOString()}`);
  if (shotRel && !embedUrl) {
    lines.push(`- **Screenshot:** saved locally at \`${shotRel}\` — paste it from your clipboard here to embed it.`);
  }

  try {
    const { number, url: issueUrl } = await ghIssueCreate(title, lines.join("\n"));
    json(res, { ok: true, number, url: issueUrl, screenshot: shotRel, embedded: !!embedUrl }, 201);
  } catch (e) {
    json(res, { ok: false, error: "gh_create_failed", message: e.message, screenshot: shotRel }, 502);
  }
  return true;
};
