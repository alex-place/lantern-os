const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const conversationLogPath = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");
const flatRagHousePath = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const flatRagHouseManifestPath = path.join(repoRoot, "manifests", "FLAT-RAG-HOUSE-LATEST.md");
const orchestratorQueueDir = path.join("C:\\Users\\alexp\\Documents\\gm-agent-orchestrator", "tasks", "queue");
const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const maxConversationTextLength = 4000;
const writeQueues = new Map();

function enqueueFileWrite(filePath, operation) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (writeQueues.get(filePath) === next) {
        writeQueues.delete(filePath);
      }
    });
  writeQueues.set(filePath, next);
  return next;
}

async function appendJsonlQueued(filePath, record) {
  const line = `${JSON.stringify(record)}\n`;
  return enqueueFileWrite(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, line, "utf8");
  });
}

async function writeTextQueued(filePath, text) {
  return enqueueFileWrite(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, text, "utf8");
  });
}

function readText(relativePath, fallback = "") {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return fallback;
  }
}

function readJson(relativePath, fallback = null) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return fallback;
  }
}

function readJsonl(relativePath, limit = 20) {
  return readText(relativePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
}

function readConversationLog(limit = 50) {
  return readJsonl(path.relative(repoRoot, conversationLogPath), limit)
    .filter((entry) => !entry.parseError);
}

function collectRequestBody(req, maxBytes = 64000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function normalizeConversationEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }

  const role = String(input.role || "operator").trim().toLowerCase();
  const allowedRoles = new Set(["operator", "lantern", "system", "note"]);
  const text = String(input.text || "").trim();
  const surface = String(input.surface || "garage").trim().slice(0, 80) || "garage";

  if (!allowedRoles.has(role)) {
    throw new Error("invalid_conversation_role");
  }
  if (!text) {
    throw new Error("conversation_text_required");
  }

  return {
    recordedAt: new Date().toISOString(),
    surface,
    role,
    text: text.slice(0, maxConversationTextLength),
  };
}

async function appendConversationEntry(entry) {
  await appendJsonlQueued(conversationLogPath, entry);
}

async function appendExternalRagItem(input) {
  const record = normalizeRagCacheItem(input);
  const cachePath = path.join(repoRoot, "data", "rag-intake", "external-llm-web-cache", "cache.jsonl");
  await appendJsonlQueued(cachePath, record);
  return record;
}

function normalizeRagCacheItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }
  const text = (value, fallback, maxLength) => String(value || fallback).trim().slice(0, maxLength);
  const allowedSourceTypes = new Set(["official_source", "web_secondary", "external_llm", "operator_asserted"]);
  const allowedDecisions = new Set(["promote", "candidate", "hold", "reject"]);
  const sourceType = text(input.sourceType, "operator_asserted", 80);
  const decision = text(input.decision, "candidate", 40);
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 0.5)));
  const claim = text(input.claim, "", 500);
  const compressedSummary = text(input.compressedSummary, claim, 1200);
  if (!claim) {
    throw new Error("rag_claim_required");
  }
  return {
    timestamp: new Date().toISOString(),
    topic: text(input.topic, "operator form intake", 160),
    claim,
    sourceUrl: text(input.sourceUrl, "", 500),
    sourceTitle: text(input.sourceTitle, "Lantern OS form intake", 220),
    sourceType: allowedSourceTypes.has(sourceType) ? sourceType : "operator_asserted",
    rightsState: "summary_only",
    evidenceClass: "operator_asserted",
    confidence,
    decision: allowedDecisions.has(decision) ? decision : "candidate",
    compressedSummary,
  };
}

