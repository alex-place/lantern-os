const { spawn } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, ".");

function buildThreeDoorsImagePrompt({ cleanText, doors, symbolMesh }) {
  return [
    "Lantern OS Three Doors scene",
    cleanText,
    doors?.length ? `Three doors: ${doors.join(" | ")}` : "",
    symbolMesh?.length ? `Recurring symbols: ${symbolMesh.join(", ")}` : "",
    "dreamlike, symbolic, liminal, soft light, painterly, high quality",
  ].filter(Boolean).join(". ");
}

function generateDoorSceneImage({ cleanText, doors, symbolMesh, entryId }) {
  return new Promise((resolve) => {
    const prompt = buildThreeDoorsImagePrompt({ cleanText, doors, symbolMesh });
    const py = spawn("python", [
      "scripts/generate-with-trained-lora.py",
      "--prompt", prompt,
      "--adapter", process.env.LANTERN_IMAGE_LORA || "models/csf-image/checkpoints/lantern-door-lora-final.safetensors",
      "--out", `data/images/three-doors/${entryId || Date.now()}.png`,
    ], { cwd: repoRoot });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", d => stdout += d.toString());
    py.stderr.on("data", d => stderr += d.toString());

    py.on("close", code => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr || `exit_${code}` });
        return;
      }
      resolve({ ok: true, stdout });
    });

    py.on("error", err => resolve({ ok: false, error: err.message }));
  });
}

module.exports = { generateDoorSceneImage };
