const fs = require("fs");
const file = "c:\\Users\\alexp\\OneDrive\\Documents\\GitHub\\lantern-os\\apps\\lantern-garage\\server.js";
const lines = fs.readFileSync(file, "utf8").split("\n");

// Fix lines 416-420 (0-indexed: 415-419)
lines[415] = '  if ((url.pathname === "/api/dream/stream" && req.method === "GET") ||';
lines[416] = '      (url.pathname === "/api/dream/chat/stream" && req.method === "POST")) {';
lines[417] = '    await handleStreamChat(req, url, res);';
lines[418] = '    return;';
lines[419] = '  }';

fs.writeFileSync(file, lines.join("\n"), "utf8");
console.log("Fixed lines");
