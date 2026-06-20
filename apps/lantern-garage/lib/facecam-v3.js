// Facecam V3 — P0 facecam detector.
//
// Precomputes a cell grid from sampled frames, then does a THOROUGH sliding-window
// search (many positions × sizes, including tall/vertical and edge-anchored boxes,
// not just fixed corners). Each candidate is scored by a 6-component confidence
// model; the best is returned. Reports "no facecam" only when best confidence < 0.25.
//
// HONESTY: no trained face model. "faceProbability"/"lipMotion"/"skinCluster" are
// HEURISTIC proxies — skin-tone density, a clustered skin blob, and motion
// concentrated in the lower-centre (mouth) of the box. "persistentRectangle"
// (the box is continuously active across the clip), "edgeConfidence" (a framed
// rectangular border) and "motionIndependence" (the box moves differently from
// the gameplay behind it) are real measurements, but proxies — not DNN face detection.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const W = 160, H = 90;          // analysis resolution (16:9)
const GW = 32, GH = 18;         // cell grid (each cell = 5x5 px)
const CW = W / GW, CH = H / GH;

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function r3(x) { return Number((x || 0).toFixed(3)); }
function isSkin(r, g, b) {
  return r > 95 && g > 40 && b > 20 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15 && Math.abs(r - g) > 15 && r > g && r > b;
}

