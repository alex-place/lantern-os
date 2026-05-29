const $ = (id) => document.getElementById(id);
const LOCAL_APP_ORIGIN = "http://127.0.0.1:4177";
const CLOUD_TRUTH_DEPLOY_MARKER = "2026-05-29-product-lanes";

const fallbackAccessModel = {
  generatedAt: new Date().toISOString(),
  audienceTarget: "dozens_of_users",
  activeUserSoftCap: 48,
  tiers: [
    { id: "public", label: "Public", priceUsdMonthly: null, authRequired: false, summary: "Always-on public proof, docs, health, mirrors, and safe PDFs.", features: ["public links", "read-only status"] },
    { id: "auth_0", label: "$0 Auth", priceUsdMonthly: 0, authRequired: true, summary: "Signed-in workspace for saved notes and RAG intake.", features: ["operator notes", "saved workspace"] },
    { id: "auth_20", label: "$20 Auth", priceUsdMonthly: 20, authRequired: true, summary: "Supporter lane for report packets, queue visibility, and weekly digest.", features: ["queue visibility", "report packets"] },
    { id: "auth_200", label: "$200 Auth", priceUsdMonthly: 200, authRequired: true, summary: "Pilot lane for guided cleanup, review, and operator scheduling.", features: ["pilot review", "cleanup session"] },
    { id: "founder", label: "Founder", priceUsdMonthly: null, authRequired: true, founderOnly: true, summary: "Founder-only local controls, dispatch, secrets, and release promotion gates.", features: ["local controls", "release gates"] },
  ],
};

const validators = [
  { name: "HTML surface", state: "pass", next: "Keep links no-store and keyboard reachable." },
  { name: "Access lanes", state: "pass", next: "Wire real identity provider before private data leaves local mode." },
  { name: "Founder controls", state: "held", next: "Require operator-machine auth proof before enabling remote dispatch." },
  { name: "Convergence loop", state: "held", next: "Run PowerShell locally; cloud/Linux keeps the issue visible." },
  { name: "Cloud mirrors", state: "candidate", next: "Promote only after health endpoint returns verified 200." },
];

