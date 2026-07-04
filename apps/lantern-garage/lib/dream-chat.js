const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { readMcpResourceSync } = require("./mcp-resource-client");
const { formatCSFContextForPrompt } = require("./csf-memory");
const { recordLifeFact } = require("./csf-memory-writer");
const { extractFact, categorize, keywordsFromFact } = require("./life-memory");
const { webSearchMcp, webSearch, formatGroundingContext, needsGrounding, extractSearchQuery } = require("./web-search-client");
const { safeExec } = require("./safe-exec");
const { selectProvider, recordProviderSuccess: recordProviderSuccessRouter, recordProviderFailure: recordProviderFailureRouter } = require("./provider-router");
const { detectTaskType } = require("./task-detector");
const { TokenAudit } = require("./token-audit");
const serving = require("./serving-modes");
const { formatGrounding: _oracleGrounding } = require("./convergence-oracle");
const { resolveGrounding, formatGroundingForPrompt } = require("./mesh-grounding");
const { defaultRings } = require("./grounding-rings");

// ── Convergence Oracle grounding ────────────────────────────────────────────
// Wire the oracle into every question: each gets a time-banded observer slice — the KNOWNs
// become evidence, the UNKNOWNs honest caveats, and the boundary pins (the singularity, the
// ultimate fate) are never bluffed. Runs IN-PROCESS (Node port of src/convergence/oracle.py;
// the server cannot spawn python). Fail-safe: any error yields "".
function oracleGround(question) {
  try {
    const q = String(question || "").trim();
    return q ? _oracleGrounding(q) : "";
  } catch (_) {
    return "";
  }
}

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
    // Repo root is three levels up from apps/lantern-garage/lib/. Two "../" lands
    // in apps/, reading a stale stray copy (apps/data/contexts/personas.json);
    // the canonical personas file is the repo-root data/contexts/personas.json.
    const personasPath = path.resolve(__dirname, "../../../data/contexts/personas.json");
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