function readOperatorQueue() {
  const items = [];
  // Read orchestrator queue tasks
  try {
    if (fs.existsSync(orchestratorQueueDir)) {
      const files = fs.readdirSync(orchestratorQueueDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(orchestratorQueueDir, file), "utf8").replace(/^﻿/, "");
        const title = /^#\s+(.+)/m.exec(content)?.[1] || file.replace(/\.md$/, "").replace(/-/g, " ");
        const priority = /priority:\s*(P\d)/i.exec(content)?.[1] || "P1";
        const owner = /owner:\s*(\S+)/i.exec(content)?.[1] || "unassigned";
        const blocked = /blocked.?by:\s*(.+)/i.exec(content)?.[1]?.trim() || null;
        items.push({ type: "task", file, title, priority, owner, blocked, source: "orchestrator" });
      }
    }
  } catch { /* orchestrator dir may not exist */ }
  // Read local operator notes
  const notes = readJsonl(path.relative(repoRoot, operatorNotesPath), 50).filter(n => !n.parseError);
  for (const note of notes) {
    items.push({ type: "note", title: note.text, priority: note.priority || "P2", owner: "operator", source: "local", createdAt: note.createdAt });
  }
  // Sort: P0 first, then P1, then P2, notes and tasks interleaved by priority
  items.sort((a, b) => {
    const pa = parseInt(a.priority?.replace("P", "") ?? "9");
    const pb = parseInt(b.priority?.replace("P", "") ?? "9");
    return pa - pb;
  });
  return items;
}

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
      path: "C:\\tmp\\human-flourishing-frameworks-scan",
      role: "HFF scan, COMET LEAP docs and PDFs, prior convergence evidence",
      archiveDecision: "source_evidence_only",
    },
    {
      name: "gm-agent-orchestrator",
      path: "C:\\Users\\alexp\\Documents\\gm-agent-orchestrator",
      role: "local MCP/orchestrator, agents, queue, service supervision",
      archiveDecision: "source_evidence_only",
    },
    {
      name: "ChildOfLevistus",
      path: "C:\\Users\\alexp\\Documents\\Codex\\2026-04-23-what-are-you-able-to-do\\ChildOfLevistus",
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
  const conversations = readConversationLog(20);
  return {
    generatedAt: new Date().toISOString(),
    purpose: "One flat RAG house over Lantern OS, HFF, orchestrator, and GM source repos.",
    boundary: "Read-only source ingestion. Old repos are archived by manifest status, not deleted.",
    sources,
    ragRecordCount: ragRecords.length,
    recentRagRecords: ragRecords.slice(-20),
    recentConversations: conversations,
    windowsSurface: {
      host: "Windows remains host until dual-boot install gates pass.",
      garageUrl: `http://127.0.0.1:${port}`,
      defaultBootMutation: "blocked",
    },
  };
}

