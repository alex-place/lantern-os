const http = require("http");
const { buildReviewDoor } = require("./review-door");

const port = Number(process.env.LANTERN_REVIEW_DOOR_PORT || 4181);
const host = process.env.LANTERN_REVIEW_DOOR_HOST || "127.0.0.1";

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, {
      ok: true,
      service: "lantern-review-door",
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/review-door") {
    try {
      sendJson(res, buildReviewDoor());
    } catch (error) {
      sendJson(res, {
        error: "review_door_failed",
        message: error.message,
      }, 500);
    }
    return;
  }

  sendJson(res, {
    error: "not_found",
    routes: ["/api/health", "/api/review-door"],
  }, 404);
}

const server = http.createServer(route);
server.listen(port, host, () => {
  console.log(`Lantern Review Door listening at http://${host}:${port}`);
});
