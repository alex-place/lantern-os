const fs = require("fs");
const path = require("path");
const { readJson, readText } = require("./file-queue");
const { getPowerShellCommand } = require("./powershell");

const repoRoot = path.resolve(__dirname, "..", "..");
const cloudMirrorsPath = path.join(repoRoot, "manifests", "cloud-mirrors.json");
const port = Number(process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177);
const host = process.env.LANTERN_GARAGE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

function getReadiness() {
  return readJson("manifests/validation/DUAL-BOOT-PREP-LATEST.json", null)
    || readJson("data/dual-boot/latest-readiness.json", {})
    || {};
}

// #672: mutable tunnel state, stamped by server.js when cloudflaredProcess events fire.
const _tunnelState = {
  enabled: false,
  status: "not_started",   // "not_started" | "starting" | "running" | "exited" | "error" | "disabled"
  exitCode: null,
  lastError: null,
  startedAt: null,
  exitedAt: null,
};

function setTunnelState(patch) {
  Object.assign(_tunnelState, patch);
}

function getTunnelState() {
  return { ..._tunnelState };
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
    // #672: live Cloudflare Tunnel state — updated by server.js lifecycle hooks
    cloudflare_tunnel: getTunnelState(),
    // #1049: key presence (boolean only, never expose values) so the root cause of
    // degraded mode (missing env vars in scheduled-task spawn) is immediately visible.
    api_keys: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai:    !!process.env.OPENAI_API_KEY,
      gemini:    !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      xai:       !!process.env.XAI_API_KEY,
      discord:   !!process.env.DISCORD_TOKEN,
      kalshi:    !!process.env.KALSHI_API_KEY,
    },
  };
}

function getMiningLabStatus() {
  const files = [
    "docs/ARC-REACTOR-MINING-LAB.md",
    "docs/WALLET-MATRIX-TEMPLATE.md",
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

function getActionCapabilities() {
  const powerShellCommand = getPowerShellCommand();
  const powerShellReady = Boolean(powerShellCommand);
  return {
    generatedAt: new Date().toISOString(),
    mode: "local",
    powerShellCommand,
    actions: {
      refresh: { enabled: true, kind: "real-action", reason: "GET routes are available in the Node app." },
      flatRagIngest: { enabled: true, kind: "real-action", reason: "Writes the local Flat RAG manifest only; no repo deletion." },
      notes: { enabled: true, kind: "real-action", reason: "Appends operator notes to data/operator-notes/notes.jsonl." },
      chat: { enabled: true, kind: "real-action", reason: "Appends local chat memory to data/conversations/garage-conversations.jsonl." },
      runLoop: { enabled: powerShellReady, kind: powerShellReady ? "real-action" : "held-action", reason: powerShellReady ? `PowerShell available via ${powerShellCommand}.` : "Held: PowerShell is not installed in this environment." },
      localControls: { enabled: powerShellReady, kind: powerShellReady ? "real-action" : "held-action", reason: powerShellReady ? `PowerShell available via ${powerShellCommand}.` : "Held: local controls require PowerShell on the operator machine." },
      dispatchAll: { enabled: true, kind: "real-action", reason: "MCP orchestrator active. Full agent dispatch + convergence loop + batch framework validation enabled." }
    },
    summary: {
      real: ["Refresh Status", "Ingest Repos", "Auto Update", "+ Note", "Chat send", "RAG intake", "Dispatch All"],
      links: ["Health", "Status JSON", "Access Model", "Mirror JSON", "Readiness Gates", "Evidence Method", "Open Issues"],
      held: powerShellReady
        ? []
        : ["Converge Loop held: PowerShell missing.", "Local Controls held: operator-machine PowerShell required."]
    }
  };
}

function getOperatorFeedbackMemory() {
  const { readJsonl } = require("./file-queue");
  const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
  const notes = readJsonl(path.relative(repoRoot, operatorNotesPath), 50).filter((note) => !note.parseError);
  const feedback = [];
  for (const note of notes) {
    const text = String(note.text || "").trim();
    const lower = text.toLowerCase();
    if (lower.includes("button") || lower.includes("fake")) {
      feedback.push({
        id: "OPERATOR-BUTTON-TRUTH",
        priority: note.priority || "P1",
        source: path.relative(repoRoot, operatorNotesPath),
        feedback: text,
        appliedAs: "Every first-screen control is classified as real-action, live-link, held-action, or founder-held; unavailable held buttons are disabled."
      });
    }
    if (lower.includes("tony") || lower.includes("garage") || lower.includes("orion")) {
      feedback.push({
        id: "OPERATOR-ORION-GARAGE",
        priority: note.priority || "P0",
        source: path.relative(repoRoot, operatorNotesPath),
        feedback: text,
        appliedAs: "Dashboard keeps the limestone/grid Orion cockpit style, redirects retired Tony Garage, and shows one canonical local URL."
      });
    }
  }
  feedback.push({
    id: "RESTART-EXTERNAL-MEMORY",
    priority: "P1",
    source: "data/context/RESTART-TEMPLATE-2026-05-29.md",
    feedback: "Use external memory files and complete targeted dashboard integration before expanding.",
    appliedAs: "Dashboard now exposes memory feedback and action capabilities as first-class API-backed panels."
  });
  return {
    generatedAt: new Date().toISOString(),
    feedback,
    boundary: "Operator feedback memory is read from local notes and context receipts; private details are summarized, not exposed as secrets."
  };
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

module.exports = {
  getStatus,
  getReadiness,
  getMiningLabStatus,
  getActionCapabilities,
  getOperatorFeedbackMemory,
  getAccessModel,
  getCloudMirrorStatus,
  parseMirrorEnv,
  setTunnelState,
  getTunnelState,
};
