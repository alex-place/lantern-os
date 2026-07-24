// Gaming-layout debug overlay — renders QA frames showing what the editor sees:
//   GREEN  = detected facecam (only drawn when present)
//   BLUE   = gameplay safe zone (must always stay visible & centred)
//   RED    = unsafe edge strips a centre crop discards (gameplay must never live here)
// Saves a few frames to <outDir>/ for eyeballing before a render goes out.

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// The sacred gameplay box (RULE 1): centre 70% x 50% of the source.
const SAFE_GAMEPLAY_ZONE = { x: 0.15, y: 0.35, width: 0.70, height: 0.50 };

function box(rect, color, t = 4) {
  return `drawbox=x=iw*${rect.x}:y=ih*${rect.y}:w=iw*${rect.width}:h=ih*${rect.height}:color=${color}@0.9:t=${t}`;
}

function frame(videoPath, ts, vf, outFile) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(ts), "-i", videoPath, "-vf", vf, "-frames:v", "1", "-y", outFile]); }
    catch (_) { return resolve(false); }
    p.on("close", () => resolve(fs.existsSync(outFile)));
    p.on("error", () => resolve(false));
  });
}

async function saveLayoutDebug(videoPath, { facecam = null, outDir = "debug", timestamps = [1, 5, 9] } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const boxes = [
    box(SAFE_GAMEPLAY_ZONE, "blue"),                 // gameplay safe zone
    box({ x: 0, y: 0, width: 0.15, height: 1 }, "red", 2),     // unsafe left strip
    box({ x: 0.85, y: 0, width: 0.15, height: 1 }, "red", 2),  // unsafe right strip
  ];
  if (facecam && facecam.bounds) boxes.push(box(facecam.bounds, "green")); // detected facecam
  const vf = boxes.join(",");

  const names = ["frame_001.png", "frame_100.png", "frame_200.png"];
  const frames = [];
  for (let i = 0; i < timestamps.length && i < names.length; i++) {
    const out = path.join(outDir, names[i]);
    if (await frame(videoPath, timestamps[i], vf, out)) frames.push(out);
  }
  return { frames, safeZone: SAFE_GAMEPLAY_ZONE, facecam: facecam ? facecam.bounds : null, legend: { green: "facecam", blue: "gameplay safe zone", red: "unsafe (cropped) strips" } };
}

module.exports = { saveLayoutDebug, SAFE_GAMEPLAY_ZONE };
