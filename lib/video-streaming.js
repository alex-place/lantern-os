// Video streaming handler for Creator Dashboard media files
// Handles range requests for efficient video playback

const fs = require("fs");
const path = require("path");

/**
 * Handle HTTP video streaming with range request support
 * @param {Object} req - Node HTTP request
 * @param {Object} res - Node HTTP response
 * @param {string} videoPath - Full path to video file
 */
function handleVideoStream(req, res, videoPath) {
  // Check if file exists
  if (!fs.existsSync(videoPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Video file not found");
    return;
  }

  // Get file stats
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;

  // Get MIME type
  const ext = path.extname(videoPath).toLowerCase();
  let mimeType = "video/mp4";
  if (ext === ".mov") mimeType = "video/quicktime";
  else if (ext === ".avi") mimeType = "video/x-msvideo";
  else if (ext === ".mkv") mimeType = "video/x-matroska";
  else if (ext === ".webm") mimeType = "video/webm";

  // Handle range requests (for seeking)
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, {
        "Content-Range": `bytes */${fileSize}`,
        "Content-Type": mimeType,
      });
      res.end();
      return;
    }

    const chunksize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": chunksize,
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    });

    const stream = fs.createReadStream(videoPath, { start, end });
    stream.pipe(res);
  } else {
    // No range request - send whole file
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    });

    const stream = fs.createReadStream(videoPath);
    stream.pipe(res);
  }
}

module.exports = {
  handleVideoStream,
};
