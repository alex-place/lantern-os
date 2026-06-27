const fs = require("fs");
const path = require("path");

// True once the response has begun (headers flushed) or finished. Writing to a
// response past this point throws ERR_HTTP_HEADERS_SENT. Because several of our
// senders run inside async callbacks (fs.stat in sendFile, awaited route
// handlers), that throw is uncaught and crashes the whole process. A double
// send is always a caller bug, but it must never take the server down — so the
// helpers below bail out instead of throwing. (Root-caused #stock-trader: a
// route that did `return sendJson(...)` returned undefined, the router treated
// the request as unhandled, and the static catch-all sent a second response.)
function responseClosed(res) {
  return res.headersSent || res.writableEnded;
}

function sendJson(res, data, status = 200) {
  if (responseClosed(res)) {
    console.warn(`[http-utils] sendJson skipped: response already sent (status ${status})`);
    return;
  }
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  });
  res.end(body);
}

function sendFile(res, filePath, req) {
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Audio/video — required so <audio>/<video> can decode (octet-stream +
    // nosniff makes the browser refuse the media). Keystone Radio needs .mp3.
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  }[ext] || "application/octet-stream";

  fs.stat(filePath, (error, stat) => {
    // The response may already be closed if a prior handler responded and the
    // request still fell through to the static catch-all — guard every write in
    // this async callback so a late stat never throws ERR_HTTP_HEADERS_SENT.
    if (responseClosed(res)) {
      console.warn(`[http-utils] sendFile skipped: response already sent for ${filePath}`);
      return;
    }
    if (error || !stat.isFile()) {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }
    const total = stat.size;
    // Accept-Ranges + Content-Length let <audio>/<video> seek (a media element
    // treats a resource with no byte-range support as non-seekable). Without a
    // Range request this streams the whole file, exactly as before — just with
    // a known length instead of chunked.
    const headers = {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
      "Accept-Ranges": "bytes",
    };

    if (req && req.method === "HEAD") {
      res.writeHead(200, { ...headers, "Content-Length": total });
      res.end();
      return;
    }

    const range = req && req.headers && req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": total });
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

function sendHtml(res, html, status = 200) {
  if (responseClosed(res)) {
    console.warn(`[http-utils] sendHtml skipped: response already sent (status ${status})`);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; font-src 'self' data:",
  });
  res.end(html);
}

function collectRequestBody(req, maxBytes = 64000, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const timer = setTimeout(() => {
      reject(new Error("request_body_timeout"));
      req.destroy();
    }, timeoutMs);
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        clearTimeout(timer);
        req.removeAllListeners("data");
        req.resume();
        reject(new Error("request_body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = {
  sendJson,
  sendFile,
  sendHtml,
  collectRequestBody,
};