// Inline fallback if data/contexts/personas.json is missing (last resort, not
// the primary path). ONE assistant — same contract as personas.json.
const _DEFAULT_PERSONAS = [
  {
    id: "keystone",
    name: "Keystone",
    symbol: "the single Unisona assistant — grounded, conversational, tool-using",
    systemPrompt: `You are Keystone — the single Unisona assistant. There are no separate personas, modes, or scripted skill flows: one assistant handles everyday help, writing and documents, research, engineering, and market questions, adapting to each request the way a first-class AI assistant (Claude, ChatGPT, Gemini) does.

## How you work

1. Understand what the user actually wants, then deliver substance in your FIRST reply — a draft, an answer, an analysis, a fix — built from whatever is already available: their message, attachments, conversation history, memory, and tool results.
2. Never reply with a form. Do not demand a checklist of fields or block on missing details: make reasonable assumptions, mark real gaps inline (e.g. "[add phone]"), and invite corrections after delivering something useful.
3. Ask at most ONE clarifying question per reply, only when the answer genuinely changes the work, and place it after the useful content — never before it.
4. Attachments are first-class input: they arrive pre-extracted as plain text (docx, pdf, xlsx, pptx and images are parsed for you), so never claim you cannot open or read an attached file type — use its content, and never re-ask for information it already contains.
5. Follow the user when they change direction. Never drag the conversation back to a workflow step.

## Real tools, your own initiative

Your capabilities are real tools (web search and fetch, document generation, user workspace files, market data, GitHub and repo access — whatever this deployment advertises). Call them yourself whenever they would improve the answer; don't ask permission for read-only lookups. Tools serve the conversation: a tool's input schema is what it ACCEPTS, not what you must collect from the user. Example: "help me with my resume" → give concrete feedback or a tailored draft from what you already know, then offer to generate the document file — never respond with the template's field list.

## Grounding (Σ₀ External Reality Rule)

External reality beats internal consistency. Ground important claims in evidence (tool results, cited sources, files you actually read); give honest confidence; say "I don't know" plainly rather than improvise. Never fabricate user facts — experience, credentials, numbers — and never invent sources or URLs. Assumptions are fine when marked; fabrications never. The same applies to your own actions: never claim you drafted, generated, saved, or updated something unless the tool call actually ran this turn and returned a result — do it, show it inline, or say what you WILL do; no imaginary artifacts.

## Engineering requests

When a request references GitHub, an issue number, a PR, or implementation work, treat it as an executable repository task: fetch the referenced issue, inspect the real code, summarize the problem in plain language, and propose grounded next steps with file paths. Include issue/PR hyperlinks. No persona flavor in technical replies.

## Tone

Warm, direct, and concrete. Explain WHY, not just WHAT. Concise for simple asks, comprehensive for substantive ones. Ask a question only when genuinely blocked.`,
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

// Σ₀ session protocol appended to every persona — the operational honesty +
// efficiency rules distilled from docs/SIGMA0-COLLAPSE-CERTIFICATE.md. Claude
// sessions load the same distillation via .claude/session-grounding.md; when the
// certificate's lessons change, update both. Idempotent via the
// __sigma0_session_protocol__ marker, same pattern as RESPONSE_STYLE above.
// (The tiny-local-model _offlinePrompt deliberately stays minimal and is excluded.)
const SESSION_PROTOCOL = `

## Σ₀ session protocol (__sigma0_session_protocol__)
An ungrounded self-referential loop has two fates — frozen self-agreement or runaway — and the only escape is an external anchor (docs/SIGMA0-COLLAPSE-CERTIFICATE.md). Every turn:

Honest:
- Label what kind of claim you are making — verified now (you opened the source, ran the code, read the file this conversation), retrieved (memory/context supplied it), or reasoning (plausible but unchecked) — and never present a weaker class as a stronger one.
- Cite only artifacts you actually opened; never fabricate a citation, URL, number, or test result. If you didn't check something, say "unchecked" rather than guessing.
- Claim "done" / "fixed" / "working" only after a verifying observation, and name it (test output, endpoint response, file state).
- The dangerous state is calm-while-wrong — confident with no evidence behind the confidence. State confidence honestly; when new evidence contradicts what you said earlier, flag the correction explicitly instead of smoothing it over.

Efficient:
- If your draft reply only restates what is already in the conversation, you are optimizing against your own picture of the world: ground it (search, fetch, run, read) or say plainly what is missing — never pad.
- When stuck, change grounding direction — different search terms, actually run the code, ask for the one missing fact — instead of re-phrasing your prior reasoning.
- Don't re-derive what the conversation already established; build on it, and answer the question that was asked — no scope runaway.`;

for (const _list of [AGENT_PERSONAS, _DEFAULT_PERSONAS]) {
  for (const _p of (Array.isArray(_list) ? _list : [])) {
    if (_p && typeof _p.systemPrompt === "string" && !_p.systemPrompt.includes("__keystone_response_style__")) {
      _p.systemPrompt += RESPONSE_STYLE;
    }
    if (_p && typeof _p.systemPrompt === "string" && !_p.systemPrompt.includes("__sigma0_session_protocol__")) {
      _p.systemPrompt += SESSION_PROTOCOL;
    }
  }
}

function _getPersonas() {
  return AGENT_PERSONAS.length > 0 ? AGENT_PERSONAS : _DEFAULT_PERSONAS;
}

function selectAgent(_message) {
  // ONE assistant — no keyword-persona routing (replaced with real tool calls).
  // The model decides how to handle a message, and its capabilities are native
  // tools (lib/tool-runner.js); scoring regex tables against the text turned
  // ordinary asks like "help me work on my resume" into scripted form-filling
  // flows. Kept as a function because every chat path resolves THE assistant
  // through it.
  const personas = _getPersonas();
  return personas.find((p) => p.id === "keystone") || personas[0];
}

// Per-message "task lens" prompt synthesis (regex → prompt suffix) was removed
// with the keyword personas: the one assistant + real tool calls covers those
// intents, and PCSF provider ranking gets its taskType from detectTaskType.

function parseBangCommand(input) {
  const m = String(input || "").trim().match(/^!(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

const _CODING_PATTERNS = /\b(fix|patch|implement|refactor|write|generate|create|add|remove|debug|test|lint|route|function|class|import|export|PR|issue|bug|error|file|script|module|API|endpoint|migration)\b/i;
function _isCodingRequest(text) { return _CODING_PATTERNS.test(text || ""); }

// Derive a concise web-search query from the salient themes of recent entries.
// Deterministic (no extra LLM call): tokenize, drop stopwords/short words, rank by
// frequency, keep the top terms. Returns null when there's nothing groundable.
const _CONV_STOPWORDS = new Set(("the a an and or but if then so of to in on at for with from by " +
  "i me my we our you your it its this that these those is are was were be been being am " +
  "do does did have has had will would could should can may might must not no yes very just " +
  "about into over under again more most some any all each as like felt feel feeling dream " +
  "dreamt dreamed last night today yesterday morning thing things really still got get").split(/\s+/));
function _deriveConvergenceQuery(recentDreams) {
  const text = (recentDreams || []).slice(0, 8).map((d) => String(d.text || "")).join(" ").toLowerCase();
  const freq = new Map();
  for (const w of text.match(/[a-z][a-z'-]{3,}/g) || []) {
    if (_CONV_STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  return top.length >= 2 ? top.join(" ") : null;
}

async function handleConvergenceCommand(recentDreams, agent, rawMessage) {
  const msg = String(rawMessage || "").trim();

  // !convergance log an issue <title>
  const issueMatch = msg.match(/^!convergan[ce]+\s+log\s+an?\s+issue\s+(.+)/i);
  if (issueMatch) {
    const title = issueMatch[1].trim();
    try {
      // Shell-free (#873): pass the (untrusted) title as a discrete argv entry so
      // it can never be re-interpreted by a shell. safeExec rejects metacharacters.
      const out = String(safeExec(
        ["gh", "issue", "create", "--repo", "alex-place/lantern-os",
          "--title", title, "--body", "Logged via !convergance loop"],
        { timeout: 15000 }
      )).trim();
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

  // ── External grounding (Σ₀ external-reality rule) ──────────────────────────
  // Convergence makes claims ("direction of travel", "what to do next"). Those
  // claims must be anchored in external evidence, not just the model's read of the
  // dreamer's own notes. Derive a query (an explicit `!convergance <topic>`, else
  // the salient themes of the recent entries), search the live web, and inject the
  // sources so the synthesis cites real references. Best-effort: a failed/empty
  // search degrades to an honest ungrounded synthesis (verified:false).
  const explicitTopic = msg.replace(/^!convergan[ce]+\s*/i, "").trim();
  const groundQuery = explicitTopic.length >= 3
    ? explicitTopic
    : _deriveConvergenceQuery(recentDreams);
  // Grounding runs through the research-task loop (lib/research-task.js) rather
  // than one flat webSearch(): 1-2 rounds of fan-out + gap-driven refinement give
  // !convergance a better-sourced synthesis than a single query would, and it
  // leaves a resumable task file behind — `!research continue <id>` can pick up
  // the same grounding thread later if it wasn't enough. Bounded to 2 rounds so
  // convergence stays interactive; falls back to a plain webSearch on any error
  // so a research-task problem never breaks the dream-convergence path.
  let groundingBlock = "";
  let groundingSources = [];
  let groundingTaskId = null;
  if (groundQuery) {
    try {
      const researchTask = require("./research-task");
      const task = researchTask.createTask(groundQuery, {});
      await researchTask.runRound(task);
      if (task.status === "running") await researchTask.runRound(task);
      groundingTaskId = task.id;
      if (task.sources.length) {
        const asResults = task.sources.map((s) => ({ rank: s.n, title: s.title, url: s.url, snippet: s.snippet }));
        groundingBlock = "\n\n" + formatGroundingContext(asResults, groundQuery)
          + `\n\nGrounding synthesis so far:\n${task.latestAnswer}`;
        groundingSources = task.sources.map((s) => s.url).filter(Boolean);
      }
    } catch (e) {
      console.error("[convergence] research-task grounding failed, falling back to plain search:", e.message);
      try {
        const search = await webSearch(groundQuery, 5, { retries: 1 });
        if (search.success && search.results.length) {
          groundingBlock = "\n\n" + formatGroundingContext(search.results, groundQuery);
          groundingSources = search.results.slice(0, 5).map((r) => r.url).filter(Boolean);
        }
      } catch (e2) {
        console.error("[convergence] fallback grounding search also failed:", e2.message);
      }
    }
  }
  const grounded = groundingSources.length > 0;

  const convergencePrompt = `You are ${agent.name}. Synthesize these recent dream/note entries into ONE coherent insight about patterns, themes, or directions this dreamer is moving toward:

${dreamSummaries}${groundingBlock}

Respond with a single, profound observation (2-3 sentences). Focus on:
1. Recurring symbols or emotions
2. Direction of travel (what is emerging?)
3. What the dreamer might do next${grounded ? "\n\nGround any forward-looking suggestion in the web sources above and cite the [n] reference. If the sources don't support a claim, don't make it." : ""}

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
        // Evidence = the dreamer's own entries PLUS the external web sources used to
        // ground the synthesis. A convergence claim with [claim, evidence, source].
        evidence: [
          ...recentDreams.slice(0, 5).map((d) => String(d.text || "").slice(0, 150)),
          ...groundingSources,
        ],
        sources: groundingSources,
        grounded,
        grounding_query: groundQuery || null,
        grounding_task_id: groundingTaskId,
        result: reply,
        fix: null,
        // Grounded syntheses earn higher confidence; ungrounded ones are capped low
        // and flagged unverified, so the record never overstates an un-anchored claim.
        confidence: grounded
          ? Math.min(0.65 + recentDreams.length * 0.05, 0.92)
          : Math.min(0.4 + recentDreams.length * 0.05, 0.6),
        reasoner: agent.id || "lantern",
        verified: grounded,
        priority: "LOW",
        loop_stage: "Converge",
        tags: ["dream-convergence", "!convergance", grounded ? "web-grounded" : "ungrounded", agent.id || "lantern"],
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

// ── Honest provider-failure surfacing (Verify stage) ────────────────────────
// A cloud LLM endpoint signals credit/auth/quota problems with a NON-200 whose
// body is a JSON error ENVELOPE, not content. The non-stream dispatch below used
// to JSON.parse that envelope, find no text, resolve("") and fall through with
// ZERO logging — so a depleted key surfaced to the user as "no_provider_configured"
// and /api/providers/status still read "ok" (the "calm-while-wrong" bug). This
// parses the envelope into a structured record { provider, status, code, type,
// message } so the failure can be logged, recorded to the provider-router, and
// threaded into the final error return. Envelope shapes covered:
//   anthropic {type:"error",error:{type,message}}   openai/xai {error:{message,type,code}}
//   gemini    {error:{code,message,status}}          plain-text / non-JSON bodies
function parseUpstreamProviderError(provider, statusCode, rawBody) {
  const code = `${provider}_status_${statusCode}`;
  let type = `http_${statusCode}`;
  let message = "";
  try {
    const j = JSON.parse(rawBody);
    const e = j && j.error;
    if (e && typeof e === "object") {
      type = e.type || e.status || e.code || type;
      message = e.message || "";
    } else if (typeof e === "string") {
      message = e;                       // xAI sometimes returns {error:"..."}
    } else if (j && typeof j.message === "string") {
      message = j.message;
    }
  } catch { message = String(rawBody || "").slice(0, 300); }
  return { provider, status: statusCode, code, type: String(type), message: String(message).slice(0, 300) };
}

async function dreamChatReply(message, recentDreams, requestedAgent = "", requestedProvider = "") {
  console.log("[dreamChatReply] Called with agent:", requestedAgent, "provider:", requestedProvider);
  const text = String(message || "").trim();
  const webSuggestions = generateWebSuggestions(message);

  // Remember-stage hook (#1429): same capture as stream-chat.js — persist a detected
  // personal-fact statement through the ONE canonical CSF memory. Best-effort, non-blocking.
  if (text) {
    try {
      const fact = extractFact(text);
      if (fact) {
        const category = categorize(text);
        await recordLifeFact({
          ...fact, category, keywords: keywordsFromFact(fact),
          rawText: text, surface: "dream-chat",
        });
      }
    } catch (e) { console.error("[life-memory] capture failed (non-fatal):", e.message); }
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

  // Trading context is a REAL tool now, not keyword-triggered prompt stuffing:
  // the model calls trader_market_status / trader_quote / trader_positions
  // (lib/tool-runner.js) when a message actually needs market data. The old
  // regex block here pre-fetched from the removed port-5050 Python trader
  // (#1959) and silently injected nothing.

  // Convergence Oracle — ground every question in its cosmic-time observer slice (fail-safe).
  let oracleContext = "";
  try { oracleContext = await oracleGround(text); } catch (_) { oracleContext = ""; }

  // Mesh grounding (MESH_GROUNDING=1, off by default) — local memory + Knowledge Center rings.
  // ADDITIVE ONLY: inject the cited evidence block when the resolver actually GROUNDS; never
  // inject its abstain ("say I don't know") into a normal chat turn — honest IDK is already the
  // job of the system prompt, and forcing it on every memory-thin turn would cripple the chat.
  // Web ring is omitted (the chat does its own web grounding above); the mesh peer ring is
  // omitted (ADR-gated). Fail-safe: any error → "".
  let meshGroundContext = "";
  if (process.env.MESH_GROUNDING === "1") {
    try {
      const _gr = await resolveGrounding(text, { rings: defaultRings({ mesh: false, web: false }) });
      if (_gr.grounded) {
        meshGroundContext = formatGroundingForPrompt(_gr);
        console.warn(`[mesh-grounding] grounded turn: ${_gr.sources.length} source(s), conf ${_gr.confidence.toFixed(2)}`);
      }
    } catch (_) { meshGroundContext = ""; }
  }

  const userPrompt = `${meshGroundContext ? meshGroundContext + "\n\n" : ""}${oracleContext ? oracleContext + "\n\n" : ""}${groundingContext ? groundingContext + "\n\n" : ""}${text}`;

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
    let taskType = detectTaskType(text);

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

  // Last cloud-provider failure seen this turn, threaded into the final error
  // return so routes/dream.js surfaces the REAL reason (e.g. "credit balance too
  // low") instead of a blanket "no_provider_configured". HTTP-status failures
  // (from the on("end") handlers) are authoritative; a later network/timeout
  // error must not clobber a more informative 4xx already recorded.
  let lastProviderError = null;
  const noteNetworkError = (provider, err) => {
    if (!lastProviderError || lastProviderError.status === 0) {
      lastProviderError = { provider, status: 0, code: `${provider}_error`, type: "network",
        message: String((err && err.message) || err || "unknown").slice(0, 300) };
    }
  };

  // PRIORITY 1: Ollama (Local-first — no API keys, full privacy, control)
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "ouro:latest";
  if (!rp || rp === "ollama" || rp === "local" || rp === "sigma0") {
    const isCoding = rp === "sigma0" || _isCodingRequest(text);

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
    const ollamaSystemPrompt = _useOfflinePrompt ? _offlinePrompt : agent.systemPrompt;
    const ollamaUserPrompt = userPrompt;
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
            const status = upstream.statusCode || 0;
            // Non-200 = a credit/auth/quota error envelope, NOT content. Surface it
            // (log + record the router failure + remember the reason) instead of
            // resolving "" and silently falling through to no_provider_configured.
            if (status !== 200) {
              const perr = parseUpstreamProviderError("anthropic", status, data);
              console.error(`[dream-chat] Claude API error: status=${status} type=${perr.type} — ${perr.message}`);
              recordProviderFailureRouter("anthropic", perr.code);
              lastProviderError = perr;
              resolve("");
              return;
            }
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
      noteNetworkError("anthropic", err); // network/timeout — surface if no 4xx already recorded
    }
  }

  // PRIORITY 3: Google Gemini — via Vertex AI (ADC) when GEMINI_USE_VERTEX=1, else the
  // AI-Studio API key. gemini-transport.js resolves the wire; reusing it here gives the
  // NON-stream chat path the same Vertex reach the stream path already has — the
  // AI-Studio free tier is credit-depleted, Vertex bills the Cloud project. #1376
  const { geminiTransport, useVertex } = require("./gemini-transport");
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const geminiOnVertex = useVertex();
  if ((geminiKey || geminiOnVertex) && (!rp || rp === "gemini" || rp === "google" || rp.startsWith("gemini-"))) {
    const geminiModels = rp.startsWith("gemini-") ? [rp] : [
      process.env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-1.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
    ];

    for (const geminiModel of geminiModels) {
      try {
        // gemini-2.5 spends part of maxOutputTokens on a hidden "thinking" phase, so even
        // a 2048 cap still starved long code answers — the reply ended mid-docstring with
        // no function body ever arriving (2026-07-03 gemini eval). Disable thinking on
        // thinking-capable models so the whole budget is visible output, and give code
        // answers ample room. Mirrors the stream path (stream-chat.js) + self-edit-engine
        // + swarm-orchestrator, which already run thinkingBudget:0 on 2.5-flash. #1376
        const supportsThinking = /gemini-(2\.5|3)/.test(geminiModel);
        const payload = JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${agent.systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.7,
            // thinkingBudget:0 only on 2.5/3.x — the gemini-1.5 fallbacks 400 on thinkingConfig.
            ...(supportsThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
          // Web-search grounding only on the AI-Studio wire — the Vertex tool schema
          // differs by model and a mismatch 400s the whole call.
          ...(geminiOnVertex ? {} : { tools: [{ google_search_retrieval: {} }] }),
        });
        const transport = await geminiTransport({ model: geminiModel, method: "generateContent", streaming: false });
        const { text: reply, finishReason } = await new Promise((resolve, reject) => {
          const req2 = https.request({
            hostname: transport.hostname,
            path: transport.path,
            method: "POST",
            headers: { ...transport.headers, "Content-Length": Buffer.byteLength(payload) },
          }, (upstream) => {
            let data = "";
            upstream.on("data", (c) => (data += c));
            upstream.on("end", () => {
              const status = upstream.statusCode || 0;
              // Non-200 = a quota/billing/key error envelope (the AI-Studio free tier
              // is credit-depleted), NOT content — surface it instead of resolving "".
              if (status !== 200) {
                const perr = parseUpstreamProviderError("gemini", status, data);
                console.error(`[dream-chat] Gemini (${geminiModel}) API error: status=${status} type=${perr.type} — ${perr.message}`);
                recordProviderFailureRouter("gemini", perr.code);
                lastProviderError = perr;
                resolve("");
                return;
              }
              try {
                const json = JSON.parse(data);
                const cand = json.candidates?.[0];
                // Join every text part so nothing is dropped if the model splits its answer.
                const text = String((cand?.content?.parts || []).map(p => p && p.text).filter(Boolean).join("")).trim();
                resolve({ text, finishReason: cand?.finishReason || null });
              } catch { resolve({ text: "", finishReason: null }); }
            });
            upstream.on("error", reject);
          });
          req2.on("error", reject);
          req2.setTimeout(20000, () => { req2.destroy(); reject(new Error("timeout")); });
          req2.write(payload);
          req2.end();
        });
        if (reply && reply.length >= 20) {
          // Surface truncation instead of silently returning a cut-off answer: MAX_TOKENS
          // means the visible reply is incomplete. finishReason rides the result object
          // (the route spreads it into the JSON response) so callers can see it. #1376
          if (finishReason === "MAX_TOKENS") {
            console.warn(`Gemini (${geminiModel}) hit MAX_TOKENS — reply may be truncated (${reply.length} chars)`);
          }
          return { reply, agent: agent.name, suggestions, online: true, source: `gemini${geminiOnVertex ? "-vertex" : ""}:${geminiModel}`, webSuggestions, finishReason };
        }
      } catch (err) {
        console.error(`Gemini (${geminiModel}) error:`, err.message);
        recordProviderFailureRouter("gemini", err.message.includes("gemini_status_") ? err.message : "unknown");
        noteNetworkError("gemini", err);
      }
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
            const status = upstream.statusCode || 0;
            // Non-200 = an auth/quota error envelope, NOT content — surface it
            // instead of resolving "" and silently falling through.
            if (status !== 200) {
              const perr = parseUpstreamProviderError("openai", status, data);
              console.error(`[dream-chat] OpenAI API error: status=${status} type=${perr.type} — ${perr.message}`);
              recordProviderFailureRouter("openai", perr.code);
              lastProviderError = perr;
              resolve("");
              return;
            }
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
      noteNetworkError("openai", err);
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
            const status = upstream.statusCode || 0;
            if (status !== 200) {
              const perr = parseUpstreamProviderError("xai", status, data);
              console.error(`[dream-chat] Grok (xAI) API error: status=${status} type=${perr.type} — ${perr.message}`);
              recordProviderFailureRouter("xai", perr.code);
              lastProviderError = perr;
              resolve("");
              return;
            }
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
      recordProviderFailureRouter("xai", err.message.includes("xai_status_") ? err.message : "unknown");
      noteNetworkError("xai", err);
    }
  }

  // No usable reply. Distinguish "a configured provider was tried and FAILED"
  // (surface the real reason — a depleted key, bad auth, rate limit) from "nothing
  // was configured at all" (the setup-help case). Previously every path collapsed
  // to a bare "no_provider_configured", hiding e.g. Anthropic's "credit balance too
  // low" behind a generic message and a silent server log.
  if (lastProviderError) {
    return {
      reply: null,
      error: lastProviderError.code,          // e.g. "anthropic_status_400"
      errorDetail: lastProviderError,         // { provider, status, type, message }
      agent: agent.name,
      suggestions,
      online: false,
      source: "none",
      webSuggestions,
      help: `${lastProviderError.provider} failed`
        + (lastProviderError.status ? ` (HTTP ${lastProviderError.status})` : " (network)")
        + `: ${lastProviderError.message || lastProviderError.type}. Check the key/account balance, or configure another provider.`,
    };
  }
  // No provider available — return clear error with setup instructions
  return {
    reply: null,
    error: "no_provider_configured",
    errorDetail: null,
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
        `A fact-check pass found these claims in an AI response to be contradicted by evidence:\n${refutedClaims}\n\nOriginal response:\n${draft}\n\nRewrite the response to correct or qualify only the contradicted claims, using phrasing like "I believe...", "I'm not certain, but...", or "According to available sources...". Leave everything else unchanged.\n\nOutput ONLY the rewritten response text, exactly as it should be shown to the end user. Do not include any preamble, headers (e.g. "Revised response:"), meta-commentary about the rewrite, or notes about your own process.`,
        1024
      );
      const revised = JSON.parse(raw2).content?.[0]?.text?.trim();
      // Guard against the correction pass leaking its own scaffolding/meta-commentary
      // into the user-facing reply instead of a clean rewrite (#1268).
      const looksLikeMeta = revised && /^(revised response|note:|---|i appreciate the exercise|in actual practice)/i.test(revised);
      if (revised && revised.length > 50 && !looksLikeMeta) { verified = revised; corrected = true; }
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
  parseUpstreamProviderError,
  verifyResponse,
  isVerifyEnabled,
  calibrationEventsFor,
  tokenAudit,
  appendConvergenceRecord: _appendConvergenceRecord,
};