async function writeFlatRagHouse() {
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

function runPowerShell(scriptRelativePath, args = []) {
  return new Promise((resolve) => {
    const scriptPath = path.join(repoRoot, scriptRelativePath);
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: repoRoot });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function getStatus() {
  const arc = readJson("data/arc-reactor/status.json", {});
  const wallet = readJson("data/wallet/local-cash-wallet.json", {});
  const controls = readJson("manifests/validation/LOCAL-CONTROLS-LATEST.json", {});
  const readiness = getReadiness();
  const v1 = readText("reports/V1-READINESS-TEST-2026-05-26.md");

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    app: "Lantern Garage",
    arc,
    wallet: {
      clearedCashUsd: wallet.clearedCashUsd ?? 0,
      pendingInvoiceUsd: wallet.pendingInvoiceUsd ?? 0,
      draftInvoiceUsd: wallet.draftInvoiceUsd ?? 0,
      pendingInvoices: wallet.pendingInvoices ?? [],
    },
    controls: {
      garageExists: controls.garageExists === true,
      accessXExists: controls.accessXExists === true,
      dashboardOk: controls.dashboard?.ok === true,
      mcpOk: controls.mcp?.ok === true,
      lanternOk: controls.lantern?.ok === true,
    },
    readiness: {
      readyForPrep: readiness.readyForPrep === true,
      readyForInstall: readiness.readyForInstall === true,
      pass: readiness.pass ?? null,
      warn: readiness.warn ?? null,
      fail: readiness.fail ?? null,
      held: readiness.held ?? null,
      summary: readiness.summary ?? "",
    },
    v1: {
      status: /Status:\s*`([^`]+)`/.exec(v1)?.[1] || "unknown",
      confidence: /Confidence:\s*`([^`]+)`/.exec(v1)?.[1] || "unknown",
    },
  };
}

function getReadiness() {
  return readJson("manifests/validation/DUAL-BOOT-PREP-LATEST.json", null)
    || readJson("data/dual-boot/latest-readiness.json", {})
    || {};
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => (
      `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    ));
}

function renderMarkdownDocument(markdown, sourcePath) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const body = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let tableRows = [];
  let title = path.basename(sourcePath);

  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      const rows = tableRows.filter((row) => !/^\s*\|?\s*:?-{3,}:?\s*\|/.test(row));
      body.push("<table>");
      rows.forEach((row, index) => {
        const cells = row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
        body.push(index === 0 ? "<thead><tr>" : "<tbody><tr>");
        cells.forEach((cell) => body.push(index === 0 ? `<th>${inlineMarkdown(cell)}</th>` : `<td>${inlineMarkdown(cell)}</td>`));
        body.push(index === 0 ? "</tr></thead>" : "</tr></tbody>");
      });
      body.push("</table>");
      tableRows = [];
      inTable = false;
    }
  };

  lines.forEach((line) => {
    if (/^```/.test(line.trim())) {
      closeList();
      closeTable();
      body.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      return;
    }
    if (inCode) {
      body.push(`${escapeHtml(line)}\n`);
      return;
    }
    if (/^\s*\|.+\|\s*$/.test(line)) {
      closeList();
      inTable = true;
      tableRows.push(line);
      return;
    }
    closeTable();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      if (level === 1) title = heading[2].trim();
      body.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }
    const listItem = /^\s*[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
      return;
    }
    if (!line.trim()) {
      closeList();
      return;
    }
    closeList();
    body.push(`<p>${inlineMarkdown(line)}</p>`);
  });
  closeList();
  closeTable();
  if (inCode) body.push("</code></pre>");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Lantern OS</title>
  <style>
    :root { color-scheme: light; --ink:#11191f; --muted:#596874; --paper:#eef4ef; --line:#bdc9c9; --arc:#08756f; --blue:#1e5f89; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family:"Segoe UI", Arial, sans-serif; }
    main { width:min(980px, calc(100% - 28px)); margin:0 auto; padding:24px 0 48px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:22px; }
    .source { color:var(--muted); font-size:0.86rem; overflow-wrap:anywhere; }
    a { color:var(--blue); font-weight:800; }
    .back { border:1px solid var(--line); padding:10px 12px; background:white; text-decoration:none; white-space:nowrap; }
    h1 { font-size:2.1rem; line-height:1.05; margin:0 0 10px; letter-spacing:0; }
    h2 { margin-top:28px; border-top:1px solid var(--line); padding-top:18px; }
    p, li { line-height:1.58; }
    code { background:white; border:1px solid var(--line); padding:1px 5px; }
    pre { background:#11191f; color:white; overflow:auto; padding:14px; }
    table { width:100%; border-collapse:collapse; background:white; margin:18px 0; }
    th, td { border:1px solid var(--line); padding:9px; vertical-align:top; }
    th { text-align:left; background:#f7faf8; color:var(--muted); text-transform:uppercase; font-size:0.78rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <div><strong>Lantern Reader</strong><div class="source">${escapeHtml(sourcePath)}</div></div>
      <a class="back" href="/">Dashboard</a>
    </header>
    ${body.join("\n")}
  </main>
</body>
</html>`;
}

function getMiningLabStatus() {
  const files = [
    "docs/ARC-REACTOR-MINING-LAB.md",
    "docs/WALLET-MATRIX-TEMPLATE.md",
    "skills/solo-mining/SKILL.md",
    "templates/hardware-intake.csv",
    "templates/wallet-matrix.csv",
    "templates/coin-feasibility.csv",
    "templates/mining-receipt.json",
    "scripts/Get-HardwareInventory.ps1",
    "scripts/Test-MiningProfitability.ps1",
    "reports/ARC-REACTOR-MINING-LAB-2026-05-29.md",
  ];
  const present = files.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(repoRoot, relativePath)),
  }));
  const ready = present.every((item) => item.exists);
  return {
    ready,
    mode: "manual_first_read_only",
    shortcutRule: "single_lantern_shortcut",
    routeSummary: {
      cpu: "XMR learning lane",
      gpu: "RVN / ETC experiment lane",
      eth: "wallet / claim checks only",
      asic: "BTC / LTC / DOGE / KAS only with owned or justified hardware",
    },
    blocked: [
      "wallet_bruteforce",
      "unauthorized_transfers",
      "hidden_transaction_signing",
      "mining_on_unowned_devices",
      "fake_roi_claims",
      "eth_mainnet_mining_claims",
    ],
    files: present,
  };
}

function parseMirrorEnv() {
  return String(process.env.LANTERN_CLOUD_MIRROR_URLS || "")
    .split(/[,\s]+/)
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url, index) => ({
      name: `env-mirror-${index + 1}`,
      url,
      role: "environment configured mirror",
      status: "configured",
      healthPath: "/api/health",
      source: "LANTERN_CLOUD_MIRROR_URLS",
    }));
}


function getAccessModel() {
  return {
    generatedAt: new Date().toISOString(),
    audienceTarget: "dozens_of_users",
    activeUserSoftCap: 48,
    authBoundary: "This is an access contract for the dashboard surface. Real identity, billing, and founder authorization must be wired before private or paid actions leave local mode.",
    tiers: [
      {
        id: "public",
        label: "Public",
        priceUsdMonthly: null,
        authRequired: false,
        summary: "Always-on public proof, health checks, public reports, cloud mirrors, and safe documentation.",
        features: ["/api/health", "/api/status", "public PDFs", "read-only readiness"]
      },
      {
        id: "auth_0",
        label: "$0 Auth",
        priceUsdMonthly: 0,
        authRequired: true,
        summary: "Free signed-in workspace for saved notes, RAG intake, and user preference continuity.",
        features: ["saved notes", "RAG intake", "workspace continuity"]
      },
      {
        id: "auth_20",
        label: "$20 Auth",
        priceUsdMonthly: 20,
        authRequired: true,
        summary: "Supporter workspace for queue visibility, report packets, and a weekly operator digest.",
        features: ["queue visibility", "report packets", "weekly digest"]
      },
      {
        id: "auth_200",
        label: "$200 Auth",
        priceUsdMonthly: 200,
        authRequired: true,
        summary: "Pilot workspace for guided cleanup sessions, report review, and direct operator scheduling.",
        features: ["pilot review", "cleanup session", "operator scheduling"]
      },
      {
        id: "founder",
        label: "Founder",
        priceUsdMonthly: null,
        authRequired: true,
        founderOnly: true,
        summary: "Founder-only controls for local dispatch, release promotion, secrets, billing setup, and boot-sensitive decisions.",
        features: ["local controls", "agent dispatch", "release gates", "private receipts"]
      }
    ]
  };
}

function getCloudMirrorStatus() {
  const manifest = readJson(path.relative(repoRoot, cloudMirrorsPath), {});
  const manifestMirrors = Array.isArray(manifest.cloudMirrors) ? manifest.cloudMirrors : [];
  const envMirrors = parseMirrorEnv();
  const seen = new Set();
  const cloudMirrors = [...manifestMirrors, ...envMirrors]
    .filter((mirror) => mirror && typeof mirror.url === "string" && mirror.url.startsWith("https://"))
    .filter((mirror) => {
      if (seen.has(mirror.url)) return false;
      seen.add(mirror.url);
      return true;
    })
    .map((mirror) => ({
      name: String(mirror.name || "cloud mirror").slice(0, 80),
      url: mirror.url,
      role: String(mirror.role || "cloud mirror").slice(0, 160),
      status: String(mirror.status || "configured").slice(0, 80),
      healthPath: String(mirror.healthPath || "/api/health").slice(0, 120),
      source: String(mirror.source || "manifests/cloud-mirrors.json").slice(0, 160),
    }));

  return {
    generatedAt: new Date().toISOString(),
    localPrimary: `http://127.0.0.1:${port}`,
    activeHost: host,
    activePort: port,
    deployBranch: manifest.deployBranch || "master",
    deployProvider: manifest.deployProvider || "Render",
    mirrorPolicy: manifest.mirrorPolicy || "Local is primary; cloud URLs are mirrors and must not create separate dashboards.",
    cloudMirrorCount: cloudMirrors.length,
    cloudMirrors,
  };
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
  }[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(html);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, { ok: true, service: "lantern-garage", generatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/status") {
    sendJson(res, getStatus());
    return;
  }

  if (url.pathname === "/api/arc-reactor") {
    sendJson(res, readJson("data/arc-reactor/status.json", {}));
    return;
  }

  if (url.pathname === "/api/wallet") {
    sendJson(res, {
      wallet: readJson("data/wallet/local-cash-wallet.json", {}),
      ledger: readJsonl("data/wallet/ledger.jsonl", 30),
    });
    return;
  }

  if (url.pathname === "/api/readiness") {
    sendJson(res, getReadiness());
    return;
  }

  if (url.pathname === "/api/mining-lab") {
    sendJson(res, getMiningLabStatus());
    return;
  }

  if (url.pathname === "/api/access-model") {
    sendJson(res, getAccessModel());
    return;
  }

  if (url.pathname === "/api/cloud-mirrors") {
    sendJson(res, getCloudMirrorStatus());
    return;
  }

  if (url.pathname === "/api/rag-cache" && req.method === "GET") {
    sendJson(res, readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 50));
    return;
  }

  if (url.pathname === "/api/rag-cache" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const record = await appendExternalRagItem(JSON.parse(body || "{}"));
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/flat-rag-house") {
    sendJson(res, fs.existsSync(flatRagHousePath)
      ? readJson(path.relative(repoRoot, flatRagHousePath), buildFlatRagHouse())
      : buildFlatRagHouse());
    return;
  }

  if (url.pathname === "/api/operator-queue") {
    sendJson(res, { items: readOperatorQueue(), generatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/operator-notes" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const input = JSON.parse(body || "{}");
      const text = String(input.text || "").trim().slice(0, 500);
      const priority = ["P0", "P1", "P2"].includes(input.priority) ? input.priority : "P1";
      if (!text) throw new Error("note_text_required");
      const record = { createdAt: new Date().toISOString(), text, priority, done: false };
      await appendJsonlQueued(operatorNotesPath, record);
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/conversations" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
    sendJson(res, {
      path: path.relative(repoRoot, conversationLogPath),
      conversations: readConversationLog(limit),
    });
    return;
  }

  if (url.pathname === "/api/conversations" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const entry = normalizeConversationEntry(JSON.parse(body || "{}"));
      await appendConversationEntry(entry);
      sendJson(res, { ok: true, entry }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return;
  }

  if (url.pathname === "/api/actions/run-loop" && req.method === "POST") {
    const result = await runPowerShell("scripts/Invoke-LanternConvergenceLoop.ps1");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/local-controls" && req.method === "POST") {
    const result = await runPowerShell("scripts/Start-LanternLocalControls.ps1");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return;
  }

  if (url.pathname === "/api/actions/flat-rag-ingest" && req.method === "POST") {
    const house = await writeFlatRagHouse();
    sendJson(res, {
      code: 0,
      stdout: `Flat RAG house updated: ${path.relative(repoRoot, flatRagHousePath)}`,
      stderr: "",
      house,
    });
    return;
  }

  if (url.pathname.startsWith("/repo/")) {
    const relative = decodeURIComponent(url.pathname.replace(/^\/repo\//, ""));
    const target = path.resolve(repoRoot, relative);
    if (!target.startsWith(repoRoot)) {
      sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    sendFile(res, target);
    return;
  }

  if (url.pathname === "/view") {
    const relative = decodeURIComponent(url.searchParams.get("path") || "");
    const target = path.resolve(repoRoot, relative);
    if (!relative || !target.startsWith(repoRoot)) {
      sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    if (!fs.existsSync(target)) {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }
    if (path.extname(target).toLowerCase() === ".md") {
      sendHtml(res, renderMarkdownDocument(fs.readFileSync(target, "utf8"), relative));
      return;
    }
    sendFile(res, target);
    return;
  }

  const staticPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = path.resolve(publicRoot, staticPath);
  if (!target.startsWith(publicRoot)) {
    sendJson(res, { error: "forbidden" }, 403);
    return;
  }
  sendFile(res, target);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => sendJson(res, { error: error.message }, 500));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Lantern Garage port ${port} is already in use. Open http://127.0.0.1:${port} or choose another port.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Lantern Garage app listening on ${host}:${port}`);
});
