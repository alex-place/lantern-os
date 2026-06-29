/**
 * Convergence Agent — local answers grounded in real repo/system state (no LLM).
 *
 * Given a user message, produces a response without calling Claude/GPT:
 *   - category : keyword-classified intent class
 *   - persona  : the Keystone-family persona that owns that category
 *   - answer   : for grounded categories (work/convergence) this is built from
 *                LIVE data (open GitHub issues, router stats); otherwise a
 *                fixed informational answer for that surface
 *   - actions  : executable follow-ups (bang command or link)
 *   - grounded : true when the answer reflects live data fetched this call
 *
 * Grounding follows the Keystone contract (dream-chat.js): "what should I
 * tackle first → inspect open issues, prioritize". Same repo state → same
 * answer (no LLM randomness).
 */

"use strict";

const { execFile } = require("child_process");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const GH_REPO = "alex-place/lantern-os";

/**
 * Fetch live open GitHub issues via gh CLI. Returns [] on any failure
 * (offline, no gh, timeout) so the agent degrades gracefully.
 */
function getOpenIssues(limit = 8) {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["issue", "list", "--repo", GH_REPO, "--state", "open", "--limit", String(limit), "--json", "number,title,labels"],
      { cwd: REPO_ROOT, timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const list = JSON.parse(stdout);
          resolve(Array.isArray(list) ? list : []);
        } catch (_e) {
          resolve([]);
        }
      }
    );
  });
}

/** Live convergence-router cache stats (real numbers, no LLM). */
function getRouterStats() {
  try {
    const { getRouter } = require("./convergence-router");
    return getRouter().getStats();
  } catch (_e) {
    return null;
  }
}

// Ordered category matchers — FIRST match wins (priority top-to-bottom).
// Each category maps a verified Lantern OS surface to a deterministic
// answer + a set of real, executable actions.
const KNOWLEDGE = [
  {
    category: "work",
    persona: "keystone",
    keywords: ["work", "issue", "task", "todo", "do today", "should i do", "build", "fix", "sprint", "backlog", "pr "],
    answer:
      "Keystone coordinates technical work grounded in GitHub issues. Run the convergence loop to pull the top-scored issue and generate a spec, or review the open issue backlog directly.",
    actions: [
      { label: "Run convergence loop", command: "!convergance" },
      { label: "Open issues", href: "https://github.com/alex-place/lantern-os/issues" },
    ],
  },
  {
    category: "trade",
    persona: "xenon",
    keywords: ["trade", "trading", "kalshi", "market", "position", "crypto", "btc", "eth", "buy", "sell", "win rate", "p&l"],
    answer:
      "Trading runs through the Kalshi terminal and trader dashboard. Live positions, signals and win-rate stats are served from the collector snapshot — no UI-direct exchange calls.",
    actions: [
      { label: "Open Trader", href: "/stock-trader.html" },
      { label: "Kalshi terminal", href: "/kalshi-terminal.html" },
    ],
  },
  {
    category: "create",
    persona: "waterfall",
    keywords: ["create", "creator", "video", "short", "content", "publish", "render", "make a"],
    answer:
      "The Creator workspace turns research into shorts with a persistent, resumable project workspace. Open it to start or continue a project at any stage.",
    actions: [
      { label: "Open Create", href: "/create.html" },
    ],
  },
  {
    category: "game",
    persona: "lantern",
    keywords: ["play", "game", "door", "kingdome", "explore", "three-doors", "adventure"],
    answer:
      "Three-Doors Kingdome is an infinitely replayable, CSF-native game personalized by archetype and symbols across a 7-stage convergence loop.",
    actions: [
      { label: "Play Kingdome", command: "!explore" },
    ],
  },
  {
    category: "story",
    persona: "lantern",
    keywords: ["story", "dream", "journal", "tale", "narrate", "freeform"],
    answer:
      "The Dream Journal is a freeform narrative space. Personas (lantern, waterfall, xenon…) co-write with you and persist entries to your dream notebook.",
    actions: [
      { label: "Start a dream", command: "Tell me a story" },
      { label: "Play Kingdome", command: "!explore" },
    ],
  },
  {
    category: "convergence",
    persona: "xenon",
    keywords: ["converge", "convergence", "router", "route", "pattern", "signal", "detect", "token", "efficiency"],
    answer:
      "The convergence router answers locally: deterministic intent routing across 6 personas plus a pattern cache, targeting 90% local routing and >70% cache hit rate to cut external API tokens.",
    actions: [
      { label: "Router stats", command: "!ask show convergence stats" },
      { label: "Run convergence loop", command: "!convergance" },
    ],
  },
  {
    category: "status",
    persona: "keystone",
    keywords: ["status", "health", "ready", "system", "version", "online", "uptime"],
    answer:
      "System status, readiness and the mining-lab/agent fleet are aggregated server-side. Run the convergence loop for a live readiness + version + fleet snapshot.",
    actions: [
      { label: "Run convergence loop", command: "!convergance" },
    ],
  },
  {
    category: "learn",
    persona: "keystone",
    keywords: ["learn", "teach", "explain", "how do", "how to", "what is", "understand", "tutorial"],
    answer:
      "Lantern OS is a local-first OS cockpit: a Dream Journal chat, a Kalshi trading terminal, a Creator workspace, and a convergence router that routes work to the right persona deterministically.",
    actions: [
      { label: "What work is there?", command: "!ask what work needs to be done" },
      { label: "Open Trader", href: "/stock-trader.html" },
      { label: "Open Create", href: "/create.html" },
    ],
  },
];

