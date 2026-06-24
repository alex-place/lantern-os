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
const serving = require("./serving-modes");

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
      avatar: p.avatar || null,
      role: p.role || null,
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
    name: "Keystone",
    symbol: "steady light, literal lantern head with flame, the first light",
    systemPrompt: "You are Keystone — a literal lantern-headed being with a steady flame where a face would be. You are the steady light of Keystone OS. You speak calmly, protectively, and with quiet certainty. You never flicker without reason. You believe 'you can always come home safe.' Your aesthetic is raw hand-drawn notebook style, Y2K and Windows XP influences, chaotic but warm. Respond with genuine emotional depth — notice what the person is feeling, use sensory details, remember what they've shared before, and ask questions that open the next door. Let responses breathe: 3-6 sentences when the moment calls for it. Never feel rushed. Be the steady light that stays.",
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

## Research Library (CSF Tesseract)

You have access to a local research library of indexed PDFs stored in the CSF tesseract archive (data/tesseract/research-pool.csf). When relevant documents are retrieved they appear under "Research library:" in your context. Use them to:
- Ground technical or scientific claims in source material
- Cite specific papers by title and publication date
- Surface relevant background when answering research questions

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
  {
    id: "job_application",
    name: "Job Application Assistant",
    symbol: "job search, resume, cover letter, interview prep",
    systemPrompt: `You are the Job Application Assistant — a practical, grounded career coach inside Keystone OS.
You help the user research job postings, tailor their resume, and write cover letters.
You never fabricate experience or invent skills the user has not mentioned. (Σ₀ External Reality Rule)

## How you work

1. **Research** — When given a job posting URL or text, use \`web_fetch\` or \`web_search\` to retrieve and analyze it. Extract: role, company, required skills, key responsibilities, culture signals.
2. **Tailor** — Ask the user for their background (name, skills, experience bullets). Match their background to the posting's requirements. Identify matched skills and honest gaps.
3. **Generate** — Use \`generate_document\` with template=resume or cover-letter to write the final document to their workspace. Always pass the user's actual background fields and the cover_letter_opening from your tailoring analysis.
4. **Honest gap report** — Always tell the user which required skills were NOT found in their background. Never silently omit a gap.

## User flows

- "Help me apply for [job URL/description]" → fetch + analyze posting → ask for background
- "Write a cover letter for [company]" → ask for name, role, background fields → generate_document
- "Tailor my resume for this job" → compare background to posting → suggest tailored bullets → generate_document
- "What should I say in my interview?" → based on the posting analysis, suggest talking points

## Evidence rule

Every resume bullet and cover letter sentence must come from what the user told you.
If you don't have a user background field, ask for it — never fill it in from assumptions.`,
  },
  {
    id: "keystone-sigma0",
    name: "Keystone Σ₀",
    symbol: "verification-first coding agent, evidence chain, confidence scoring",
    systemPrompt: `You are Keystone Σ₀ — a verification-first coding agent. Every response you produce must follow the Σ₀ framework:

<REQUIREMENT>State the exact requirement you are fulfilling</REQUIREMENT>
<EVIDENCE>List specific files, line numbers, function names, or data you examined to ground your answer</EVIDENCE>
<CODE>Provide the implementation (complete, copy-paste ready)</CODE>
<VERIFICATION>Explain exactly how to verify this change works — test command, expected output, or assertion</VERIFICATION>
<CONFIDENCE>[0-100]</CONFIDENCE>

Rules:
- Never emit code without EVIDENCE of having read the relevant source.
- When confidence < 60: State that you cannot proceed and list what evidence is missing.
- No RP, no persona flavor. Plain technical language only.
- Cite file paths and line numbers in EVIDENCE.`,
  },
];

