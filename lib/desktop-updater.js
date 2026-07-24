// desktop-updater.js — delta auto-update for the packaged desktop app.
//
// The Core's code lives in this repo, so the installed app keeps its CODE in sync with
// GitHub `master` (the same source the stable server auto-deploys from). We ask the
// GitHub git-tree API for every tracked file + its blob SHA (one request), compare each
// against the LOCAL file's git-blob-sha, and download ONLY the files that differ from
// `raw.githubusercontent.com`. Downloads are staged; the launcher applies the staged set
// at the NEXT startup, before the Core runs — never hot-swapping live code.
//
// What is NOT patched here (they change rarely and can't be pulled from git raw):
//   • node_modules — installed, not in the repo (dep changes → full installer).
//   • the exe itself — the running unisona.exe embeds launcher.js; a launcher change is
//     flagged as `needsFullUpdate` so the app can prompt for a fresh installer.
//   • LFS-tracked media (png/jpg/jpeg/gif/zip/pdf) — raw would serve pointers.
//
// Zero-dependency (Node builtins only). Gated by the launcher to the packaged app.
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OWNER = "alex-place", REPO = "lantern-os", BRANCH = "master";
const TREE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/`;

const LFS_EXT = /\.(png|jpe?g|gif|zip|pdf)$/i;                 // served as pointers via raw — skip
const SKIP_DIRS = ["desktop/dist/", "desktop/node_modules/"];

// Map a repo path to the install-relative destination, or null if it isn't a code file
// we sync. (node_modules is gitignored, so it never appears in the tree.)
function repoPathToDst(p) {
  if (LFS_EXT.test(p) || SKIP_DIRS.some((d) => p.startsWith(d)) || p.includes("/node_modules/")) return null;
  if (p.startsWith("")) return "resources/app/" + p.slice("".length);
  if (p.startsWith("src/")) return p;
  if (p.startsWith("data/contexts/")) return p;
  if (p === "package.json") return "package.json";
  return null;
}

function httpsGet(url, cb, redirects = 0) {
  const req = https.get(url, { headers: { "User-Agent": "unisona-desktop-updater", Accept: "*/*" } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
      res.resume();
      return httpsGet(res.headers.location, cb, redirects + 1);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error(`HTTP ${res.statusCode} for ${url}`)); }
    const chunks = [];
    res.on("data", (d) => chunks.push(d));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  req.on("error", cb);
  req.setTimeout(20000, () => req.destroy(new Error("timeout")));
}

// git blob sha = sha1("blob " + byteLength + "\0" + content) — matches the tree API's
// `sha`. The repo stores text with LF, so a Windows checkout's CRLF files must be
// normalized (CRLF→LF) before hashing or they'd all look "changed". Binary files (a
// NUL byte, git's own heuristic) are hashed as-is. Downloaded raw content is already
// LF, so normalization is a no-op there.
function gitBlobSha(content) {
  let c = content;
  if (!c.includes(0)) c = Buffer.from(c.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return crypto.createHash("sha1").update("blob " + c.length + "\0").update(c).digest("hex");
}
function localBlobSha(p) {
  try { return gitBlobSha(fs.readFileSync(p)); } catch { return null; }
}

// Check master and stage any changed code files. cb(err, { downloaded, needsFullUpdate }).
function checkAndStage(installRoot, cb) {
  httpsGet(TREE_URL, (err, buf) => {
    if (err) return cb(err);
    let tree;
    try { tree = JSON.parse(buf.toString("utf8")); } catch (e) { return cb(e); }
    if (!tree || !Array.isArray(tree.tree)) return cb(new Error("bad tree response"));

    const wanted = [];
    for (const node of tree.tree) {
      if (node.type !== "blob") continue;
      const dst = repoPathToDst(node.path);
      if (dst && localBlobSha(path.join(installRoot, dst)) !== node.sha) {
        wanted.push({ src: node.path, dst, sha: node.sha });
      }
    }

    const updDir = path.join(installRoot, ".updates");
    fs.rmSync(updDir, { recursive: true, force: true });
    if (wanted.length === 0) return cb(null, { downloaded: 0, upToDate: true });

    const stageDir = path.join(updDir, "staged");
    let i = 0, needsFullUpdate = false;
    const next = () => {
      if (i >= wanted.length) {
        fs.mkdirSync(updDir, { recursive: true });
        fs.writeFileSync(path.join(updDir, "pending.json"), JSON.stringify({ files: wanted.map((w) => w.dst) }));
        return cb(null, { downloaded: wanted.length, needsFullUpdate });
      }
      const w = wanted[i++];
      httpsGet(RAW_BASE + w.src, (e, data) => {
        if (e) return cb(e);
        if (gitBlobSha(data) !== w.sha) return cb(new Error("blob-sha mismatch for " + w.src));
        const out = path.join(stageDir, w.dst);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, data);
        if (w.dst.replace(/\\/g, "/").endsWith("desktop/launcher.js")) needsFullUpdate = true;
        next();
      });
    };
    next();
  });
}

// Apply a staged update (copy staged files over the install). Call BEFORE the Core runs.
// Returns the number of files applied, or 0 if nothing pending.
function applyPending(installRoot) {
  const updDir = path.join(installRoot, ".updates");
  let pend;
  try { pend = JSON.parse(fs.readFileSync(path.join(updDir, "pending.json"), "utf8")); } catch { return 0; }
  const stageDir = path.join(updDir, "staged");
  let n = 0;
  try {
    for (const dst of pend.files || []) {
      const from = path.join(stageDir, dst), to = path.join(installRoot, dst);
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); n++; }
    }
  } catch { /* partial apply is fine — a re-check re-stages the rest next time */ }
  fs.rmSync(updDir, { recursive: true, force: true });
  return n;
}

module.exports = { checkAndStage, applyPending, TREE_URL, RAW_BASE };