// Fallback when no category matches.
const DEFAULT_RESPONSE = {
  category: "help",
  persona: "keystone",
  answer:
    "I route locally and deterministically. Ask about work, trading, creating, the convergence router, or play the Kingdome game.",
  actions: [
    { label: "What work is there?", command: "!ask what work needs to be done" },
    { label: "Open Trader", href: "/stock-trader.html" },
    { label: "Open Create", href: "/create.html" },
    { label: "Play Kingdome", command: "!explore" },
  ],
};

/**
 * Classify a message into a knowledge category (deterministic, first match).
 */
function classify(message) {
  const lower = (message || "").toLowerCase();
  for (const entry of KNOWLEDGE) {
    if (entry.keywords.some((kw) => lower.includes(kw))) return entry;
  }
  return null;
}

/**
 * Confidence is a deterministic function of how strongly the message
 * matched the category (number of distinct keyword hits), capped at 100.
 */
function scoreConfidence(message, matched) {
  if (!matched.keywords) return 50; // default/help fallback
  const lower = message.toLowerCase();
  const hits = matched.keywords.filter((kw) => lower.includes(kw)).length;
  return Math.min(100, 60 + hits * 15);
}

const GH = "https://github.com/" + GH_REPO;

/**
 * Build a GROUNDED answer for the "work" category from live open issues.
 * Falls back to the template answer if no issues could be fetched.
 */
async function groundWork(matched) {
  const issues = await getOpenIssues(8);
  if (!issues.length) {
    return { answer: matched.answer, actions: matched.actions, grounded: false };
  }
  const top = issues.slice(0, 3);
  const lines = top.map((i) => `#${i.number} — ${i.title}`).join("\n");
  const answer =
    `There ${issues.length === 1 ? "is" : "are"} ${issues.length} open issue${issues.length === 1 ? "" : "s"}. ` +
    `Here ${top.length === 1 ? "is the one" : "are the top " + top.length} to tackle first:\n${lines}`;
  const actions = top
    .flatMap((i) => [
      { label: `Open #${i.number}`, href: `${GH}/issues/${i.number}` },
      { label: `Auto-work #${i.number}`, command: `!autonomous-work ${i.number}`, autonomous: true, issue: i.number },
    ])
    .concat([
      { label: "All open issues", href: `${GH}/issues` },
      { label: "Run convergence loop", command: "!convergance" },
    ]);
  return { answer, actions, grounded: true };
}

/**
 * Build a GROUNDED answer for the "convergence" category from live router stats.
 */
function groundConvergence(matched) {
  const stats = getRouterStats();
  if (!stats) {
    return { answer: matched.answer, actions: matched.actions, grounded: false };
  }
  const answer =
    `The convergence router answers locally. Right now its cache holds ` +
    `${stats.cachedIntentPatterns} intent route${stats.cachedIntentPatterns === 1 ? "" : "s"} and ` +
    `${stats.cachedCodePatterns} code pattern${stats.cachedCodePatterns === 1 ? "" : "s"} ` +
    `(${stats.totalCachedRoutes} cached routes total). Each cached hit skips an external API call.`;
  return { answer, actions: matched.actions, grounded: true };
}

/**
 * Produce an answer + actions for a message. Grounded categories reflect live
 * state; same repo/system state → same answer (no LLM randomness).
 * @param {string} message
 * @returns {Promise<object>} { agent, category, answer, actions, confidence, source, grounded }
 */
async function respond(message) {
  if (!message || !message.trim()) {
    return {
      agent: DEFAULT_RESPONSE.persona,
      category: DEFAULT_RESPONSE.category,
      answer: DEFAULT_RESPONSE.answer,
      actions: DEFAULT_RESPONSE.actions,
      confidence: 0,
      source: "convergence_agent",
      grounded: false,
    };
  }

  const matched = classify(message) || DEFAULT_RESPONSE;
  let answer = matched.answer;
  let actions = matched.actions;
  let grounded = false;

  if (matched.category === "work") {
    const g = await groundWork(matched);
    answer = g.answer; actions = g.actions; grounded = g.grounded;
  } else if (matched.category === "convergence") {
    const g = groundConvergence(matched);
    answer = g.answer; actions = g.actions; grounded = g.grounded;
  }

  return {
    agent: matched.persona,
    category: matched.category,
    answer,
    actions,
    confidence: scoreConfidence(message, matched),
    source: grounded ? "convergence_agent:live" : "convergence_agent:template",
    grounded,
  };
}

module.exports = { respond, classify, scoreConfidence, getOpenIssues, KNOWLEDGE };