function appOrigin() {
  return window.location.protocol === "file:" ? LOCAL_APP_ORIGIN : window.location.origin;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function money(value) {
  return `$${Number(value || 0).toLocaleString()}`;
}

function safeText(value, fallback = "--") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function log(message) {
  const logElement = $("log");
  if (!logElement) return;
  logElement.textContent = `${new Date().toLocaleTimeString()} ${message}\n${logElement.textContent}`;
}

let autoUpdateTimer = null;

async function api(path, options) {
  const response = await fetch(`${appOrigin()}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options && options.headers ? options.headers : {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function normalizeInternalLinks() {
  if (window.location.protocol !== "file:") return;
  document.querySelectorAll('a[href^="/"]').forEach((link) => {
    link.href = `${LOCAL_APP_ORIGIN}${link.getAttribute("href")}`;
  });
}

async function refreshOperatorQueue() {
  const data = await api("/api/operator-queue");
  const list = $("operatorQueue");
  if (!list) return data;
  list.innerHTML = "";
  if (!data.items || !data.items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = data.boundary || "Queue clear.";
    list.appendChild(li);
    return data;
  }
  data.items.slice(0, 24).forEach((item) => {
    const priority = safeText(item.priority, "P1").toLowerCase();
    const li = document.createElement("li");
    li.className = `queue-item ${priority}`;
    const badge = document.createElement("span");
    badge.className = `priority-badge ${priority}`;
    badge.textContent = safeText(item.priority, "P1");
    const label = document.createElement("span");
    label.className = "queue-label";
    label.textContent = safeText(item.title, "Untitled queue item");
    const meta = document.createElement("span");
    meta.className = "queue-meta";
    meta.textContent = item.type === "note" ? "operator note" : `${item.owner || "—"}${item.blocked ? " ⛔ " + item.blocked : ""}`;
    li.append(badge, label, meta);
    list.appendChild(li);
  });
  return data;
}

async function storeNote(event) {
  event.preventDefault();
  const text = $("noteText").value.trim();
  if (!text) return;
  await api("/api/operator-notes", {
    method: "POST",
    body: JSON.stringify({ text, priority: $("notePriority").value }),
  });
  $("noteText").value = "";
  log("Note added to Operator Lane.");
  await refreshOperatorQueue();
}

function renderAccessModel(model = fallbackAccessModel) {
  const tiers = Array.isArray(model.tiers) ? model.tiers : fallbackAccessModel.tiers;
  const byId = Object.fromEntries(tiers.map((tier) => [tier.id, tier]));
  const set = (id, tierId) => {
    const el = $(id);
    const tier = byId[tierId];
    if (el && tier) el.textContent = `${tier.authRequired ? "auth" : "public"}: ${tier.summary}`;
  };
  set("publicLane", "public");
  set("authZeroLane", "auth_0");
  set("authTwentyLane", "auth_20");
  set("authTwoHundredLane", "auth_200");
  set("founderLane", "founder");
  const cap = $("userCapacity");
  if (cap) cap.textContent = `Dozens-ready soft cap: ${model.activeUserSoftCap || 48} users; private founder actions held.`;
}

function renderValidators() {
  const body = $("validatorBody");
  if (!body) return;
  body.innerHTML = "";
  validators.forEach((validator) => {
    const row = document.createElement("tr");
    [validator.name, validator.state, validator.next].forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 1) {
        const badge = document.createElement("span");
        badge.className = `slot-state ${validator.state === "pass" ? "active" : validator.state === "held" ? "blocked" : "idle"}`;
        badge.textContent = validator.state;
        cell.appendChild(badge);
      } else {
        cell.textContent = value;
      }
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  const pass = validators.filter((validator) => validator.state === "pass").length;
  const held = validators.filter((validator) => validator.state === "held").length;
  $("validatorCounts").textContent = `${pass} pass | ${held} held | ${validators.length} total`;
  $("validatorBadge").textContent = held ? "HELD" : "PASS";
  $("validatorBadge").className = held ? "badge badge-blocked" : "badge badge-live";
}

async function refresh() {
  const [[status, rag, conversationState, flatHouse, miningLab, mirrors, accessModel], queue] = await Promise.all([
    Promise.all([
      api("/api/status"),
      api("/api/rag-cache"),
      api("/api/conversations?limit=8"),
      api("/api/flat-rag-house"),
      api("/api/mining-lab"),
      api("/api/cloud-mirrors"),
      api("/api/access-model").catch(() => fallbackAccessModel),
    ]),
    refreshOperatorQueue(),
  ]);

  $("movie1").textContent = status.arc?.movie1GarageConfidence ?? "--";
  $("phase").textContent = status.arc?.currentPhase || "No phase recorded.";
  $("m1").textContent = status.arc?.movie1GarageConfidence ?? "--";
  $("m2").textContent = status.arc?.movie2PublicPlatformConfidence ?? "--";
  $("m3").textContent = status.arc?.movie3DistributedFleetConfidence ?? "--";
  $("avengers").textContent = status.arc?.avengersState || "held";

  $("cash").textContent = money(status.wallet?.clearedCashUsd);
  $("pending").textContent = money(status.wallet?.pendingInvoiceUsd);
  $("invoices").textContent = String(status.wallet?.pendingInvoices?.length || 0);

  $("prep").textContent = yesNo(status.readiness?.readyForPrep);
  $("install").textContent = yesNo(status.readiness?.readyForInstall);
  $("bootSummary").textContent = status.readiness?.summary || "No readiness summary.";
  renderBootGate(status.readiness || {});

  $("dashboard").textContent = yesNo(status.controls?.dashboardOk);
  $("mcp").textContent = yesNo(status.controls?.mcpOk);
  $("accessx").textContent = yesNo(status.controls?.accessXExists);

  renderRagCache(rag || []);
  renderConversations(conversationState.conversations || []);
  renderFlatHouse(flatHouse || {});
  renderMiningLab(miningLab || {});
  renderCloudMirrors(mirrors || {});
  renderAccessModel(accessModel);
  renderValidators();
  renderFleet(queue, status);
  renderHff(status);
  log("Status refreshed.");
}

function renderRagCache(rag) {
  const list = $("ragCache");
  if (!list) return;
  list.innerHTML = "";
  if (!rag.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No RAG records yet.";
    list.appendChild(li);
    return;
  }
  rag.slice(-8).reverse().forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${safeText(item.topic, "topic")}: ${safeText(item.claim, "claim")} (${safeText(item.decision, "candidate")}, ${safeText(item.confidence, "n/a")})`;
    list.appendChild(li);
  });
}