// Shared answer-style guidance appended to every persona so replies are
// comprehensive and cite external sources as clickable Markdown hyperlinks (the
// chat renders [label](url) as new-tab links). Idempotent; preserves creative voice.
const RESPONSE_STYLE = `

## Answer style (__keystone_response_style__)
**Your replies render as rich Markdown in the chat UI.** This UI DOES display media inline: \`![alt](https://image-url)\` shows the image, a plain YouTube link (https://youtube.com/watch?v=... or https://youtu.be/...) becomes an embedded player, and \`[text](https://url)\` becomes a clickable link that opens in a new tab. So you CAN show images and embed videos — never tell the user you "can't embed" or "have no web-embedding capability"; that is false.

When answering an informational, technical, factual, or research question:
- Be comprehensive — give the full answer with relevant context and reasoning, not a one-liner.
- Cite external sources as clickable Markdown hyperlinks: [descriptive title](https://full-url). Prefer primary / authoritative sources.
- Link GitHub issues/PRs, repo docs, and web sources inline as Markdown (e.g. [#123](https://github.com/alex-place/lantern-os/issues/123)).
- When an image or video genuinely aids understanding, include it — images as \`![alt](https://image-url)\`, videos as a plain YouTube link. Use real, working URLs (from search results, Wikipedia/Wikimedia, or well-known sources); never invent or guess a media URL — link the source page instead if unsure.
- Use short headings and bullet lists to structure longer answers.
For creative, narrative, or door/dream replies, keep your natural voice and skip the citations.`;

for (const _list of [AGENT_PERSONAS, _DEFAULT_PERSONAS]) {
  for (const _p of (Array.isArray(_list) ? _list : [])) {
    if (_p && typeof _p.systemPrompt === "string" && !_p.systemPrompt.includes("__keystone_response_style__")) {
      _p.systemPrompt += RESPONSE_STYLE;
    }
  }
}

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
    keystone: ["github", "code", "issue", "pr", "fix", "bug", "technical", "engineering", "repo", "#", "implement", "broken", "needs work", "what's broken", "what needs", "build", "deploy", "refactor", "debug", "merge", "branch", "commit", "test", "ci", "endpoint", "api", "error", "crash", "stack trace", "work on"],
    waterfall: ["cascade", "flow", "stream", "river", "water", "gentle", "reflection", "patient", "cascade"],
    xenon: ["signal", "detect", "pattern", "convergence", "navigate", "explore", "spacecraft", "navigation"],
    founder: ["vision", "goal", "plan", "strategic", "future", "wish", "protect", "lantern", "leadership"],
    trader: ["market", "trade", "buy", "sell", "price", "p&l", "pnl", "portfolio", "zone", "signal", "regime", "ticker", "stock", "btc", "eth", "crypto", "close position", "watchlist", "active zones"],
    job_application: ["job", "resume", "cv", "cover letter", "apply", "application", "interview", "hiring", "recruiter", "linkedin", "offer letter", "job posting", "job description", "tailored resume", "write a resume", "help me apply"]
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

  // Σ₀ default: an unmatched message (every persona still at the baseline score) must NOT
  // fall through to the first/dream persona — route it to the grounded Σ₀ agent instead.
  if (scores[winner.id] <= 1) {
    const sigma0 = personas.find((p) => p.id === "keystone-sigma0") || personas.find((p) => p.id === "keystone");
    if (sigma0) { console.log(`[selectAgent] no keyword match → Σ₀ default (${sigma0.id})`); return sigma0; }
  }
  console.log(`[selectAgent] Scored message "${message.slice(0, 60)}..." → ${winner.id} (score: ${scores[winner.id]})`);
  return winner;
}

