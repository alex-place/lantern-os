/**
 * Cube Store — private and shared cube event writer.
 *
 * Every dream-chat event, door choice, and surface interaction
 * writes a delta into the owner's private cube. Shared events
 * (approved claim packets) write into the shared cube.
 */

const fs = require("fs");
const path = require("path");
const { writeTextQueued, readJson, appendJsonlQueued } = require("./file-queue");

const CUBES_ROOT = "data/cubes";

const CUBE_DIR_MAP = {
  "cube:alex.private": "alex.private",
  "cube:shared.world": "shared",
};

function getCubeDir(repoRoot, cubeId) {
  // cube:alex.private  -> data/cubes/alex.private
  // cube:shared.world -> data/cubes/shared
  // cube:ally.001      -> data/cubes/allies/001
  const slug = CUBE_DIR_MAP[cubeId] || cubeId.replace(/^cube:/, "").replace(/\./g, "/");
  return path.join(repoRoot, CUBES_ROOT, slug);
}

function ensureCubeDir(repoRoot, cubeId) {
  const dir = getCubeDir(repoRoot, cubeId);
  fs.mkdirSync(path.join(dir, "deltas"), { recursive: true });
  fs.mkdirSync(path.join(dir, "indexes"), { recursive: true });
  return dir;
}

