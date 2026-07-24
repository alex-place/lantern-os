// Lantern Creator Suite Job Queue
// Persistent JSONL-based job management for async video processing
// Jobs: analyze, caption, export, etc.

const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("crypto").randomUUID || (() => Math.random().toString(36).substr(2, 9))();

const JobStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

class Job {
  constructor(type, input) {
    this.id = generateJobId();
    this.type = type; // "analyze" | "caption" | "export" | etc
    this.input = input;
    this.status = JobStatus.PENDING;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.completedAt = null;
    this.progress = 0; // 0-100
    this.progressMessage = "Queued";
    this.result = null;
    this.error = null;
    // Rich progress state for TaskProgressPanel
    this.stages = [];        // [{id, name, weight, status, startedAt, endedAt}]
    this.logs = [];          // [{ts, msg}] — capped at 200 lines
    this.liveStats = {};     // {analyzedSec, totalSec, highlightsFound, topScore, …}
    this.etaSeconds = null;
    this.currentStageId = null;
  }

  start() {
    this.status = JobStatus.PROCESSING;
    this.startedAt = new Date().toISOString();
  }

  setProgress(percent, message) {
    this.progress = Math.min(100, Math.max(0, percent));
    this.progressMessage = message;
  }

  // ── Stage tracking ─────────────────────────────────────────────────────────

  setStages(stageDefs) {
    this.stages = stageDefs.map(s => ({ ...s, status: "pending", startedAt: null, endedAt: null }));
  }

  startStage(stageId) {
    const now = new Date().toISOString();
    for (const s of this.stages) {
      if (s.id === stageId) {
        s.status = "running";
        s.startedAt = now;
      } else if (s.status === "running") {
        s.status = "done";
        s.endedAt = now;
      }
    }
    this.currentStageId = stageId;
  }

  completeStage(stageId, failed = false) {
    const s = this.stages.find(x => x.id === stageId);
    if (s) { s.status = failed ? "failed" : "done"; s.endedAt = new Date().toISOString(); }
    if (this.currentStageId === stageId) this.currentStageId = null;
  }

  appendLog(msg) {
    this.logs.push({ ts: new Date().toISOString(), msg: String(msg) });
    if (this.logs.length > 200) this.logs = this.logs.slice(-200);
  }

  setLiveStats(stats) {
    Object.assign(this.liveStats, stats);
  }

  setEta(seconds) {
    this.etaSeconds = (seconds != null && isFinite(seconds)) ? Math.max(0, Math.round(seconds)) : null;
  }

  // ─────────────────────────────────────────────────────────────────────────

  complete(result) {
    this.status = JobStatus.COMPLETE;
    this.completedAt = new Date().toISOString();
    this.progress = 100;
    this.progressMessage = "Complete";
    this.result = result;
    this.etaSeconds = 0;
    // Mark any lingering stages as done
    for (const s of this.stages) {
      if (s.status === "pending" || s.status === "running") {
        s.status = "done";
        s.endedAt = this.completedAt;
      }
    }
  }

  fail(error) {
    this.status = JobStatus.FAILED;
    this.completedAt = new Date().toISOString();
    this.error = error instanceof Error ? error.message : String(error);
    // Mark running stage as failed
    for (const s of this.stages) {
      if (s.status === "running") { s.status = "failed"; s.endedAt = this.completedAt; }
    }
  }

  cancel() {
    this.status = JobStatus.CANCELLED;
    this.completedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      progress: this.progress,
      progressMessage: this.progressMessage,
      stages: this.stages,
      logs: this.logs,
      liveStats: this.liveStats,
      etaSeconds: this.etaSeconds,
      currentStageId: this.currentStageId,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
      result: this.result,
    };
  }
}

class JobQueue {
  constructor(repoRoot, queueDir = "data/creator/jobs") {
    this.repoRoot = repoRoot;
    this.queuePath = path.join(repoRoot, queueDir);
    this.queueFile = path.join(this.queuePath, "queue.jsonl");
    this.archiveFile = path.join(this.queuePath, "archive.jsonl");
    this.jobs = new Map(); // In-memory cache: id -> Job

    this.ensureDirectories();
    this.loadQueue();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.queuePath)) {
      fs.mkdirSync(this.queuePath, { recursive: true });
    }
  }

  loadQueue() {
    // Load all jobs from disk into memory
    if (fs.existsSync(this.queueFile)) {
      const lines = fs
        .readFileSync(this.queueFile, "utf8")
        .split("\n")
        .filter((line) => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          const job = Object.assign(new Job(data.type, data.input), data);
          this.jobs.set(job.id, job);
        } catch (e) {
          console.error("[job-queue] Failed to load job:", e.message);
        }
      }
    }
  }

  enqueue(type, input) {
    const job = new Job(type, input);
    this.jobs.set(job.id, job);
    this.persistJob(job, "queue");
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  getPending() {
    return Array.from(this.jobs.values()).filter((j) => j.status === JobStatus.PENDING);
  }

  getByStatus(status) {
    return Array.from(this.jobs.values()).filter((j) => j.status === status);
  }

  updateJob(job) {
    this.jobs.set(job.id, job);
    this.persistJob(job, "queue");

    // Archive if complete or failed
    if (job.status === JobStatus.COMPLETE || job.status === JobStatus.FAILED) {
      this.archiveJob(job);
    }
  }

  persistJob(job, type = "queue") {
    const file = type === "archive" ? this.archiveFile : this.queueFile;

    // Append job as JSONL line
    fs.appendFileSync(file, JSON.stringify(job.toJSON()) + "\n");
  }

  archiveJob(job) {
    // Move completed job to archive
    this.persistJob(job, "archive");

    // Remove from queue file by rewriting it
    this.rewriteQueueFile();
  }

  rewriteQueueFile() {
    // Rebuild queue file without archived jobs
    const pending = this.getPending();
    const processing = this.getByStatus(JobStatus.PROCESSING);
    const active = [...pending, ...processing];

    fs.writeFileSync(
      this.queueFile,
      active.map((j) => JSON.stringify(j.toJSON())).join("\n") + (active.length > 0 ? "\n" : "")
    );
  }

  getStats() {
    const all = Array.from(this.jobs.values());
    return {
      total: all.length,
      pending: all.filter((j) => j.status === JobStatus.PENDING).length,
      processing: all.filter((j) => j.status === JobStatus.PROCESSING).length,
      complete: all.filter((j) => j.status === JobStatus.COMPLETE).length,
      failed: all.filter((j) => j.status === JobStatus.FAILED).length,
    };
  }
}

function generateJobId() {
  return "job-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
}

module.exports = {
  JobQueue,
  Job,
  JobStatus,
};