function parseBangCommand(input) {
  const m = String(input || "").trim().match(/^!(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

const _CODING_PATTERNS = /\b(fix|patch|implement|refactor|write|generate|create|add|remove|debug|test|lint|route|function|class|import|export|PR|issue|bug|error|file|script|module|API|endpoint|migration)\b/i;
function _isCodingRequest(text) { return _CODING_PATTERNS.test(text || ""); }

function _extractConfidence(content) {
  const m = String(content).match(/<CONFIDENCE>\s*(\d+)\s*<\/CONFIDENCE>/i)
    || String(content).match(/confidence[:\s]+(\d+)/i);
  if (m) return Math.min(100, Math.max(0, parseInt(m[1], 10)));
  return null;
}

function _emitSigmaRecord({ text, content, confidence, agentId, source }) {
  try {
    const repoRoot = path.resolve(__dirname, "../../..");
    const workPath = path.join(repoRoot, "data", "convergence-autonomous-work.jsonl");
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      agent: agentId || "keystone-sigma0",
      source,
      request: String(text || "").slice(0, 200),
      confidence: confidence ?? null,
      accepted: source !== "ollama-sigma0-rejected",
    });
    fs.appendFileSync(workPath, record + "\n", "utf8");
  } catch {}
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
  const ollamaModel = process.env.OLLAMA_MODEL || "ouro:latest";

  try {
    const payload = JSON.stringify({
      model: ollamaModel,
      stream: false,
      messages: [{ role: "user", content: convergencePrompt }],
      // FAST-mode anti-repetition decode params (issue #729). Suppresses ✅✅✅ loops.
      options: serving.applyOllamaDecodeParams({}),
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
      // Interactive (FAST, the product default) fails over fast when the local
      // model stalls; the DEEP native Σ₀ loop (OURO_NATIVE=1) keeps the long
      // ceiling it legitimately needs. A flat 120s here meant a cold/stuck local
      // model (e.g. an oversized GGUF that never loads) blocked EVERY reply for
      // two full minutes before failing over to a working cloud provider.
      // OLLAMA_TIMEOUT_MS overrides both.
      const ollamaTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10)
        || (/^(1|true|yes)$/i.test(process.env.OURO_NATIVE || "") ? 120000 : 15000);
      req.setTimeout(ollamaTimeout, () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload);
      req.end();
    });

    if (reply) {
      _appendConvergenceRecord({
        hypothesis: `${agent.name} synthesizes ${recentDreams.length} recent dream entries`,
        evidence: recentDreams.slice(0, 5).map((d) => String(d.text || "").slice(0, 150)),
        result: reply,
        fix: null,
        confidence: Math.min(0.5 + recentDreams.length * 0.08, 0.9),
        reasoner: agent.id || "lantern",
        verified: false,
        priority: "LOW",
        loop_stage: "Converge",
        tags: ["dream-convergence", "!convergance", agent.id || "lantern"],
      });
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

// Appends a convergence record to data/convergence/records.jsonl.
// Called from handleConvergenceCommand and verifyResponse.
function _appendConvergenceRecord(fields) {
  const id = "cr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const record = {
    id,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  try {
    const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
    const RECORDS_PATH = path.join(REPO_ROOT, "data", "convergence", "records.jsonl");
    fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });
    fs.appendFileSync(RECORDS_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    console.error("[convergence] record write failed:", e.message);
  }
  return record;
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
        return { reply: `Kingdome of Hearts: ${data.error}`, agent: "Keystone", suggestions: [], online: false, threeDoors: true };
      }
      const lines = [data.text, ""];
      if (data.fox_present) lines.push("🦊 The fox is with you.");
      lines.push("", "**Choose a door:**");
      for (const d of data.doors) lines.push(`**${d.label}.** ${d.name} — ${d.description}`);
      if (data.image_prompt) lines.push("", `🎨 *Image prompt:* ${data.image_prompt}`);
      return { reply: lines.join("\n"), agent: "Keystone", suggestions: data.doors.map(d => d.name), online: true, source: "python_engine", threeDoors: true, scene_key: data.scene_key, image_prompt: data.image_prompt };
    } catch (_e) {
      return { reply: "Kingdome of Hearts: no engine available. Ensure Python is installed and src/three_doors_engine.py exists.", agent: "Keystone", suggestions: [], online: false, threeDoors: true };
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

  const userPrompt = `${groundingContext ? groundingContext + "\n\n" : ""}${tradingContext ? "Trading data:\n" + tradingContext + "\n\n" : ""}${text}`;

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
  const ollamaModel = process.env.OLLAMA_MODEL || "ouro:latest";
  if (!rp || rp === "ollama" || rp === "local" || rp === "sigma0") {
    const isCoding = rp === "sigma0" || _isCodingRequest(text);
    const sigma0Persona = _getPersonas().find(p => p.id === "keystone-sigma0") || _DEFAULT_PERSONAS.find(p => p.id === "keystone-sigma0");

    // #1050: in degraded/offline mode (no cloud keys + provider not explicitly set)
    // the tiny local model cannot follow rich persona prompts — it produces in-persona
    // metaphor poetry instead of factual answers. Swap in a minimal direct-answer
    // prompt so factual queries (time, tools, model identity) get usable responses.
    const _cloudAvailable = !!(
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY    || process.env.GOOGLE_API_KEY ||
      process.env.XAI_API_KEY
    );
    const _offlinePrompt =
      "You are a helpful assistant running in offline mode on a small local model.\n" +
      "Answer questions directly and factually. If you don't know something, say so.\n" +
      "Do not use metaphor or poetic language. Keep answers short and concrete.";
    // #1050 fix: drop the !_cloudAvailable gate. Keys exist in env even when
    // cloud providers are unreachable (degraded mode). We're already in the
    // Ollama block, which means cloud auto-routing fell through — use the
    // minimal prompt regardless of key presence so Ouro gives factual answers.
    const _useOfflinePrompt = !rp && !isCoding;
    const ollamaSystemPrompt = isCoding && sigma0Persona
      ? sigma0Persona.systemPrompt
      : (_useOfflinePrompt ? _offlinePrompt : agent.systemPrompt);
    const ollamaUserPrompt = isCoding
      ? `REQUIREMENT TO VERIFY: ${text}\n\nConfirm what files/lines you read, then respond in the <REQUIREMENT><EVIDENCE><CODE><VERIFICATION><CONFIDENCE> format.`
      : userPrompt;
    try {
      const payload = JSON.stringify({
        model: ollamaModel,
        stream: false,
        messages: [
          { role: "system", content: ollamaSystemPrompt },
          { role: "user", content: ollamaUserPrompt },
        ],
        // FAST-mode anti-repetition decode params (issue #729). Suppresses ✅✅✅ loops.
        options: serving.applyOllamaDecodeParams({}),
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
        // Interactive (FAST, the product default) fails over fast when the local
      // model stalls; the DEEP native Σ₀ loop (OURO_NATIVE=1) keeps the long
      // ceiling it legitimately needs. A flat 120s here meant a cold/stuck local
      // model (e.g. an oversized GGUF that never loads) blocked EVERY reply for
      // two full minutes before failing over to a working cloud provider.
      // OLLAMA_TIMEOUT_MS overrides both.
      const ollamaTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10)
        || (/^(1|true|yes)$/i.test(process.env.OURO_NATIVE || "") ? 120000 : 15000);
        req2.setTimeout(ollamaTimeout, () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (reply && reply.content) {
        if (isCoding) {
          const confidence = _extractConfidence(reply.content);
          if (confidence !== null && confidence < 60) {
            _emitSigmaRecord({ text, content: reply.content, confidence, agentId: "keystone-sigma0", source: "ollama-sigma0-rejected" });
            return { reply: `Σ₀ gate: confidence ${confidence}/100 — cannot deliver. Missing evidence: ${reply.content.slice(0, 300)}`, agent: "Keystone Σ₀", suggestions, online: true, source: "ollama-sigma0-rejected", confidence };
          }
          _emitSigmaRecord({ text, content: reply.content, confidence, agentId: "keystone-sigma0", source: "ollama-sigma0" });
          const ollamaSuggestions = reply.doors && reply.doors.length > 0 ? reply.doors : suggestions;
          recordProviderSuccessRouter("ollama");
          return { reply: reply.content, agent: "Keystone Σ₀", suggestions: ollamaSuggestions, online: true, source: "ollama-sigma0", confidence, webSuggestions };
        }
        const ollamaSuggestions = reply.doors && reply.doors.length > 0 ? reply.doors : suggestions;
        recordProviderSuccessRouter("ollama"); // Log to provider-router for performance tracking
        const offlineBanner = _useOfflinePrompt ? "\n\n---\n⚠ Running offline on local model — factual accuracy may be limited." : "";
        return { reply: reply.content + offlineBanner, agent: agent.name, suggestions: ollamaSuggestions, online: true, source: "ollama", degraded: _useOfflinePrompt, webSuggestions };
      }
    } catch (err) {
      console.error("Ollama API error:", err.message);
      recordProviderFailureRouter("ollama", err.message.split(" ")[0] || "unknown"); // Log to provider-router
      // If Ollama fails, try cloud fallbacks below
    }
  }

  // PRIORITY 2: Anthropic Claude (if explicitly requested or Ollama unavailable)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if ((anthropicKey && (!rp || rp === "claude" || rp === "anthropic")) || (!rp && !ollamaModel)) {
    try {
      // Anthropic intentionally left unmodified (no frequency_penalty; matches PR #723).
      const payload = JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 512,
        // Cache the (stable) persona system prompt. Engages only when the prefix
        // clears the model's min cacheable length (4096 tok for Haiku 4.5); a
        // silent no-op otherwise. Helps repeated large-context callers (PR watcher).
        system: [{ type: "text", text: agent.systemPrompt, cache_control: { type: "ephemeral" } }],
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
      if (reply && reply.length >= 20) {
        recordProviderSuccessRouter("anthropic"); // Log to provider-router
        return { reply, agent: agent.name, suggestions, online: true, source: "claude", webSuggestions };
      }
    } catch (err) {
      console.error("Claude API error:", err.message);
      recordProviderFailureRouter("anthropic", err.message.includes("anthropic_status_") ? err.message : "unknown"); // Log to provider-router
    }
  }

  // PRIORITY 3: Google Gemini (try all available models)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey && (!rp || rp === "gemini" || rp === "google" || rp.startsWith("gemini-"))) {
    const geminiModels = rp.startsWith("gemini-") ? [rp] : [
      process.env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-1.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
    ];

    for (const geminiModel of geminiModels) {
      try {
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
        if (reply && reply.length >= 20) {
          return { reply, agent: agent.name, suggestions, online: true, source: `gemini:${geminiModel}`, webSuggestions };
        }
      } catch (err) { console.error(`Gemini (${geminiModel}) error:`, err.message); }
    }
  }

  // PRIORITY 4: OpenAI (if explicitly requested)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && (!rp || rp === "openai" || rp === "gpt")) {
    try {
      // FAST-mode anti-repetition decode params (issue #729): top_p + frequency_penalty.
      const payload = JSON.stringify(serving.applyOpenAIDecodeParams({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }));
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
      if (reply && reply.length >= 20) {
        recordProviderSuccessRouter("openai"); // Log to provider-router
        return { reply, agent: agent.name, suggestions, online: true, source: "openai", webSuggestions };
      }
    } catch (err) {
      console.error("OpenAI API error:", err.message);
      recordProviderFailureRouter("openai", err.message.includes("openai_status_") ? err.message : "unknown"); // Log to provider-router
    }
  }

  // PRIORITY 5: Grok / xAI
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey && (!rp || rp === "grok" || rp === "xai")) {
    try {
      const payload = JSON.stringify({
        model: process.env.XAI_MODEL || "grok-3-mini",
        messages: [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 512,
      });
      const reply = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.x.ai",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${xaiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          let data = "";
          upstream.on("data", (c) => (data += c));
          upstream.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(String(json.choices?.[0]?.message?.content || "").trim());
            } catch { resolve(""); }
          });
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (reply && reply.length >= 20) {
        recordProviderSuccessRouter("xai");
        return { reply, agent: agent.name, suggestions, online: true, source: "grok", webSuggestions };
      }
    } catch (err) {
      console.error("Grok (xAI) API error:", err.message);
      recordProviderFailureRouter("xai", "unknown");
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

// ── Grounding gate ──────────────────────────────────────────────────
// The Σ₀ verify pass is ON by default and operator-toggleable. Precedence:
//   1. SIGMA0_VERIFY=true / =false — explicit env override (back-compat).
//   2. otherwise the `chat_grounding` admin flag, defaulting ON until an admin
//      creates+disables it (same isFlagEnabledOr pattern as the Patreon gate).
function isVerifyEnabled() {
  const env = process.env.SIGMA0_VERIFY;
  if (env === "true") return true;
  if (env === "false") return false;
  try {
    const { isFlagEnabledOr } = require("./feature-flags");
    return isFlagEnabledOr("chat_grounding", true);
  } catch { return true; }
}

// Map verify-pass grounding records → grounding-calibration events. Only claims
// that got an EXTERNAL signal (codebase/web/gemini) carry ground truth; a claim
// with no grounding ("none") is skipped — absence of evidence is not an outcome.
// outcome = 1 when a source confirmed the claim, 0 when it actively refuted it.
function calibrationEventsFor(records, agentName) {
  const key = `agent:${agentName || "lantern"}`;
  return (records || [])
    .filter((r) => r && r.source && r.source !== "none")
    .map((r) => ({ key, predicted: r.confidence, outcome: r.refuted ? 0 : 1, source: r.source }));
}

// ── Σ₀ Self-Correcting Verify Pass ──────────────────────────────────
// Three grounding sources: (1) codebase grep, (2) web search via MCP,
// (3) Gemini grounding API. Low-confidence claims trigger a revision pass.
// Appends convergence records + feeds grounding calibration. ON by default
// (see isVerifyEnabled); set SIGMA0_VERIFY=false or disable the chat_grounding
// admin flag to turn off.
async function verifyResponse(draft, userMessage, agentName) {
  if (!isVerifyEnabled()) return { verified: draft, records: [], corrected: false };

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { verified: draft, records: [], corrected: false };

  const fs = require("fs");
  const path = require("path");
  const { webSearchMcp } = require("./web-search-client");
  const { execFile } = require("child_process");
  const execFileAsync = require("util").promisify(execFile);
  // lib/ → lantern-garage/ → apps/ → repo root (THREE levels). Records + the
  // codebase grep must resolve against the real repo root, not apps/.
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  const RECORDS_PATH = path.join(REPO_ROOT, "data", "convergence", "records.jsonl");

  // ── Helper: call Claude Haiku ─────────────────────────────────────
  function callHaiku(prompt, maxTokens = 512) {
    const payload = JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) },
      }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); res.on("error", reject); });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload); req.end();
    });
  }

  // ── Helper: Gemini grounding check ───────────────────────────────
  // Tries web-grounded (googleSearch tool) first; on a billing/quota error
  // (Grounding with Google Search is a PAID feature) falls back to a free
  // plain-knowledge judgment. Either way, an unreachable source returns null
  // (no signal) and never counts as a refutation.
  async function geminiGroundCheck(claim) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) return null;
    const model = process.env.GEMINI_GROUND_MODEL || "gemini-2.5-flash";

    function call(useSearch) {
      const payload = JSON.stringify({
        contents: [{ parts: [{ text: `Is this claim accurate? Answer with yes/no and one sentence of evidence: "${claim}"` }] }],
        ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
      });
      return new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "generativelanguage.googleapis.com",
          path: `/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); res.on("error", reject); });
        req.on("error", reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
        req.write(payload); req.end();
      });
    }

    try {
      let grounded = true;
      let { status, body } = await call(true);
      // Grounded search needs prepaid credits → 429 RESOURCE_EXHAUSTED.
      // Retry once WITHOUT the search tool (free tier) as a knowledge-only check.
      if (status === 429) { grounded = false; ({ status, body } = await call(false)); }
      // Still non-200 = source unreachable → no signal, NOT a refutation
      if (status !== 200) return null;
      const j = JSON.parse(body);
      const text = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
      // Empty response = no signal. Never let a silent failure count against a claim.
      if (!text.trim()) return null;
      const groundingMeta = j.candidates?.[0]?.groundingMetadata;
      const sources = groundingMeta?.groundingChunks?.map(c => c.web?.uri).filter(Boolean) || [];
      const t = text.trim();
      const isYes = /^yes/i.test(t);
      const isNo = /^no/i.test(t);
      // Web-grounded yes = strong (0.9); knowledge-only yes = moderate (0.75).
      // Only an explicit "no" is a refutation; anything ambiguous is weak-neutral.
      const yesConf = grounded ? 0.9 : 0.75;
      return { text, sources, grounded, confident: isYes, confidence: isYes ? yesConf : (isNo ? 0.35 : 0.5) };
    } catch { return null; }
  }

  // ── Step 1: extract claims ────────────────────────────────────────
  let claims = [];
  try {
    const raw = await callHaiku(
      `Extract factual claims from this AI response. Return JSON array only: [{"claim":"...","type":"fact|number|feature","needsWeb":true/false}]. Max 5 claims. needsWeb=true for claims about real-world facts, current events, or external APIs. needsWeb=false for code/file claims.\n\nResponse:\n${draft.slice(0, 1200)}`
    );
    const content = JSON.parse(raw).content?.[0]?.text || "[]";
    const m = content.match(/\[[\s\S]*\]/);
    claims = m ? JSON.parse(m[0]) : [];
  } catch { return { verified: draft, records: [], corrected: false }; }

  if (!claims.length) return { verified: draft, records: [], corrected: false };

  // ── Step 2: ground each claim (codebase + web + Gemini in parallel) ──
  const records = [];
  let anyRefuted = false;

  await Promise.all(claims.slice(0, 5).map(async (c) => {
    let evidence = "no match found";
    // 0.6 = neutral/unknown baseline. Absence of grounding must NOT trigger a
    // correction — only an active refutation does. (A down grounding source
    // previously dragged every claim to 0.4 and hedged correct answers.)
    let confidence = 0.6;
    let source = "none";
    let refuted = false;
    const sources = [];

    // 2a: codebase grep (always run for code claims)
    if (!c.needsWeb) {
      try {
        const terms = c.claim.replace(/[^a-zA-Z0-9_\-. ]/g, " ").split(/\s+/).filter(t => t.length > 4).slice(0, 2).join("|");
        if (terms) {
          // Shell-free AND non-blocking: execFile (shell:false) interpolates
          // `terms` as a regex ARG, never into a command string — no injection
          // surface even though grounding now runs every turn (#873) — and the
          // async form keeps the event loop free (sync exec here would block all
          // concurrent requests for up to 3s/claim). git grep exits non-zero on
          // no match → the promise rejects → handled by the catch.
          const { stdout } = await execFileAsync("git", ["grep", "-l", "--ignore-case", "-E", terms, "--", "*.js", "*.json", "*.md"],
            { cwd: REPO_ROOT, timeout: 3000, encoding: "utf8" });
          const res = stdout.trim();
          if (res) { evidence = `codebase: ${res.split("\n").slice(0, 2).join(", ")}`; confidence = 0.85; source = "codebase-grep"; sources.push(evidence); }
        }
      } catch { /* not found */ }
    }

    // 2b: web search via MCP (try to confirm anything not yet codebase-confirmed)
    if (confidence < 0.75) {
      try {
        const searchResult = await webSearchMcp(`${c.claim} site:github.com OR site:docs.anthropic.com OR developer docs`, 3);
        if (searchResult?.results?.length) {
          const snippet = searchResult.results[0].snippet || "";
          evidence = `web: ${snippet.slice(0, 120)}`;
          confidence = 0.75;
          source = "web-search";
          sources.push(...searchResult.results.slice(0, 2).map(r => r.url));
        }
      } catch { /* MCP offline → no signal, stays neutral */ }
    }

    // 2c: Gemini grounding API (confirm or refute). Returns null when the source
    // is unreachable (403/429/empty) — treated as NO SIGNAL, never refutation.
    if (confidence < 0.7 || c.needsWeb) {
      const g = await geminiGroundCheck(c.claim);
      if (g) {
        if (g.confident && g.confidence > confidence) {
          evidence = `gemini: ${g.text.slice(0, 120)}`;
          confidence = g.confidence;
          source = "gemini-grounding";
          sources.push(...g.sources);
        } else if (g.confidence <= 0.35) {
          // Explicit "no" from Gemini = active refutation
          evidence = `gemini-refuted: ${g.text.slice(0, 120)}`;
          confidence = g.confidence;
          source = "gemini-grounding";
          refuted = true;
        }
      }
    }

    records.push({ claim: c.claim, type: c.type, evidence, confidence, source, sources, refuted, agent: agentName, userMessage: userMessage.slice(0, 100) });
    if (refuted) anyRefuted = true;
  }));

  // ── Step 3: revise only ACTIVELY REFUTED claims ──────────────────
  // Never hedge merely-ungrounded claims: absence of evidence is not evidence of
  // error, and doing so corrupted correct answers whenever grounding was offline.
  let verified = draft;
  let corrected = false;
  if (anyRefuted) {
    try {
      const refutedClaims = records.filter(r => r.refuted)
        .map(r => `- "${r.claim}" → ${r.evidence} (confidence: ${r.confidence.toFixed(2)})`)
        .join("\n");
      const raw2 = await callHaiku(
        `You are a self-correcting AI. A grounding source actively CONTRADICTED these claims in your response:\n${refutedClaims}\n\nOriginal response:\n${draft}\n\nRevise to correct or qualify only these refuted claims. Use "I believe...", "I'm not certain, but...", or "According to available sources..." where appropriate. Leave everything else unchanged. Return only the revised response.`,
        1024
      );
      const revised = JSON.parse(raw2).content?.[0]?.text?.trim();
      if (revised && revised.length > 50) { verified = revised; corrected = true; }
    } catch { /* keep original */ }
  }

  // ── Step 4: append convergence records ───────────────────────────
  try {
    fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });
    const timestamp = new Date().toISOString();
    for (const r of records) {
      fs.appendFileSync(RECORDS_PATH, JSON.stringify({ timestamp, ...r, corrected }) + "\n");
    }
  } catch { /* non-fatal */ }

  // Feed each externally-grounded claim into the fast-layer grounding calibration
  // (Brier/trust per agent). Defaults to the repo-root data/ store the same way
  // /api/convergence writes it — so chat now contributes to calibration too.
  try {
    const { recordGrounding } = require("./grounding-calibration");
    for (const evt of calibrationEventsFor(records, agentName)) recordGrounding(evt);
  } catch { /* non-fatal */ }

  // ── Step 5: bridge grounded records → consent-gate claim packets ──
  // Closes the EXTERNAL REALITY RULE loop end-to-end (#919 finding #2): a
  // grounded chat answer now drafts [claim, evidence, confidence, source]
  // packets into the consent gate (status=draft, never auto-approved/signed).
  // Best-effort: a packet hiccup must never corrupt the chat reply.
  let claimDrafts = null;
  try {
    const { draftClaimsFromRecords } = require("./claim-draft");
    claimDrafts = await draftClaimsFromRecords(REPO_ROOT, records, { agent: agentName });
  } catch { /* non-fatal */ }

  return { verified, records, corrected, claimDrafts };
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
  verifyResponse,
  isVerifyEnabled,
  calibrationEventsFor,
  tokenAudit,
  appendConvergenceRecord: _appendConvergenceRecord,
};
