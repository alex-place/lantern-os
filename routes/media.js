// Media streaming route for Creator Dashboard videos and thumbnails
// Handles serving video files with range request support for seeking

module.exports = async function mediaRoutes(req, res, url, deps) {
  const { path: pathModule, repoRoot } = deps;
  const fs = require("fs");
  const { handleVideoStream } = require("../lib/video-streaming");

  // Pattern: /media/data/creator/entries/.../video.mp4
  // Pattern: /media/data/creator/entries/.../thumbnail.jpg
  const mediaMatch = url.pathname.match(/^\/media\/(.+)$/);
  if (mediaMatch && req.method === "GET") {
    try {
      const relativePath = decodeURIComponent(mediaMatch[1]);
      const fullPath = pathModule.join(repoRoot, relativePath);

      // Security: Ensure path doesn't escape the repo root
      const relative = pathModule.relative(repoRoot, fullPath);
      if (relative.startsWith("..")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return true;
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not found");
        return true;
      }

      // Determine file type
      const ext = pathModule.extname(fullPath).toLowerCase();
      const isVideo = [".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext);
      const isImage = [".jpg", ".jpeg", ".png", ".gif"].includes(ext);

      if (isVideo) {
        // Use streaming handler for videos
        handleVideoStream(req, res, fullPath);
        return true;
      } else if (isImage) {
        // Serve images with appropriate headers
        let mimeType = "image/jpeg";
        if (ext === ".png") mimeType = "image/png";
        else if (ext === ".gif") mimeType = "image/gif";

        const stat = fs.statSync(fullPath);
        res.writeHead(200, {
          "Content-Type": mimeType,
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=3600",
        });

        const stream = fs.createReadStream(fullPath);
        stream.pipe(res);
        return true;
      } else {
        // Unsupported file type
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported file type");
        return true;
      }
    } catch (error) {
      console.error("[media] Error serving file:", error.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
      return true;
    }
  }

  return false;
};
