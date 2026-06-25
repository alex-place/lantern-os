// Creator profile intake and retrieval
const { execFile } = require("child_process");
const nodePath = require("path");

// Pack the creator's profile into their personal CSF archive
// (data/profiles/<slug>.csf — gitignored), the durable home for the PII the
// loose JSON working copy holds. Resolves with the python log; rejects on
// failure so callers can treat it as best-effort.
function packPersonalCsf(repoRoot, slug) {
  return new Promise((resolve, reject) => {
    execFile(
      "python",
      ["-m", "csf.profile_pack", "pack", slug, "-o", `data/profiles/${slug}.csf`],
      { cwd: repoRoot, timeout: 120_000, env: { ...process.env, PYTHONPATH: nodePath.resolve(repoRoot, "src") } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(String(stdout).trim()))
    );
  });
}

// Read a creator profile back out of the personal CSF archive (the member is
// stored at user/data/creators/<slug>.json by profile_pack). Returns the raw
// JSON text. Used as a load fallback when the loose working copy is gone.
function readCreatorFromCsf(repoRoot, slug) {
  return new Promise((resolve, reject) => {
    const code =
      "import sys, csf; " +
      `sys.stdout.write(csf.read_file(${JSON.stringify(`data/profiles/${slug}.csf`)}, ` +
      `${JSON.stringify(`user/data/creators/${slug}.json`)}).decode("utf-8"))`;
    execFile(
      "python",
      ["-c", code],
      { cwd: repoRoot, timeout: 60_000, encoding: "utf8", env: { ...process.env, PYTHONPATH: nodePath.resolve(repoRoot, "src") } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))
    );
  });
}

module.exports = async function creatorsRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, path, repoRoot, fs } = deps;

  const creatorsDir = path.join(repoRoot, "data", "creators");

  function ensureDir() {
    if (!fs.existsSync(creatorsDir)) fs.mkdirSync(creatorsDir, { recursive: true });
  }

  // GET /api/creators — list all creator slugs
  if (url.pathname === "/api/creators" && req.method === "GET") {
    ensureDir();
    const files = fs.readdirSync(creatorsDir).filter(f => f.endsWith(".json")).sort();
    const slugs = files.map(f => f.replace(".json", ""));
    sendJson(res, { creators: slugs });
    return true;
  }

  // GET /api/creators/:slug — load a creator profile
  if (url.pathname.startsWith("/api/creators/") && req.method === "GET") {
    // Validate (don't silently sanitize) so behavior matches the POST handler.
    const slug = url.pathname.split("/api/creators/")[1] || "";
    if (!/^[a-z0-9-]+$/.test(slug)) {
      sendJson(res, { error: "Invalid slug (lowercase letters, numbers, hyphens only)" }, 400);
      return true;
    }
    const filePath = path.join(creatorsDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
      // The loose working copy is gone — fall back to the personal CSF archive,
      // which retains the profile even when the JSON is removed.
      const archivePath = path.join(repoRoot, "data", "profiles", `${slug}.csf`);
      if (fs.existsSync(archivePath)) {
        try {
          const data = JSON.parse(await readCreatorFromCsf(repoRoot, slug));
          sendJson(res, { creator: data, source: "csf" });
          return true;
        } catch (csfErr) {
          console.error("[creators] CSF fallback read failed:", csfErr.message);
        }
      }
      sendJson(res, { error: "Creator not found" }, 404);
      return true;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      sendJson(res, { error: "Failed to parse creator profile" }, 500);
      return true;
    }
    sendJson(res, { creator: data, source: "json" });
    return true;
  }

  // POST /api/creators — save or update a creator profile
  if (url.pathname === "/api/creators" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      if (!body.slug || !/^[a-z0-9-]+$/.test(body.slug)) {
        sendJson(res, { error: "Invalid or missing slug (lowercase letters, numbers, hyphens only)" }, 400);
        return true;
      }
      ensureDir();
      const filePath = path.join(creatorsDir, `${body.slug}.json`);
      const record = { ...body, ingestedAt: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");

      // Persist into the user's personal CSF archive (data/profiles/<slug>.csf,
      // gitignored) so the profile's PII lives in the durable personal store and
      // not only in the loose JSON. Best-effort: a missing python/csf toolchain
      // must not fail the save.
      let csf;
      try {
        const log = await packPersonalCsf(repoRoot, body.slug);
        csf = { archive: `data/profiles/${body.slug}.csf`, log };
      } catch (csfErr) {
        console.error("[creators] personal CSF pack failed:", csfErr.message);
        csf = { error: csfErr.message };
      }

      sendJson(res, { saved: true, slug: body.slug, creator: record, csf });
    } catch (err) {
      sendJson(res, { error: err.message }, 400);
    }
    return true;
  }

  return false;
};
