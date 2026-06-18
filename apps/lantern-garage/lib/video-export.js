// Short-form video export (real ffmpeg re-encode)
// Converts an arbitrary source clip into an output that conforms to the
// short-form spec checked by the ExportValidator:
//   exact target resolution (default 1080x1920), h264 video, aac audio present,
//   target fps, duration clamped to the max window, +faststart.
//
// Modes (how the source aspect is mapped into 9:16):
//   "pad"  (default) scale-to-fit + black bars  — never crops content
//   "crop"            scale-to-cover + center crop — fills frame, may crop edges
//   "blur"            blurred-cover background + fitted foreground — "shorts" look
//
// Honesty note: this re-encodes real pixels/audio. It does NOT fabricate
// duration — a source shorter than the minimum stays short, and the validator
// will honestly block it. We only TRIM sources longer than the max window.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULTS = {
  width: 1080,
  height: 1920,
  fps: 30, // >= validator minFps; pass fps:60 to match the 60fps target
  fit: "pad", // pad | crop | blur
  maxDuration: 60, // trim sources longer than this
  crf: 20,
  preset: "veryfast",
  audioBitrate: "128k",
  sampleRate: 44100,
  timeoutMs: 10 * 60 * 1000,
};

/**
 * Probe a source for the basics we need to plan the encode.
 * @returns {Promise<{duration:number|null, hasAudio:boolean, width:number|null, height:number|null}>}
 */
function probeSource(inputPath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("ffprobe", [
        "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", inputPath,
      ]);
    } catch {
      return resolve({ duration: null, hasAudio: false, width: null, height: null });
    }
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", () => {});
    proc.on("error", () => resolve({ duration: null, hasAudio: false, width: null, height: null }));
    proc.on("close", () => {
      try {
        const data = JSON.parse(out);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const v = streams.find((s) => s.codec_type === "video");
        const hasAudio = streams.some((s) => s.codec_type === "audio");
        const duration = data.format && Number.isFinite(Number(data.format.duration))
          ? Number(data.format.duration) : null;
        resolve({ duration, hasAudio, width: v ? v.width : null, height: v ? v.height : null });
      } catch {
        resolve({ duration: null, hasAudio: false, width: null, height: null });
      }
    });
  });
}

