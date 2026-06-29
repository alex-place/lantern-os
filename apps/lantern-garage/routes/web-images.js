/**
 * Web Image Proxy Route
 *
 * GET /api/web-image?url={encodeURIComponent(url)}  — fetch and proxy image from web
 * GET /api/image-search?q={query}  — search for images on the web
 * POST /api/dream/image  — send image URL to dream chat (SSE stream)
 */

const https = require("https");
const http = require("http");

const ALLOWED_DOMAINS = [
  "unsplash.com",
  "pexels.com",
  "pixabay.com",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "raw.githubusercontent.com",
  "imgur.com",
  "giphy.com",
  "wikipedia.org",
];

function isAllowedDomain(url) {
  try {
    const urlObj = new URL(url);
    return ALLOWED_DOMAINS.some((d) => urlObj.hostname.includes(d));
  } catch {
    return false;
  }
}

module.exports = function webImageRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  // Proxy image from URL with safety checks
  if (req.method === "GET" && url.pathname === "/api/web-image") {
    const imageUrl = url.searchParams.get("url");

    if (!imageUrl) {
      sendJson(res, { error: "Missing url parameter" }, 400);
      return true;
    }

    if (!isAllowedDomain(imageUrl)) {
      sendJson(
        res,
        { error: "Domain not allowed. Supported: unsplash, pexels, pixabay, wikimedia, github, imgur, giphy" },
        403
      );
      return true;
    }

    // Fetch the image
    const protocol = imageUrl.startsWith("https") ? https : http;
    protocol
      .get(imageUrl, { timeout: 10000 }, (imgRes) => {
        if (imgRes.statusCode !== 200) {
          sendJson(res, { error: `Image fetch failed: ${imgRes.statusCode}` }, imgRes.statusCode);
          return;
        }

        // Copy image headers
        const contentType = imgRes.headers["content-type"] || "image/jpeg";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });

        // Stream the image
        imgRes.pipe(res);
      })
      .on("error", (err) => {
        sendJson(res, { error: `Failed to fetch image: ${err.message}` }, 500);
      });

    return true;
  }

  // Real image SEARCH (#1343): return an actual photo of a specific subject, not a
  // random stock photo. Wikimedia Commons is keyless and reliable for real subjects
  // (landmarks, public figures, products), so it leads; if it has nothing, we report
  // empty so the caller can fall back to its generate chain.
  if (req.method === "GET" && url.pathname === "/api/image-search") {
    const query = url.searchParams.get("q");

    if (!query) {
      sendJson(res, { error: "Missing q parameter" }, 400);
      return true;
    }

    // Wikimedia Commons file search: generator=search over the File namespace (6),
    // returning a thumbnail URL for the top hit. No API key required.
    const wmUrl =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo" +
      "&iiprop=url&iiurlwidth=768&generator=search&gsrnamespace=6&gsrlimit=3" +
      "&gsrsearch=" + encodeURIComponent(query);

    const reqOpts = {
      headers: {
        // Wikimedia's User-Agent policy requires a descriptive UA or requests 403.
        "User-Agent": "LanternOS/1.0 (https://lantern-os.net; keystone image search)",
        Accept: "application/json",
      },
      timeout: 6000,
    };

    https
      .get(wmUrl, reqOpts, (apiRes) => {
        let data = "";
        apiRes.on("data", (chunk) => (data += chunk));
        apiRes.on("end", () => {
          try {
            const json = JSON.parse(data);
            const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
            // Prefer the best-ranked hit that actually has a raster thumbnail.
            const sorted = pages.sort((a, b) => (a.index || 0) - (b.index || 0));
            for (const p of sorted) {
              const info = p.imageinfo && p.imageinfo[0];
              const u = info && (info.thumburl || info.url);
              if (u && /\.(jpe?g|png|gif|webp)$/i.test(u)) {
                sendJson(res, { url: u, source: "Wikimedia Commons", title: p.title || query });
                return;
              }
            }
            sendJson(res, {}); // no real photo found → caller falls back
          } catch {
            sendJson(res, {});
          }
        });
      })
      .on("error", () => sendJson(res, {}))
      .on("timeout", function () {
        this.destroy();
        sendJson(res, {});
      });

    return true;
  }

  return false;
};
