// Library route — serves the Knowledge Center PDF library index.
//
// GET /api/library/list -> the prebuilt index.json (thumbnails + /repo/ PDF urls)
// produced by scripts/build_library_thumbs.py. PDFs themselves are served by the
// existing /repo/<path> handler (routes/files.js); this route only lists them.
module.exports = async function libraryRoutes(req, res, url, deps) {
  const { fs, path, sendJson, publicRoot } = deps;

  if (url.pathname !== "/api/library/list") return false;

  const indexPath = path.join(publicRoot, "library-thumbs", "index.json");
  try {
    if (fs.existsSync(indexPath)) {
      const entries = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      sendJson(res, { count: entries.length, entries });
    } else {
      sendJson(res, {
        count: 0, entries: [],
        note: "index missing — run: python scripts/build_library_thumbs.py",
      });
    }
  } catch (e) {
    sendJson(res, { error: e.message, count: 0, entries: [] }, 500);
  }
  return true;
};