// Merge options over DEFAULTS but IGNORE undefined values, so a caller that
// passes { width: undefined } (e.g. an export request that omits dimensions)
// does not blow away the default and produce scale=undefined.
function withDefaults(options = {}) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function isValidRect(rect) {
  if (!rect || typeof rect !== "object") return false;
  const { x, y, width, height } = rect;
  for (const v of [x, y, width, height]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 1.0001 && y + height <= 1.0001;
}

/**
 * Build the video filtergraph for a given fit mode.
 * Returns { vf } for simple modes or { filterComplex, mapV } for blur.
 * @param {Object|null} cropRect  normalized {x,y,width,height} on the SOURCE.
 *   When provided in crop mode, the source is cropped to that exact window
 *   (e.g. a SafeZoneDetectorV2 plan that avoids the facecam) before scaling,
 *   instead of a naive center crop.
 */
// facecam-top sub-graph: take one video stream (inLabel), lift the detected
// facecam overlay into a top band, stack the gameplay beneath it, and emit
// outLabel — the standard gaming-short layout. `facecam` and `gameplayRect` are
// normalized source rects (the facecam from SafeZoneDetectorV2; the gameplay
// window defaults to the full frame). Reused by both the single-clip and the
// segment-concat renderers. `tail` is an optional trailing filter (e.g. fps).
function facecamTopChain(inLabel, outLabel, w, h, facecam, gameplayRect, topFrac, tail) {
  const frac = Math.min(0.35, Math.max(0.12, Number(topFrac) || 0.22));
  const topH = Math.round((h * frac) / 2) * 2; // even height for yuv420p
  const botH = h - topH;
  const f = facecam;
  const g = isValidRect(gameplayRect) ? gameplayRect : { x: 0, y: 0, width: 1, height: 1 };
  const id = (outLabel.match(/[a-z0-9]+/i) || ["x"])[0]; // unique pad suffix
  const t = tail ? `,${tail}` : "";
  return (
    `${inLabel}split=2[fcs_${id}][gps_${id}];` +
    `[fcs_${id}]crop=in_w*${f.width}:in_h*${f.height}:in_w*${f.x}:in_h*${f.y},` +
      `scale=${w}:${topH}:force_original_aspect_ratio=increase,crop=${w}:${topH}[fct_${id}];` +
    `[gps_${id}]crop=in_w*${g.width}:in_h*${g.height}:in_w*${g.x}:in_h*${g.y},` +
      `scale=${w}:${botH}:force_original_aspect_ratio=increase,crop=${w}:${botH}[gpt_${id}];` +
    `[fct_${id}][gpt_${id}]vstack=inputs=2${t}${outLabel}`
  );
}

function buildVideoFilter(fit, w, h, fps, cropRect, facecam, gameplayRect, topFrac) {
  const fpsEnd = `fps=${fps},format=yuv420p,setsar=1`;

  // facecam-top: the detected facecam overlay is lifted to a top band and the
  // gameplay is stacked beneath it. Requires a facecam rect; otherwise the caller
  // should fall back to another fit.
  if (fit === "facecam-top" && isValidRect(facecam)) {
    return {
      filterComplex: facecamTopChain("[0:v]", "[vout]", w, h, facecam, gameplayRect, topFrac, fpsEnd),
      mapV: "[vout]",
    };
  }

  if (fit === "crop") {
    if (cropRect && isValidRect(cropRect)) {
      const { x, y, width, height } = cropRect;
      // Crop the source window first (expressed against input dims), then scale.
      return { vf: `crop=in_w*${width}:in_h*${height}:in_w*${x}:in_h*${y},scale=${w}:${h},${fpsEnd}` };
    }
    return { vf: `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${fpsEnd}` };
  }
  if (fit === "blur") {
    return {
      filterComplex:
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:2[bgb];` +
        `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,${fpsEnd}[vout]`,
      mapV: "[vout]",
    };
  }
  // default: pad (scale-to-fit + black bars) — never crops content
  return {
    vf: `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,${fpsEnd}`,
  };
}

/**
 * Re-encode a source video to a short-form-conforming output.
 * @param {string} inputPath  absolute path to source
 * @param {string} outputPath absolute path to write
 * @param {Object} options    overrides for DEFAULTS + optional { start, duration }
 * @returns {Promise<{outputPath, durationTarget, fit, hadAudioSource, fps, width, height}>}
 */
async function reencodeToShortForm(inputPath, outputPath, options = {}) {
  const cfg = withDefaults(options);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`source not found: ${inputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const meta = await probeSource(inputPath);

  // Plan duration: trim only when the source exceeds the max window.
  // An explicit options.duration wins (clamped to the max).
  let durationTarget = null;
  if (Number.isFinite(Number(options.duration))) {
    durationTarget = Math.min(Number(options.duration), cfg.maxDuration);
  } else if (meta.duration && meta.duration > cfg.maxDuration) {
    durationTarget = cfg.maxDuration;
  }
  const start = Number.isFinite(Number(options.start)) ? Number(options.start) : null;

  const { vf, filterComplex, mapV } = buildVideoFilter(
    cfg.fit, cfg.width, cfg.height, cfg.fps, options.cropRect || null,
    options.facecam || null, options.gameplayRect || null, options.facecamTopFrac
  );

  // Assemble ffmpeg args.
  const args = ["-y"];
  if (start !== null) args.push("-ss", String(start));
  args.push("-i", inputPath);

  // Only synthesize a silent track when the probe succeeded and confirmed the
  // source has no audio. If the probe failed (duration===null), meta.hasAudio
  // defaults to false but the source may still have audio — in that case skip
  // synthesis and let the optional "-map 0:a:0?" mapping handle it safely.
  const probeSucceeded = meta.duration !== null;
  const needSilentAudio = probeSucceeded && !meta.hasAudio;
  if (needSilentAudio) {
    args.push("-f", "lavfi", "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${cfg.sampleRate}`);
  }

  if (durationTarget !== null) args.push("-t", String(durationTarget));

  // Video filtergraph
  if (filterComplex) {
    args.push("-filter_complex", filterComplex, "-map", mapV);
  } else {
    args.push("-vf", vf, "-map", "0:v:0");
  }

  // Audio mapping
  if (needSilentAudio) {
    args.push("-map", `${filterComplex ? 1 : 1}:a:0`);
  } else {
    args.push("-map", "0:a:0?"); // optional in case probe was wrong
  }

  args.push(
    "-r", String(cfg.fps),
    "-c:v", "libx264", "-preset", cfg.preset, "-crf", String(cfg.crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", cfg.audioBitrate, "-ar", String(cfg.sampleRate),
    "-movflags", "+faststart",
  );
  if (needSilentAudio) args.push("-shortest");
  args.push(outputPath);

  await runFfmpeg(args, cfg.timeoutMs);

  if (!fs.existsSync(outputPath)) {
    throw new Error("ffmpeg completed but output file was not created");
  }

  return {
    outputPath,
    durationTarget,
    fit: cfg.fit,
    cropRect: cfg.fit === "crop" && isValidRect(options.cropRect || null) ? options.cropRect : null,
    hadAudioSource: meta.hasAudio,
    fps: cfg.fps,
    width: cfg.width,
    height: cfg.height,
  };
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      return reject(new Error(`failed to spawn ffmpeg: ${e.message}`));
    }
    let stderr = "";
    let settled = false;
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000); // keep tail only
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg re-encode timed out"));
    }, timeoutMs);
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg error: ${e.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.split("\n").slice(-4).join(" | ").trim()}`));
    });
  });
}

/**
 * Render a cut-list of source segments into a single short-form-conforming clip.
 * Each segment is trimmed from the source, mapped to the target frame with the
 * same fit filter, then concatenated. Produces exact target resolution, h264 +
 * aac (silence synthesized if the source has no audio), +faststart.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Array<{start:number,end:number}>} segments  source cut-list (seconds)
 * @param {Object} options  { width,height,fps,fit,cropRect,maxDuration }
 * @returns {Promise<{outputPath, segments:number, durationTarget, fit, hadAudioSource}>}
 */
async function renderSegments(inputPath, outputPath, segments, options = {}) {
  const cfg = withDefaults(options);
  if (!fs.existsSync(inputPath)) throw new Error(`source not found: ${inputPath}`);
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("no segments to render");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const meta = await probeSource(inputPath);
  const srcDur = meta.duration || Infinity;

  // Sanitize segments: clamp to source, drop empties, cap total to maxDuration.
  const clean = [];
  let total = 0;
  for (const s of segments) {
    const start = Math.max(0, Number(s.start) || 0);
    let end = Math.min(srcDur, Number(s.end) || 0);
    if (!(end > start)) continue;
    if (total + (end - start) > cfg.maxDuration) {
      end = start + Math.max(0, cfg.maxDuration - total); // trim last to fit cap
    }
    if (end > start) { clean.push({ start, end }); total += end - start; }
    if (total >= cfg.maxDuration) break;
  }
  if (clean.length === 0) throw new Error("no valid segments after clamping");

  // Per-segment frame filter. facecam-top builds a per-segment stack sub-graph;
  // blur falls back to pad for concat; pad/crop reuse the simple vf.
  const useFacecamTop = cfg.fit === "facecam-top" && isValidRect(options.facecam || null);
  const fctTail = `fps=${cfg.fps},format=yuv420p,setsar=1`;
  const { vf } = useFacecamTop
    ? { vf: null }
    : buildVideoFilter(cfg.fit === "blur" ? "pad" : cfg.fit, cfg.width, cfg.height, cfg.fps, options.cropRect || null);
  const hasAudio = meta.hasAudio;

  const chains = [];
  const concatInputs = [];
  clean.forEach((s, i) => {
    if (useFacecamTop) {
      chains.push(
        `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[seg${i}];` +
        facecamTopChain(`[seg${i}]`, `[v${i}]`, cfg.width, cfg.height, options.facecam, options.gameplayRect || null, options.facecamTopFrac, fctTail)
      );
    } else {
      chains.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS,${vf}[v${i}]`);
    }
    if (hasAudio) {
      chains.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,aresample=async=1[a${i}]`);
      concatInputs.push(`[v${i}][a${i}]`);
    } else {
      concatInputs.push(`[v${i}]`);
    }
  });
  chains.push(
    hasAudio
      ? `${concatInputs.join("")}concat=n=${clean.length}:v=1:a=1[v][a]`
      : `${concatInputs.join("")}concat=n=${clean.length}:v=1:a=0[v]`
  );
  const filterComplex = chains.join(";");

  const args = ["-y", "-i", inputPath];
  if (!hasAudio) args.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${cfg.sampleRate}`);
  args.push("-filter_complex", filterComplex, "-map", "[v]");
  args.push("-map", hasAudio ? "[a]" : "1:a");
  args.push(
    "-r", String(cfg.fps),
    "-c:v", "libx264", "-preset", cfg.preset, "-crf", String(cfg.crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", cfg.audioBitrate, "-ar", String(cfg.sampleRate),
    "-movflags", "+faststart"
  );
  if (!hasAudio) args.push("-shortest");
  args.push(outputPath);

  await runFfmpeg(args, cfg.timeoutMs);
  if (!fs.existsSync(outputPath)) throw new Error("ffmpeg completed but output file was not created");

  return {
    outputPath,
    segments: clean.length,
    durationTarget: Number(total.toFixed(3)),
    fit: cfg.fit === "blur" ? "pad" : cfg.fit,
    hadAudioSource: hasAudio,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Caption burning
// Post-processes an already-rendered video by overlaying captions via the
// ffmpeg libass subtitles filter. Writes a temp SRT, runs a re-encode pass,
// deletes the temp file. Non-destructive: on error, the original clip is intact.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Burn captions into a rendered video file using ffmpeg subtitles filter.
 * @param {string} inputPath   absolute path to the rendered clip (source)
 * @param {string} outputPath  absolute path to write (captions burned in)
 * @param {Array<{text:string, startTime:number, endTime:number}>} captions
 * @param {Object} opts  { timeoutMs }
 */
async function burnCaptionsToVideo(inputPath, outputPath, captions, opts = {}) {
  if (!Array.isArray(captions) || captions.length === 0) {
    await fs.promises.copyFile(inputPath, outputPath);
    return { burned: 0 };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpSrt = outputPath + ".burn.srt";
  fs.writeFileSync(tmpSrt, buildSRT(captions), "utf8");

  // ffmpeg subtitles filter path: on Windows, drive-letter colon must be escaped
  // (C:/path → C\:/path) after converting backslashes to forward slashes.
  const srtForFilter = tmpSrt.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\:");

  const timeoutMs = opts.timeoutMs || 10 * 60 * 1000;
  try {
    await runFfmpeg([
      "-y", "-i", inputPath,
      "-vf", `subtitles='${srtForFilter}':force_style='FontSize=36,Alignment=2,MarginV=100,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      outputPath,
    ], timeoutMs);
  } finally {
    try { fs.unlinkSync(tmpSrt); } catch {}
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error("burnCaptionsToVideo: ffmpeg completed but output not created");
  }
  return { burned: captions.length };
}

function buildSRT(captions) {
  return captions.map((c, i) => {
    const start = srtTime(c.startTime != null ? c.startTime : (c.start || 0));
    const end   = srtTime(c.endTime   != null ? c.endTime   : (c.end   || 0));
    const text  = String(c.text || "").replace(/\r?\n/g, " ");
    return `${i + 1}\n${start} --> ${end}\n${text}\n`;
  }).join("\n");
}

function srtTime(secs) {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
}
function p2(n) { return String(Math.floor(n)).padStart(2, "0"); }
function p3(n) { return String(Math.floor(n)).padStart(3, "0"); }

module.exports = { reencodeToShortForm, renderSegments, probeSource, buildVideoFilter, burnCaptionsToVideo, DEFAULTS };