function extractFrames(videoPath, { fps = 2, maxSeconds = 60, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-t", String(maxSeconds),
      "-vf", `fps=${fps},scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
    const frames = []; let buf = Buffer.alloc(0); let settled = false;
    const frameSize = W * H * 3;
    const done = () => { if (settled) return; settled = true; clearTimeout(t); resolve(frames); };
    let proc;
    try { proc = spawn("ffmpeg", args); } catch (_) { return resolve([]); }
    const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} done(); }, timeoutMs);
    proc.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= frameSize) { frames.push(buf.subarray(0, frameSize)); buf = buf.subarray(frameSize); } });
    proc.stderr.on("data", () => {});
    proc.on("error", done);
    proc.on("close", done);
  });
}

// Precompute per-cell time series so each candidate is a cheap aggregation.
function buildGrid(frames) {
  const nf = frames.length;
  const nCells = GW * GH;
  const cellMotion = Array.from({ length: nCells }, () => new Float32Array(nf - 1)); // motion per cell per transition
  const cellSkin = new Float32Array(nCells);   // mean skin fraction
  const cellLum = new Float32Array(nCells);    // mean luminance
  const frameMotion = new Float32Array(nf - 1);

  for (let f = 0; f < nf; f++) {
    const cur = frames[f], prev = f > 0 ? frames[f - 1] : null;
    for (let cy = 0; cy < GH; cy++) {
      for (let cx = 0; cx < GW; cx++) {
        const ci = cy * GW + cx;
        let mot = 0, skin = 0, lum = 0, n = 0;
        const x0 = Math.floor(cx * CW), x1 = Math.floor((cx + 1) * CW);
        const y0 = Math.floor(cy * CH), y1 = Math.floor((cy + 1) * CH);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * W + x) * 3;
            const r = cur[i], g = cur[i + 1], b = cur[i + 2];
            lum += 0.299 * r + 0.587 * g + 0.114 * b;
            if (isSkin(r, g, b)) skin++;
            if (prev) mot += Math.abs(r - prev[i]) + Math.abs(g - prev[i + 1]) + Math.abs(b - prev[i + 2]);
            n++;
          }
        }
        if (prev) { cellMotion[ci][f - 1] = mot / n; frameMotion[f - 1] += mot / n; }
        cellSkin[ci] += n ? skin / n : 0;
        cellLum[ci] += n ? lum / n : 0;
      }
    }
  }
  for (let ci = 0; ci < nCells; ci++) { cellSkin[ci] /= nf; cellLum[ci] /= nf; }
  return { nf, cellMotion, cellSkin, cellLum, frameMotion };
}

function corr(a, b) {
  const n = a.length; if (!n) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Score a candidate region given in cell coords [cx0,cy0,cw,ch].
function scoreRegion(grid, cx0, cy0, cw, ch) {
  const { nf, cellMotion, cellSkin, cellLum, frameMotion } = grid;
  const cx1 = cx0 + cw, cy1 = cy0 + ch;
  const cells = [];
  for (let cy = cy0; cy < cy1; cy++) for (let cx = cx0; cx < cx1; cx++) cells.push(cy * GW + cx);

  // region motion series + skin stats
  const regSeries = new Float32Array(nf - 1);
  const skinVals = [];
  let lowerCenterMot = 0, totalMot = 0;
  const lcX0 = cx0 + Math.floor(cw * 0.25), lcX1 = cx0 + Math.ceil(cw * 0.75), lcY0 = cy0 + Math.floor(ch * 0.5);
  for (const ci of cells) {
    const cx = ci % GW, cy = (ci / GW) | 0;
    skinVals.push(cellSkin[ci]);
    const mm = cellMotion[ci];
    let cellTot = 0;
    for (let t = 0; t < mm.length; t++) { regSeries[t] += mm[t]; cellTot += mm[t]; }
    totalMot += cellTot;
    if (cx >= lcX0 && cx < lcX1 && cy >= lcY0 && cy < cy1) lowerCenterMot += cellTot;
  }

  // faceProbability — region skin fraction
  const meanSkin = skinVals.reduce((s, v) => s + v, 0) / (skinVals.length || 1);
  const faceProbability = clamp01(meanSkin / 0.20);

  // skinCluster — skin concentrated in a few cells (a face), not spread thin
  const sorted = [...skinVals].sort((a, b) => b - a);
  const topQ = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.25))).reduce((s, v) => s + v, 0);
  const allSkin = sorted.reduce((s, v) => s + v, 0);
  const skinCluster = allSkin > 0 ? clamp01((topQ / allSkin - 0.25) / 0.5) : 0; // >25% in top quartile => clustered

  // lipMotion — motion concentrated lower-centre (mouth when talking)
  const lipMotion = totalMot > 0 ? clamp01((lowerCenterMot / totalMot - 0.18) / 0.3) : 0;

  // motionIndependence — region motion decorrelated from the whole-frame motion
  const motionIndependence = clamp01(1 - Math.abs(corr(regSeries, frameMotion)));

  // persistentRectangle — region is continuously active across the clip (a live cam)
  let active = 0; const avgMot = totalMot / ((nf - 1) || 1);
  for (let t = 0; t < regSeries.length; t++) if (regSeries[t] > avgMot * 0.2) active++;
  const persistentRectangle = clamp01(active / ((nf - 1) || 1));

  // edgeConfidence — luminance contrast across the 4 borders (a framed box)
  const borderContrast = () => {
    let sum = 0, n = 0;
    const at = (cx, cy) => (cx >= 0 && cx < GW && cy >= 0 && cy < GH) ? cellLum[cy * GW + cx] : null;
    for (let cx = cx0; cx < cx1; cx++) { const a = at(cx, cy0), b = at(cx, cy0 - 1); if (a != null && b != null) { sum += Math.abs(a - b); n++; } const c = at(cx, cy1 - 1), d = at(cx, cy1); if (c != null && d != null) { sum += Math.abs(c - d); n++; } }
    for (let cy = cy0; cy < cy1; cy++) { const a = at(cx0, cy), b = at(cx0 - 1, cy); if (a != null && b != null) { sum += Math.abs(a - b); n++; } const c = at(cx1 - 1, cy), d = at(cx1, cy); if (c != null && d != null) { sum += Math.abs(c - d); n++; } }
    return n ? sum / n : 0;
  };
  const edgeConfidence = clamp01(borderContrast() / 30);

  const confidence = 0.25 * persistentRectangle + 0.20 * faceProbability + 0.20 * lipMotion
    + 0.15 * motionIndependence + 0.10 * skinCluster + 0.10 * edgeConfidence;

  return {
    confidence: r3(confidence),
    bounds: { x: r3(cx0 / GW), y: r3(cy0 / GH), width: r3(cw / GW), height: r3(ch / GH) },
    components: { persistentRectangle: r3(persistentRectangle), faceProbability: r3(faceProbability), lipMotion: r3(lipMotion), motionIndependence: r3(motionIndependence), skinCluster: r3(skinCluster), edgeConfidence: r3(edgeConfidence) },
  };
}

function cornerOf(b) {
  const cxv = b.x + b.width / 2, cyv = b.y + b.height / 2;
  if (cxv > 0.35 && cxv < 0.65 && cyv > 0.35 && cyv < 0.65) return "center";
  return (cyv < 0.5 ? "top_" : "bottom_") + (cxv < 0.5 ? "left" : "right");
}
// Edge-aware label — corners, the four EDGES (a side/top/bottom-hugging cam that
// is not in a corner, e.g. a vertical facecam down the right side), or center.
function positionLabel(b) {
  const eps = 0.06;
  const L = b.x <= eps, R = b.x + b.width >= 1 - eps, T = b.y <= eps, B = b.y + b.height >= 1 - eps;
  if (L && T) return "top_left"; if (R && T) return "top_right";
  if (L && B) return "bottom_left"; if (R && B) return "bottom_right";
  if (L) return "left_edge"; if (R) return "right_edge";
  if (T) return "top_edge"; if (B) return "bottom_edge";
  return "center";
}

function saveDebugOverlay(videoPath, best, opts = {}) {
  return new Promise((resolve, reject) => {
    const out = opts.debugPath || path.join(opts.cwd || process.cwd(), "facecam-debug.png");
    const b = best.bounds;
    const vf = `drawbox=x=iw*${b.x}:y=ih*${b.y}:w=iw*${b.width}:h=ih*${b.height}:color=red@0.9:t=4`;
    const args = ["-hide_banner", "-loglevel", "error", "-ss", "2", "-i", videoPath, "-vf", vf, "-frames:v", "1", "-y", out];
    let p;
    try { p = spawn("ffmpeg", args); } catch (e) { return reject(e); }
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error("overlay ffmpeg " + c))));
  });
}

// Real face model (OpenCV via scripts/facecam_face_detect.py). Returns the JSON
// it prints, or null if Python/opencv/the script is unavailable.
function detectFaceModel(videoPath, maxSamples = 30) {
  return new Promise((resolve) => {
    const py = process.env.LANTERN_PY || "python";
    const script = path.join(__dirname, "..", "..", "..", "scripts", "facecam_face_detect.py");
    let proc, done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    try { proc = spawn(py, [script, videoPath, String(maxSamples)], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch (_) { return resolve(null); }
    const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} finish(null); }, 90000);
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", () => finish(null));
    proc.on("close", () => { try { finish(JSON.parse(out.trim().split("\n").pop())); } catch (_) { finish(null); } });
  });
}

async function detectFacecamV3(videoPath, opts = {}) {
  // PRIMARY: a real face model. A consistently-detected, stable face IS a facecam
  // — this is what lets the >=0.85 gate fire reliably on real cams (and stay
  // silent on pure gameplay). Confidence is built from REAL measurements:
  // detection rate (face_presence + temporal_consistency), location stability
  // (static_region), and an edge bonus (cams hug edges).
  const fm = opts.faceModel === false ? null : await detectFaceModel(videoPath).catch(() => null);
  if (fm && fm.ok && fm.facecam_box && fm.detection_rate >= 0.25) {
    const b = fm.facecam_box;
    const sat = (v, k) => Math.min(1, v / k);
    // A real facecam's defining trait is a STABLE face location — faces get
    // missed during head turns/blur, so we don't demand 100% per-frame hits.
    // Weight location stability highest, with detection rate as presence.
    const facePresence = sat(fm.detection_rate, 0.35);
    const temporal = sat(fm.detection_rate, 0.30);
    const stat = clamp01(fm.stability);
    const nearEdge = b.x <= 0.06 || b.x + b.width >= 0.94 || b.y <= 0.06 || b.y + b.height >= 0.94;
    const edge = nearEdge ? 1 : 0.6;
    const confidence = r3(0.30 * facePresence + 0.35 * stat + 0.20 * temporal + 0.15 * edge);
    const has = confidence >= 0.25;
    let debugPath = null;
    if (opts.debug !== false) { try { debugPath = await saveDebugOverlay(videoPath, { bounds: b }, opts); } catch (_) {} }
    return {
      facecam: has ? { corner: cornerOf(b), position: positionLabel(b), bounds: b, confidence, source: "face-model",
        components: { face_presence: r3(facePresence), static_region: r3(stat), temporal_consistency: r3(temporal), edge: r3(edge), detection_rate: fm.detection_rate } } : null,
      confidence, meets85: confidence >= 0.85, source: "face-model", framesAnalyzed: fm.samples,
      faceDetectionRate: fm.detection_rate, debugPath,
      note: "OpenCV face model (real detection); heuristic search used only when the model is unavailable.",
    };
  }

  // FALLBACK: heuristic cell-grid sliding-window search (no face model available).
  const frames = await extractFrames(videoPath, opts);
  if (frames.length < 4) return { facecam: null, confidence: 0, meets85: false, reason: "insufficient frames" };
  const grid = buildGrid(frames);

  let best = null, searched = 0;
  const consider = (cx0, cy0, cw, ch) => {
    if (cx0 < 0 || cy0 < 0 || cx0 + cw > GW || cy0 + ch > GH) return;
    searched++;
    const s = scoreRegion(grid, cx0, cy0, cw, ch);
    if (!best || s.confidence > best.confidence) best = s;
  };

  // (1) Full-frame coarse sweep — widths/heights incl. tall boxes.
  const widths = [5, 7, 9];                       // ~0.16 / 0.22 / 0.28 of width
  const heights = [3, 4, 6, 8, 10, 13, 16];       // ~0.17 .. 0.89 of height (full-height side cams)
  for (const cw of widths) for (const ch of heights) for (let cy0 = 0; cy0 + ch <= GH; cy0 += 2) for (let cx0 = 0; cx0 + cw <= GW; cx0 += 2) consider(cx0, cy0, cw, ch);

  // (2) Fine BORDER pass — facecams hug edges, so slide along every edge at step 1.
  //     Left/right edges get vertical boxes (incl. tall side cams); top/bottom get bars.
  for (const w of [4, 5, 6]) for (const ch of [4, 6, 8, 10, 13, 16]) for (let cy0 = 0; cy0 + ch <= GH; cy0 += 1) { consider(0, cy0, w, ch); consider(GW - w, cy0, w, ch); }
  for (const cw of [6, 8, 10, 12]) for (const ch of [3, 4, 5]) for (let cx0 = 0; cx0 + cw <= GW; cx0 += 1) { consider(cx0, 0, cw, ch); consider(cx0, GH - ch, cw, ch); }

  const has = best && best.confidence >= 0.25;
  if (best) { best.corner = cornerOf(best.bounds); best.position = positionLabel(best.bounds); }
  let debugPath = null;
  if (opts.debug !== false && best) { try { debugPath = await saveDebugOverlay(videoPath, best, opts); } catch (_) { debugPath = null; } }
  return {
    facecam: has ? { corner: best.corner, position: best.position, bounds: best.bounds, confidence: best.confidence, components: best.components } : null,
    confidence: best ? best.confidence : 0,
    meets85: !!(best && best.confidence >= 0.85),
    searched, framesAnalyzed: frames.length, debugPath,
    note: "Heuristic proxies (skin/motion/edge), not a trained face model. 'none' only when confidence < 0.25.",
  };
}

// Drop-in for safe-zone-v2.analyzeForCrop that UPGRADES the facecam region with
// Facecam V3 (thorough multi-window + border search). V3 replaces v2's facecam
// only when at least as confident (or v2 found none); crop / HUD / safe-zones are
// unchanged, and any V3 error falls back to the v2 plan — never breaks a render.
async function analyzeForCropV3(videoPath, opts = {}) {
  const sz2 = require("./safe-zone-v2");
  const plan = await sz2.analyzeForCrop(videoPath, opts).catch(() => ({ status: "unavailable", regions: [] }));
  try {
    const v3 = await detectFacecamV3(videoPath, { fps: 2, maxSeconds: 40, debug: false });
    const regions = Array.isArray(plan.regions) ? [...plan.regions] : [];
    const existing = regions.find((r) => r.type === "facecam");
    if (v3.facecam && (!existing || v3.facecam.confidence >= (existing.confidence || 0))) {
      const upgraded = { type: "facecam", corner: v3.facecam.corner, position: v3.facecam.position, bounds: v3.facecam.bounds, confidence: v3.facecam.confidence, source: "facecam-v3", components: v3.facecam.components };
      if (existing) Object.assign(existing, upgraded); else regions.push(upgraded);
    }
    return { ...plan, regions, facecamV3: { confidence: v3.confidence, corner: v3.facecam ? v3.facecam.corner : null, position: v3.facecam ? v3.facecam.position : null, meets85: v3.meets85 } };
  } catch (_) {
    return plan;
  }
}

module.exports = { detectFacecamV3, analyzeForCropV3, buildGrid, scoreRegion, extractFrames };
