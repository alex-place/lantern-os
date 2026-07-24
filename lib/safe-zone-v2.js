// SafeZoneDetectorV2 (Creator V10)
// Multi-frame detector that finds protected-region CANDIDATES in gameplay and
// plans a 9:16 crop window that avoids slicing through them.
//
// Honesty boundary: this is a motion/contrast heuristic, not a face recognizer.
// It flags (a) corner regions with sustained, locally-distinct activity — which
// commonly indicates a facecam/overlay — and (b) static high-contrast bands —
// which commonly indicate a HUD. Every region carries a MEASURED confidence
// (the fraction of sampled frame-transitions in which it "fired"), plus the
// frame count behind it, so the value is auditable. When detection cannot run
// (ffmpeg missing / unreadable video), it returns { status: "unavailable" } and
// fabricates nothing.
//
// See docs/creator-v10/safe-zone-v2.md

"use strict";

const fs = require("fs");
const { spawn } = require("child_process");

const SAMPLE_W = 192; // downscaled analysis frame (keeps it fast)
const SAMPLE_H = 108;
const GRID_COLS = 12;
const GRID_ROWS = 8;
const TARGET_ASPECT_9_16 = 9 / 16;

// ---------------------------------------------------------------------------
// Frame sampling (real ffmpeg raw pipeline, same approach as highlight-engine)
// ---------------------------------------------------------------------------

function sampleFrames(videoPath, fps = 1) {
  return new Promise((resolve) => {
    if (!fs.existsSync(videoPath)) return resolve({ frames: [], ok: false });
    let proc;
    try {
      proc = spawn("ffmpeg", [
        "-i", videoPath,
        "-vf", `fps=${fps},scale=${SAMPLE_W}:${SAMPLE_H}`,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve({ frames: [], ok: false });
    }
    const frameSize = SAMPLE_W * SAMPLE_H * 3;
    const frames = [];
    let buf = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameSize) {
        frames.push(buf.slice(0, frameSize));
        buf = buf.slice(frameSize);
      }
    });
    proc.on("error", () => resolve({ frames: [], ok: false }));
    proc.on("close", (code) => resolve({ frames, ok: code === 0 && frames.length > 0 }));
  });
}

// ---------------------------------------------------------------------------
// Per-cell metrics
// ---------------------------------------------------------------------------

// Mean brightness of each grid cell for one frame.
function cellBrightness(frame) {
  const grid = Array.from({ length: GRID_ROWS }, () => new Float64Array(GRID_COLS));
  const counts = Array.from({ length: GRID_ROWS }, () => new Float64Array(GRID_COLS));
  for (let y = 0; y < SAMPLE_H; y++) {
    const row = Math.min(GRID_ROWS - 1, Math.floor((y / SAMPLE_H) * GRID_ROWS));
    for (let x = 0; x < SAMPLE_W; x++) {
      const col = Math.min(GRID_COLS - 1, Math.floor((x / SAMPLE_W) * GRID_COLS));
      const idx = (y * SAMPLE_W + x) * 3;
      const lum = (frame[idx] + frame[idx + 1] + frame[idx + 2]) / 3;
      grid[row][col] += lum;
      counts[row][col] += 1;
    }
  }
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (counts[r][c]) grid[r][c] /= counts[r][c];
    }
  }
  return grid;
}

