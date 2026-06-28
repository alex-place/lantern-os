const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readJsonl } = require("./file-queue");
const { RepoIndexer } = require("../../lib/repo-indexer");

const repoRoot = path.resolve(__dirname, "..", "..");
const flatRagHousePath = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");

function repoSources() {
  return [
    {
      name: "lantern-os",
      path: repoRoot,
      role: "control plane, RAG house, Garage app, release surface",
      archiveDecision: "keep_canonical",
    },
    {
      name: "human-flourishing-frameworks",
      path: process.env.HFF_REPO_PATH || path.join(repoRoot, "..", "human-flourishing-frameworks-scan"),
      role: "HFF scan, COMET LEAP docs and PDFs, prior convergence evidence",
      archiveDecision: "source_evidence_only",
    },
    {
      name: "ChildOfLevistus",
      path: process.env.CHILD_OF_LEVISTUS_PATH || path.join(repoRoot, "..", "ChildOfLevistus"),
      role: "GameMaker game source and GM validation lane",
      archiveDecision: "source_evidence_only",
    },
  ];
}

function runGit(repoPath, args) {
  if (!fs.existsSync(repoPath)) {
    return { ok: false, output: "", error: "path_missing" };
  }
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    output: (result.stdout || "").trim(),
    error: (result.stderr || "").trim(),
  };
}

function inspectSourceRepo(source) {
  const branch = runGit(source.path, ["branch", "--show-current"]);
  const remote = runGit(source.path, ["remote", "get-url", "origin"]);
  const head = runGit(source.path, ["rev-parse", "--short=12", "HEAD"]);
  const status = runGit(source.path, ["status", "--short"]);
  const files = fs.existsSync(source.path)
    ? fs.readdirSync(source.path).slice(0, 24)
    : [];

  return {
    ...source,
    exists: fs.existsSync(source.path),
    branch: branch.output || "unknown",
    remote: remote.output || "",
    head: head.output || "",
    dirty: Boolean(status.output),
    statusShort: status.output,
    topLevelFiles: files,
  };
}

function buildFlatRagHouse() {
  const sources = repoSources().map(inspectSourceRepo);
  const ragRecords = readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 200)
    .filter((entry) => !entry.parseError);
  const { readConversationLog } = require("./conversation-store");
  const conversations = readConversationLog(20);
  return {
    generatedAt: new Date().toISOString(),
    purpose: "One flat RAG house over Lantern OS, HFF, and GM source repos.",
    boundary: "Read-only source ingestion. Old repos are archived by manifest status, not deleted.",
    sources,
    ragRecordCount: ragRecords.length,
    recentRagRecords: ragRecords.slice(-20),
    recentConversations: conversations,
    windowsSurface: {
      host: "Windows remains host until dual-boot install gates pass.",
      garageUrl: `http://127.0.0.1:${process.env.LANTERN_GARAGE_PORT || 4177}`,
      defaultBootMutation: "blocked",
    },
  };
}

async function writeFlatRagHouse() {
  const { writeTextQueued } = require("./file-queue");
  const house = buildFlatRagHouse();
  await Promise.all([
    writeTextQueued(flatRagHousePath, `${JSON.stringify(house, null, 2)}\n`),
    writeTextQueued(flatRagHouseManifestPath, renderFlatRagHouseManifest(house)),
  ]);
  return house;
}

function renderFlatRagHouseManifest(house) {
  const rows = house.sources.map((source) => (
    `| ${source.name} | ${source.branch} | ${source.dirty ? "dirty" : "clean"} | ${source.archiveDecision} | ${source.role} |`
  )).join("\n");
  return `# Flat RAG House Latest

Generated: ${house.generatedAt}

Status: local read-only merge surface.

Boundary: ${house.boundary}

## Sources

| Source | Branch | State | Archive Decision | Role |
|---|---|---|---|---|
${rows}

## Counts

- RAG records: ${house.ragRecordCount}
- Recent local conversations: ${house.recentConversations.length}

## Launch

Lantern OS Garage: ${house.windowsSurface.garageUrl}

Default boot mutation: ${house.windowsSurface.defaultBootMutation}
`;
}

module.exports = {
  repoSources,
  inspectSourceRepo,
  buildFlatRagHouse,
  writeFlatRagHouse,
  renderFlatRagHouseManifest,
};