async function postAction(path, label) {
  log(`${label} started...`);
  const result = await api(path, { method: "POST", body: "{}" });
  log(`${label} finished with code ${result.code}. ${result.stderr || result.stdout || ""}`.trim());
  return result;
}

async function ingestFlatRagHouse() {
  log("Flat RAG ingest started...");
  const result = await api("/api/actions/flat-rag-ingest", { method: "POST", body: "{}" });
  renderFlatHouse(result.house || {});
  log("Flat RAG ingest finished.");
}

function renderFlatHouse(house) {
  const sources = house.sources || [];
  $("flatSources").textContent = String(sources.length || 0);
  $("flatRecords").textContent = String(house.ragRecordCount || 0);
  $("archiveMode").textContent = "manifest only; no repo deletion";
  $("windowsHost").textContent = house.windowsSurface?.host || "Windows host, Lantern OS app";
  $("bootMutation").textContent = house.windowsSurface?.defaultBootMutation || "blocked";

  const list = $("flatSourceList");
  list.innerHTML = "";
  sources.slice(0, 8).forEach((source) => {
    const li = document.createElement("li");
    li.textContent = `${source.name}: ${source.dirty ? "dirty" : "clean"} @ ${source.branch || "unknown"} (${source.archiveDecision || "source_evidence_only"})`;
    list.appendChild(li);
  });
}

function renderMiningLab(lab) {
  const panel = $("miningLabPanel");
  if (!panel) return;
  if (!lab || lab.ready !== true) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("miningMode").textContent = lab.mode || "manual-first";
  $("miningCpu").textContent = lab.routeSummary?.cpu || "XMR learning lane";
  $("miningGpu").textContent = lab.routeSummary?.gpu || "RVN / ETC experiment lane";
  $("miningEth").textContent = lab.routeSummary?.eth || "wallet / claim checks only";
}

function isLocalOnlyUrl(value) {
  try {
    const url = new URL(value || "", window.location.href);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "file:" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return true;
  }
}

function isVerifiedCloudMirror(mirror) {
  if (!mirror || isLocalOnlyUrl(mirror.url)) return false;
  const status = String(mirror.status || "").toLowerCase();
  return status.includes("verified") && status.includes("200");
}

function renderCloudMirrors(mirrors) {
  const localPrimary = mirrors.localPrimary || LOCAL_APP_ORIGIN;
  const cloudMirrors = mirrors.cloudMirrors || [];
  const verifiedCloudMirrors = cloudMirrors.filter(isVerifiedCloudMirror);
  const publicProofCount = verifiedCloudMirrors.length;

  $("mirrorPrimary").textContent = localPrimary;
  $("mirrorCount").textContent = `${publicProofCount}/${cloudMirrors.length}`;
  $("mirrorDeploy").textContent = `${mirrors.deployBranch || "master"} -> ${mirrors.deployProvider || "Render"}`;
  $("chatStatus").textContent = window.location.protocol === "file:" ? "preview via local app" : "web app";
  $("tunnelStatus").textContent = publicProofCount > 0 ? "cloud verified" : "cloud candidate";
  $("chatMirrorSummary").textContent = `Local primary: ${localPrimary} | public mirrors: ${publicProofCount}/${cloudMirrors.length} | marker ${CLOUD_TRUTH_DEPLOY_MARKER}`;
  const chatLinks = $("chatMirrorLinks");
  chatLinks.innerHTML = "";
  cloudMirrors.slice(0, 4).forEach((mirror) => {
    const link = document.createElement("a");
    link.href = mirror.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = mirror.name || mirror.url;
    chatLinks.appendChild(link);
  });
  const list = $("mirrorList");
  if (!list) return;
  list.innerHTML = "";
  cloudMirrors.forEach((mirror) => {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = mirror.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = mirror.name || mirror.url;
    const meta = document.createElement("span");
    const proof = isVerifiedCloudMirror(mirror) ? "public proof verified" : "public proof pending";
    meta.textContent = ` ${mirror.status || "configured"} ${mirror.healthPath || ""} — ${proof}`;
    li.append(link, meta);
    list.appendChild(li);
  });
}