function loadManifest(repoRoot, cubeId) {
  const dir = getCubeDir(repoRoot, cubeId);
  const manifestPath = path.join(dir, "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function saveManifest(repoRoot, cubeId, manifest) {
  const dir = getCubeDir(repoRoot, cubeId);
  const manifestPath = path.join(dir, "manifest.json");
  manifest.updated_at = new Date().toISOString();
  return writeTextQueued(manifestPath, JSON.stringify(manifest, null, 2));
}

// ── Private cube delta ──

async function appendPrivateCubeDelta(repoRoot, cubeId, delta) {
  const manifest = loadManifest(repoRoot, cubeId);
  if (!manifest) throw new Error(`Cube not found: ${cubeId}`);
  if (manifest.cube_type !== "private") {
    throw new Error(`appendPrivateCubeDelta only for private cubes, got ${manifest.cube_type}`);
  }

  ensureCubeDir(repoRoot, cubeId);

  const record = {
    schema: "lantern.cube_delta.v1",
    cube_id: cubeId,
    delta_id: `delta:${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
    source_surface: delta.source_surface || "unknown",
    event_type: delta.event_type,
    privacy: "private",
    observer_id: delta.observer_id || manifest.owner_name || "alex",
    symbols: delta.symbols || [],
    payload_ref: delta.payload_ref || "",
    coordinate: delta.coordinate || "",
    created_at: new Date().toISOString(),
  };

  const deltasPath = path.join(getCubeDir(repoRoot, cubeId), "deltas", "deltas.jsonl");
  await appendJsonlQueued(deltasPath, record);
  return record;
}

function readPrivateCubeDeltas(repoRoot, cubeId, limit = 50) {
  const deltasPath = path.join(getCubeDir(repoRoot, cubeId), "deltas", "deltas.jsonl");
  if (!fs.existsSync(deltasPath)) return [];
  return fs
    .readFileSync(deltasPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parseError: true, raw: line }; }
    });
}

function readPrivateCubeSummary(repoRoot, cubeId) {
  const manifest = loadManifest(repoRoot, cubeId);
  const deltas = readPrivateCubeDeltas(repoRoot, cubeId, 20);
  const deltasPath = path.join(getCubeDir(repoRoot, cubeId), "deltas", "deltas.jsonl");
  const totalDeltas = fs.existsSync(deltasPath)
    ? fs.readFileSync(deltasPath, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;

  return {
    cube_id: cubeId,
    cube_type: manifest?.cube_type,
    display_name: manifest?.display_name,
    owner: manifest?.owner_name,
    total_deltas: totalDeltas,
    recent_events: deltas,
    surfaces: manifest?.surfaces || [],
    privacy: manifest?.privacy,
  };
}

// ── Shared cube claim packet ──

async function appendSharedCubeClaim(repoRoot, cubeId, packet) {
  const manifest = loadManifest(repoRoot, cubeId);
  if (!manifest) throw new Error(`Cube not found: ${cubeId}`);
  if (manifest.cube_type !== "shared_world") {
    throw new Error(`appendSharedCubeClaim only for shared_world cubes, got ${manifest.cube_type}`);
  }

  ensureCubeDir(repoRoot, cubeId);
  fs.mkdirSync(path.join(getCubeDir(repoRoot, cubeId), "claims"), { recursive: true });

  const record = {
    schema: "lantern.shared_claim_entry.v1",
    cube_id: cubeId,
    packet_id: packet.packet_id,
    origin_node_id: packet.origin?.node_id,
    claim_title: packet.claim?.title,
    claim_scope: packet.claim?.scope,
    claim_domain: packet.claim?.domain,
    uncertainty: packet.measurement?.uncertainty,
    evidence_class: packet.evidence?.evidence_class,
    certainty: packet.evidence?.certainty,
    privacy_level: packet.privacy?.privacy_level,
    allowed_use: packet.privacy?.allowed_use,
    consent_gate_status: packet.review?.consent_gate_status,
    signed: !!(packet.signature?.signature),
    inserted_at: new Date().toISOString(),
  };

  const claimsPath = path.join(getCubeDir(repoRoot, cubeId), "claims", "claims.jsonl");
  await appendJsonlQueued(claimsPath, record);
  return record;
}

function readSharedCubeSummary(repoRoot, cubeId) {
  const manifest = loadManifest(repoRoot, cubeId);
  const claimsPath = path.join(getCubeDir(repoRoot, cubeId), "claims", "claims.jsonl");
  const claims = fs.existsSync(claimsPath)
    ? fs.readFileSync(claimsPath, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;

  return {
    cube_id: cubeId,
    cube_type: manifest?.cube_type,
    display_name: manifest?.display_name,
    owner: manifest?.owner_name,
    member_count: (manifest?.members || []).length,
    total_claims: claims,
    members: manifest?.members || [],
    privacy: manifest?.privacy,
    sync: manifest?.sync,
  };
}

function readSharedCubeClaims(repoRoot, cubeId, limit = 50) {
  const claimsPath = path.join(getCubeDir(repoRoot, cubeId), "claims", "claims.jsonl");
  if (!fs.existsSync(claimsPath)) return [];
  return fs
    .readFileSync(claimsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parseError: true, raw: line }; }
    });
}

// ── Ally helpers ──

function listAllies(repoRoot) {
  const alliesPath = path.join(repoRoot, "data", "nodes", "allies.jsonl");
  if (!fs.existsSync(alliesPath)) return [];
  return fs
    .readFileSync(alliesPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parseError: true, raw: line }; }
    });
}

function addAlly(repoRoot, ally) {
  const alliesPath = path.join(repoRoot, "data", "nodes", "allies.jsonl");
  const record = {
    schema: "lantern.ally.v1",
    ally_id: ally.ally_id || `ally:${Date.now().toString(16)}`,
    display_name: ally.display_name,
    node_id: ally.node_id,
    public_key: ally.public_key,
    status: ally.status || "invited",
    shared_cubes: ally.shared_cubes || ["cube:shared.world"],
    private_cube_access: false,
    permissions: ally.permissions || {
      can_read_shared_cube: true,
      can_submit_claims: true,
      can_submit_shared_lore: false,
      can_request_private_review: false,
      can_receive_recommendations: true,
    },
    invited_at: new Date().toISOString(),
  };
  return appendJsonlQueued(alliesPath, record);
}

module.exports = {
  getCubeDir,
  ensureCubeDir,
  loadManifest,
  saveManifest,
  appendPrivateCubeDelta,
  readPrivateCubeDeltas,
  readPrivateCubeSummary,
  appendSharedCubeClaim,
  readSharedCubeSummary,
  readSharedCubeClaims,
  listAllies,
  addAlly,
};
