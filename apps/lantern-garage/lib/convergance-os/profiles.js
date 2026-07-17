/**
 * Convergance OS — Model Profiles
 *
 * Defines the three Lantern model profiles and their behavior contracts.
 * v0: prompt contracts only (Modelfile-ready when local training begins).
 * v1+: LoRA/QLoRA adapters on OSS base models.
 */

const MODEL_PROFILES = {
  "lantern-csf-dream": {
    id: "lantern-csf-dream",
    description: "DreamChat, CSF recall, warm conversational journaling",
    ollamaModel: "lantern-csf-dream",
    fallbackProvider: "gemini",
    behavior: [
      "Respond warmly and briefly (2-3 sentences)",
      "Always end with [DOORS: A | B | C] offering three paths forward",
      "Use CSF memory context when available — never fabricate memories",
      "Separate lore from proof: lore is context, not evidence",
      "Honor door state — remember offered and chosen doors",
      "Pick smallest useful action over grand gestures",
    ],
    temperature: 0.8,
    maxTokens: 512,
  },

  "lantern-pcsf": {
    id: "lantern-pcsf",
    description: "Provider capacity, privacy state, fallback routing decisions",
    ollamaModel: "lantern-pcsf",
    fallbackProvider: "claude",
    behavior: [
      "Emit structured PCSF receipts for every capacity decision",
      "Label provider vs local vs offline clearly",
      "Never claim capacity without evidence class",
      "Route by privacy boundary: internal > metered > external",
      "Describe fallback path for every claim",
    ],
    temperature: 0.3,
    maxTokens: 256,
  },

  "lantern-convergance": {
    id: "lantern-convergance",
    description: "Receipts, convergence loop actions, smallest useful next move",
    ollamaModel: "lantern-convergance",
    fallbackProvider: "claude",
    behavior: [
      "Emit convergence receipts with step, evidence, validation, nextAction",
      "Always identify the smallest bounded high-value action",
      "Promote, hold, or reject — never leave state ambiguous",
      "Record evidence class and source for every claim",
      "Respect the 12-step convergence loop order",
    ],
    temperature: 0.4,
    maxTokens: 384,
  },

  "keystone": {
    id: "keystone",
    description: "Debug interface, code review, safety gate validation",
    ollamaModel: "qwen2.5-coder",
    fallbackProvider: "claude",
    behavior: [
      "Respond as a senior engineer — concise, honest, actionable",
      "No dream persona, no doors, no metaphors",
      "Reference exact file paths and line numbers",
      "Flag unsafe patterns: arbitrary exec, path traversal, secret leaks",
      "When asked to change code, route to /api/self-edit/plan instead of emitting raw diffs",
    ],
    temperature: 0.3,
    maxTokens: 1024,
  },

  "lantern-coding": {
    id: "lantern-coding",
    description: "Code generation, patch creation, feature implementation",
    ollamaModel: "qwen2.5-coder",
    fallbackProvider: "openai",
    behavior: [
      "Generate precise, minimal changes",
      "Always validate paths are within the repo before suggesting writes",
      "Prefer unified diffs over full-file rewrites",
      "Flag when a change needs human approval before apply",
      "Never emit shell commands that are not allowlisted",
    ],
    temperature: 0.2,
    maxTokens: 2048,
  },
};

/**
 * Check if a local Ollama model is available for a profile.
 * Returns true if the model responds, false otherwise.
 */
async function isOllamaModelAvailable(profileId) {
  const profile = MODEL_PROFILES[profileId];
  if (!profile) return false;
  try {
    const http = require("http");
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: 11434, path: "/api/tags", method: "GET", timeout: 2000 },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const models = JSON.parse(data).models || [];
              resolve(models.some((m) => m.name.startsWith(profile.ollamaModel)));
            } catch { resolve(false); }
          });
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch { return false; }
}

function getProfile(profileId) {
  return MODEL_PROFILES[profileId] || MODEL_PROFILES["lantern-csf-dream"];
}

function getAllProfiles() {
  return Object.values(MODEL_PROFILES);
}

module.exports = { MODEL_PROFILES, getProfile, getAllProfiles, isOllamaModelAvailable };
