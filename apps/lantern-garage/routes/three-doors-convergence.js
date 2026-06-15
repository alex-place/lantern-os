/**
 * Three Doors Convergence Loop Routes
 *
 * POST /api/three-doors/convergence-loop
 *   Body: { stage, archetype, agent, symbols }
 *   Response: { stage, next_stage, personalized_prompt, csfKey }
 *
 * Seven-stage convergence loop for Kingdome of Hearts (issue #455):
 *   intake → sprint1 → sprint2 → sprint3 → sprint4 → integration → deploy
 *
 * Each stage returns a personalized prompt template based on archetype,
 * agent persona, and symbolic tokens. csfKey is a UUID for CSF archiving.
 */

const crypto = require("crypto");

const STAGES = ["intake", "sprint1", "sprint2", "sprint3", "sprint4", "integration", "deploy"];

const STAGE_TEMPLATES = {
  intake: (archetype, agent, symbols) =>
    `[${agent}] ${archetype} enters the Kingdome threshold. ` +
    `Symbols detected: ${symbols}. ` +
    `Intake protocol initiated — cataloguing intent and mapping dream topology.`,

  sprint1: (archetype, agent, symbols) =>
    `[${agent}] Sprint 1 — ${archetype} charts the first passage. ` +
    `Activating symbols: ${symbols}. ` +
    `Convergence cycle 1 of 4: laying foundations for the dream sprint.`,

  sprint2: (archetype, agent, symbols) =>
    `[${agent}] Sprint 2 — ${archetype} deepens the convergence arc. ` +
    `Symbols resonating: ${symbols}. ` +
    `Cycle 2 of 4: expanding the lore layer and refining pathways.`,

  sprint3: (archetype, agent, symbols) =>
    `[${agent}] Sprint 3 — ${archetype} approaches the inner sanctum. ` +
    `Symbolic harmonics: ${symbols}. ` +
    `Cycle 3 of 4: stress-testing the narrative mesh and tightening loops.`,

  sprint4: (archetype, agent, symbols) =>
    `[${agent}] Sprint 4 — ${archetype} completes the final sprint arc. ` +
    `Symbol convergence: ${symbols}. ` +
    `Cycle 4 of 4: polishing, validating, and sealing the dream package.`,

  integration: (archetype, agent, symbols) =>
    `[${agent}] Integration — ${archetype} weaves all sprint outputs into the Kingdome fabric. ` +
    `Unified symbol matrix: ${symbols}. ` +
    `Convergence synthesis: merging four sprint streams into coherent delivery artifact.`,

  deploy: (archetype, agent, symbols) =>
    `[${agent}] Deploy — ${archetype} releases the Kingdome into the dream lattice. ` +
    `Deployed symbols: ${symbols}. ` +
    `Convergence loop complete. Feedback channel open — awaiting next intake cycle.`,
};

const ARCHETYPE_DEFAULTS = {
  explorer:    { tone: "curious",    suffix: "The path ahead shimmers with possibility." },
  guardian:    { tone: "protective", suffix: "Every gate is held with steady purpose." },
  architect:   { tone: "precise",    suffix: "Each structure is laid with intention." },
  wanderer:    { tone: "fluid",      suffix: "The journey shapes itself as you move." },
  oracle:      { tone: "visionary",  suffix: "What unfolds has long been seen." },
  trickster:   { tone: "playful",    suffix: "Nothing is quite what it seems — and that is the gift." },
};

function buildPrompt(stage, archetype, agent, symbols) {
  const archetypeKey = (archetype || "explorer").toLowerCase();
  const agentLabel = (agent || "lantern").toLowerCase();
  const symbolList = Array.isArray(symbols) ? symbols.join(", ") : (symbols || "none");
  const meta = ARCHETYPE_DEFAULTS[archetypeKey] || ARCHETYPE_DEFAULTS.explorer;
  const template = STAGE_TEMPLATES[stage];
  if (!template) return null;
  return `${template(archetypeKey, agentLabel, symbolList)} ${meta.suffix}`;
}

module.exports = function threeDoorConvergenceRoutes(req, res, url, deps) {
  // ── POST /api/three-doors/convergence-loop ──────────────────────────
  if (req.method === "POST" && url.pathname === "/api/three-doors/convergence-loop") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const { stage, archetype, agent, symbols } = parsed;

        const currentStage = (stage || "intake").toLowerCase();
        const stageIndex = STAGES.indexOf(currentStage);

        if (stageIndex === -1) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: `Unknown stage "${currentStage}". Valid stages: ${STAGES.join(", ")}`,
          }));
          return;
        }

        const nextStage = stageIndex < STAGES.length - 1 ? STAGES[stageIndex + 1] : null;
        const personalizedPrompt = buildPrompt(currentStage, archetype, agent, symbols);
        const csfKey = crypto.randomUUID();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          stage: currentStage,
          next_stage: nextStage,
          personalized_prompt: personalizedPrompt,
          csfKey,
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }
};
