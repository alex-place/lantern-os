const $ = (id) => document.getElementById(id);
const LOCAL_APP_ORIGIN = "http://127.0.0.1:4177";

function appOrigin() {
  return window.location.protocol === "file:" ? LOCAL_APP_ORIGIN : window.location.origin;
}

async function api(path) {
  const response = await fetch(`${appOrigin()}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

function money(value) {
  return `$${Number(value || 0).toLocaleString()}`;
}

async function loadHealth() {
  try {
    const data = await api("/api/health");
    $("healthStatus").textContent = data.ok ? "ok" : "down";
    $("healthService").textContent = data.service || "lantern-garage";
    $("healthTime").textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : "--";
  } catch (e) {
    $("healthStatus").textContent = "unreachable";
  }
}

async function loadWallet() {
  try {
    const data = await api("/api/wallet");
    $("walletCleared").textContent = money(data.wallet?.clearedCashUsd);
    $("walletPending").textContent = money(data.wallet?.pendingInvoiceUsd);
    $("walletInvoices").textContent = String(data.wallet?.pendingInvoices?.length || 0);
  } catch (e) {
    $("walletCleared").textContent = "--";
  }
}

async function loadTraction() {
  try {
    const data = await api("/api/traction");
    $("tractionCleared").textContent = money(data.revenue?.clearedUsd);
    $("tractionWorkflows").textContent = String(data.nonOperatorWorkflows?.count ?? "--");
    $("tractionOutreach").textContent = String(data.outreach?.sends ?? "--");
    const reported = data.operatorReportedUsage?.count ?? 0;
    $("tractionReported").textContent = `${reported} (unverified)`;
  } catch (e) {
    $("tractionCleared").textContent = "--";
  }
}

async function loadArc() {
  try {
    const data = await api("/api/arc-reactor");
    $("arcPhase").textContent = data.currentPhase || "--";
    $("arcM1").textContent = data.movie1GarageConfidence ?? "--";
    $("arcM2").textContent = data.movie2PublicPlatformConfidence ?? "--";
    $("arcM3").textContent = data.movie3DistributedFleetConfidence ?? "--";
  } catch (e) {
    $("arcPhase").textContent = "--";
  }
}

async function loadLanes() {
  try {
    const data = await api("/api/access-model");
    const list = $("lanesList");
    list.innerHTML = "";
    const tiers = data.tiers || [];
    tiers.forEach((tier) => {
      const li = document.createElement("li");
      li.textContent = `${tier.label}: ${tier.summary}`;
      list.appendChild(li);
    });
  } catch (e) {
    $("lanesList").innerHTML = "<li class='empty'>--</li>";
  }
}

async function loadConvergence() {
  try {
    const data = await api("/api/status");
    $("loopIssues").textContent = data.issues || "--";
    $("loopHeld").textContent = data.held ? data.held.length : "--";
    $("loopRepos").textContent = data.repos ? data.repos.length : "--";
  } catch (e) {
    $("loopIssues").textContent = "--";
  }
}

async function loadDreamer() {
  try {
    const data = await api("/api/dreamer");
    $("dreamerCount").textContent = `${data.entries?.length || 0} entries`;
    $("dreamerUser").textContent = data.user || "--";
    $("dreamerPath").textContent = data.path || "--";
  } catch (e) {
    $("dreamerCount").textContent = "--";
  }
}

async function init() {
  await Promise.all([loadHealth(), loadWallet(), loadTraction(), loadArc(), loadLanes(), loadConvergence(), loadDreamer()]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
