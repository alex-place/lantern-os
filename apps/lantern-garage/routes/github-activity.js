/**
 * GitHub activity route — the project's own public repo (alex-place/lantern-os).
 *
 *   GET /api/github/activity
 *     → { repo, url, stars, releases:[{tag,name,url,date}], commits:[{sha,msg,url,date}] }
 *
 * Pulls the latest releases + recent commits from the public GitHub REST API
 * (no token needed; 60 req/hr/IP is plenty behind the 30-min cache) and caches
 * in memory. Falls back to a verified baked snapshot if the network/API is
 * unavailable, so Explore always renders. Mirrors the discipline of youtube.js.
 */

const https = require("https");

const OWNER = "alex-place";
const REPO = "lantern-os";
const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Baked fallback (verified 2026-06-21 via GitHub API) — used only if the API fails.
const FALLBACK = {
  stars: 3,
  releases: [
    { tag: "v1.2.0", name: "Dream Journal v1.2.0", url: `${REPO_URL}/releases/tag/v1.2.0`, date: null },
    { tag: "v1.1.0-rc.1", name: "Dream Journal v1.1.0-rc.1", url: `${REPO_URL}/releases/tag/v1.1.0-rc.1`, date: null },
    { tag: "v1.0.0", name: "Lantern OS v1.0.0", url: `${REPO_URL}/releases/tag/v1.0.0`, date: null },
  ],
  commits: [
    { sha: "1eb9655", msg: "fix(home): stop index.html polling dead endpoints", url: `${REPO_URL}/commit/1eb9655`, date: null },
  ],
};

let cache = { at: 0, data: null };

function httpGetJson(target) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      target,
      {
        headers: {
          "User-Agent": "lantern-os-explore",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGetJson(res.headers.location).then(resolve, reject);
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("github " + res.statusCode));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(7000, () => req.destroy(new Error("timeout")));
  });
}

async function fetchActivity() {
  const base = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const [meta, releases, commits] = await Promise.all([
    httpGetJson(base).catch(() => null),
    httpGetJson(`${base}/releases?per_page=10`).catch(() => []),
    httpGetJson(`${base}/commits?per_page=4`).catch(() => []),
  ]);

  return {
    stars: meta && typeof meta.stargazers_count === "number" ? meta.stargazers_count : FALLBACK.stars,
    releases: (Array.isArray(releases) ? releases : [])
      .filter((r) => r && !r.draft)
      .slice(0, 3)
      .map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        url: r.html_url,
        date: r.published_at || r.created_at || null,
      })),
    commits: (Array.isArray(commits) ? commits : [])
      .slice(0, 4)
      .map((c) => ({
        sha: (c.sha || "").slice(0, 7),
        msg: (c.commit && c.commit.message ? c.commit.message : "").split("\n")[0],
        url: c.html_url,
        date: c.commit && c.commit.author ? c.commit.author.date : null,
      })),
  };
}

// Producer: cache-aware fetch of repo activity. Reused by the route below AND by
// the Explore feed aggregator (lib/explore-feed.js).
async function load() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;

  let activity;
  try {
    activity = await fetchActivity();
    if (!activity.releases.length && !activity.commits.length) throw new Error("empty");
  } catch (e) {
    activity = { stars: FALLBACK.stars, releases: FALLBACK.releases, commits: FALLBACK.commits };
  }

  const data = {
    repo: `${OWNER}/${REPO}`,
    url: REPO_URL,
    ...activity,
    fetchedAt: new Date(now).toISOString(),
  };
  cache = { at: now, data };
  return data;
}

module.exports = async function githubActivityRoute(req, res, url, deps) {
  const { sendJson } = deps;
  if (url.pathname !== "/api/github/activity" || req.method !== "GET") return false;
  sendJson(res, await load(), 200);
  return true;
};

module.exports.load = load;
