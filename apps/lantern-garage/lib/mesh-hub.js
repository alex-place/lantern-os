/**
 * Mesh Hub — n-user contributor mesh registry and presence.
 *
 * Members are declared in config/mesh-members.json (joining = a PR that adds
 * yourself there — git-native, no registration endpoint to abuse). Each member
 * machine posts heartbeats; the hub aggregates presence for the fleet view.
 *
 * Heartbeats append to data/mesh/heartbeats.jsonl through the file queue
 * (concurrent-write safe) and the latest one per member is cached in memory.
 */

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MEMBERS_PATH = path.join(REPO_ROOT, "config", "mesh-members.json");
const HEARTBEAT_LOG = path.join(REPO_ROOT, "data", "mesh", "heartbeats.jsonl");

// A member is "online" if it heartbeated within this window.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// Input limits — reject anything outside these (SECURITY.md: validate all input)
const MAX_STRING = 64;
const MAX_NOTE = 200;
const MAX_AGENTS = 16;
const MAX_PROVIDERS = 10;

let _membersCache = { data: null, ts: 0 };
const MEMBERS_CACHE_TTL_MS = 10_000;

// Latest heartbeat per member id, this process lifetime. Seeded lazily from
// the tail of the JSONL log so restarts don't blank the fleet view.
const _lastHeartbeat = new Map();
let _seeded = false;

function loadMembers() {
  const now = Date.now();
  if (_membersCache.data && now - _membersCache.ts < MEMBERS_CACHE_TTL_MS) {
    return _membersCache.data;
  }
  let parsed = { version: 0, hub: {}, members: [] };
  try {
    parsed = JSON.parse(fs.readFileSync(MEMBERS_PATH, "utf8"));
    if (!Array.isArray(parsed.members)) parsed.members = [];
  } catch { /* missing/invalid registry — empty mesh */ }
  _membersCache = { data: parsed, ts: now };
  return parsed;
}

function _seedFromLog() {
  if (_seeded) return;
  _seeded = true;
  try {
    const lines = fs.readFileSync(HEARTBEAT_LOG, "utf8").trim().split("\n");
    // Tail only — old history is irrelevant for presence
    for (const line of lines.slice(-200)) {
      try {
        const hb = JSON.parse(line);
        if (hb && hb.member) _lastHeartbeat.set(hb.member, hb);
      } catch { /* skip bad line */ }
    }
  } catch { /* no log yet */ }
}

function _cleanString(value, max = MAX_STRING) {
  return String(value || "").slice(0, max).trim();
}

function _cleanStringArray(value, maxItems, maxLen = MAX_STRING) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((v) => _cleanString(v, maxLen)).filter(Boolean);
}

/**
 * Validate and record a heartbeat. Returns { ok, error?, heartbeat? }.
 * Only registered members may heartbeat — unknown ids are rejected.
 */
async function recordHeartbeat(body) {
  const registry = loadMembers();
  const memberId = _cleanString(body && body.member);
  if (!memberId) return { ok: false, error: "member required" };

  const member = registry.members.find((m) => m.id === memberId);
  if (!member) return { ok: false, error: `unknown member '${memberId}' — add yourself to config/mesh-members.json via PR first` };

  const heartbeat = {
    member: memberId,
    machine: _cleanString(body.machine) || "unknown",
    agents: _cleanStringArray(body.agents, MAX_AGENTS),
    providers: _cleanStringArray(body.providers, MAX_PROVIDERS),
    note: _cleanString(body.note, MAX_NOTE),
    receivedAt: new Date().toISOString(),
  };

  _seedFromLog();
  _lastHeartbeat.set(memberId, heartbeat);
  await appendJsonlQueued(HEARTBEAT_LOG, heartbeat, { rotate: true }).catch(() => {}); // #872 per-heartbeat
  return { ok: true, heartbeat };
}

/** Registry + presence for every member. */
function getMeshStatus() {
  _seedFromLog();
  const registry = loadMembers();
  const now = Date.now();
  const members = registry.members.map((m) => {
    const hb = _lastHeartbeat.get(m.id) || null;
    const lastSeen = hb ? hb.receivedAt : null;
    const online = !!(lastSeen && now - Date.parse(lastSeen) < ONLINE_WINDOW_MS);
    return {
      ...m,
      online,
      lastSeen,
      machine: hb ? hb.machine : null,
      agents: hb ? hb.agents : [],
      providers: hb ? hb.providers : [],
      note: hb ? hb.note : "",
    };
  });
  return {
    hub: registry.hub || {},
    memberCount: members.length,
    onlineCount: members.filter((m) => m.online).length,
    members,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { loadMembers, recordHeartbeat, getMeshStatus, ONLINE_WINDOW_MS };