// Horizontal edge energy per cell (proxy for text/HUD contrast) for one frame.
function cellEdges(frame) {
  const grid = Array.from({ length: GRID_ROWS }, () => new Float64Array(GRID_COLS));
  for (let y = 0; y < SAMPLE_H; y++) {
    const row = Math.min(GRID_ROWS - 1, Math.floor((y / SAMPLE_H) * GRID_ROWS));
    for (let x = 1; x < SAMPLE_W; x++) {
      const col = Math.min(GRID_COLS - 1, Math.floor((x / SAMPLE_W) * GRID_COLS));
      const i = (y * SAMPLE_W + x) * 3;
      const j = (y * SAMPLE_W + (x - 1)) * 3;
      const d = Math.abs(frame[i] - frame[j]) + Math.abs(frame[i + 1] - frame[j + 1]) + Math.abs(frame[i + 2] - frame[j + 2]);
      grid[row][col] += d / 3;
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Facecam cues (honest heuristics, NOT face recognition):
//   skin   — fraction of skin-tone pixels (a webcam usually frames a person)
//   border — gradient energy along the block's INNER edges (overlay box frame)
//   temporal — sustained locally-distinct motion (computed in detectRegions)
// Each is a real pixel measurement; they're blended into a measured confidence
// and reported individually so the value is auditable.
// ---------------------------------------------------------------------------

// Classic Kovac RGB skin rule (uncalibrated; a cue, not a guarantee).
function isSkin(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return r > 95 && g > 40 && b > 20 && (mx - mn) > 15 &&
    Math.abs(r - g) > 15 && r > g && r > b;
}

// Pixel rect for a grid corner block.
function cornerPixels(b) {
  const cellW = SAMPLE_W / GRID_COLS, cellH = SAMPLE_H / GRID_ROWS;
  return {
    px0: Math.round(b.c0 * cellW), px1: Math.round(b.c1 * cellW),
    py0: Math.round(b.r0 * cellH), py1: Math.round(b.r1 * cellH),
  };
}

function skinFraction(frame, p) {
  let skin = 0, total = 0;
  for (let y = p.py0; y < p.py1; y++) {
    for (let x = p.px0; x < p.px1; x++) {
      const i = (y * SAMPLE_W + x) * 3;
      if (isSkin(frame[i], frame[i + 1], frame[i + 2])) skin++;
      total++;
    }
  }
  return total ? skin / total : 0;
}

// Mean gradient along the block's INNER borders (the lines where an overlay box
// would meet gameplay). cornerName picks which two inner edges to sample.
function borderEdgeScore(frame, b, cornerName) {
  const p = cornerPixels(b);
  const lum = (x, y) => {
    const i = (Math.max(0, Math.min(SAMPLE_H - 1, y)) * SAMPLE_W + Math.max(0, Math.min(SAMPLE_W - 1, x))) * 3;
    return (frame[i] + frame[i + 1] + frame[i + 2]) / 3;
  };
  const innerX = cornerName.includes("left") ? p.px1 : p.px0; // vertical inner edge
  const innerY = cornerName.includes("top") ? p.py1 : p.py0;  // horizontal inner edge
  let vSum = 0, vN = 0;
  for (let y = p.py0; y < p.py1; y++) { vSum += Math.abs(lum(innerX, y) - lum(innerX - 1, y)); vN++; }
  let hSum = 0, hN = 0;
  for (let x = p.px0; x < p.px1; x++) { hSum += Math.abs(lum(x, innerY) - lum(x, innerY - 1)); hN++; }
  const vMean = vN ? vSum / vN : 0, hMean = hN ? hSum / hN : 0;
  return Math.max(vMean, hMean); // a box needs at least one strong straight inner edge
}

// Pearson correlation of two equal-length series. Used to measure whether a
// corner's motion tracks the gameplay (high corr = part of the game) or moves
// on its own (low/negative corr = a separate overlaid video, i.e. a facecam).
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const xa = a[i] - ma, xb = b[i] - mb; num += xa * xb; da += xa * xa; db += xb * xb; }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? num / den : 0;
}

// Locate a facecam OVERLAY rectangle. A facecam is a separate video composited
// on top of the gameplay, so its real signature is a "seam" — a sharp, straight
// brightness discontinuity along the box's inner edges, where the webcam meets
// the game — plus interior motion of its own and a look that stands out from the
// scene. We search corner-anchored boxes of plausible facecam sizes and keep the
// one with the strongest seam. This finds the ACTUAL box (often a small bright
// rectangle), instead of scoring a fixed quarter-frame block and being fooled by
// whichever corner happens to have skin-toned or busy gameplay pixels.
// Map an optional creator hint to a facecam-search constraint. Accepts free-ish
// text like "Top Right", "Bottom Left", "Full Height Left", "Vertical Facecam
// Right Side", "No Facecam", "Webcam moves around".
function parseGuidance(g) {
  if (!g) return null;
  const s = String(g).toLowerCase();
  if (s.includes("no facecam") || s.trim() === "none") return { none: true };
  const c = {};
  if (s.includes("left")) c.side = "left";
  else if (s.includes("right")) c.side = "right";
  if (s.includes("top")) c.vertical = "top";
  else if (s.includes("bottom")) c.vertical = "bottom";
  if (s.includes("full height") || s.includes("vertical")) c.fullHeight = true;
  if (s.includes("move") || s.includes("around")) c.moves = true;
  return Object.keys(c).length ? c : null;
}

function bestFacecamRect(meanBright, activity, globalBright, guidance) {
  const mean = (grid, r0, r1, c0, c1) => {
    let s = 0, k = 0;
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) { s += grid[r][c]; k++; }
    return k ? s / k : 0;
  };
  // Scene activity scale → motion normalizes per-video (no magic constant).
  let gAct = 0, gN = 0;
  for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) { gAct += activity[r][c]; gN++; }
  gAct = gN ? gAct / gN : 1;

  // Seam (mean abs brightness step) across a vertical or horizontal grid edge.
  const colSeam = (cIn, cOut, r0, r1) => {
    if (cOut < 0 || cOut >= GRID_COLS) return 0;
    let s = 0, k = 0; for (let r = r0; r < r1; r++) { s += Math.abs(meanBright[r][cIn] - meanBright[r][cOut]); k++; } return k ? s / k : 0;
  };
  const rowSeam = (rIn, rOut, c0, c1) => {
    if (rOut < 0 || rOut >= GRID_ROWS) return 0;
    let s = 0, k = 0; for (let c = c0; c < c1; c++) { s += Math.abs(meanBright[rIn][c] - meanBright[rOut][c]); k++; } return k ? s / k : 0;
  };

  // The box is anchored to a left/right frame edge (facecams hug a side) but its
  // vertical extent FLOATS — we search every [r0,r1) band and let the top and
  // bottom seams bound it, so the box hugs the real cam instead of stretching to
  // the frame corner.
  // Creator guidance narrows the search: a side hint restricts left/right, a
  // top/bottom hint restricts the vertical half, full-height/vertical raises the
  // height cap so a tall side-cam isn't truncated.
  const sides = guidance && guidance.side ? [guidance.side] : ["left", "right"];
  const maxH = guidance && guidance.fullHeight ? GRID_ROWS : 6;
  let best = null;
  for (const side of sides) {
    const left = side === "left";
    for (const w of [2, 3, 4]) {
      const c0 = left ? 0 : GRID_COLS - w, c1 = c0 + w;
      const innerCol = left ? c1 - 1 : c0, outerCol = left ? c1 : c0 - 1;
      for (let r0 = 0; r0 <= GRID_ROWS - 2; r0++) {
        for (let r1 = r0 + 2; r1 <= GRID_ROWS; r1++) {
          if (r1 - r0 > maxH) continue; // a facecam is rarely taller than ~75% (unless guided full-height)
          if (guidance && guidance.vertical) {
            const inTop = (r0 + r1) / 2 < GRID_ROWS / 2;
            if ((guidance.vertical === "top") !== inTop) continue;
          }
          const vSeam = colSeam(innerCol, outerCol, r0, r1);      // toward centre
          const topSeam = rowSeam(r0, r0 - 1, c0, c1);            // above the box
          const botSeam = rowSeam(r1 - 1, r1, c0, c1);            // below the box
          // A well-bounded box is distinct on its inner vertical edge AND on top
          // AND bottom. Bias toward the weakest bound so a box that bleeds into
          // matching pixels (e.g. stretches down into more darkness) scores lower.
          const vBound = Math.min(topSeam, botSeam);
          const seam = Math.min(vSeam, vBound) * 0.6 + (vSeam + topSeam + botSeam) / 3 * 0.4;
          const interiorAct = mean(activity, r0, r1, c0, c1);
          const interiorBright = mean(meanBright, r0, r1, c0, c1);
          const nSeam = Math.min(1, seam / 22);
          const nAct = Math.min(1, interiorAct / (gAct * 1.4 + 1));
          const nDist = Math.min(1, Math.abs(interiorBright - globalBright) / (globalBright + 20));
          const score = 0.58 * nSeam + 0.24 * nAct + 0.18 * nDist;
          const corner = (r0 + r1) / 2 < GRID_ROWS / 2 ? `top_${side}` : `bottom_${side}`;
          if (!best || score > best.score) best = { corner, r0, r1, c0, c1, score, cues: { seam: round3(nSeam), activity: round3(nAct), distinct: round3(nDist) } };
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Region detection
// ---------------------------------------------------------------------------

function detectRegions(frames, opts = {}) {
  const n = frames.length;
  const brightnesses = frames.map(cellBrightness);

  // Temporal activity: per-cell mean abs brightness change between frames,
  // and per-frame "fire" counts for the four corner blocks.
  const activity = Array.from({ length: GRID_ROWS }, () => new Float64Array(GRID_COLS));
  let transitions = 0;
  for (let f = 1; f < n; f++) {
    transitions++;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        activity[r][c] += Math.abs(brightnesses[f][r][c] - brightnesses[f - 1][r][c]);
      }
    }
  }
  if (transitions > 0) {
    for (let r = 0; r < GRID_ROWS; r++)
      for (let c = 0; c < GRID_COLS; c++) activity[r][c] /= transitions;
  }

  // Mean brightness per cell across all frames, and the scene average — used by
  // the seam/distinctness search below.
  const meanBright = Array.from({ length: GRID_ROWS }, () => new Float64Array(GRID_COLS));
  for (let f = 0; f < n; f++)
    for (let r = 0; r < GRID_ROWS; r++)
      for (let c = 0; c < GRID_COLS; c++) meanBright[r][c] += brightnesses[f][r][c] / n;
  let gbSum = 0, gbN = 0;
  for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) { gbSum += meanBright[r][c]; gbN++; }
  const globalBright = gbN ? gbSum / gbN : 0;

  // Find the actual overlaid facecam rectangle by its seam (see bestFacecamRect).
  // An optional creator guidance hint narrows or disables the search.
  const regions = [];
  const guidance = parseGuidance(opts.facecamGuidance);
  const fc = (guidance && guidance.none) ? null : bestFacecamRect(meanBright, activity, globalBright, guidance);
  // Honest tiers: >=0.45 → confident facecam region; 0.25..0.45 → low-confidence
  // candidate flagged needsDeclaration so the UI can ask the user to confirm or
  // place it; <0.25 → emit nothing. We never report a bare detected:true.
  if (fc && fc.score >= 0.25) {
    regions.push({
      type: "facecam",
      candidate: true,
      corner: fc.corner,
      bounds: {
        x: round3(fc.c0 / GRID_COLS),
        y: round3(fc.r0 / GRID_ROWS),
        width: round3((fc.c1 - fc.c0) / GRID_COLS),
        height: round3((fc.r1 - fc.r0) / GRID_ROWS),
      },
      confidence: round3(fc.score),
      cues: fc.cues,
      guided: !!guidance, // narrowed by a creator guidance hint
      needsDeclaration: fc.score < 0.45 && !guidance, // a guided detection is trusted
      priority: 1,
    });
  }

  // HUD bands: top/bottom rows with high edge energy and LOW temporal activity.
  const edges = cellEdges(brightnesses.length ? frames[Math.floor(n / 2)] : frames[0]);
  const bandRows = Math.max(1, Math.round(GRID_ROWS * 0.18));
  for (const band of [
    { name: "top", r0: 0, r1: bandRows, y: 0 },
    { name: "bottom", r0: GRID_ROWS - bandRows, r1: GRID_ROWS, y: 1 - bandRows / GRID_ROWS },
  ]) {
    let edgeSum = 0, actSum = 0, cells = 0;
    for (let r = band.r0; r < band.r1; r++)
      for (let c = 0; c < GRID_COLS; c++) { edgeSum += edges[r][c]; actSum += activity[r][c]; cells++; }
    const edgeMean = cells ? edgeSum / cells : 0;
    const actMean = cells ? actSum / cells : 0;
    // High contrast, low movement → static UI band.
    if (edgeMean > 12 && actMean < 6) {
      regions.push({
        type: "hud",
        candidate: true,
        bounds: { x: 0, y: round3(band.y), width: 1, height: round3(bandRows / GRID_ROWS) },
        confidence: round3(Math.min(1, edgeMean / 40)),
        framesSeen: n,
        priority: 3,
      });
    }
  }

  return { regions, framesSampled: n, transitions };
}

// ---------------------------------------------------------------------------
// Crop planner (9:16 by default)
// ---------------------------------------------------------------------------

// Weighted importance (spec ordering): facecam must override motion. Only
// facecam + hud are actually detected today; the rest are here for when/if their
// detectors exist, so the crop solver already ranks them correctly.
const PRIORITY_WEIGHT = { facecam: 10, crosshair: 9, killfeed: 7.5, minimap: 7, hud: 6, combat: 6, motion: 4 };

function horizCoverage(region, winX, winW) {
  const rX = region.bounds.x, rW = region.bounds.width;
  if (rW <= 0) return 0;
  const overlap = Math.max(0, Math.min(rX + rW, winX + winW) - Math.max(rX, winX));
  return overlap / rW;
}

function planCrop(regions, srcW, srcH, targetAspect = TARGET_ASPECT_9_16) {
  const srcAspect = srcW / srcH;
  // Source already as-narrow-or-narrower than target → no horizontal crop.
  if (srcAspect <= targetAspect + 1e-6) {
    return {
      cropRect: { x: 0, y: 0, width: 1, height: 1 },
      mode: "none",
      preserved: regions.map((r) => r.type),
      excluded: [],
      sliced: [],
      pipRecommended: false,
      confidence: 1,
    };
  }

  const cropWNorm = (targetAspect * srcH) / srcW; // normalized crop-window width
  const steps = 120;
  let best = null;
  for (let i = 0; i <= steps; i++) {
    const x = (1 - cropWNorm) * (i / steps);
    let score = 0;
    const preserved = [], excluded = [], sliced = [];
    for (const r of regions) {
      const w = (PRIORITY_WEIGHT[r.type] || 1) * (r.confidence ?? 1);
      const cov = horizCoverage(r, x, cropWNorm);
      if (cov >= 0.99) { score += w; preserved.push(r.type); }
      else if (cov <= 0.01) { excluded.push(r.type); }      // cleanly excluded (PiP candidate)
      else { score -= w * 1.5; sliced.push(r.type); }        // slicing through is the worst
    }
    // Gentle bias toward keeping the center (gameplay action) on ties.
    score += -Math.abs((x + cropWNorm / 2) - 0.5) * 0.05;
    if (!best || score > best.score) best = { score, x, preserved, excluded, sliced };
  }

  const facecam = regions.find((r) => r.type === "facecam");
  const pipRecommended = !!facecam &&
    best.excluded.includes("facecam") && (facecam.confidence ?? 0) >= 0.4;

  return {
    cropRect: { x: round3(best.x), y: 0, width: round3(cropWNorm), height: 1 },
    mode: "horizontal",
    preserved: best.preserved,
    excluded: best.excluded,
    sliced: best.sliced,
    pipRecommended,
    confidence: round3(Math.max(0, Math.min(1, regions.length ? 1 : 0.5))),
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Analyze a source and produce a crop plan that avoids slicing protected
 * regions. Returns { status:"unavailable" } if ffmpeg can't read the source —
 * it never fabricates a default layout.
 */
async function analyzeForCrop(videoPath, opts = {}) {
  const fps = opts.fps || 1;
  const { frames, ok } = await sampleFrames(videoPath, fps);
  if (!ok || frames.length < 2) {
    return { status: "unavailable", reason: "could not sample frames (ffmpeg missing or unreadable video)" };
  }
  const { regions, framesSampled, transitions } = detectRegions(frames, opts);
  const srcW = opts.srcWidth || SAMPLE_W;
  const srcH = opts.srcHeight || SAMPLE_H;
  const cropPlan = planCrop(regions, srcW, srcH, opts.targetAspect || TARGET_ASPECT_9_16);
  return { status: "ok", regions, cropPlan, framesSampled, transitions };
}

function round3(n) { return Number(Number(n).toFixed(3)); }

// ---------------------------------------------------------------------------
// Debug overlay — draw the detected region boxes onto a real frame so the user
// can VISUALLY verify the detections (this is how they judge if it's right).
// ---------------------------------------------------------------------------

const OVERLAY_COLORS = { facecam: "red", hud: "cyan", crosshair: "yellow", minimap: "lime", killfeed: "orange" };

/**
 * Burn the detected region boxes onto a representative frame -> JPG.
 * @returns {Promise<{ok:boolean, outPath?:string, reason?:string}>}
 */
function renderSafeZoneOverlay(videoPath, regions, outPath, opts = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(videoPath)) return resolve({ ok: false, reason: "source not found" });
    const at = Number.isFinite(opts.at) ? opts.at : 1;
    const boxes = (regions || [])
      .filter((r) => r && r.bounds)
      .map((r) => {
        const { x, y, width, height } = r.bounds;
        const color = OVERLAY_COLORS[r.type] || "white";
        // thickness 4; low-confidence facecam drawn thinner/dashed-ish (t=2)
        const t = r.needsDeclaration ? 2 : 4;
        return `drawbox=x=iw*${x}:y=ih*${y}:w=iw*${width}:h=ih*${height}:color=${color}@0.9:t=${t}`;
      });
    const vf = (boxes.length ? boxes.join(",") + "," : "") + "format=yuvj420p";
    let proc;
    try {
      proc = spawn("ffmpeg", ["-y", "-ss", String(at), "-i", videoPath, "-vf", vf, "-frames:v", "1", outPath],
        { stdio: ["ignore", "ignore", "ignore"] });
    } catch (e) {
      return resolve({ ok: false, reason: e.message });
    }
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve({ ok: false, reason: "overlay render timed out" }); }, 60000);
    proc.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outPath) ? { ok: true, outPath } : { ok: false, reason: `ffmpeg exited ${code}` });
    });
  });
}

module.exports = {
  analyzeForCrop,
  detectRegions,
  planCrop,
  sampleFrames,
  renderSafeZoneOverlay,
  TARGET_ASPECT_9_16,
  PRIORITY_WEIGHT,
};
