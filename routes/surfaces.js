// Hub, surfaces directory, and static file catch-all
const { isSurfaceAllowed } = require("../lib/deployment-profile");
module.exports = async function surfaceRoutes(req, res, url, deps) {
  const { fs, path, sendJson, sendFile, repoRoot, publicRoot, __dirname: dir } = deps;

  if (url.pathname === "/hub") {
    // Hub redirects to home
    res.writeHead(302, { Location: "/" });
    res.end();
    return true;
  }

  if (url.pathname.startsWith("/surfaces/")) {
    const surfacesRoot = path.resolve(dir, "../../surfaces");
    const surfacePath = url.pathname.slice("/surfaces/".length) || "index.html";
    const target = path.resolve(surfacesRoot, surfacePath);
    if (target.startsWith(surfacesRoot)) { sendFile(res, target); return true; }
  }

  // Static file catch-all
  let staticPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (staticPath.endsWith("/")) staticPath += "index.html";
  const target = path.resolve(publicRoot, staticPath);
  if (!target.startsWith(publicRoot)) { sendJson(res, { error: "forbidden" }, 403); return true; }
  // Cloud profile (ADR-0018 W4): serve only the hosted subset of top-level *.html
  // surfaces; bounce everything else to the hosted home. Assets (js/css/img/media in
  // subdirs) always pass so allowed pages still render. No-op in the local profile.
  if (/^[^/]+\.html$/.test(staticPath) && !isSurfaceAllowed(staticPath)) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return true;
  }
  // #1946 desktop: inject the window-heartbeat into served HTML so the app quits
  // itself when the window closes (lib/desktop-heartbeat). Non-desktop streams as-is.
  const hb = require("../lib/desktop-heartbeat");
  if (hb.enabled && /\.html?$/i.test(target)) {
    fs.readFile(target, "utf8", (err, html) => {
      if (err) { sendJson(res, { error: "not_found" }, 404); return; }
      const body = hb.injectHeartbeat(html);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req && req.method === "HEAD" ? undefined : body);
    });
    return true;
  }
  sendFile(res, target, req); // pass req so media (e.g. /radio/*.mp3) supports Range/seek + HEAD
  return true;
};
