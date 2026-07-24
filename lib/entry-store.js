// Entry metadata storage system for Creator Dashboard
// Stores entry metadata, analysis, renders, and thumbnails
// Structure:
//   data/creator/entries/
//     entry-id/
//       metadata.json (title, description, tags, timestamps)
//       analysis.json (highlights, scenes, scores)
//       thumbnail.jpg
//       renders/
//         highlight.mp4
//         variantA.mp4
//         variantB.mp4
//         variantC.mp4

const fs = require("fs");
const path = require("path");

const ENTRIES_DIR = "data/creator/entries";

function getEntryDir(repoRoot, entryId) {
  return path.join(repoRoot, ENTRIES_DIR, entryId);
}

function generateEntryId() {
  return `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function createEntry(repoRoot, entryData) {
  const entryId = generateEntryId();
  const entryDir = getEntryDir(repoRoot, entryId);

  // Ensure directory exists
  fs.mkdirSync(entryDir, { recursive: true });
  fs.mkdirSync(path.join(entryDir, "renders"), { recursive: true });

  // Create metadata
  const metadata = {
    id: entryId,
    title: entryData.title?.trim() || "Untitled",
    description: entryData.description || "",
    project: entryData.project || "",
    tags: Array.isArray(entryData.tags)
      ? entryData.tags
      : typeof entryData.tags === "string"
      ? entryData.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [],
    type: entryData.type || "video",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filePath: entryData.filePath || null, // Path to original uploaded file
    facecamGuidance: entryData.facecamGuidance || null, // optional creator hint for facecam layout
    thumbnail: null, // Path to thumbnail
    analysis: null,
    renders: {
      highlight: null,
      variantA: null,
      variantB: null,
      variantC: null,
    },
    status: "uploaded", // uploaded, analyzing, ready, failed
  };

  const metadataPath = path.join(entryDir, "metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  return metadata;
}

// Backfill structural fields older entries may lack, so a project created before
// these features existed still opens and operates in the workspace. Pure: returns
// a normalized copy and never throws on a partial entry.
function normalizeEntry(data) {
  if (!data || typeof data !== "object") return data;
  return {
    ...data,
    tags: Array.isArray(data.tags) ? data.tags : [],
    status: data.status || "uploaded",
    renders: {
      highlight: null, variantA: null, variantB: null, variantC: null,
      ...(data.renders || {}),
    },
    renderRecords: Array.isArray(data.renderRecords) ? data.renderRecords : [],
    stages: (data.stages && typeof data.stages === "object") ? data.stages : {},
    analysisRuns: Array.isArray(data.analysisRuns) ? data.analysisRuns : [],
    analysisError: data.analysisError || null,
  };
}

// Persist a structured analysis failure (stage + reason) so the dashboard can
// show exactly what went wrong instead of a silent hang. Also appends a failed
// run to the audit trail.
function recordAnalysisError(repoRoot, entryId, info) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) return null;
  const runs = [...(entry.analysisRuns || []), {
    jobId: info.jobId || null,
    status: "failed",
    stage: info.stage || null,
    error: info.error || "unknown error",
    finishedAt: info.at || new Date().toISOString(),
  }].slice(-20); // keep the last 20 runs
  return updateEntry(repoRoot, entryId, {
    analysisError: { stage: info.stage || null, error: info.error || "unknown error", at: info.at || new Date().toISOString() },
    analysisRuns: runs,
    status: "failed",
  });
}

function clearAnalysisError(repoRoot, entryId) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry || !entry.analysisError) return entry;
  return updateEntry(repoRoot, entryId, { analysisError: null });
}

// Append a run to the analysis audit trail (most-recent-last, capped at 20).
function addAnalysisRun(repoRoot, entryId, run) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) return null;
  const runs = [...(entry.analysisRuns || []), {
    jobId: run.jobId || null,
    status: run.status || "complete",
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || new Date().toISOString(),
    highlightCount: typeof run.highlightCount === "number" ? run.highlightCount : null,
    durationSec: typeof run.durationSec === "number" ? run.durationSec : null,
    analysisCapped: !!run.analysisCapped,
  }].slice(-20);
  return updateEntry(repoRoot, entryId, { analysisRuns: runs });
}

function getEntry(repoRoot, entryId) {
  const metadataPath = path.join(getEntryDir(repoRoot, entryId), "metadata.json");

  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  return normalizeEntry(data);
}

// Record a per-stage completion timestamp (analyzed/variants/captions/safezones/
// rendered). Merged so each stage keeps its own time across re-runs.
function touchStages(repoRoot, entryId, stageNames) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) return null;
  const stages = { ...(entry.stages || {}) };
  const now = new Date().toISOString();
  for (const name of [].concat(stageNames || [])) stages[name] = now;
  return updateEntry(repoRoot, entryId, { stages });
}

// Append a render record (the viewer's source of truth). Records carry their own
// id so they can be individually deleted/re-rendered.
function addRenderRecord(repoRoot, entryId, record) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  const id = record.id || `render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full = {
    id,
    variant: record.variant || record.renderKey || "highlight",
    renderKey: record.renderKey || record.variant || "highlight",
    path: record.path,                 // repo-relative, served via /media/
    durationSec: typeof record.durationSec === "number" ? record.durationSec : null,
    sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : null,
    createdAt: record.createdAt || new Date().toISOString(),
    validation: record.validation || null,
  };
  const renderRecords = [...(entry.renderRecords || []), full];
  updateEntry(repoRoot, entryId, { renderRecords });
  return full;
}

