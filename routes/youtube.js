/**
 * YouTube channel route — Lantern's own channel (@lantern1975 / "lanternYT").
 *
 *   GET /api/youtube/lantern-videos
 *     → { channel, channelUrl, featured, count, videos:[{id,title,url,featured}] }
 *
 * Scrapes the channel's /videos page for the current upload list (no API key),
 * resolves titles via oEmbed, and caches in memory ~30 min. Falls back to a
 * verified baked list if the network is unavailable, so Explore always renders.
 * The featured video (Gage's canon piece) is placed in the centre of the list.
 */

const https = require("https");

const CHANNEL_ID = "UCSJmngRa4YpqX0Ow1P_5XLQ";
const CHANNEL_HANDLE = "@lantern1975";
const CHANNEL_NAME = "lanternYT";
const FEATURED_ID = "_bjDjkQsTs0"; // Gage's canon piece — kept centred
const CACHE_TTL_MS = 30 * 60 * 1000;

// Baked fallback (verified 2026-06-17 via oEmbed) — used only if the scrape fails.
const FALLBACK = [
  { id: "_bjDjkQsTs0", title: "playing doom 1 half playthrough [lantern gaming]" },
  { id: "20t9zSUXhhw", title: "learning Mario [lantern gaming]" },
];

let cache = { at: 0, data: null };

function httpGet(target) {
  return new Promise((resolve, reject) => {
    const req = https.get(target, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(7000, () => req.destroy(new Error("timeout")));
  });
}

async function oembedTitle(id) {
  try {
    const r = await httpGet(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`
    );
    if (r.status === 200) return JSON.parse(r.body).title || null;
  } catch {
    /* fall through to id */
  }
  return null;
}

async function fetchChannelVideos() {
  const r = await httpGet(`https://www.youtube.com/channel/${CHANNEL_ID}/videos`);
  if (r.status !== 200) throw new Error("channel fetch " + r.status);
  const seen = new Set();
  const ids = [];
  const re = /"videoId":"([0-9A-Za-z_-]{11})"/g;
  let m;
  while ((m = re.exec(r.body))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  if (!ids.length) throw new Error("no videos parsed");
  const titles = await Promise.all(ids.map(oembedTitle));
  return ids.map((id, i) => ({ id, title: titles[i] || id }));
}

// Place the featured video in the centre of the list.
function centreFeatured(videos) {
  const feat = videos.find((v) => v.id === FEATURED_ID);
  const rest = videos.filter((v) => v.id !== FEATURED_ID);
  if (!feat) return videos.slice();
  const mid = Math.floor(rest.length / 2);
  return [...rest.slice(0, mid), { ...feat, featured: true }, ...rest.slice(mid)];
}

// Producer: cache-aware fetch of the channel video list. Reused by the route
// below AND by the Explore feed aggregator (lib/explore-feed.js).
async function load() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;

  let videos;
  try {
    videos = await fetchChannelVideos();
  } catch (e) {
    videos = FALLBACK.slice();
  }

  const data = {
    channel: CHANNEL_NAME,
    channelUrl: `https://www.youtube.com/${CHANNEL_HANDLE}`,
    featured: FEATURED_ID,
    count: videos.length,
    videos: centreFeatured(videos).map((v) => ({
      ...v,
      url: `https://www.youtube.com/watch?v=${v.id}`,
    })),
    fetchedAt: new Date(now).toISOString(),
  };
  cache = { at: now, data };
  return data;
}

module.exports = async function youtubeRoute(req, res, url, deps) {
  const { sendJson } = deps;
  if (url.pathname !== "/api/youtube/lantern-videos" || req.method !== "GET") return false;
  sendJson(res, await load(), 200);
  return true;
};

module.exports.load = load;