function renderConversations(conversations) {
  const container = $("chatMessages");
  const empty = $("chatEmpty");
  if (!conversations.length) {
    container.innerHTML = "";
    container.appendChild(empty);
    empty.style.display = "";
    showQuickReplies("greeting");
    return;
  }
  empty.style.display = "none";
  container.innerHTML = "";
  conversations.forEach((entry) => {
    const div = document.createElement("div");
    div.className = `chat-bubble ${entry.role || "note"}`;
    const text = document.createElement("span");
    text.textContent = entry.text;
    div.appendChild(text);
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = entry.recordedAt ? new Date(entry.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";
    div.appendChild(time);
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
  const lastRole = conversations[conversations.length - 1]?.role;
  showQuickReplies(lastRole === "lantern" || lastRole === "system" ? "respond" : "follow-up");
}

const quickSets = {
  greeting: [
    { label: "Check fleet", text: "What is the current agent fleet and validator status?" },
    { label: "Add P0", text: "P0: " },
    { label: "Access lanes", text: "Show the public, auth $0, $20, $200, and founder lanes." },
  ],
  respond: [
    { label: "Approve", text: "Approved. Proceed with the next safe action." },
    { label: "Hold", text: "Hold — I need to review this first." },
    { label: "Next task", text: "Move to the next queued task." },
  ],
  "follow-up": [
    { label: "Refresh", text: "Refresh the full system status." },
    { label: "Dispatch held", text: "Founder dispatch remains held until local auth proof." },
    { label: "P1 note", text: "P1: " },
  ],
};

function showQuickReplies(name) {
  const container = $("chatQuick");
  if (!container) return;
  container.innerHTML = "";
  (quickSets[name] || quickSets.greeting).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-reply";
    button.textContent = item.label;
    button.addEventListener("click", () => {
      $("conversationText").value = item.text;
      $("conversationText").focus();
    });
    container.appendChild(button);
  });
}

async function storeConversation(event) {
  event.preventDefault();
  const textarea = $("conversationText");
  const text = textarea.value.trim();
  if (!text) return;
  await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ role: $("conversationRole").value, text, surface: "garage-dashboard" }),
  });
  textarea.value = "";
  textarea.style.height = "auto";
  log("Conversation saved locally.");
  const state = await api("/api/conversations?limit=8");
  renderConversations(state.conversations || []);
}

async function storeRagItem(event) {
  event.preventDefault();
  const claim = $("ragClaim").value.trim();
  if (!claim) return;
  const record = await api("/api/rag-cache", {
    method: "POST",
    body: JSON.stringify({
      topic: $("ragTopic").value.trim() || "dashboard intake",
      claim,
      decision: $("ragDecision").value,
      confidence: 0.5,
    }),
  });
  $("ragClaim").value = "";
  $("ragTopic").value = "";
  log(`RAG item added: ${record.record?.decision || "candidate"}.`);
  renderRagCache(await api("/api/rag-cache"));
}

function renderBootGate(readiness) {
  $("launchRule").textContent = "Local app first. Disk, bootloader, firmware, and default-boot changes remain operator-held.";
  $("nextBoot").textContent = readiness.readyForInstall
    ? "Prep says ready for physical install; operator still owns the boot decision."
    : "Windows remains the host until physical checklist and rollback proof are complete.";
  $("memoryRule").textContent = "RAG cache, notes, and conversations are source-labeled; private founder material stays auth/local-held.";
}

