const fs = require("fs");
const path = require("path");
const filePath = path.resolve("c:\\Users\\alexp\\OneDrive\\Documents\\GitHub\\lantern-os\\apps\\lantern-garage\\server.js");
const content = fs.readFileSync(filePath, "utf8");
const lines = content.split("\n");

const routeIndex = lines.findIndex((l) => l.startsWith("async function route"));
if (routeIndex === -1) {
  console.error("Could not find route function");
  process.exit(1);
}

const tail = lines.slice(routeIndex).join("\n");

const head = `const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  sendJson, sendFile, sendHtml, collectRequestBody,
} = require("./lib/http-utils");
const {
  readJson, readJsonl, appendJsonlQueued,
} = require("./lib/file-queue");
const {
  getStatus, getReadiness, getMiningLabStatus, getActionCapabilities,
  getOperatorFeedbackMemory, getAccessModel, getCloudMirrorStatus,
} = require("./lib/status");
const {
  readConversationLog, normalizeConversationEntry, appendConversationEntry,
  appendExternalRagItem, readOperatorQueue,
} = require("./lib/conversation-store");
const {
  buildFlatRagHouse, writeFlatRagHouse,
} = require("./lib/rag-house");
const { runPowerShell } = require("./lib/powershell");
const { renderMarkdownDocument } = require("./lib/markdown-render");
const {
  normalizeDreamerUser, dreamerNotebookPath, appendDreamerEntry,
  readDreamerNotebook, readRecentDreams,
} = require("./lib/dreamer-store");
const {
  dreamChatReply, AGENT_PERSONAS, DREAM_DOORS, selectAgent,
} = require("./lib/dream-chat");
const {
  unifiedAgentGreet, unifiedAgentHealth, unifiedAgentInspect,
} = require("./lib/unified-agent");
const { handleStreamChat } = require("./lib/stream-chat");

const repoRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const conversationLogPath = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");
const flatRagHousePath = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");
const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const maxConversationTextLength = 4000;
const maxDreamerTextLength = 2000;

`;

fs.writeFileSync(filePath, head + tail, "utf8");
console.log("Rewrote server.js, kept route onward from line " + routeIndex);
