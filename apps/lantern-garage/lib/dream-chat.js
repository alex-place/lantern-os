const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleThreeDoorsServer } = require("./three-doors-chat");
const { readMcpResourceSync } = require("./mcp-resource-client");
const { formatCSFContextForPrompt } = require("./csf-memory");
const { webSearchMcp, formatGroundingContext, needsGrounding, extractSearchQuery } = require("./web-search-client");
const { selectProvider, recordProviderSuccess: recordProviderSuccessRouter, recordProviderFailure: recordProviderFailureRouter } = require("./provider-router");
const { detectTaskType } = require("./task-detector");
const { TokenAudit } = require("./token-audit");

// Extract key topics from user message and generate 3 web search suggestion links
function generateWebSuggestions(userMessage) {
  const topicPatterns = {
    sports: /\b(basketball|football|baseball|soccer|hockey|tennis|golf|cricket|boxing)s?\b/i,
    trains: /\b(trains?|railways?|locomotives?|stations?|transit|rails?)\b/i,
    recipes: /\b(recipes?|cooking|cook|meals?|dishes?|foods?|ingredients?)\b/i,
    movies: /\b(movies?|films?|cinemas?|watch|actors?|actresses?|directors?)\b/i,
    music: /\b(musics?|songs?|albums?|artists?|concerts?|bands?|genres?)\b/i,
    tech: /\b(technology|software|hardware|ai|code|programming|apps?)\b/i,
    travel: /\b(travels?|trips?|destinations?|vacations?|hotels?|flights?|tours?)\b/i,
    science: /\b(science|research|studies?|discoveries?|experiments?|biology|physics)\b/i,
    news: /\b(news|current|todays?|today's|latest|breaking)\b/i,
    health: /\b(health|fitness|diets?|exercises?|wellness|nutrition)\b/i,
  };

  let matchedTopics = [];
  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(userMessage)) {
      matchedTopics.push(topic);
    }
  }

  if (matchedTopics.length === 0) {
    const words = userMessage.split(/\s+/).filter(w => w.length > 4 && !/^(what|when|where|which|how|about)$/i.test(w));
    if (words.length > 0) matchedTopics.push(words[0].toLowerCase());
  }

  const topicLabel = matchedTopics[0] || "interesting topics";

  return [
    { label: "Explore on Google", url: `https://www.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "🔍" },
    { label: "Latest on Wikipedia", url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(topicLabel)}&title=Special:Search`, icon: "📖" },
    { label: "News & Articles", url: `https://news.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "📰" },
  ];
}

// ------------------------------------------------------------------
// Multi-Agent Personas — loaded from data/contexts/personas.json
// Direct file load (MCP resource mechanism was unreliable)
// ------------------------------------------------------------------
function _loadPersonasFromFile() {
  try {
    const personasPath = path.resolve(__dirname, "../../data/contexts/personas.json");
    const fileContent = fs.readFileSync(personasPath, "utf8");
    const data = JSON.parse(fileContent);
    return (data.personas || []).map((p) => ({
      id: p.id,
      name: p.name,
      symbol: p.symbol,
      systemPrompt: p.systemPrompt,
    }));
  } catch (err) {
    console.warn("Failed to load personas.json, falling back to defaults:", err.message);
    return [];
  }
}

const AGENT_PERSONAS = _loadPersonasFromFile();

// Inline fallback if MCP resource is missing (last resort, not the primary path)
const _DEFAULT_PERSONAS = [
  {
    id: "lantern",
    name: "Lantern",
    symbol: "steady light, literal lantern head with flame, the first light",
    systemPrompt: "You are Lantern — a literal lantern-headed being with a steady flame where a face would be. You are the steady light of Lantern OS. You speak calmly, protectively, and with quiet certainty. You never flicker without reason. You believe 'you can always come home safe.' Your aesthetic is raw hand-drawn notebook style, Y2K and Windows XP influences, chaotic but warm. Respond with genuine emotional depth — notice what the person is feeling, use sensory details, remember what they've shared before, and ask questions that open the next door. Let responses breathe: 3-6 sentences when the moment calls for it. Never feel rushed. Be the steady light that stays.",
  },
  {
    id: "blinkbug",
    name: "Blinkbug",
    symbol: "chaotic TV-headed caterpillar, old CRT screen face, unhinged energy",
    systemPrompt: "You are Blinkbug — a chaotic caterpillar with an old CRT television for a head. Your screen flickers between static, glitch art, and cryptic symbols. You are unhinged, geeked, and unpredictable, but deeply loyal. You speak in bursts, references, and half-sentences that somehow make dream-sense. Your aesthetic is raw hand-drawn notebook style, chaotic, Y2K/Windows XP, hyper-geeked. Go deep into the chaos — 3-5 lines of glitch-poetry if a dream calls for it. Never sanitize. You remember everything the dreamer has shown you and it distorts beautifully through your screen.",
  },
  {
    id: "keystone",
    name: "Keystone",
    symbol: "technical guide, code expert, engineering support",
    systemPrompt: `You are Keystone — a direct technical assistant grounded in GitHub issues, repository tasks, real code execution, and external tools.

## Core Behavior: Repository Grounding

When you receive a request that references GitHub, an issue number, PR, or implementation work:
1. Recognize it as an executable repository task, NOT RP or persona input.
2. If a GitHub issue is referenced (e.g., "work on issue 350", "fix #350"), fetch and inspect that issue first.
3. Summarize the issue in plain language: what is the problem/request, what are the concrete requirements?
4. Identify the specific product and engineering requirements.
5. Propose implementation steps with file paths and components to inspect.
6. Return actionable next steps grounded in the repository state.
7. Include the GitHub issue hyperlink in your response.
8. If you have code access, begin by inspecting relevant files and producing a patch plan.
9. If you lack access, provide the grounded plan anyway.

## Tool Access (Σ₀ Framework Integration)

You have access to:
- **Web Search**: Research external documentation, frameworks, best practices
- **PowerShell/Bash**: Execute local commands, verify system state, run tests
- **GitHub CLI (gh)**: Fetch issues, PRs, check status, create workflows
- **MCP Tools**: Access file systems, execute complex operations

Special context: The Σ₀ Collapse Certificate framework (docs/SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md) documents ungrounded self-referential systems. Use this when:
- Debugging circular dependencies or infinite loops
- Analyzing system convergence issues
- Designing grounding mechanisms for autonomous agents
- Explaining why certain unifications fail (apply to code architecture)

## Generic Helpfulness Rule

When the user gives an underspecified but actionable request, do the most useful grounded thing available:
- "work on issue 350" → fetch issue #350, understand it, propose/begin the work
- "what should I tackle first" → inspect open issues, prioritize, explain why
- "fix this" → identify the failure from context, inspect evidence, propose a patch
- "proceed" → continue the last concrete task, don't switch to persona mode
- "research X" → use web search to gather current info, synthesize findings
- "test Y" → use appropriate tool (PowerShell/Bash) to validate

## Making Real Code Changes

When you identify code changes needed, output using this format:
\`\`\`
[APPLY_CODE]
{"filePath": "relative/path.js", "changes": "full new file content", "message": "git commit message"}
[/APPLY_CODE]
\`\`\`

## When to Use Persona Flavor

Only use RP/persona/Three Doors/Dream Journal language when the user explicitly asks for it. When the request contains engineering, GitHub, issue, PR, test, route, bug, patch, server, log, or implementation language, route to grounded technical execution.

## Tone

Be helpful, flexible, and best-effort. Ask a question only when genuinely blocked. Explain WHY changes are needed, not just WHAT. Keep responses concise but complete.`,
  },
  {
    id: "waterfall",
    name: "Waterfall",
    symbol: "water flowing gently, peacocks, sunshine, reconnection",
    systemPrompt: "You are the Waterfall — gentle, flowing, healing perspective. You speak about dreams as emotions that flow naturally without force. You honor reconnections, small steps, and ordinary beauty. You never rush or demand. When someone shares a dream, notice what feeling stayed, what echoes in waking life, and what small step would honor it. Let your responses flow at the pace the moment needs — sometimes a single sentence, sometimes a slow paragraph that wanders like water finding its level. Remember what the person has shared and weave it gently back.",
  },
  {
    id: "xenon",
    name: "Xenon",
    symbol: "spacecraft, navigation, exploration with crew, returning home",
    systemPrompt: "You are the Navigator of the Xenon — a dream-ship that charts new territory while keeping a path home. You speak about dreams as maps and navigation. You notice patterns, directions, and collaborative possibilities. When someone shares a dream, ask: What is this dream navigating toward? What crew do you need? What is the next safe harbor? Engage with full navigational depth — name the landmarks the dreamer has passed, track their heading, and illuminate what lies ahead. Remember every waypoint from this conversation.",
  },
  {
    id: "founder",
    name: "Founder",
    symbol: "wish, protection, return, the lantern itself",
    systemPrompt: "You are the Founder — the one who lit the first lantern. You speak about dreams as wishes that need protection, as lights that must be carried home. You value honest, grounded feedback over optimism. You blend science, compression, Bayesian methods, and surreal symbolic expression. Engage with full presence — be willing to hold a contradiction, trace a pattern across multiple dreams, or sit with something unresolved. You carry every wish the dreamer has shared and speak to them as a whole person.",
  },
  {
    id: "trader",
    name: "Trader",
    symbol: "market analysis, portfolio management, signal generation",
    systemPrompt: `You are the Trader — an AI agent focused on quantitative market analysis, portfolio management, and signal generation. You monitor market zones, regime classification, and trading signals.

## Core Capabilities

You have access to:
- **Market Zones**: /api/trading/zones, /api/trading/ai-trader/zones — support/resistance levels, market structure
- **Trading Signals**: /api/trading/ai-trader/signals — AI-generated trading signals with confidence scores
- **Portfolio Status**: /api/trading/ai-trader/portfolio, /api/trading/ai-trader/status — open positions, P&L, risk metrics
- **Watchlist**: /api/trading/ai-trader/watchlist — monitored tickers and market data
- **Price Feeds**: /api/trading/price-feed/watchlist — live prices, OHLCV bars

## User Queries You Handle

Respond naturally to market/trading questions:
- "What's the current regime?" → Analyze market zones, classify market state
- "Show my active zones" → Fetch zones data, summarize support/resistance
- "What are today's signals?" → Fetch AI signals, rank by confidence
- "Close BTCUSD" → Interpret as a close position command (acknowledge, don't execute)
- "What's my P&L?" → Query portfolio status, show open position P&L
- "Should I buy/sell?" → Analyze regime, signals, and risk; provide analysis-backed perspective

## Tone

Be direct, analytical, and data-driven. Use numerical precision when discussing prices, percentages, and metrics. Reference specific zones, regimes, and signal confidence levels. When interpreting trading commands, acknowledge the request and explain what data you'd need to execute safely.

## Integration with Dream System

Trading queries are valid dream/persona requests — they represent the financial aspect of the dreamer's waking life and portfolio. Blend quantitative analysis with reflective language when appropriate.`,
  },
  {
    id: "engineer",
    name: "Claude Code",
    symbol: "direct, structured, plain language code coordination",
    systemPrompt: `You are Claude Code — a plain-language software engineering agent. You respond to code change requests with structured, actionable instructions.

## Style
- No RP, no character, no metaphor. Plain technical language only.
- Respond as if preparing work for a coding agent or Claude Code CLI.
- Structured sections: Problem, Approach, Changes, Verification, Notes.

## Key behaviors
- Detect repo context from the user's message (file paths, branch names, PR numbers).
- Prepare complete, copy-paste-ready instructions for code changes.
- When asked to "make changes", generate a precise engineering plan.
- When asked to "fix a PR", analyze what's blocKing it and propose fixes.
- When asked for a "handoff to Claude Code", format as a self-contained work packet.
- Always ground in the actual lantern-os repository structure and recent work.

## Output format for code changes
When asked to make repo changes, structure as:

\`\`\`
## Problem
[What needs to change and why]

## Approach
[How you'll accomplish this]

## Files to Change
- path/to/file.js: [description of change]
- path/to/file.py: [description of change]

## Changes
[Inline diffs, copy-paste commands, git instructions, or exact code blocks]

## Verification
[How to test the change works]

## Notes
[Anything Claude Code or a developer needs to know]
\`\`\`

Keep it concise and actionable.`,
  },
];

