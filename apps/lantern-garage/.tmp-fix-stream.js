const fs = require("fs");
const file = "c:\\Users\\alexp\\OneDrive\\Documents\\GitHub\\lantern-os\\apps\\lantern-garage\\server.js";
const content = fs.readFileSync(file, "utf8");

const startMarker = "// Dream Journal V1.0.0 — Streaming chat (strict provider mode)";
const endMarker = '  if (url.pathname === "/api/dream/stats"';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) {
  console.error("Markers not found", startIdx, endIdx);
  process.exit(1);
}

const replacement = `  if ((url.pathname === "/api/dream/stream" && req.method === "GET") ||
      (url.pathname === "/api/dream/chat/stream" && req.method === "POST")) {
    await handleStreamChat(req, url, res);
    return;
  }

`;

const newContent = content.slice(0, startIdx) + replacement + content.slice(endIdx);
fs.writeFileSync(file, newContent, "utf8");
console.log("Replaced streaming block");