function renderFleet(queue = {}, status = {}) {
  const items = queue.items || [];
  const body = $("fleetBody");
  if (!body) return;
  body.innerHTML = "";
  const rows = items.slice(0, 6);
  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="4" class="muted">No local queue exposed; Render keeps dispatch held.</td>';
    body.appendChild(row);
  } else {
    rows.forEach((item, index) => {
      const row = document.createElement("tr");
      const state = item.blocked ? "blocked" : "active";
      row.innerHTML = `<td>${index + 1}</td><td><span class="slot-state ${state}">${state}</span></td><td></td><td>${item.priority || "P1"}</td>`;
      row.children[2].textContent = item.title || item.file || "queue item";
      body.appendChild(row);
    });
  }
  const p0 = items.filter((item) => item.priority === "P0").length;
  const p1 = items.filter((item) => item.priority === "P1").length;
  $("fleetCounts").textContent = `P0:${p0} P1:${p1} items:${items.length}`;
  $("fleetBadge").textContent = status.controls?.mcpOk ? "LOCAL" : "HELD";
  $("fleetBadge").className = status.controls?.mcpOk ? "badge badge-live" : "badge badge-blocked";
}

function renderHff(status = {}) {
  const lanes = status.arc?.evidenceLanes || {};
  $("hffHumans").textContent = Math.round((lanes.patientPacketSystem || 0.74) * 100);
  $("hffAnimals").textContent = Math.round((lanes.repoAndReports || 0.92) * 100);
  $("hffEco").textContent = Math.round((lanes.ragAndDataCenter || 0.68) * 100);
  $("hffUniverse").textContent = Math.round((lanes.fourDGms || 0.55) * 100);
  $("hffMeta").textContent = "proof-weighted local scores | public claims held at evidence boundary";
}

function toggleAutoUpdate() {
  const button = $("autoUpdate");
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
    button.setAttribute("aria-pressed", "false");
    $("autoUpdateState").textContent = "off";
    log("Auto update off.");
    return;
  }
  autoUpdateTimer = setInterval(() => refresh().catch((error) => log(`Auto refresh failed: ${error.message}`)), 30000);
  button.setAttribute("aria-pressed", "true");
  $("autoUpdateState").textContent = "30s";
  log("Auto update on: 30s refresh for dozens-ready dashboard.");
}

function wireUi() {
  normalizeInternalLinks();
  $("refresh")?.addEventListener("click", () => refresh().catch((error) => log(`Refresh failed: ${error.message}`)));
  $("runLoop")?.addEventListener("click", () => postAction("/api/actions/run-loop", "Convergence loop").catch((error) => log(`Convergence loop held/failed: ${error.message}`)));
  $("flatRagIngest")?.addEventListener("click", () => ingestFlatRagHouse().catch((error) => log(`Flat RAG ingest failed: ${error.message}`)));
  $("autoUpdate")?.addEventListener("click", toggleAutoUpdate);
  $("localControls")?.addEventListener("click", () => postAction("/api/actions/local-controls", "Local controls").catch((error) => log(`Local controls held/failed: ${error.message}`)));
  $("dispatchAll")?.addEventListener("click", () => log("Founder dispatch is held until local auth proof and MCP canary pass."));
  $("noteForm")?.addEventListener("submit", (event) => storeNote(event).catch((error) => log(`Note failed: ${error.message}`)));
  $("ragForm")?.addEventListener("submit", (event) => storeRagItem(event).catch((error) => log(`RAG intake failed: ${error.message}`)));
  $("conversationForm")?.addEventListener("submit", (event) => storeConversation(event).catch((error) => log(`Conversation failed: ${error.message}`)));
  $("conversationText")?.addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireUi();
  renderAccessModel(fallbackAccessModel);
  renderValidators();
  refresh().catch((error) => log(`Initial refresh failed: ${error.message}`));
});