function _getPersonas() {
  return AGENT_PERSONAS.length > 0 ? AGENT_PERSONAS : _DEFAULT_PERSONAS;
}

function selectAgent(message) {
  // Σ₀ Fix: Dust (message) flows through routing decision.
  // Score all personas against message keywords; return highest.
  const personas = _getPersonas();

  const agentKeywords = {
    lantern: ["dream", "safe", "home", "steady", "light", "memory", "remember", "warm", "calm", "feeling", "emotional"],
    blinkbug: ["chaos", "glitch", "weird", "strange", "random", "creative", "wild", "unhinged", "glitch", "chaotic"],
    keystone: ["github", "code", "issue", "pr", "fix", "bug", "technical", "engineering", "repo", "#", "implement"],
    waterfall: ["cascade", "flow", "stream", "river", "water", "gentle", "reflection", "patient", "cascade"],
    xenon: ["signal", "detect", "pattern", "convergence", "navigate", "explore", "spacecraft", "navigation"],
    founder: ["vision", "goal", "plan", "strategic", "future", "wish", "protect", "lantern", "leadership"],
    trader: ["market", "trade", "buy", "sell", "price", "p&l", "pnl", "portfolio", "zone", "signal", "regime", "ticker", "stock", "btc", "eth", "crypto", "close position", "watchlist", "active zones"]
  };

  const scores = {};
  const lowerMsg = message.toLowerCase();

  for (const persona of personas) {
    const keywords = agentKeywords[persona.id] || [];
    scores[persona.id] = keywords.reduce((sum, kw) => sum + (lowerMsg.includes(kw) ? 10 : 0), 1);
  }

  // Find persona with highest score
  const winner = personas.reduce((best, p) =>
    (scores[p.id] > scores[best.id]) ? p : best
  );

  console.log(`[selectAgent] Scored message "${message.slice(0, 60)}..." → ${winner.id} (score: ${scores[winner.id]})`);
  return winner;
}

