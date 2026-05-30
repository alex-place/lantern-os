const $ = (id) => document.getElementById(id);
const LOCAL_APP_ORIGIN = "http://127.0.0.1:4177";
const CLOUD_PROVIDER_LABEL = "AWS ECS/Fargate";

function appOrigin() {
  return window.location.protocol === "file:" ? LOCAL_APP_ORIGIN : window.location.origin;
}

function currentSurfaceOrigin() {
  return window.location.protocol === "file:" ? LOCAL_APP_ORIGIN : window.location.origin;
}

function setFrontDoorLink(url, label = "Cloud front door") {
  const link = $("frontDoorLink");
  if (!link || !url) return;
  link.href = url;
  link.textContent = `${label}: ${url}`;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function money(value) {
  return `$${Number(value || 0).toLocaleString()}`;
}

function log(message) {
  $("log").textContent = `${new Date().toLocaleTimeString()} ${message}\n${$("log").textContent}`;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
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
  list.innerHTML = "";
  if (!data.items || !data.items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Queue clear.";
    list.appendChild(li);
    return;
  }
  data.items.forEach((item) => {
    const li = document.createElement("li");
    li.className = `queue-item ${item.priority.toLowerCase()}`;
    const badge = document.createElement("span");
    badge.className = `priority-badge ${item.priority.toLowerCase()}`;
    badge.textContent = item.priority;
    const label = document.createElement("span");
    label.className = "queue-label";
    label.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "queue-meta";
    meta.textContent = item.type === "note" ? "note" : `${item.owner || "—"}${item.blocked ? " ⛔ " + item.blocked : ""}`;
    li.appendChild(badge);
    li.appendChild(label);
    li.appendChild(meta);
    list.appendChild(li);
  });
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
  log("Note added.");
  await refreshOperatorQueue();
}

async function refresh() {
  const [[status, rag, conversationState, flatHouse, miningLab, mirrors]] = await Promise.all([
    Promise.all([
      api("/api/status"),
      api("/api/rag-cache"),
      api("/api/conversations?limit=8"),
      api("/api/flat-rag-house"),
      api("/api/mining-lab"),
      api("/api/cloud-mirrors"),
    ]),
    refreshOperatorQueue(),
  ]);

  const proofLoop = status.arc.currentPhase || "Movie 1 garage proven; Movie 2 proof loop forming";
  setText("movie1", status.arc.movie1GarageConfidence ?? "--");
  setText("phase", proofLoop);
  setText("modelProofLoop", proofLoop);
  setText(
    "modelTokenCut",
    `MCP gates + RAG compression: ${status.mcpCatalog?.toolCount ?? "--"} tools visible, ${status.mcpCatalog?.status || "catalog checking"}.`
  );
  setText(
    "modelRevenueLane",
    `Zero-cash lane: ads/service fees, privacy boundaries, and wallet truth at ${money(status.wallet.clearedCashUsd)} cleared / ${money(status.wallet.pendingInvoiceUsd)} pending.`
  );
  setText("currentModelVersion", "Current Model: Baseline v1");
  setText(
    "currentModelMeta",
    `Local chat first. ${mirrors.deployProvider || CLOUD_PROVIDER_LABEL} URL ${mirrors.cloudMirrorCount ? "listed" : "pending"}; MCP ${status.mcpCatalog?.toolCount ?? "--"} tools ${status.mcpCatalog?.status || "unverified"}.`
  );
  $("m1").textContent = status.arc.movie1GarageConfidence ?? "--";
  $("m2").textContent = status.arc.movie2PublicPlatformConfidence ?? "--";
  $("m3").textContent = status.arc.movie3DistributedFleetConfidence ?? "--";
  $("avengers").textContent = status.arc.avengersState || "held";

  $("cash").textContent = money(status.wallet.clearedCashUsd);
  $("pending").textContent = money(status.wallet.pendingInvoiceUsd);
  $("invoices").textContent = String(status.wallet.pendingInvoices?.length || 0);

  $("prep").textContent = yesNo(status.readiness.readyForPrep);
  $("install").textContent = yesNo(status.readiness.readyForInstall);
  $("bootSummary").textContent = status.readiness.summary || "No readiness summary.";
  renderBootGate(status.readiness);

  $("dashboard").textContent = yesNo(status.controls.dashboardOk);
  $("mcp").textContent = yesNo(status.controls.mcpOk);
  $("accessx").textContent = yesNo(status.controls.accessXExists);

  const list = $("ragCache");
  list.innerHTML = "";
  rag.slice(-8).reverse().forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${item.topic}: ${item.claim} (${item.decision}, ${item.confidence})`;
    list.appendChild(li);
  });

  renderConversations(conversationState.conversations || []);
  renderFlatHouse(flatHouse);
  renderMiningLab(miningLab);
  renderCloudMirrors(mirrors);
  renderOrchestratorDependency(status.orchestratorDependency);
  log("Status refreshed.");
}

async function postAction(path, label, trigger) {
  const originalText = trigger?.textContent;
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "Working...";
    trigger.setAttribute("aria-busy", "true");
  }
  log(`${label} started...`);
  try {
    const result = await api(path, { method: "POST", body: "{}" });
    log(`${label} finished with code ${result.code}.`);
    if (result.receiptPath) log(`${label} receipt: ${result.receiptPath}`);
    if (result.paperOrderCount !== undefined) {
      const realSpend = Number(result.realMoneyUsd || 0).toFixed(2);
      log(`${label} paper orders: ${result.paperOrderCount}; real spend $${realSpend}; live trading ${result.liveTradingStatus || "blocked"}.`);
    }
    if (result.paperBlock) renderKalshiBlock(result);
    return result;
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = originalText;
      trigger.removeAttribute("aria-busy");
    }
  }
}

function renderKalshiBlock(result) {
  const block = result.paperBlock || {};
  const orders = block.orders || [];
  setText("kalshiBlockMode", result.liveTradingStatus || "blocked");
  setText("kalshiBlockOrders", String(result.paperOrderCount ?? orders.length));
  setText("kalshiBlockRisk", `$${Number(block.allocatedPaperRiskUsd || 0).toFixed(2)} paper`);
  setText("kalshiBlockSpend", `$${Number(result.realMoneyUsd || 0).toFixed(2)}`);
  const receipt = $("kalshiBlockReceipt");
  if (receipt && result.receiptPath) receipt.href = `/view?path=${encodeURIComponent(result.receiptPath)}`;

  const list = $("kalshiBlockList");
  if (!list) return;
  list.innerHTML = "";
  if (!orders.length) {
    const li = document.createElement("li");
    li.textContent = "No current near-term tickets returned.";
    list.appendChild(li);
    return;
  }
  orders.forEach((order) => {
    const li = document.createElement("li");
    const limit = Number(order.limitCents || 0);
    const loss = Number(order.maxLossUsd || 0).toFixed(2);
    const minutes = Number(order.minutesToKnown || 0).toFixed(1);
    li.textContent = `${order.ticker}: ${limit}c limit, $${loss} max loss, ${minutes}m, ${order.status || "paper"}`;
    list.appendChild(li);
  });
}

async function ingestFlatRagHouse() {
  log("Flat RAG ingest started...");
  const result = await api("/api/actions/flat-rag-ingest", { method: "POST", body: "{}" });
  renderFlatHouse(result.house);
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
  sources.forEach((source) => {
    const li = document.createElement("li");
    li.textContent = `${source.name}: ${source.dirty ? "dirty" : "clean"} @ ${source.branch || "unknown"} (${source.archiveDecision})`;
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

function getCanonicalCloudMirror(cloudMirrors) {
  return cloudMirrors.find((mirror) => {
    if (!mirror) return false;
    const name = String(mirror.name || "").toLowerCase();
    const role = String(mirror.role || "").toLowerCase();
    return name.includes("lantern os aws") || role.includes("canonical aws");
  }) || cloudMirrors.find(isVerifiedCloudMirror) || null;
}

function canonicalFrontDoorVerified(cloudMirrors) {
  return isVerifiedCloudMirror(getCanonicalCloudMirror(cloudMirrors));
}

function cloudMirrorStateLabel(mirror, mirrors) {
  const provider = mirrors?.deployProvider || CLOUD_PROVIDER_LABEL;
  const status = String(mirror?.status || "unconfigured").toLowerCase();
  if (isVerifiedCloudMirror(mirror)) return `${provider} verified`;
  if (!mirror) return `${provider} service URL pending`;
  if (status.includes("404")) return `${provider} 404 held`;
  if (status.includes("candidate") || status.includes("pending") || status.includes("held")) return `${provider} held`;
  return `${provider} unverified`;
}

function getFrontDoorUrl(mirrors) {
  const currentOrigin = window.location.protocol === "file:" ? "" : window.location.origin;
  if (currentOrigin && !isLocalOnlyUrl(currentOrigin)) return currentOrigin;
  const cloudMirrors = Array.isArray(mirrors?.cloudMirrors) ? mirrors.cloudMirrors : [];
  const canonicalMirror = getCanonicalCloudMirror(cloudMirrors);
  if (isVerifiedCloudMirror(canonicalMirror)) return canonicalMirror.url;
  return mirrors?.localPrimary || LOCAL_APP_ORIGIN;
}

function renderCloudMirrors(mirrors) {
  if (!mirrors) return;
  const localPrimary = mirrors.localPrimary || "http://127.0.0.1:4177";
  const cloudMirrors = mirrors.cloudMirrors || [];
  const verifiedCloudMirrors = cloudMirrors.filter(isVerifiedCloudMirror);
  const publicProofCount = verifiedCloudMirrors.length;
  const canonicalMirror = getCanonicalCloudMirror(cloudMirrors);
  const canonicalVerified = canonicalFrontDoorVerified(cloudMirrors);
  const cloudState = cloudMirrorStateLabel(canonicalMirror, mirrors);
  const frontDoorUrl = getFrontDoorUrl(mirrors);
  const currentOrigin = currentSurfaceOrigin();

  setFrontDoorLink(frontDoorUrl, canonicalVerified ? "Cloud front door" : "Local front door");
  $("mirrorPrimary").textContent = frontDoorUrl;
  $("mirrorCount").textContent = String(publicProofCount);
  $("mirrorDeploy").textContent = `${mirrors.deployBranch || "master"} -> ${mirrors.deployProvider || CLOUD_PROVIDER_LABEL}`;
  $("chatStatus").textContent = window.location.protocol === "file:" ? "preview via local app" : isLocalOnlyUrl(currentOrigin) ? "local" : "cloud";
  $("tunnelStatus").textContent = canonicalVerified ? "cloud verified" : cloudState.toLowerCase();
  $("chatMirrorSummary").textContent = `Front door: ${frontDoorUrl} | ${cloudState} | verified public mirrors: ${publicProofCount}`;
  const chatLinks = $("chatMirrorLinks");
  chatLinks.innerHTML = "";
  cloudMirrors.slice(0, 3).forEach((mirror) => {
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
    const proof = isVerifiedCloudMirror(mirror) ? "public proof verified" : "public proof missing";
    meta.textContent = ` ${mirror.status || "configured"} ${mirror.healthPath || ""} — ${proof}`;
    li.appendChild(link);
    li.appendChild(meta);
    list.appendChild(li);
  });
}

function renderOrchestratorDependency(dependency) {
  if (!dependency) return;
  setText("orchDepStatus", dependency.status || "unvalidated");
  setText(
    "orchDepTools",
    dependency.healthOk
      ? `${dependency.toolCount ?? "--"} visible; read tools ${dependency.canUseReadTools ? "ready" : "held"}`
      : "MCP health failed"
  );
  setText(
    "orchDepFleet",
    `available ${dependency.availableAgentCount ?? "--"} / active ${dependency.activeAgentCount ?? "--"} / stale ${dependency.staleAgentCount ?? "--"}`
  );
  setText("orchDepNext", dependency.nextHumanAction || "Run dependency validation.");
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
    div.className = `chat-bubble ${entry.role}`;
    const text = document.createElement("span");
    text.textContent = entry.text;
    div.appendChild(text);
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = new Date(entry.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    div.appendChild(time);
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
  const lastRole = conversations[conversations.length - 1]?.role;
  showQuickReplies(lastRole === "lantern" || lastRole === "system" ? "respond" : "follow-up");
}

const quickSets = {
  greeting: [
    { label: "!one", text: "!one" },
    { label: "!converge", text: "!converge" },
    { label: "!superjarvis", text: "!superjarvis" },
  ],
  respond: [
    { label: "Approve", text: "Approved. Proceed." },
    { label: "Hold", text: "Hold — I need to review this first." },
    { label: "Next task", text: "Move to the next queued task." },
  ],
  "follow-up": [
    { label: "Refresh status", text: "Refresh the full system status." },
    { label: "Dispatch agents", text: "Dispatch all available agents on queued work." },
    { label: "Add P0 note", text: "I need to flag a P0 item." },
  ],
};

function showQuickReplies(context) {
  const bar = $("chatQuick");
  bar.innerHTML = "";
  const chips = quickSets[context] || quickSets["follow-up"];
  chips.forEach((chip) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-chip";
    btn.textContent = chip.label;
    btn.addEventListener("click", () => sendChat(chip.text));
    bar.appendChild(btn);
  });
}

function renderBootGate(readiness) {
  const installReady = readiness.readyForInstall === true;
  const prepReady = readiness.readyForPrep === true;
  $("launchRule").textContent = installReady
    ? "Install gate is ready for operator-reviewed physical action. The app still will not mutate boot settings."
    : "Local app first. Disk, bootloader, firmware, and default-boot changes remain operator-held.";
  $("nextBoot").textContent = installReady
    ? "Review the install checklist, backup keys, recovery media, and boot USB before changing the machine."
    : prepReady
      ? "Prep is ready, but install is held until unallocated disk space and elevated checks pass."
      : "Windows remains the host until readiness evidence improves.";
  $("memoryRule").textContent = "RAG cache and local conversations are source-labeled. Private notes stay local.";
}

async function sendChat(text) {
  if (!text || !text.trim()) return;
  text = text.trim();
  appendBubble("operator", text, { status: "queued" });
  const waitingBubble = appendBubble("lantern", "Waiting for Lantern response...", {
    pending: true,
    status: "queued for MCP/local reply",
  });
  $("conversationText").value = "";
  autoGrow($("conversationText"));
  $("chatStatus").textContent = "thinking";
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });
    updateBubble(waitingBubble, "lantern", result.reply || generateLocalReply(text), result.provider || "local");
    $("chatStatus").textContent = result.provider || "local";
    showQuickReplies("respond");
  } catch (err) {
    const reply = generateLocalReply(text);
    updateBubble(waitingBubble, "lantern", reply, "local fallback");
    $("chatStatus").textContent = "local fallback";
    try {
      await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ surface: "lantern-garage", role: "operator", text }),
      });
      await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ surface: "lantern-garage", role: "lantern", text: reply }),
      });
    } catch {
      log(`Chat stored on-screen only: ${err.message}`);
    }
    showQuickReplies("respond");
  }
}

async function postCommand(command, label = command) {
  log(`${label} command started through /api/command...`);
  const result = await api("/api/command", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
  log(`${label}: ${result.ok ? "done" : result.error || "held"}`);
  const output = String(result.stdout || result.stderr || "").trim();
  if (output) log(output.split(/\r?\n/).slice(-4).join(" | "));
  return result;
}

function generateLocalReply(input) {
  const lower = input.toLowerCase();
  if (lower.startsWith("!one"))
    return "Use /api/command for !one. It runs the read-only One IDE preflight locally.";
  if (lower.startsWith("!converge"))
    return "Use /api/command for !converge. It runs the Lantern convergence loop locally.";
  if (lower.startsWith("!superjarvis"))
    return "Use /api/command for !superjarvis. It runs one Super Jarvis diagnostic pass locally.";
  if (lower.includes("mine") || lower.includes("mining") || lower.includes("monero") || lower.includes("btc") || lower.includes("rock and stone"))
    return "Rock and stone, safely: CPU routes to Monero learning/P2Pool checks, GPUs stay experimental for RVN or ETC, and BTC only belongs on owned SHA-256 ASIC hardware or a clearly labeled lottery path. No wallet cracking, no hidden signing, no fake one-shot ROI.";
  if (lower.includes("fleet") || lower.includes("agent") || lower.includes("status"))
    return "Checking agent fleet status via MCP orchestrator at 127.0.0.1:8787. Use Refresh Status to pull live queue and slot evidence.";
  if (lower.includes("next task") || lower.includes("queue"))
    return "Queue is managed by the orchestrator. Use the operator queue panel above or hit Refresh to see current state.";
  if (lower.includes("sync") || lower.includes("evidence") || lower.includes("ingest") || lower.includes("repo") || lower.includes("rag"))
    return "Sync Evidence rebuilds the flat RAG house from configured local source repos and then shows source and record counts on the dashboard.";
  if (lower.includes("converge") || lower.includes("loop"))
    return "Running convergence loop. This executes the Lantern convergence script and updates RAG + status.";
  if (lower.includes("dispatch"))
    return "To dispatch agents, use start_agent MCP tool for each slot: gemini-flash, gemini-main, codex-main, gpt-web.";
  if (lower.includes("hold"))
    return "Holding. Current action paused for operator review.";
  if (lower.includes("approve") || lower.includes("proceed"))
    return "Acknowledged. Proceeding with current action path.";
  if (lower.includes("p0") || lower.includes("flag") || lower.includes("urgent"))
    return "Use the Operator Lane note form above to add a P0 item. It will appear at the top of the queue.";
  return "Message stored locally. Use quick-reply buttons or type for more context.";
}

function appendBubble(role, text, options = {}) {
  const container = $("chatMessages");
  const empty = $("chatEmpty");
  empty.style.display = "none";
  const div = document.createElement("div");
  div.className = `chat-bubble ${role}${options.pending ? " pending" : ""}`;
  if (options.pending) div.setAttribute("aria-busy", "true");
  const span = document.createElement("span");
  span.className = "chat-message-text";
  span.textContent = text;
  div.appendChild(span);
  const time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = options.status || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.appendChild(time);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function updateBubble(bubble, role, text, status) {
  if (!bubble) {
    appendBubble(role, text, { status });
    return;
  }
  bubble.className = `chat-bubble ${role}`;
  bubble.removeAttribute("aria-busy");
  const message = bubble.querySelector(".chat-message-text");
  if (message) message.textContent = text;
  const time = bubble.querySelector(".chat-time");
  if (time) time.textContent = status || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

async function storeConversation(event) {
  event.preventDefault();
  const text = $("conversationText").value.trim();
  if (!text) return;
  await sendChat(text);
}

async function storeRagItem(event) {
  event.preventDefault();
  const claim = $("ragClaim").value.trim();
  if (!claim) {
    log("RAG claim required.");
    return;
  }
  await api("/api/rag-cache", {
    method: "POST",
    body: JSON.stringify({
      topic: $("ragTopic").value || "Lantern OS form intake",
      claim,
      decision: $("ragDecision").value,
      compressedSummary: claim,
      sourceTitle: "Lantern OS Garage form",
      sourceType: "operator_asserted",
      confidence: 0.66,
    }),
  });
  $("ragClaim").value = "";
  log("RAG item stored.");
  await refresh();
}

function toggleAutoUpdate() {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
    $("autoUpdate").setAttribute("aria-pressed", "false");
    $("autoUpdateState").textContent = "off";
    log("Auto update off.");
    return;
  }
  autoUpdateTimer = setInterval(() => refresh().catch((error) => log(error.message)), 30000);
  $("autoUpdate").setAttribute("aria-pressed", "true");
  $("autoUpdateState").textContent = "30s refresh";
  log("Auto update on: 30s refresh only.");
}

async function refreshFleet() {
  try {
    const data = await api("/api/fleet");
    if (!data.ok) throw new Error(data.error || "fleet unavailable");
    renderFleet(data);
  } catch (error) {
    $("fleetBadge").textContent = "OFFLINE";
    $("fleetBadge").className = "badge badge-blocked";
    $("fleetCounts").textContent = `MCP offline: ${error.message}`;
    const dispatch = $("dispatchAll");
    dispatch.disabled = true;
    dispatch.textContent = "Dispatch Held";
    dispatch.title = "MCP fleet status is offline; no agent dispatch is allowed.";
  }
}

function renderFleet(data) {
  const body = $("fleetBody");
  body.innerHTML = "";
  const agents = data.agents || [];
  const activeCount = agents.filter((agent) => agent.currentTask).length;
  const availability = data.raw?.availability || {};
  const parsedAvailableCount = Number(availability.availableCount);
  const availableCount = Number.isFinite(parsedAvailableCount)
    ? parsedAvailableCount
    : agents.filter((agent) => agent.available && !agent.currentTask).length;
  const canDispatch = availableCount > 0
    && agents.some((agent) => agent.available && !agent.currentTask && agent.slot !== "operator-intake");
  const nextHumanAction = availability.nextHumanAction || data.raw?.headline || "";
  const dispatch = $("dispatchAll");
  dispatch.disabled = !canDispatch;
  dispatch.textContent = canDispatch ? "Dispatch Ready" : "Dispatch Held";
  dispatch.title = canDispatch ? "Rate-limited MCP dispatch is available." : (nextHumanAction || "No safe agent slots are available.");
  $("fleetBadge").textContent = activeCount > 0 ? `${activeCount} ACTIVE` : "IDLE";
  $("fleetBadge").className = activeCount > 0 ? "badge badge-live" : "badge badge-medium";
  agents.forEach((agent) => {
    if (agent.slot === "operator-intake") return;
    const tr = document.createElement("tr");
    const stateClass = agent.currentTask ? "active" : agent.available ? "idle" : "blocked";
    const taskText = agent.currentTask ? agent.currentTask.replace(/__/g, " ").replace(/\.md$/, "") : "--";
    const confidence = agent.currentTask ? "running" : agent.available ? "ready" : agent.reason;
    tr.innerHTML = `<td><strong>${agent.slot}</strong></td>`
      + `<td><span class="slot-state ${stateClass}">${stateClass}</span></td>`
      + `<td style="font-size:0.82rem">${taskText}</td>`
      + `<td><span class="badge badge-${stateClass === "active" ? "live" : stateClass === "idle" ? "high" : "blocked"}">${String(confidence || "unknown").toUpperCase()}</span></td>`;
    body.appendChild(tr);
  });
  const counts = data.counts || {};
  const queueText = `Q:${counts.queue ?? "--"} A:${counts.active ?? "--"} D:${counts.done ?? "--"} F:${counts.failed ?? "--"}`;
  $("fleetCounts").textContent = nextHumanAction ? `${queueText} | ${nextHumanAction}` : queueText;
}

async function refreshHff() {
  try {
    const data = await api("/api/hff-sensors");
    if (!data.ok) throw new Error(data.error || "HFF sensor poll unavailable");
    $("hffBadge").textContent = data.liveSensorsEnabled ? "SENSORS ON" : "HOLD";
    $("hffBadge").className = data.liveSensorsEnabled ? "badge badge-live" : "badge badge-candidate";
    renderScores({ humans: 54, animals: 43, ecosystems: 52, universe: 50 });
    $("hffMeta").textContent = `${data.verifiedNodes} verified nodes | ${data.securityNodes} security nodes | consensus target ${data.minConsensusNodes} | source: ${data.dataSource}`;
  } catch (error) {
    $("hffBadge").textContent = "LOCAL";
    $("hffBadge").className = "badge badge-candidate";
    renderScores({ humans: 54, animals: 43, ecosystems: 52, universe: 50 });
    $("hffMeta").textContent = `sensor poll held: ${error.message}`;
  }
}

function startVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log("Mic input is not available in this browser.");
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  $("voiceInput").setAttribute("aria-pressed", "true");
  log("Listening...");
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    if (transcript) {
      $("conversationText").value = transcript;
      autoGrow($("conversationText"));
      $("conversationText").focus();
    }
  };
  recognition.onerror = (event) => log(`Mic input stopped: ${event.error || "unknown error"}`);
  recognition.onend = () => $("voiceInput").setAttribute("aria-pressed", "false");
  recognition.start();
}

function sparkline(canvasId, values) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - (value / 100) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderScores(scores) {
  $("hffHumans").textContent = `${scores.humans}%`;
  $("hffAnimals").textContent = `${scores.animals}%`;
  $("hffEco").textContent = `${scores.ecosystems}%`;
  $("hffUniverse").textContent = `${scores.universe}%`;
  sparkline("scoreChart", [scores.humans, scores.animals, scores.ecosystems, scores.universe]);
}

async function init() {
  normalizeInternalLinks();
  setFrontDoorLink(LOCAL_APP_ORIGIN, "Local front door");
  $("dispatchAll").addEventListener("click", async () => {
    log("Dispatching local MCP agent slots...");
    const result = await api("/api/actions/dispatch-all", { method: "POST", body: "{}" });
    if (result.held) {
      log(`${result.message || "Dispatch held."} ${result.nextHumanAction || ""}`.trim());
      await refreshFleet();
      return;
    }
    if (result.rateLimited) {
      log(`Dispatch held: retry in ${Math.ceil((result.retryAfterMs || 0) / 1000)} seconds.`);
      return;
    }
    if (result.active) {
      log(result.message || "Dispatch already running.");
      return;
    }
    if (result.accepted) {
      log(result.message || "Dispatch started.");
      setTimeout(() => refreshFleet().catch((error) => log(error.message)), 5000);
      return;
    }
    (result.results || []).forEach((item) => log(`${item.slot}: ${item.ok ? "DISPATCHED" : item.error || item.result?.error || "held"}`));
    await refreshFleet();
  });
  $("refresh").addEventListener("click", () => { refresh(); refreshFleet(); refreshHff(); });
  $("runLoop").addEventListener("click", () => postCommand("!converge", "Loop").catch((error) => log(error.message)));
  $("nearTermKalshiBlock").addEventListener("click", (event) => postAction("/api/actions/kalshi-near-term-paper-block", "Near 20m Kalshi paper block", event.currentTarget).catch((error) => log(error.message)));
  $("localControls").addEventListener("click", () => postAction("/api/actions/local-controls", "Local controls").catch((error) => log(error.message)));
  $("flatRagIngest").addEventListener("click", () => ingestFlatRagHouse().catch((error) => log(error.message)));
  $("autoUpdate").addEventListener("click", toggleAutoUpdate);
  $("conversationForm").addEventListener("submit", (event) => storeConversation(event).catch((error) => log(error.message)));
  $("ragForm").addEventListener("submit", (event) => storeRagItem(event).catch((error) => log(error.message)));
  $("noteForm").addEventListener("submit", (event) => storeNote(event).catch((error) => log(error.message)));
  $("voiceInput").addEventListener("click", startVoiceInput);
  $("conversationText").addEventListener("input", function () { autoGrow(this); });
  $("conversationText").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("conversationForm").dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  renderScores({ humans: 43, animals: 52, ecosystems: 50, universe: 54 });
  showQuickReplies("greeting");
  refresh().catch((error) => log(error.message));
  refreshFleet().catch(() => {});
  refreshHff().catch(() => {});
}

init();
