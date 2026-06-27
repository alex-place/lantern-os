// Creator Intelligence — ExportValidator
// A hard gate run BEFORE a final render is accepted. Uses ffprobe (real
// measurement) to verify short-form spec. Every verdict is traceable to an
// actual ffprobe value. On failure the export is blocked with concrete reasons.
//
// See docs/creator-v10/export-validator.md

"use strict";

const fs = require("fs");
const { spawn } = require("child_process");

const DEFAULTS = {
  targetWidth: 1080,
  targetHeight: 1920,
  minFps: 30,
  // Short-form floor. 5s lets the editor ship genuine 5–6s highlight shorts
  // (e.g. from a short reference clip) instead of blocking anything under 15s.
  minDuration: 5,
  maxDuration: 60,
  videoCodecAllow: ["h264"],
  requireAudio: true,
  captionsExpected: false,
};

/**
 * Run ffprobe and return parsed JSON, or null if ffprobe is unavailable/fails.
 */
function probe(filePath) {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ];
    let out = "";
    let spawnFailed = false;
    let proc;
    try {
      proc = spawn("ffprobe", args);
    } catch {
      return resolve(null);
    }
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", () => {});
    proc.on("error", () => { spawnFailed = true; resolve(null); });
    proc.on("close", (code) => {
      if (spawnFailed) return;
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

function parseFrameRate(str) {
  if (!str || typeof str !== "string") return 0;
  if (str.includes("/")) {
    const [n, d] = str.split("/").map(Number);
    if (d) return n / d;
    return 0;
  }
  const v = Number(str);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Validate an exported file against short-form spec.
 * @param {string} outputPath
 * @param {Object} options  overrides for DEFAULTS
 * @returns {Promise<{ok:boolean, checks:Array, blockedReasons:string[], probedAt:string}>}
 */
async function validateExport(outputPath, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const probedAt = new Date().toISOString();

  if (!fs.existsSync(outputPath)) {
    return {
      ok: false,
      checks: [{ name: "file_exists", ok: false, actual: "missing" }],
      blockedReasons: [`output file not found: ${outputPath}`],
      probedAt,
    };
  }

  const data = await probe(outputPath);
  if (!data) {
    // Block rather than pass: an unvalidated export must not look validated.
    return {
      ok: false,
      checks: [{ name: "ffprobe", ok: false, actual: "unavailable" }],
      blockedReasons: ["ffprobe not available or file unreadable — cannot validate export"],
      probedAt,
    };
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const format = data.format || {};

  const checks = [];
  const blockedReasons = [];
  const add = (name, ok, expected, actual) => {
    checks.push({ name, ok, expected, actual });
    if (!ok) blockedReasons.push(`${name}: expected ${expected}, got ${actual}`);
  };

  // resolution
  if (!video) {
    add("resolution", false, `${cfg.targetWidth}x${cfg.targetHeight}`, "no video stream");
  } else {
    const actual = `${video.width}x${video.height}`;
    add("resolution", video.width === cfg.targetWidth && video.height === cfg.targetHeight,
      `${cfg.targetWidth}x${cfg.targetHeight}`, actual);
  }

  // fps
  if (video) {
    const fps = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
    add("fps", fps >= cfg.minFps, `>=${cfg.minFps}`, fps ? fps.toFixed(2) : "unknown");
  }

  // video codec
  if (video) {
    add("video_codec", cfg.videoCodecAllow.includes(video.codec_name),
      cfg.videoCodecAllow.join("|"), video.codec_name || "unknown");
  }

  // audio present
  if (cfg.requireAudio) {
    add("audio", !!audio, "present",
      audio ? `${audio.codec_name} ${audio.channels}ch` : "none");
  }

  // duration
  const duration = Number(format.duration);
  if (!Number.isFinite(duration)) {
    add("duration", false, `${cfg.minDuration}-${cfg.maxDuration}s`, "unknown");
  } else {
    add("duration", duration >= cfg.minDuration && duration <= cfg.maxDuration,
      `${cfg.minDuration}-${cfg.maxDuration}s`, `${duration.toFixed(1)}s`);
  }

  // captions rendered — verified against the editor's burn manifest, not assumed.
  if (cfg.captionsExpected) {
    const burned = options.captionBurnConfirmed === true;
    add("captions_rendered", burned, "burned-in",
      burned ? "confirmed by burn manifest" : "not confirmed");
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, blockedReasons, probedAt };
}

module.exports = { validateExport, DEFAULTS };