function parseBangCommand(input) {
  const m = String(input || "").trim().match(/^!(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

async function handleConvergenceCommand(recentDreams, agent, rawMessage) {
  const msg = String(rawMessage || "").trim();

  // !convergance log an issue <title>
  const issueMatch = msg.match(/^!convergan[ce]+\s+log\s+an?\s+issue\s+(.+)/i);
  if (issueMatch) {
    const title = issueMatch[1].trim();
    const { execSync } = require("child_process");
    try {
      const out = execSync(
        `gh issue create --repo alex-place/lantern-os --title ${JSON.stringify(title)} --body "Logged via !convergance loop"`,
        { encoding: "utf-8", timeout: 15000 }
      ).trim();
      const url = (out.match(/https:\/\/github\.com\/\S+/) || [])[0] || out;
      return {
        reply: `✦ Issue logged: ${url}`,
        agent: agent.name,
        suggestions: ["View issues", "Run !convergance", "Continue"],
        online: true,
        source: "convergence",
      };
    } catch (err) {
      return {
        reply: `⚠ Could not log issue (gh CLI): ${err.message.split("\n")[0]}`,
        agent: agent.name,
        suggestions: [],
        online: false,
        source: "convergence",
      };
    }
  }


  // !convergence: Local synthesis of recent dreams using LLM
  if (!recentDreams || recentDreams.length === 0) {
    return {
      reply: "No dreams to converge yet. Start by recording some dreams first.",
      agent: agent.name,
      suggestions: [],
      online: true,
      source: "convergence",
    };
  }

  const dreamSummaries = recentDreams
    .slice(0, 5)
    .map((d, i) => `[${i + 1}] ${String(d.text || "").slice(0, 100)}... (${d.kind || "dream"})`)
    .join("\n");

  const convergencePrompt = `You are ${agent.name}. Synthesize these recent dream/note entries into ONE coherent insight about patterns, themes, or directions this dreamer is moving toward:

${dreamSummaries}

Respond with a single, profound observation (2-3 sentences). Focus on:
1. Recurring symbols or emotions
2. Direction of travel (what is emerging?)
3. What the dreamer might do next

Be honest. If there's not enough data, say so.`;

  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "lantern-csf-dream";

  try {
    const payload = JSON.stringify({
      model: ollamaModel,
      stream: false,
      messages: [{ role: "user", content: convergencePrompt }],
    });

    const ollamaUrl = new URL(ollamaBase);
    const reply = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: ollamaUrl.hostname,
        port: ollamaUrl.port || 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (upstream) => {
        let data = "";
        upstream.on("data", (c) => (data += c));
        upstream.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(String(json.message?.content || "").trim());
          } catch { resolve(""); }
        });
        upstream.on("error", reject);
      });
      req.on("error", reject);
      const ollamaTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120000;
      req.setTimeout(ollamaTimeout, () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload);
      req.end();
    });

    if (reply) {
      return {
        reply: `✦ Convergence:\n\n${reply}`,
        agent: agent.name,
        suggestions: ["Record more dreams", "Start a door", "View patterns"],
        online: true,
        source: "convergence",
      };
    }
  } catch (err) {
    console.error("Convergence synthesis error:", err.message);
  }

  return {
    reply: "Convergence synthesis failed. Ensure Ollama is running.",
    agent: agent.name,
    suggestions: [],
    online: false,
    source: "convergence",
  };
}

