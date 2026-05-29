const http = require("http");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const publicRoot = path.join(__dirname, "public");
const port = Number(process.env.PORT || process.env.LANTERN_GARAGE_PORT || 10000);
const host = process.env.HOST || "0.0.0.0";
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");

function readJson(relativePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function readJsonl(relativePath, limit = 20) {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try { return JSON.parse(line); } catch { return { parseError: true, raw: line }; }
      });
  } catch {
    return [];
  }
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
  let title = path.basename(sourcePath);

  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };

  lines.forEach((line) => {
    if (/^```/.test(line.trim())) {
      closeList();
      body.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      return;
    }
    if (inCode) {
      body.push(`${escapeHtml(line)}\n`);
      return;
    }
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

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, text, status = 200, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function sendHtml(res, html, status = 200) {
  sendText(res, html, status, "text/html; charset=utf-8");
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
  }[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(data);
  });
}

function getStatus() {
  const arc = readJson("data/arc-reactor/status.json", {});
  const wallet = readJson("data/wallet/local-cash-wallet.json", {});
  const readiness = readJson("manifests/validation/DUAL-BOOT-PREP-LATEST.json", {});
  return {
    generatedAt: new Date().toISOString(),
    app: "Lantern Garage",
    mode: "render_public_static",
    boundary: "Public Render mode serves safe program pages and read-only status only. Local MCP, local controls, and agent dispatch stay local-held.",
    arc,
    wallet: {
      clearedCashUsd: wallet.clearedCashUsd ?? 0,
      pendingInvoiceUsd: wallet.pendingInvoiceUsd ?? 0,
      pendingInvoices: wallet.pendingInvoices ?? [],
    },
    controls: {
      dashboardOk: false,
      mcpOk: false,
      accessXExists: false,
      boundary: "local_only_not_available_on_render",
    },
    readiness,
  };
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
  return {
    ready: present.every((item) => item.exists),
    mode: "render_read_only",
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

function getCloudMirrorStatus(reqHost = "") {
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
    });

  return {
    generatedAt: new Date().toISOString(),
    localPrimary: "http://127.0.0.1:4177",
    renderHost: reqHost,
    deployBranch: manifest.deployBranch || "master",
    deployProvider: manifest.deployProvider || "Render",
    mirrorPolicy: manifest.mirrorPolicy || "Local is primary; cloud URLs are mirrors and must not create separate dashboards.",
    cloudMirrorCount: cloudMirrors.length,
    cloudMirrors,
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    sendJson(res, { ok: true, service: "lantern-garage", mode: "render", generatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/status") {
    sendJson(res, getStatus());
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
    sendJson(res, getCloudMirrorStatus(req.headers.host || ""));
    return;
  }

  if (url.pathname === "/api/rag-cache") {
    sendJson(res, readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 50));
    return;
  }

  if (url.pathname === "/api/conversations") {
    sendJson(res, { path: "render_public_static", conversations: [] });
    return;
  }

  if (url.pathname === "/api/flat-rag-house") {
    sendJson(res, {
      generatedAt: new Date().toISOString(),
      purpose: "Render-safe public Lantern OS surface.",
      boundary: "No local source repo or MCP access from Render.",
      sources: [],
      ragRecordCount: readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 200).length,
      windowsSurface: { host: "render", defaultBootMutation: "blocked" },
    });
    return;
  }

  if (url.pathname === "/api/operator-queue") {
    sendJson(res, { items: [], generatedAt: new Date().toISOString(), boundary: "local orchestrator queue is not exposed on Render" });
    return;
  }

  if (url.pathname.startsWith("/api/actions/")) {
    sendJson(res, {
      code: 2,
      stdout: "Action held in Render mode.",
      stderr: "Local MCP, PowerShell, local controls, and agent dispatch are local-only.",
    }, 202);
    return;
  }

  if (url.pathname === "/os") {
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  if (url.pathname === "/outreach") {
    res.writeHead(302, { Location: "/outreach.html" });
    res.end();
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

server.listen(port, host, () => {
  console.log(`Lantern Garage Render app listening on http://${host}:${port}`);
});