function removeRenderRecord(repoRoot, entryId, renderId) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  const records = entry.renderRecords || [];
  const target = records.find((r) => r.id === renderId);
  if (!target) return entry;

  // Best-effort delete the file from disk (inside the project dir).
  try {
    const abs = path.join(repoRoot, target.path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) { /* best-effort cleanup */ }

  // Clear the back-compat renders[type] pointer if it referenced this file.
  const renders = { ...(entry.renders || {}) };
  for (const k of Object.keys(renders)) {
    if (renders[k] === target.path) renders[k] = null;
  }

  return updateEntry(repoRoot, entryId, {
    renderRecords: records.filter((r) => r.id !== renderId),
    renders,
  });
}

function updateEntry(repoRoot, entryId, updates) {
  const metadataPath = path.join(getEntryDir(repoRoot, entryId), "metadata.json");

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Entry ${entryId} not found`);
  }

  const current = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const updated = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(metadataPath, JSON.stringify(updated, null, 2));
  return updated;
}

function saveAnalysis(repoRoot, entryId, analysis) {
  const entryDir = getEntryDir(repoRoot, entryId);
  const analysisPath = path.join(entryDir, "analysis.json");

  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

  // Update metadata
  updateEntry(repoRoot, entryId, { analysis: "analysis.json" });
}

function getAnalysis(repoRoot, entryId) {
  const analysisPath = path.join(getEntryDir(repoRoot, entryId), "analysis.json");

  if (!fs.existsSync(analysisPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(analysisPath, "utf8"));
}

// Append an analysis-run audit record (kept to the last 20). Called by the job
// worker after each analyze job so the workspace can show run history.
function addAnalysisRun(repoRoot, entryId, run) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  const full = {
    jobId: run.jobId || null,
    status: run.status || "complete",
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || new Date().toISOString(),
    highlightCount: typeof run.highlightCount === "number" ? run.highlightCount : null,
    durationSec: typeof run.durationSec === "number" ? run.durationSec : null,
    analysisCapped: !!run.analysisCapped,
  };
  const analysisRuns = [...(entry.analysisRuns || []), full].slice(-20);
  return updateEntry(repoRoot, entryId, { analysisRuns });
}

// Record the last analysis failure on the entry so a reopened project can show
// what went wrong (cleared on the next successful run).
function recordAnalysisError(repoRoot, entryId, err) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) return null;
  return updateEntry(repoRoot, entryId, {
    analysisError: {
      stage: (err && err.stage) || "unknown",
      error: (err && err.error) || "unknown error",
      at: (err && err.at) || new Date().toISOString(),
      jobId: (err && err.jobId) || null,
    },
    status: "failed",
  });
}

function clearAnalysisError(repoRoot, entryId) {
  const entry = getEntry(repoRoot, entryId);
  if (!entry) return null;
  if (!entry.analysisError) return entry;
  return updateEntry(repoRoot, entryId, { analysisError: null });
}

function saveRender(repoRoot, entryId, type, filePath) {
  // filePath is relative to repo root
  const entryDir = getEntryDir(repoRoot, entryId);
  const renderDir = path.join(entryDir, "renders");

  fs.mkdirSync(renderDir, { recursive: true });

  // Copy or move file to render directory
  const filename = path.basename(filePath);
  const fullDestPath = path.join(renderDir, filename);
  const fullSourcePath = path.join(repoRoot, filePath);

  if (fs.existsSync(fullSourcePath)) {
    fs.copyFileSync(fullSourcePath, fullDestPath);
  }

  // Update metadata
  const entry = getEntry(repoRoot, entryId);
  if (entry) {
    entry.renders[type] = path.relative(repoRoot, fullDestPath);
    updateEntry(repoRoot, entryId, { renders: entry.renders });
  }
}

function saveValidation(repoRoot, entryId, type, result) {
  // Persist an ExportValidator result on the entry, keyed by render type.
  // Merged (not replaced) so each render type keeps its own validation record.
  const entry = getEntry(repoRoot, entryId);
  if (!entry) {
    throw new Error(`Entry ${entryId} not found`);
  }
  const validations = { ...(entry.validations || {}) };
  validations[type] = result;
  return updateEntry(repoRoot, entryId, { validations });
}

function saveThumbnail(repoRoot, entryId, filePath) {
  const entryDir = getEntryDir(repoRoot, entryId);
  const thumbnailPath = path.join(entryDir, "thumbnail.jpg");
  const fullSourcePath = path.join(repoRoot, filePath);
  const fullDestPath = path.join(repoRoot, thumbnailPath);

  fs.mkdirSync(entryDir, { recursive: true });

  if (fs.existsSync(fullSourcePath)) {
    fs.copyFileSync(fullSourcePath, fullDestPath);
  }

  // Update metadata
  updateEntry(repoRoot, entryId, { thumbnail: path.relative(repoRoot, fullDestPath) });
}

function listEntries(repoRoot) {
  const entriesDir = path.join(repoRoot, ENTRIES_DIR);

  if (!fs.existsSync(entriesDir)) {
    return [];
  }

  const entries = [];
  const dirs = fs.readdirSync(entriesDir);

  for (const dir of dirs) {
    const metadataPath = path.join(entriesDir, dir, "metadata.json");
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      entries.push(normalizeEntry(metadata));
    }
  }

  return entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Scan every project, write back the normalized metadata shape (so projects
// created before newer fields existed are repaired on disk), and report any
// whose source video is missing. Idempotent and safe to run repeatedly.
function repairAllProjects(repoRoot) {
  const entries = listEntries(repoRoot); // normalized in-memory
  const report = { scanned: 0, repaired: 0, missingVideo: [], missingThumbnail: [] };
  for (const e of entries) {
    report.scanned++;
    if (e.filePath && !fs.existsSync(path.join(repoRoot, e.filePath))) report.missingVideo.push(e.id);
    if (e.thumbnail && !fs.existsSync(path.join(repoRoot, e.thumbnail))) report.missingThumbnail.push(e.id);
    try {
      // Persist the normalized fields so they physically exist in metadata.json.
      updateEntry(repoRoot, e.id, {
        tags: e.tags, status: e.status, renders: e.renders,
        renderRecords: e.renderRecords, stages: e.stages,
        analysisRuns: e.analysisRuns, analysisError: e.analysisError,
      });
      report.repaired++;
    } catch { /* skip unreadable entry */ }
  }
  return report;
}

function formatTimestamp(isoString) {
  try {
    const date = new Date(isoString);
    const options = {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    return date.toLocaleDateString("en-US", options);
  } catch (e) {
    return "Unknown date";
  }
}

function deleteEntry(repoRoot, entryId) {
  const entryDir = getEntryDir(repoRoot, entryId);

  if (!fs.existsSync(entryDir)) {
    throw new Error(`Entry ${entryId} not found`);
  }

  // Recursively delete the entry directory
  fs.rmSync(entryDir, { recursive: true, force: true });
  return true;
}

module.exports = {
  generateEntryId,
  createEntry,
  getEntry,
  updateEntry,
  normalizeEntry,
  touchStages,
  addRenderRecord,
  removeRenderRecord,
  recordAnalysisError,
  clearAnalysisError,
  addAnalysisRun,
  repairAllProjects,
  saveAnalysis,
  getAnalysis,
  addAnalysisRun,
  recordAnalysisError,
  clearAnalysisError,
  saveRender,
  saveValidation,
  saveThumbnail,
  listEntries,
  formatTimestamp,
  getEntryDir,
  deleteEntry,
};