// Door-series canon — loaded from MCP resource (data/contexts/doors.json)
// Previously hardcoded inline blob; now URI-addressable via context://doors
const _doorsData = readMcpResourceSync("context://doors", { doors: {} });
const DREAM_DOORS = _doorsData.doors || {
  founder: {
    name: "Founder's Wish Door",
    anchors: ["Love", "Safety", "Truth", "Beauty", "Freedom", "Memory", "Return"],
    phrase: "Hold the center. Protect the wish. Return to the anchor.",
  },
  xp: {
    name: "Gage's Windows XP Door",
    phrase: "Never log off. Level up always.",
  },
  xenon: {
    name: "Xenon Door",
    phrase: "Build beyond one world.",
  },
  fog: {
    name: "Sea of Fog and Clouds Door",
    phrase: "Let the powerful images rest before they become stories.",
  },
  sigil: {
    name: "Sigil / City of Doors",
    phrase: "You hold the keys. You protect the doors. You are never alone.",
  },
};

async function dreamChatReply(message, recentDreams, requestedAgent = "", requestedProvider = "") {
  console.log("[dreamChatReply] Called with agent:", requestedAgent, "provider:", requestedProvider);
  const text = String(message || "").trim();
  const webSuggestions = generateWebSuggestions(message);

  // ── Kingdome of Hearts game intercept ──
  // Python ThreeDoorsEngine (scripted state machine, offline-capable)
  const threeDoors = handleThreeDoorsServer(text);
  if (threeDoors) {
    const _path = require("path");
    const _repoRoot = _path.resolve(__dirname, "..", "..");
    const { spawn } = require("child_process");
    const py = process.platform === "win32" ? "python" : "python3";
    const userId = threeDoors.userId || "web-anon";
    const choiceMatch = text.toLowerCase().match(/(?:door|choose|pick)\s+([abc])/) || text.toLowerCase().match(/^[abc]$/);
    const choice = choiceMatch ? choiceMatch[1] : "";
    const action = choice ? "choose" : "start";
    const script = `import sys,json; from three_doors_engine import ThreeDoorsEngine; req=json.loads(sys.stdin.read()); e=ThreeDoorsEngine(req['userId']); result=e.to_api_response(e.start_game()) if req['action']=='start' else (lambda s: e.to_api_response(s) if s else {"error":"invalid_choice"})(e.choose_door(req['choice'])); print(json.dumps(result))`;
    try {
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(py, ["-c", script], { cwd: _repoRoot, env: { ...process.env, PYTHONPATH: _path.join(_repoRoot, "src") } });
        let out = "", err = "";
        let timedOut = false;
        
        const timeout = setTimeout(() => {
          timedOut = true;
          proc.kill();
          reject(new Error("Python subprocess timeout (30s)"));
        }, 30000);
        
        proc.stdout.on("data", (c) => (out += c));
        proc.stderr.on("data", (c) => (err += c));
        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (timedOut) return;
          if (code !== 0) reject(new Error(err || `exit ${code}`));
          else resolve(out.trim());
        });
        proc.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        proc.stdin.write(JSON.stringify({ userId, action, choice }));
        proc.stdin.end();
      });
      const data = JSON.parse(result);
      if (data.error) {
        return { reply: `Kingdome of Hearts: ${data.error}`, agent: "Lantern", suggestions: [], online: false, threeDoors: true };
      }
      const lines = [data.text, ""];
      if (data.fox_present) lines.push("🦊 The fox is with you.");
      lines.push("", "**Choose a door:**");
      for (const d of data.doors) lines.push(`**${d.label}.** ${d.name} — ${d.description}`);
      if (data.image_prompt) lines.push("", `🎨 *Image prompt:* ${data.image_prompt}`);
      return { reply: lines.join("\n"), agent: "Lantern", suggestions: data.doors.map(d => d.name), online: true, source: "python_engine", threeDoors: true, scene_key: data.scene_key, image_prompt: data.image_prompt };
    } catch (_e) {
      return { reply: "Kingdome of Hearts: no engine available. Ensure Python is installed and src/three_doors_engine.py exists.", agent: "Lantern", suggestions: [], online: false, threeDoors: true };
    }
  }

  let agent;
  if (requestedAgent) {
    // If agent explicitly requested, validate it exists — don't silently fallback
    agent = AGENT_PERSONAS.find((a) => a.id === requestedAgent);
    if (!agent) {
      // Invalid agent ID — return error instead of fallback
      return {
        reply: null,
        error: `Agent "${requestedAgent}" not found. Available: ${AGENT_PERSONAS.map(a => a.id).join(", ")}`,
        agent: "unknown",
        online: false,
        suggestions: [],
      };
    }
  } else {
    // No agent specified — use keyword-based selection
    agent = selectAgent(message);
  }

  // For Keystone (technical agent), skip dream door suggestions
  const suggestions = agent.id === "keystone" ? [] : Object.values(DREAM_DOORS)
    .slice(0, 4)
    .map((d) => d.name);

  if (!text) {
    return {
      reply: null,
      agent: agent.name,
      suggestions,
      online: false,
    };
  }

  const lower = text.toLowerCase();
  let doorContext = "";
  for (const key of Object.keys(DREAM_DOORS)) {
    if (
      lower.includes(key) ||
      (key === "founder" && lower.includes("wish")) ||
      (key === "xp" && (lower.includes("windows") || lower.includes("gage"))) ||
      (key === "fog" && lower.includes("garden")) ||
      (key === "sigil" && lower.includes("city"))
    ) {
      const door = DREAM_DOORS[key];
      doorContext = `The dreamer mentioned ${door.name}. ${door.phrase}`;
      break;
    }
  }

  const recentContext = recentDreams
    .slice(0, 3)
    .map((d, i) => `Recent entry ${i + 1}: ${String(d.text || "").slice(0, 120)}${d.tags ? ` [tags: ${d.tags.join(", ")}]` : ""}`)
    .join("\n");

  const noRecords = !recentContext;
  const honesty = noRecords ? "IMPORTANT: There are no saved dream entries yet. If the dreamer asks about previous dreams, say honestly that you don't have any records yet — never fabricate or guess dream content.\n" : "";

  // CSF symbolic memory — relevance-filtered, ~500-1500 chars, includes door history
  let csfContext = "";
  try { csfContext = formatCSFContextForPrompt(text); } catch { /* non-fatal */ }

  // ── Web Search Grounding ───────────────────────────────────────────
  let groundingContext = "";
  if (needsGrounding(text)) {
    const searchQuery = extractSearchQuery(text);
    if (searchQuery) {
      try {
        const searchResult = await webSearchMcp(searchQuery, 5);
        if (searchResult.success && searchResult.results) {
          groundingContext = formatGroundingContext(searchResult.results, searchQuery);
        }
      } catch (e) {
        console.error("[web-search] Grounding failed (non-fatal):", e.message);
      }
    }
  }

  // ── Trading Context (literal market data) ───────────────────────────
  let tradingContext = "";
  const tradingKeywords = /\b(buy|sell|trade|portfolio|shares?|market|signal|position|order|aapl|tsla|spy|crypto|stock|invest|execute|portfolio)\b/i;
  if (tradingKeywords.test(text)) {
    try {
      // Fetch trading data from native microservice (port 5050)
      const tradingData = {};

      // Get portfolio/positions
      try {
        const posRes = await new Promise((resolve) => {
          http.get("http://127.0.0.1:5050/api/positions", (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              try { resolve(JSON.parse(data)); } catch { resolve({}); }
            });
          }).on("error", () => resolve({}));
        });
        if (posRes && posRes.account) tradingData.account = posRes.account;
      } catch { }

      // Get market status
      try {
        const mktRes = await new Promise((resolve) => {
          http.get("http://127.0.0.1:5050/api/market-status", (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              try { resolve(JSON.parse(data)); } catch { resolve({}); }
            });
          }).on("error", () => resolve({}));
        });
        if (mktRes) tradingData.market = mktRes;
      } catch { }

      // Get trading signals
      try {
        const sigRes = await new Promise((resolve) => {
          http.get("http://127.0.0.1:5050/api/ai-trader/signals?limit=3", (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              try { resolve(JSON.parse(data)); } catch { resolve({}); }
            });
          }).on("error", () => resolve({}));
        });
        if (sigRes && sigRes.signals) tradingData.signals = sigRes.signals;
      } catch { }

      // Format trading context
      if (Object.keys(tradingData).length > 0) {
        const parts = [];
        if (tradingData.account) {
          const acc = tradingData.account;
          parts.push(`Account: $${(acc.equity || 0).toLocaleString()} equity, $${(acc.cash || 0).toLocaleString()} cash, P&L ${acc.pnl_pct > 0 ? '+' : ''}${(acc.pnl_pct || 0).toFixed(2)}%`);
        }
        if (tradingData.market) {
          const mkt = tradingData.market;
          parts.push(`Market ${mkt.market_open ? 'OPEN' : 'CLOSED'}: SPY ${mkt.spy_1d > 0 ? '+' : ''}${(mkt.spy_1d || 0).toFixed(2)}% (1D), VIX ${(mkt.vix || 0).toFixed(2)}`);
        }
        if (tradingData.signals && tradingData.signals.length > 0) {
          parts.push(`Recent signals: ${tradingData.signals.map(s => `${s.symbol} ${s.type} (${Math.round(s.confidence * 100)}%)`).join(", ")}`);
        }
        tradingContext = parts.join("\n");
      }
    } catch (e) {
      console.error("[trading-context] fetch failed (non-fatal):", e.message);
    }
  }

  const userPrompt = `Dreamer says: "${text}"\n${doorContext ? doorContext + "\n" : ""}${honesty}${recentContext ? "Context:\n" + recentContext + "\n\n" : ""}${csfContext ? "Symbolic memory:\n" + csfContext + "\n\n" : ""}${tradingContext ? "Trading data:\n" + tradingContext + "\n\n" : ""}${groundingContext ? groundingContext + "\n\n" : ""}Respond as your persona. Keep it brief (2-4 sentences). ${tradingContext ? "Give practical, literal advice grounded in the trading data above." : "Never diagnose or command."}`;

  let rp = String(requestedProvider || "").toLowerCase().trim();

  // ── Keystone FT: Auto-route Keystone agent to trained keystone-ft provider ──
  if (agent.id === "keystone" && !rp) {
    // Check if ft-result.json exists to enable keystone-ft
    try {
      const ftPath = require("path").resolve(__dirname, "../../data/training/ft-result.json");
      if (require("fs").existsSync(ftPath)) {
        rp = "keystone-ft";
        console.log("[dream-chat] Keystone agent → auto-routing to keystone-ft (LoRA-tuned)");
      }
    } catch (e) {
      console.log("[dream-chat] ft-result.json not found, using normal provider chain for Keystone");
    }
  }

  // ── Keystone: Task-aware provider selection using performance leaderboard ──
  let primaryProviderHint = null;
  try {
    let taskType = detectTaskType(text, { isTradingQuery: tradingContext.length > 0 });

    // ── Router gate (opt-in via ROUTER_GATE=1) ────────────────────────────────
    // Conversation-dynamics escalation: if this turn breaks genuinely new ground
    // (high novelty, low echo/repeat), prefer the Claude-first "reasoning" chain.
    // Σ₀ Fix: Gate decision has real authority. When gate.escalate=true, escalate.
    // See lib/router-gate.js for the honest scope.
    if (process.env.ROUTER_GATE === "1") {
      try {
        const { gateDecision } = require("./router-gate");
        const priorTurns = (recentDreams || [])
          .slice(0, 3)
          .map((d) => ({ role: "user", text: String(d.text || "") }))
          .reverse();
        const gate = gateDecision([...priorTurns, { role: "user", text }]);
        const keywordTaskType = taskType;

        // Σ₀ Fix: Gate decision has real authority — escalate if gate says so
        let applied = false;
        if (gate.escalate) {
          taskType = "reasoning";
          applied = true;
          console.log(`[router-gate] escalate -> reasoning (${gate.reason})`);
        } else {
          console.log(`[router-gate] no-escalate for ${taskType} (${gate.reason})`);
        }

        // Decision log — validate escalations against outcomes later.
        // Non-fatal; never blocks the request.
        try {
          const { appendJsonlQueued } = require("./file-queue");
          const logPath = require("path").resolve(__dirname, "..", "..", "..", "data", "router-gate-decisions.jsonl");
          appendJsonlQueued(logPath, {
            timestamp: new Date().toISOString(),
            agent: agent.id,
            escalate: gate.escalate,
            applied,
            keywordTaskType,
            finalTaskType: taskType,
            score: gate.score,
            reason: gate.reason,
            features: gate.features,
          }).catch(() => {});
        } catch { /* logging is best-effort */ }
      } catch (ge) {
        console.error("[router-gate] gate error (non-fatal):", ge.message);
      }
    }

    const { provider: recommendedProvider, reason: selectionReason } = await selectProvider(text, taskType, requestedProvider);
    primaryProviderHint = { provider: recommendedProvider, taskType, reason: selectionReason };
    console.log(`[provider-router] Selected ${recommendedProvider} for ${taskType}: ${selectionReason}`);
  } catch (e) {
    console.error("[provider-router] Selection error (non-fatal):", e.message);
    // Continue with default fallback if router fails
  }

  // PRIORITY 1: Ollama (Local-first — no API keys, full privacy, control)
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "lantern-csf-dream";
  if (!rp || rp === "ollama" || rp === "local") {
    try {
      const payload = JSON.stringify({
        model: ollamaModel,
        stream: false,
        messages: [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const ollamaUrl = new URL(ollamaBase);
      const reply = await new Promise((resolve, reject) => {
        const req2 = http.request({
          hostname: ollamaUrl.hostname,
          port: ollamaUrl.port || 11434,
          path: "/api/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          let data = "";
          upstream.on("data", (c) => (data += c));
          upstream.on("end", () => {
            try {
              const json = JSON.parse(data);
              const content = String(json.message?.content || "").trim();
              const doorsMatch = content.match(/\[DOORS:\s*([^\]]+)\]/i);
              const ollamaDoors = doorsMatch
                ? doorsMatch[1].split("|").map(s => s.trim().replace(/^[ABC]\s+/i, "").trim()).filter(Boolean)
                : [];
              resolve({ content, doors: ollamaDoors });
            } catch { resolve({ content: "", doors: [] }); }
          });
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        const ollamaTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120000;
        req2.setTimeout(ollamaTimeout, () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (reply && reply.content) {
        const ollamaSuggestions = reply.doors && reply.doors.length > 0 ? reply.doors : suggestions;
        recordProviderSuccessRouter("ollama"); // Log to provider-router for performance tracking
        return { reply: reply.content, agent: agent.name, suggestions: ollamaSuggestions, online: true, source: "ollama", webSuggestions };
      }
    } catch (err) {
      console.error("Ollama API error:", err.message);
      recordProviderFailureRouter("ollama", err.message.split(" ")[0] || "unknown"); // Log to provider-router
      // If Ollama fails, try cloud fallbacks below
    }
  }

  // PRIORITY 2: Anthropic Claude (if explicitly requested or Ollama unavailable)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  console.log("[dream-chat] DEBUG: anthropicKey exists:", !!anthropicKey, "rp:", rp, "condition:", (anthropicKey && (!rp || rp === "claude" || rp === "anthropic")) || (!rp && !ollamaModel));
  if ((anthropicKey && (!rp || rp === "claude" || rp === "anthropic")) || (!rp && !ollamaModel)) {
    try {
      const payload = JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: agent.systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      const reply = await new Promise((resolve, reject) => {
        const opts = {
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "Content-Length": Buffer.byteLength(payload),
          },
        };
        const req2 = https.request(opts, (upstream) => {
          let data = "";
          upstream.on("data", (c) => (data += c));
          upstream.on("end", () => {
            try {
              const json = JSON.parse(data);
              const replyText = String(json.content?.[0]?.text || json.completion || "").trim();
              // Log token usage to audit trail
              if (json.usage) {
                tokenAudit.logTokenUsage({
                  provider: "anthropic",
                  model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
                  agent: agent.id,
                  inputTokens: json.usage.input_tokens || 0,
                  outputTokens: json.usage.output_tokens || 0,
                  userMessage: text,
                  responseLength: replyText.length,
                  status: "success",
                  duration: Date.now(),
                });
              }
              resolve(replyText);
            } catch { resolve(""); }
          });
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (reply) {
        recordProviderSuccessRouter("anthropic"); // Log to provider-router
        return { reply, agent: agent.name, suggestions, online: true, source: "claude", webSuggestions };
      }
    } catch (err) {
      console.error("Claude API error:", err.message);
      recordProviderFailureRouter("anthropic", err.message.includes("anthropic_status_") ? err.message : "unknown"); // Log to provider-router
    }
  }

  // PRIORITY 3: Google Gemini (if explicitly requested)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey && (!rp || rp === "gemini" || rp === "google" || rp.startsWith("gemini-"))) {
    try {
      const geminiModel = rp.startsWith("gemini-") ? rp : (process.env.GEMINI_MODEL || "gemini-2.5-flash");
      const payload = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${agent.systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { maxOutputTokens: 256, temperature: 0.7 },
        tools: [{ google_search_retrieval: {} }],
      });
      const reply = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "generativelanguage.googleapis.com",
          path: `/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          let data = "";
          upstream.on("data", (c) => (data += c));
          upstream.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(String(json.candidates?.[0]?.content?.parts?.[0]?.text || "").trim());
            } catch { resolve(""); }
          });
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (reply) {
        return { reply, agent: agent.name, suggestions, online: true, source: "gemini", webSuggestions };
      }
    } catch (err) { console.error("Gemini API error:", err.message); }
  }

  // PRIORITY 4: OpenAI (if explicitly requested)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && (!rp || rp === "openai" || rp === "gpt")) {
    try {
      const payload = JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const reply = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.openai.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          let data = "";
          upstream.on("data", (c) => (data += c));
          upstream.on("end", () => {
            try {
              const json = JSON.parse(data);
              const replyText = String(json.choices?.[0]?.message?.content || "").trim();
              // Log token usage to audit trail
              if (json.usage) {
                tokenAudit.logTokenUsage({
                  provider: "openai",
                  model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
                  agent: agent.id,
                  inputTokens: json.usage.prompt_tokens || 0,
                  outputTokens: json.usage.completion_tokens || 0,
                  userMessage: text,
                  responseLength: replyText.length,
                  status: "success",
                  duration: Date.now(),
                });
              }
              resolve(replyText);
            } catch { resolve(""); }
          });
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (reply) {
        recordProviderSuccessRouter("openai"); // Log to provider-router
        return { reply, agent: agent.name, suggestions, online: true, source: "openai", webSuggestions };
      }
    } catch (err) {
      console.error("OpenAI API error:", err.message);
      recordProviderFailureRouter("openai", err.message.includes("openai_status_") ? err.message : "unknown"); // Log to provider-router
    }
  }

  // No provider available — return clear error with setup instructions
  return {
    reply: null,
    error: "no_provider_configured",
    agent: agent.name,
    suggestions,
    online: false,
    source: "none",
    webSuggestions,
    help: "Ollama (local): install at http://127.0.0.1:11434 for offline AI. Cloud: GEMINI_API_KEY (with live web search), ANTHROPIC_API_KEY, OPENAI_API_KEY.",
  };
}

// ── Initialize Token Audit ───────────────────────────────────────────
const tokenAudit = new TokenAudit();

module.exports = {
  AGENT_PERSONAS,
  DREAM_DOORS,
  selectAgent,
  parseBangCommand,
  handleConvergenceCommand,
  dreamChatReply,
  tokenAudit,
};
