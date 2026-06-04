const fs = require("fs");
const file = "c:\\Users\\alexp\\OneDrive\\Documents\\GitHub\\lantern-os\\apps\\lantern-garage\\server.js";
let content = fs.readFileSync(file, "utf8");

const bad = '  }\n\n    if ((url.pathname === "/api/dream/stream" && req.method === "GET") ||\n      (url.pathname === "/api/dream/chat/stream" && req.method === "POST")) {\n    await handleStreamChat(req, url, res);\n    return;\n  }';

const good = '  }\n\n  if ((url.pathname === "/api/dream/stream" && req.method === "GET") ||\n      (url.pathname === "/api/dream/chat/stream" && req.method === "POST")) {\n    await handleStreamChat(req, url, res);\n    return;\n  }';

if (!content.includes(bad)) {
  console.error("Bad block not found");
  process.exit(1);
}

content = content.replace(bad, good);
fs.writeFileSync(file, content, "utf8");
console.log("Fixed indentation");
