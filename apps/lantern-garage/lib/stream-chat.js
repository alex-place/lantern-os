const https = require("https");
const http = require("http");
const path = require("path");

// TLS-verification gate centralized in lib/insecure-tls.js (shared by self-edit-engine
// + routes/providers so the gate can't drift). Without it on Windows, cloud requests
// throw, the auto cascade swallows the error, and chat silently degrades to the weak
// local model — the "calm while wrong" failure in #740. Insecure only on Windows or
// LANTERN_INSECURE_TLS=1; LANTERN_INSECURE_TLS=0 forces it off. #869
const { llmAgent } = require("./insecure-tls");

const { AGENT_PERSONAS, DREAM_DOORS, selectAgent, parseBangCommand, verifyResponse, isVerifyEnabled } = require("./dream-chat");
const { modelFor } = require("./provider-models");
const { readRecentDreams, normalizeDreamerUser } = require("./dreamer-store");
const { appendConversationEntry } = require("./conversation-store");
const { getProviderState, recordProviderSuccess, recordProviderFailure } = require("./provider-cache");
const { swarmOrchestrate } = require("./swarm-orchestrator");
const { emitConvergenceRecord } = require("./convergence-records");
const { unifiedAgentStreamSSE } = require("./unified-agent");
const sse = require("./stream-chat/sse");
const { parseStreamChatRequest } = require("./stream-chat/request");
const { scoreReplyCollapse, antiCollapseSignal } = require("./collapse-canary");
const { assembleSessionContext } = require("./session-summary-store");
const { formatCSFContextForPrompt, saveDoorChoice } = require("./csf-memory");
const { route: converganceRoute, buildBehaviorPreamble } = require("./convergance-os/model-router");
const { THREE_DOORS_PREAMBLE } = require("./convergance-os/profiles");
const { generateDoorSceneImage } = require("./image-generation");
const { webSearchMcp, formatGroundingContext, needsGrounding, extractSearchQuery } = require("./web-search-client");
const { chatDilation, groundingPolicy, isGroundingDue, GROUNDING_TICK_MS } = require("./grounding-policy");
// #1012 boiling-frog defense: ms epoch of the last mandatory external-grounding tick.
// Module-level so the cadence spans requests for this server process.
let _lastGroundingTickMs = 0;
const { generatePlan, generatePatch } = require("./self-edit-engine");
const { selectProvider, selectKernelProvider, recordProviderSuccess: recordProviderSuccessRouter, recordProviderFailure: recordProviderFailureRouter } = require("./provider-router");
const { detectTaskType } = require("./task-detector");
const { classifyIntent } = require("./intent-router");
const serving = require("./serving-modes");
const { convergeMessage } = require("./convergence-adapter");
const { keystoneRun, KEYSTONE_SYSTEM_PROMPT } = require("./keystone-runtime");
const { unifiedAgentStreamSSE: unifiedStreamSSE } = require("./unified-agent");

const repoRoot = path.resolve(__dirname, "../../../");

const maxConversationTextLength = 4000;

// Per-request grounding (web search + live GitHub project context) is best-effort
// enrichment that runs BEFORE the model is called. If the network or the `gh` CLI
// is slow/hung, an unbounded await there stalls the ENTIRE chat reply (no tokens,
// no error) - observed in degraded environments. Bound each grounding call so it
// can never hang the response: on timeout, resolve to a fallback and proceed; the
// underlying call finishes (and self-times-out) in the background.
const GROUNDING_TIMEOUT_MS = parseInt(process.env.GROUNDING_TIMEOUT_MS, 10) || 4000;
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Fallback doors when AI omits the marker or provider fails
const FALLBACK_DOORS = ["Tell me more about that", "What happened next?", "How are you feeling about it?"];

// Conversation history compaction thresholds
// Increased for richer RP context (issue #332 — journal/Three Doors felt flat)
const FULL_FIDELITY_RECENT_TURNS = 6;
const MID_FIDELITY_TURNS = 4;
const MID_FIDELITY_CHAR_LIMIT = 400;
const LOW_FIDELITY_WORD_LIMIT = 10;

// Log truncation metrics to track information loss
function logTruncationMetric(originalChars, truncatedChars, truncationType) {
  try {
    const metricsPath = path.resolve(__dirname, "../../data/truncation-metrics.jsonl");
    const metric = {
      timestamp: new Date().toISOString(),
      originalChars,
      truncatedChars,
      charsSaved: originalChars - truncatedChars,
      truncationType, // "mid_fidelity" or "low_fidelity"
      compressionRatio: truncatedChars / originalChars
    };
    const { appendJsonlQueued } = require("./file-queue");
    appendJsonlQueued(metricsPath, metric, { rotate: true }).catch(() => {}); // #872 per-message hot path
  } catch (e) {
    // Best-effort logging; never block on metric failure
  }
}

// Conversation history compaction: tiered summarization to reduce provider token costs.
// Only compacts turns older than the most recent FULL_FIDELITY_RECENT_TURNS exchanges;
// never re-compacts already-compacted text (FlowKV principle).
// Σ₀ Fix: Track truncation metrics to measure information loss
function compactHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  return history.map((h, i) => {
    const text = String(h.text != null ? h.text : (h.content != null ? h.content : ""));
    const role = h.role || "user";
    if (i >= history.length - FULL_FIDELITY_RECENT_TURNS) {
      return { role, text }; // Full fidelity, no truncation
    }
    if (i >= history.length - FULL_FIDELITY_RECENT_TURNS - MID_FIDELITY_TURNS) {
      if (text.length > MID_FIDELITY_CHAR_LIMIT) {
        const truncated = text.slice(0, MID_FIDELITY_CHAR_LIMIT) + "…";
        logTruncationMetric(text.length, truncated.length, "mid_fidelity");
        return { role, text: truncated };
      }
      return { role, text };
    }
    // Low fidelity: first N words only
    const words = text.trim().split(/\s+/).filter(Boolean).slice(0, LOW_FIDELITY_WORD_LIMIT).join(" ");
    const roleLabel = role === "assistant" ? "Keystone" : "Dreamer";
    const summary = words.length > 0 ? `[${roleLabel}: ${words}…]` : `[${roleLabel}]`;
    logTruncationMetric(text.length, summary.length, "low_fidelity");
    return { role, text: summary };
  });
}

// Build the provider messages array from compacted history + current message.
// Single source of truth — all providers call this instead of inlining history.map.
function buildProviderMessages(systemPrompt, compacted, currentMessage) {
  return [
    { role: "system", content: systemPrompt },
    ...compacted.map(h => ({ role: h.role, content: h.text })),
    { role: "user", content: currentMessage },
  ];
}

// Parse [DOORS: A | B | C] out of the full reply and return cleaned text + doors array.
// Local models (Ollama) sometimes use commas instead of pipes — fall back gracefully.
function extractDoors(text) {
  // Match complete [DOORS: A | B | C] or incomplete [DOORS: A | B | C (no closing bracket)
  const match = text.match(/\[DOORS:\s*([^\]]+)\]?/i);
  if (!match) return { cleanText: text.trim(), doors: [] };
  let doors = match[1].split("|").map(d => d.trim()).filter(Boolean).slice(0, 3);
  // Fallback: if pipe-split didn't produce 3 doors, try comma-before-capital split
  if (doors.length < 3) {
    const commaSplit = match[1].split(/,\s*(?=[A-Z])/).map(d => d.trim()).filter(Boolean).slice(0, 3);
    if (commaSplit.length > doors.length) doors = commaSplit;
  }
  const cleanText = text.replace(/\[DOORS:[^\]]*\]?/i, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, doors };
}

// Cut a local model's output at the first instruction-template echo or new-turn
// marker it appends AFTER it has already answered (### Response:, <|im_end|>,
// "\n\nUser:", …). These are turn/template boundaries, never legitimate answer
// content; cloud models don't emit them, so this is a no-op for Claude/Gemini/GPT.
// The #1 reliability fix for served local models that ramble past their answer.
function stripModelArtifacts(text) {
  if (!text || typeof text !== "string") return text;
  const m = text.match(/\n*#{2,}\s*(?:response|instruction)\b|<\|(?:im_end|im_start|endoftext|eot_id)\|>|\n\n+\s*(?:user|human|assistant|question|system)\s*:/i);
  return (m && m.index > 0) ? text.slice(0, m.index).trimEnd() : text;
}

function doorsOrFallback(text, skipDoors = false) {
  text = stripModelArtifacts(text);
  if (skipDoors) return { cleanText: text.trim(), suggestions: [] };
  const { cleanText, doors } = extractDoors(text);
  // Always return exactly 3 suggestions. Pad with fallbacks if model gave fewer than 3.
  let finalDoors;
  if (doors.length >= 3) {
    finalDoors = doors.slice(0, 3);
  } else if (doors.length > 0) {
    finalDoors = [...doors, ...FALLBACK_DOORS].slice(0, 3);
  } else {
    finalDoors = FALLBACK_DOORS;
  }
  if (doors.length > 0) {
    try { saveDoorChoice(null, finalDoors); } catch {}
  }
  return { cleanText, suggestions: finalDoors };
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

  // If no patterns match, extract first meaningful word
  if (matchedTopics.length === 0) {
    const words = userMessage.split(/\s+/).filter(w => w.length > 4 && !/^(what|when|where|which|how|about)$/i.test(w));
    if (words.length > 0) matchedTopics.push(words[0].toLowerCase());
  }

  const topicLabel = matchedTopics[0] || "interesting topics";

  // Generate 3 search suggestion links with generic but relevant queries
  const suggestions = [
    { label: "Explore on Google", url: `https://www.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "🔍" },
    { label: "Latest on Wikipedia", url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(topicLabel)}&title=Special:Search`, icon: "📖" },
    { label: "News & Articles", url: `https://news.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "📰" },
  ];

  return suggestions;
}

// Non-blocking image generation sidecar for Three Doors mode
function triggerImageGeneration({ cleanText, suggestions, surfaceMode, symbolMesh }) {
  if (surfaceMode !== "three-doors") return null;
  
  const entryId = Date.now().toString();
  generateDoorSceneImage({ cleanText, doors: suggestions, symbolMesh, entryId })
    .then(result => {
      // Image generation completes asynchronously; failure is non-blocking
    })
    .catch(err => {
      // Image generation errors are non-blocking
    });
  
  return entryId;
}

/**
 * Analyze a convergence loop result and determine:
 * - What categories of failures exist
 * - Which agent profile should handle them
 * - Proposed next actions (with UI button metadata)
 */
function analyzeConvergenceResult(result) {
  const phases = result.phases || [];
  const findings = {
    testFailures: [],
    docDrift: [],
    providerFailures: [],
    validationFailures: [],
    otherFailures: [],
    actions: [],
  };

  for (const p of phases) {
    if (p.status === "pass" || p.status === "skip") continue;
    const name = p.name || "";
    const evidence = p.evidence || {};
    const fail = { name, status: p.status, evidence };

    if (name.includes("test") || (evidence.tests && evidence.tests.failed > 0)) {
      findings.testFailures.push(fail);
    } else if (name.includes("doc") || name.includes("readme") || evidence.drift) {
      findings.docDrift.push(fail);
    } else if (name.includes("provider") || name.includes("capacity") || name.includes("pcsf")) {
      findings.providerFailures.push(fail);
    } else if (name.includes("valid") || name.includes("promote") || name.includes("hold")) {
      findings.validationFailures.push(fail);
    } else {
      findings.otherFailures.push(fail);
    }
  }

  // Build proposed actions
  if (findings.testFailures.length > 0) {
    findings.actions.push({
      label: "Fix test failures",
      action: "self-edit-plan",
      profile: "lantern-coding",
      intent: "coding_change",
      hint: `Address ${findings.testFailures.length} test failure(s)`,
    });
  }
  if (findings.providerFailures.length > 0) {
    findings.actions.push({
      label: "Check provider capacity",
      action: "self-edit-plan",
      profile: "lantern-pcsf",
      intent: "capacity_query",
      hint: `Investigate ${findings.providerFailures.length} provider issue(s)`,
    });
  }
  if (findings.docDrift.length > 0) {
    findings.actions.push({
      label: "Update docs",
      action: "self-edit-plan",
      profile: "keystone",
      intent: "code_review",
      hint: `Resolve ${findings.docDrift.length} doc drift issue(s)`,
    });
  }
  if (findings.validationFailures.length > 0) {
    findings.actions.push({
      label: "Review validation failures",
      action: "self-edit-plan",
      profile: "keystone",
      intent: "code_review",
      hint: `Review ${findings.validationFailures.length} validation issue(s)`,
    });
  }
  if (result.promotion_ready && findings.actions.length === 0) {
    findings.actions.push({
      label: "Promote changes",
      action: "self-edit-pr",
      profile: "lantern-convergance",
      intent: "convergance_action",
      hint: "Convergence clean — open a promotion PR",
    });
  }

  return findings;
}

// ── Native Anthropic tool-use: stream ONE assistant turn ──────────────────────
// Streams a single /v1/messages turn with `tools`, forwarding text deltas live via
// onToken and accumulating any native tool_use blocks (input_json_delta → JSON).
// Resolves { assistantContent, toolUses, stopReason } so the caller can run the
// requested tools and append a tool_result turn for the next iteration. This is the
// cloud-model analog of the local model's free-text <tool_call> path — same registry,
// same executor (lib/tool-runner), reliable native protocol instead of text parsing.
function anthropicToolTurn({ anthropicKey, model, system, messages, tools, maxTokens, onToken }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages, tools });
    const req = https.request({
      agent: llmAgent,
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        reject(new Error(`anthropic_status_${upstream.statusCode}`));
        return;
      }
      const blocks = [];      // index → { type:"text", text } | { type:"tool_use", id, name, jsonbuf }
      let stopReason = null;
      let buf = "";
      upstream.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt; try { evt = JSON.parse(raw); } catch { continue; }
          if (evt.type === "content_block_start") {
            const cb = evt.content_block || {};
            blocks[evt.index] = cb.type === "tool_use"
              ? { type: "tool_use", id: cb.id, name: cb.name, jsonbuf: "" }
              : { type: "text", text: "" };
          } else if (evt.type === "content_block_delta") {
            const b = blocks[evt.index];
            if (evt.delta?.type === "text_delta") {
              if (b) b.text += evt.delta.text;
              if (onToken && evt.delta.text) onToken(evt.delta.text);
            } else if (evt.delta?.type === "input_json_delta" && b) {
              b.jsonbuf += evt.delta.partial_json || "";
            }
          } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
            stopReason = evt.delta.stop_reason;
          }
        }
      });
      upstream.on("end", () => {
        const assistantContent = [];
        const toolUses = [];
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === "text") {
            if (b.text) assistantContent.push({ type: "text", text: b.text });
          } else {
            let input = {};
            try { input = b.jsonbuf ? JSON.parse(b.jsonbuf) : {}; } catch { input = {}; }
            assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input });
            toolUses.push({ id: b.id, name: b.name, input });
          }
        }
        resolve({ assistantContent, toolUses, stopReason });
      });
      upstream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("anthropic_timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── Σ₀ convergence brain: order the providers for THIS turn ───────────────────
// The brain (provider-router.selectProvider, surfaced as `hintProvider`) decides who
// LEADS; an explicit request pins to one; otherwise the brain's pick leads and a
// stable backstop chain follows. Filtered to providers that actually have a key
// (ollama/local is always reachable). This is the single ranked list the dispatch
// loop walks — it replaces the hardcoded gemini→anthropic→openai→xai→ollama order.
const _PROVIDER_ALIASES = {
  claude: "anthropic", "claude-sonnet": "anthropic", anthropic: "anthropic",
  google: "gemini", gemini: "gemini", openai: "openai", gpt: "openai",
  grok: "xai", xai: "xai", ollama: "ollama", local: "ollama",
};
function _dispatchHasKey(p) {
  const e = process.env;
  switch (p) {
    case "anthropic": return !!e.ANTHROPIC_API_KEY;
    case "gemini": return !!(e.GEMINI_API_KEY || e.GOOGLE_API_KEY);
    case "openai": return !!e.OPENAI_API_KEY;
    case "xai": return !!e.XAI_API_KEY;
    case "ollama": return true;
    default: return false;
  }
}
function buildBrainOrder({ requestedProvider, hintProvider }) {
  const DISPATCH = ["anthropic", "gemini", "openai", "xai", "ollama"];
  const norm = (p) => {
    const s = String(p || "").toLowerCase();
    if (s.startsWith("gemini-")) return "gemini";   // gemini-2.5-pro etc.
    return _PROVIDER_ALIASES[s] || null;
  };
  if (requestedProvider) {
    const n = norm(requestedProvider);
    return n && DISPATCH.includes(n) ? [n] : [];   // explicit request pins to one
  }
  const seen = new Set();
  const order = [];
  const push = (p) => { const n = norm(p); if (n && DISPATCH.includes(n) && !seen.has(n)) { seen.add(n); order.push(n); } };
  push(hintProvider);                  // the brain's pick leads
  for (const p of DISPATCH) push(p);   // stable backstop chain after it
  return order.filter(_dispatchHasKey);
}

async function handleStreamChat(req, url, res) {
  const { collectRequestBody } = require("./http-utils");
  const parsed = await parseStreamChatRequest(req, url, {
    normalizeDreamerUser,
    collectRequestBody,
  });
  let { message, user, requestedAgent, requestedProvider, history, mcpFlag, routeIntent } = parsed;

  // Surface mode: dream-chat (default) or three-doors.
  // The game page declares itself via body.surface; bang commands can also flip it below.
  let surfaceMode = parsed.surface === "three-doors" ? "three-doors" : "dream-chat";

  // Session scoping: stamp every recorded turn with the caller's session so history
  // reads back per-conversation instead of one global flat log (issue: session mgmt).
  const sessionId = parsed.sessionId || null;
  const logConversation = (entry) => appendConversationEntry({ ...entry, sessionId });

  // Handle bang commands
  const cmd = parseBangCommand(message);
  if (cmd) {
    // Three Doors mode
    if (cmd.name === "three-doors" || cmd.name === "threedoors" || cmd.name === "three_doors") {
      surfaceMode = "three-doors";
      message = message.replace(/!(?:three-doors|threedoors|three_doors)\b/gi, "").trim() || "begin";
    }

    if (cmd.name === "swarm") {
      // Parse: !swarm <mode> <job> <message...>
      // or:   !swarm <job> <message...>  (default mode = single)
      const parts = cmd.args.split(/\s+/);
      const knownModes = ["single", "parallel", "consensus", "council"];
      const knownJobs = ["chat", "coding", "reasoning", "vision", "summarize", "creative", "research"];
      let mode = "single";
      let job = "chat";
      let swarmMessage = cmd.args;
      if (knownModes.includes(parts[0])) {
        mode = parts.shift();
      }
      if (knownJobs.includes(parts[0])) {
        job = parts.shift();
      }
      swarmMessage = parts.join(" ") || "Hello swarm";

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      const sendToken = (token) => res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      const sendDone = (source, meta) => res.write(`event: done\ndata: ${JSON.stringify({ done: true, source, ...meta })}\n\n`);

      sendToken(`Keystone routing…\n\n`);
      const agent = selectAgent(swarmMessage);
      const systemPrompt = `${agent.systemPrompt}\n\nTone: thoughtful, unhurried, human. Never clinical. Never sycophantic.`;

      swarmOrchestrate({ job, mode, systemPrompt, message: swarmMessage, history })
        .then((result) => {
          const words = result.text.split(" ");
          for (const word of words) sendToken(word + " ");
          const meta = { agent: "Keystone", provider: result.provider, online: true, swarm: { provider: result.provider, model: result.model, mode, job } };
          if (result.consensus) meta.swarm.consensus = result.consensus;
          if (result.council) meta.swarm.council = result.council;
          sendDone("keystone", meta);
          res.end();
        })
        .catch((err) => {
          sendToken(`Swarm failed: ${err.message}\n`);
          sendDone("failed", { error: err.message });
          res.end();
        });
      return;
    }

    if (cmd.name === "search" || cmd.name === "web-search") {
      const searchQuery = cmd.args.trim() || message.replace(/!\w+\s*/, "").trim();
      if (!searchQuery) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "search_query_required", message: "Usage: !search <query>" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      const sendToken = (token) => res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      const sendDone = (source, meta) => res.write(`event: done\ndata: ${JSON.stringify({ done: true, source, ...meta })}\n\n`);

      sendToken(`🔍 Searching: "${searchQuery}"\n\n`);
      try {
        const result = await webSearchMcp(searchQuery, 5);
        if (result.success && result.results) {
          sendToken(`Found ${result.result_count || result.results.length} results:\n\n`);
          for (const r of result.results) {
            sendToken(`${r.rank}. **${r.title}**\n   ${r.url}\n   ${r.snippet || ""}\n\n`);
          }
          sendDone("web_search", { agent: "WebSearch", online: true, query: searchQuery, resultCount: result.result_count });
        } else {
          sendToken(`Search failed: ${result.error || "unknown error"}\n`);
          sendDone("web_search", { agent: "WebSearch", online: false, error: result.error });
        }
      } catch (e) {
        sendToken(`Search error: ${e.message}\n`);
        sendDone("web_search", { agent: "WebSearch", online: false, error: e.message });
      }
      res.end();
      return;
    }

    // Keystone Kernel Mode: File-grounded, tool-driven code execution
    if (cmd.name === "keystone") {
      const issue = cmd.args.trim() || message.replace(/!keystone\s*/i, "").trim();

      if (!issue) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "issue_required", message: "Usage: !keystone <issue description>" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });

      const sendToken = (token) => res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      const sendDone = (source, meta) => res.write(`event: done\ndata: ${JSON.stringify({ done: true, source, ...meta })}\n\n`);

      sendToken(`🔧 Keystone Kernel Mode\n\n`);
      sendToken(`Issue: ${issue}\n\n`);

      // Kernel path uses its own provider chain (#894): Keystone/Ouro first, Claude
      // explicit last-resort — never inherits chat selectProvider's defaults. (Also
      // fixes the prior bug where the async selectProvider was used un-awaited.)
      const { provider, model: kernelModel, mode: rolloverMode } = await selectKernelProvider(requestedProvider);
      let llmFn;

      try {
        // #897: actually escalate through the kernel chain on failure (Keystone/Ouro
        // → … → Claude) — not just RECORD the intent — and record each escalation +
        // the final landed-by as convergence events. In shadow mode it's Claude-only.
        const {
          kernelEscalationChain, runKernelWithEscalation, recordEscalation, recordLanded,
        } = require("./keystone-escalation");
        const runId = `kernel-${Date.now()}`;
        const providers = rolloverMode === "default"
          ? kernelEscalationChain()
          : [{ provider, model: kernelModel || "claude-opus-4-8" }];

        const { result, providerUsed, escalations } = await runKernelWithEscalation({
          providers,
          runOne: async (prov, mdl, i) => {
            if (i > 0) sendToken(`\n↪ Escalating to ${prov}/${mdl}…\n`);
            return keystoneRun(issue, repoRoot, async (opts) => {
              const systemPrompt = opts.system || KEYSTONE_SYSTEM_PROMPT;
              const messages = opts.messages || [{ role: "user", content: opts.input || "" }];
              return unifiedStreamSSE({ systemPrompt, messages, provider: prov, model: mdl || null, user });
            }, { verbose: true, maxFiles: 10 });
          },
          onEscalate: async (rec) => {
            try {
              await recordEscalation({
                issue, failedProvider: rec.failedProvider, failedModel: rec.failedModel,
                escalatedTo: rec.escalatedTo, runId, attempt: rec.attempt, error: rec.error, repoRoot,
              });
            } catch (_e) { /* recording must never break the stream */ }
          },
        });

        if (result && (result.status === "success" || result.status === "applied_unverified")) {
          const used = providerUsed || { provider, model: kernelModel };
          sendToken(`\n✅ Keystone execution complete (landed by ${used.provider}/${used.model})\n\n`);
          sendToken(`**Plan:**\n${result.plan}\n\n`);
          if (Array.isArray(result.applied)) {
            sendToken(`**Files changed:**\n${result.applied.map((f) => `  - ${f.path}`).join("\n")}\n\n`);
          }
          if (result.tests && result.tests.success) sendToken(`✓ Tests passed\n\n`);
          else if (result.tests) sendToken(`⚠️ Tests output:\n${result.tests.output}\n\n`);
          try {
            await recordLanded({
              issue, provider: used.provider, model: used.model, runId,
              verified: !!(result.tests && result.tests.success), repoRoot,
            });
          } catch (_e) { /* best effort */ }
          sendDone("keystone", {
            agent: "Keystone", provider: used.provider, model: used.model, rolloverMode,
            status: "success", filesChanged: Array.isArray(result.applied) ? result.applied.length : 0,
            testsRun: !!result.tests, escalations: escalations.length,
          });
        } else {
          sendToken(`\n❌ Keystone failed after ${escalations.length + 1} attempt(s): ${result ? result.error : "unknown"}\n`);
          if (result && result.phase) sendToken(`Phase: ${result.phase}\n`);
          sendDone("keystone", {
            agent: "Keystone", provider, model: kernelModel, rolloverMode,
            status: "failed", error: result ? result.error : "unknown", escalations: escalations.length,
          });
        }
        res.end();
      } catch (e) {
        sendToken(`Error: ${e.message}\n`);
        // #897: sync-throw escalation also recorded
        emitConvergenceRecord({
          hypothesis: `Keystone kernel can land issue via ${provider || "unknown"}`,
          result: `escalated-to-claude: ${e.message}`,
          confidence: 0.0,
          evidence_ids: [e.message],
          reasoner: "kernel-escalation",
          verified: true,
          verification_notes: `Sync kernel error; mode=${rolloverMode || "unknown"}`,
          source: `kernel/${provider || "unknown"}/${kernelModel || "default"}`,
        }).catch(() => {});
        sendDone("keystone", { agent: "Keystone", status: "error", error: e.message });
        res.end();
      }

      return;
    }

    if (cmd.name === "doors" || cmd.name === "door") {
      const { spawn } = require("child_process");
      const doorTypes = cmd.args || "elephant garden cosmic";
      
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      const sendToken = (token) => res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      const sendDone = (source, meta) => res.write(`event: done\ndata: ${JSON.stringify({ done: true, source, ...meta })}\n\n`);

      sendToken(`◈ Generating mystical doors…\n\n`);
      sendToken(`Door types: ${doorTypes}\n`);
      sendToken(`Style: Abstract, dreamlike, not cartoonish\n\n`);
      
      const py = spawn("python", ["scripts/generate-door-images.py", "generate"], { cwd: repoRoot });
      let stdout = "";
      let stderr = "";
      
      py.stdout.on("data", (d) => {
        stdout += d.toString();
        sendToken(d.toString());
      });
      
      py.stderr.on("data", (d) => {
        stderr += d.toString();
        sendToken(`⚠️ ${d.toString()}`);
      });
      
      py.on("close", (code) => {
        if (code === 0) {
          sendToken(`\n✅ Door images generated successfully!\n`);
          sendToken(`Check: data/images/three-doors/\n`);
          sendDone("doors", { agent: "DoorGenerator", online: true, count: 3 });
        } else {
          sendToken(`\n❌ Generation failed (exit ${code})\n`);
          sendToken(`Make sure Stable Diffusion is running: python -m launch --api\n`);
          sendDone("doors", { agent: "DoorGenerator", online: false, error: stderr });
        }
        res.end();
      });
      
      py.on("error", (err) => {
        sendToken(`\n❌ Failed to spawn generator: ${err.message}\n`);
        sendDone("doors", { agent: "DoorGenerator", online: false, error: err.message });
        res.end();
      });
      
      return;
    }

    if (cmd.name === "converge" || cmd.name === "convergance") {
      // Σ₀ convergence (real, not a length vote): run a multi-provider COUNCIL —
      // creative + critic + a Sonnet synthesizer — then EMIT a Convergence Record so
      // the Verify→Converge stage is grounded and auditable in records.jsonl.
      const question = (cmd.args || "").trim() || message.replace(/^!\S+\s*/, "").trim();
      if (question) {
        sse.writeStreamHeaders(res);
        sse.sendRoute(res, { label: "Convergence · Σ₀ council", agentName: "Keystone", surface: surfaceMode });
        // Use the shared SSE helpers so the frontend (which reads {type:"token",text:…})
        // actually renders these. The old raw {token} format was silently dropped.
        const sendToken = (token) => sse.sendToken(res, token);
        const sendDone = (source, meta) => sse.sendDone(res, source, meta); // ends the response
        sendToken("Σ₀ converging across providers…\n\n");
        const convSystem = "You are a Σ₀ convergence engine. Weigh the perspectives, then give the single most accurate, well-grounded answer — comprehensive, with sources as Markdown links [title](url) when you can. End with exactly one final line: CONFIDENCE: <a number 0-1 for how well-supported the answer is>.";
        try {
          const result = await swarmOrchestrate({ job: "chat", mode: "council", systemPrompt: convSystem, message: question, history });
          let conf = 0.6;
          const cm = String(result.text).match(/CONFIDENCE:\s*([0-9]*\.?[0-9]+)/i);
          if (cm) conf = Math.max(0, Math.min(1, parseFloat(cm[1])));
          const answer = String(result.text).replace(/\n*CONFIDENCE:\s*[0-9]*\.?[0-9]+\s*$/i, "").trim() || String(result.text);
          const members = (result.council && result.council.members) || [];
          let recordId = null;
          try {
            const rec = await emitConvergenceRecord({
              hypothesis: question.slice(0, 300),
              result: answer.slice(0, 2000),
              confidence: conf,
              evidence_ids: members.map((m) => m.provider),
              reasoner: "convergance-council",
              verified: true,
              verification_notes: `Σ₀ council convergence over ${members.length} provider(s) [${members.map((m) => `${m.role}:${m.provider}`).join(", ")}]; synthesizer=${result.provider}/${result.model}`,
              source: `council/${result.provider}/${result.model}`,
            });
            recordId = rec && rec.id;
          } catch (_e) { /* record emit is best-effort */ }
          for (const w of answer.split(" ")) sendToken(w + " ");
          sendDone("keystone", {
            agent: "Keystone",
            provider: result.provider,
            online: true,
            routeLabel: "Convergence · Σ₀ council",
            convergence: { confidence: conf, synthesizer: `${result.provider}/${result.model}`, providers: members.map((m) => ({ role: m.role, provider: m.provider })), recordId },
          });
          return;
        } catch (err) {
          // Council unavailable (e.g. no provider keys) — fall back to a single provider
          // so the user still gets an answer. Headers are already SSE, so do NOT fall through.
          try {
            const fb = await swarmOrchestrate({ job: "chat", mode: "single", systemPrompt: convSystem, message: question, history });
            const ans = String(fb.text).replace(/\n*CONFIDENCE:\s*[0-9]*\.?[0-9]+\s*$/i, "").trim() || String(fb.text);
            for (const w of ans.split(" ")) sendToken(w + " ");
            sendDone("keystone", { agent: "Keystone", provider: fb.provider, online: true, routeLabel: "Convergence · single (council unavailable)" });
          } catch (e2) {
            sendToken(`Convergence unavailable: ${err.message}\n`);
            sendDone("failed", { error: err.message });
          }
          return;
        }
      }
      // Empty !convergance — fall through to normal Keystone chat.
      requestedAgent = requestedAgent || "keystone";
    }

    if (cmd.name === "self-edit" || cmd.name === "selfedit" || cmd.name === "code") {
      const requestText = cmd.args.trim() || message.replace(/^!\S+\s*/, "").trim();
      if (!requestText) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "self_edit_request_required", message: "Usage: !self-edit <what to change>" }));
        return;
      }

      sse.writeStreamHeaders(res);
      const sendToken = (token) => sse.sendToken(res, token);
      const sendDone = (source, meta) => sse.sendDone(res, source, meta);

      sendToken(`◈ Self-Edit Mode\n\n`);
      sendToken(`Request: ${requestText}\n`);
      sendToken(`Generating plan…\n\n`);

      (async () => {
        try {
          const plan = await generatePlan(repoRoot, requestText, [], history || []);
          sendToken(`Plan: ${plan.summary}\n`);
          sendToken(`Risk: ${plan.riskLevel}\n`);
          sendToken(`Files: ${plan.affectedFiles.join(", ")}\n\n`);

          sendToken(`Generating patch…\n\n`);
          const { diffText, files } = await generatePatch(repoRoot, plan);
          const changedFiles = files.map((f) => f.newFile || f.oldFile).filter(Boolean);
          sendToken(`Changed files: ${changedFiles.join(", ")}\n`);
          sendToken(`\n--- Patch Preview ---\n${diffText.slice(0, 1500)}${diffText.length > 1500 ? "\n…(truncated)" : ""}\n`);

          const actions = [
            { label: "Apply patch + run tests", action: "self-edit-apply", hint: plan.summary, plan, diffText },
            { label: "Open draft PR", action: "self-edit-pr", hint: plan.summary, plan, diffText },
          ];

          sendDone("self-edit", {
            agent: "SelfEdit",
            online: true,
            plan,
            diffText,
            changedFiles,
            actions,
          });
          res.end();
        } catch (err) {
          sse.sendError(res, `Self-edit failed: ${err.message}`);
          sendDone("failed", { error: err.message });
          res.end();
        }
      })();
      return;
    }

    // Three Doors variants: start fresh game if no history, else strip command and continue
    if (cmd.name === "three-doors" || cmd.name === "threedoors" || cmd.name === "three_doors"
        || cmd.name === "converge" || cmd.name === "convergance"
        || cmd.name === "ask") {   // !ask falls through to the convergence-agent short-circuit below
      if (cmd.name === "converge" || cmd.name === "convergance") { /* already handled above */ }
      if (history && history.length > 0) {
        // Game already in progress — strip the bang command, keep any surrounding text
        const stripped = message.replace(/!(?:three-doors|threedoors|three_doors)\b/gi, "").trim();
        message = stripped || "continue";
      }
      // fall through to normal SSE chat routing below
    } else {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "unsupported_command", command: cmd.name }));
      return;
    }
  }

  sse.writeStreamHeaders(res);

  // Realtime context — declared here because KEYSTONE_DEBUG_PROMPT / ROUTER_PROMPT
  // below interpolate it. It used to be declared ~140 lines further down, so the
  // prompt template hit a temporal-dead-zone ReferenceError on EVERY request,
  // throwing right after the 200 header and hanging the socket (no token, no done).
  const _now = new Date();
  const _realtimeCtx = `Current date/time: ${_now.toISOString()} (${_now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ${_now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })})`;

  const allRecent = readRecentDreams(12);
  // Adaptive Focus Memory: high-lucidity / high-tag entries stay Full,
  // older low-signal entries become Placeholder summaries
  const recentDreams = allRecent.map((d, i) => {
    const lucidity = d.lucidity || 0;
    const tagCount = (d.tags || []).length + (d.symbols || []).length;
    const age = i; // 0 = most recent
    if (age < 2 || lucidity >= 0.7 || tagCount >= 3) return d; // Full
    if (age < 5) return { ...d, text: String(d.text || '').slice(0, 60) + '…', _fidelity: 'compressed' }; // Compressed
    return { ...d, text: `[${d.kind || 'dream'} — ${d.tags?.[0] || 'untitled'}]`, _fidelity: 'placeholder' }; // Placeholder
  });

  // Dream Chat is Keystone-only: the desk agent is always Keystone.
  // Personas (Keystone et al.) live in the Three Doors game surface, where the
  // game may request a specific guide via body.agent (defaults to Keystone).
  const agent = surfaceMode === "three-doors"
    ? (AGENT_PERSONAS.find((a) => a.id === (requestedAgent || "lantern"))
        || AGENT_PERSONAS.find((a) => a.id === "lantern")
        || selectAgent(message))
    : (AGENT_PERSONAS.find((a) => a.id === "keystone") || selectAgent(message));

  // ── Keystone debug mode ───────────────────────────────────────────────
  // When Keystone is selected, bypass persona/doors and talk raw to the model
  // about app dev, repo state, and convergence. Direct API access from the UX.
  const isKeystoneDebug = agent.id === "keystone" && (mcpFlag || message.startsWith("[Convergence task]"));

  // Name reported in done events — Keystone at the desk, the persona (Keystone) in the game
  const doneAgentName = agent.name || "Keystone";

  let dreamContext = recentDreams.length > 0
    ? `Recent journal entries:\n${recentDreams.slice(0, 3).map((d, i) =>
        `${i + 1}. ${String(d.text || d.content || "").slice(0, 200)}`
      ).join("\n")}`
    : "No journal entries yet — this is the dreamer's first visit.";

  // Symbol mesh — top recurring symbols/tags across all dreams, feeds into door options
  const symbolMesh = (() => {
    const freq = {};
    for (const d of allRecent) {
      for (const s of [...(d.symbols || []), ...(d.tags || [])]) freq[s] = (freq[s] || 0) + 1;
    }
    return Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, 8).map(([k]) => k);
  })();

  // Compact history once; providers reuse this via buildProviderMessages.
  // historyContext is kept for Keystone debug prompt only — not injected into dream system prompt.
  //
  // #772 REMEMBER stage: assemble a token-budgeted context — a rolling summary of
  // older turns plus recent verbatim turns within the active model's window — from
  // the FULL session log instead of the client's fixed last-6 slice. Drop-in for
  // compactHistory(history) (same { role, text }[] shape). Best-effort: any failure
  // degrades to the pre-#772 fixed-slice behaviour so a chat reply never breaks.
  let compacted;
  try {
    const budgeted = assembleSessionContext({
      sessionId: parsed.sessionId,
      clientHistory: history,
      currentMessage: message,
      requestedProvider,
      surfaceMode,
    });
    compacted = Array.isArray(budgeted && budgeted.compacted) ? budgeted.compacted : compactHistory(history);
  } catch {
    compacted = compactHistory(history);
  }
  const historyContext = compacted.length > 0
    ? `\nPrior conversation turns:\n${compacted.map(h => `${h.role === "assistant" ? "Keystone" : "Dreamer"}: ${h.text}`).join("\n")}`
    : "";

  // Co-occurrence pairs: symbols that appear together in the same entry strengthen the edge
  const coOccur = {};
  for (const d of allRecent) {
    const syms = [...(d.symbols || []), ...(d.tags || [])].slice(0, 6);
    for (let a = 0; a < syms.length; a++) {
      for (let b = a + 1; b < syms.length; b++) {
        const key = [syms[a], syms[b]].sort().join('⟶');
        coOccur[key] = (coOccur[key] || 0) + 1;
      }
    }
  }
  const topPairs = Object.entries(coOccur).sort((a,b)=>b[1]-a[1]).slice(0,3)
    .map(([k,v]) => `${k}(\xd7${v})`).join(', ');

  const meshHint = symbolMesh.length > 0
    ? `\nRecurring symbols in dreamer's mesh: ${symbolMesh.join(", ")}.${topPairs ? ` Connected pairs: ${topPairs}.` : ''}`
    : "";

  // Three Doors instruction — equally weighted future-tense canaries
  const DOORS_INSTRUCTION = `\n\nAt the end of every response, imagine exactly 3 forward-facing doors — canaries the dreamer is sending ahead into their waking and dreaming life. Each door should be a brief, future-tense, equally weighted sensory or experiential path grounded in the last door mentioned and the dreamer's personal symbol mesh. All 3 should carry equal weight — no door is more important. They represent what the dreamer wants to see, hear, feel, taste, touch, or live. Write them as a single hidden line:\n[DOORS: door one | door two | door three]\nRules: future tense, first person, short (under 8 words), no questions, no commands, equally weighted, rooted in the conversation and symbol mesh.${meshHint}`;

  // Keystone debug prompt — raw dev access, no persona, no doors
  const KEYSTONE_DEBUG_PROMPT = `You are Keystone, a direct debug interface for Keystone OS development. You have access to the full repo context below. Respond as a senior engineer — concise, honest, actionable. No dream persona, no doors, no metaphors.\n\n${_realtimeCtx}\n\nRepo state:\n- Server: apps/lantern-garage/server.js (modular routes under routes/)\n- Streaming: lib/stream-chat.js (Gemini→Claude→OpenAI→Grok→Ollama chain)\n- Dream journal: ${allRecent.length} entries in data/dream_journal/\n- Providers configured: ${['GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','XAI_API_KEY'].filter(k => process.env[k]).join(', ') || 'none'}\n- Symbol mesh: ${symbolMesh.slice(0, 5).join(', ') || 'empty'}\n- Co-occurrence: ${topPairs || 'none'}\n${historyContext}\n\nYou can EXECUTE commands. When you output a single-line bash code block, the UI renders a ▶ Run button.\nONLY use these exact commands (anything else is blocked):\n\nTESTS: \`npm test\` or \`node tests/test_dream_journal_api.js\` or \`node tests/test_dream_journal_chat.js\` or \`node tests/test_dream_chat_multiturns.js\` or \`node tests/test_dream_journal_keystone.js\`\nGIT: \`git status\` \`git diff --stat\` \`git log --oneline -N\` \`git add FILE\` \`git commit -m "MSG"\` \`git push origin master\` \`git branch\`\nPR: \`gh pr create --repo alex-place/lantern-os --head cdblasioli-gif:master --base master --title "TITLE" --body "BODY"\`\nORCH: \`python src/convergence_io_engine.py health\` or \`loop\` or \`inspect\`\nREAD: \`cat FILE\` \`head -N FILE\`\n\nWhen asked to do something, output the EXACT command in a bash code block. The user clicks ▶ to run it. Do NOT suggest commands outside this list.\n\nAnswer directly. Reference file paths. Check data/pcsf/ for state. Check manifests/dream-journal-v1-agent-slots.json and csf/ingest/*.md for work queue.`;

  // ── Web Search Grounding (dilation-gated; within→without bridge) ─────
  // Chat-level time-dilation drives how hard to reach external reality: an
  // uncertain/analytical/fresh-fact query dilates → wider grounding; a normal one
  // stays at the base. (convergence_io.dilation ↔ grounding-policy.js)
  let groundingContext = "";
  const groundingD = chatDilation(message);
  const gpol = groundingPolicy(groundingD);
  // #1012 boiling-frog defense: a hard time cadence forces an external re-check even
  // when proximity~0 and the message wouldn't otherwise trigger grounding. Internal
  // monitors are provably blind to slow drift, so we ground on a timer regardless.
  const groundingTickDue = isGroundingDue(_lastGroundingTickMs);
  if (!isKeystoneDebug && (needsGrounding(message) || groundingD >= 1.5 || groundingTickDue)) {
    // On a mandatory tick fall back to the message itself when no query extracts, so
    // the cadence still reaches external reality on otherwise un-groundable turns.
    const searchQuery = extractSearchQuery(message) || (groundingTickDue ? String(message || "").slice(0, 120).trim() : "");
    if (searchQuery) {
      try {
        const searchResult = await withTimeout(webSearchMcp(searchQuery, gpol.maxResults), GROUNDING_TIMEOUT_MS, { success: false });
        if (searchResult.success && searchResult.results) {
          groundingContext = formatGroundingContext(searchResult.results, searchQuery);
        }
        if (groundingTickDue) {
          _lastGroundingTickMs = Date.now();
          console.warn(`[grounding-tick] mandatory external-grounding tick fired (cadence=${GROUNDING_TICK_MS}ms, ok=${!!(searchResult && searchResult.success)})`);
        }
      } catch (e) {
        console.error("[web-search] Grounding failed (non-fatal):", e.message);
      }
    } else if (groundingTickDue) {
      // Due but nothing to query — advance the clock + log so the cadence doesn't retry every turn.
      _lastGroundingTickMs = Date.now();
      console.warn(`[grounding-tick] due but no query extracted; cadence reset (cadence=${GROUNDING_TICK_MS}ms)`);
    }
  }

  // ── Knowledge Center grounding (base KB index, $0) ──────────────────
  // Wire the Knowledge Center in: the nearest doc section grounds the LLM, and a
  // confident hit can answer before any model (Tier 0, below). Off via KB_ROUTER=0.
  let kbAnswer = null;
  if (!isKeystoneDebug && surfaceMode !== "three-doors" && message && process.env.KB_ROUTER !== "0") {
    try {
      const kr = require("./knowledge-router");
      kbAnswer = kr.answer(message);
      // New-user orientation anchor. The most natural identity questions —
      // "what is this", "what is this app?", "what can you do" — are mostly
      // stop-words or get diluted below the TF-IDF threshold, so they MISS the KB
      // and fall through to whatever weak fallback model is up (e.g. local Ollama
      // when the cloud providers are unreachable), which improvises dream-journal
      // filler. Anchor those to the canonical product section so the Tier-0
      // short-circuit answers them deterministically. The lookahead keeps
      // "what is this FUNCTION/file/error…" out (those are real technical asks).
      const isOrientation = /\b(?:what(?:'s| is| are)?\s+this(?=[\s?!.]*$|\s+(?:app|thing|site|place|tool|project))|what(?:'s| is)?\s+lantern\s*os|what\s+can\s+you\s+do|who\s+are\s+you|how\s+do\s+i\s+(?:get\s+)?start)/i.test(String(message).trim());
      if (isOrientation && (!kbAnswer || !kbAnswer.hit || (kbAnswer.tier !== "deterministic" && (kbAnswer.score || 0) < 0.3))) {
        const canonical = kr.answer("what is lantern os");
        if (canonical && canonical.hit) kbAnswer = canonical;
      }
      if (kbAnswer && kbAnswer.hit) {
        const kbBlock = `Knowledge Center (Keystone OS docs) — grounding from ${kbAnswer.source}:\n${kbAnswer.text}`;
        groundingContext = groundingContext ? `${groundingContext}\n\n${kbBlock}` : kbBlock;
      }
    } catch (e) {
      console.error("[knowledge-router] grounding failed (non-fatal):", e.message);
    }
  }

  // ── Keystone live project context (GitHub issues/PRs + MCP tools) ──────────
  // Links Keystone chat to the project's real tools/details so ANY provider
  // (incl. Grok) answers grounded in the live repo, not generic guesses. Cached
  // 60s, best-effort. Disable with KEYSTONE_MCP=0.
  if (!isKeystoneDebug && surfaceMode !== "three-doors" && message && process.env.KEYSTONE_MCP !== "0") {
    try {
      const { gatherProjectContext } = require("./keystone-context");
      const proj = await withTimeout(gatherProjectContext({ maxItems: 8 }), GROUNDING_TIMEOUT_MS, null);
      if (proj) groundingContext = groundingContext ? `${groundingContext}\n\n${proj}` : proj;
    } catch (e) {
      console.error("[keystone-context] failed (non-fatal):", e.message);
    }
  }

  // CSF long-term memory + door state (query-time relevance filtered)
  const csfContext = formatCSFContextForPrompt(message);
  const csfBlock = csfContext ? `\n\nLong-term memory (CSF):\n${csfContext}` : "";

  // ── Convergance OS routing (runs before systemPrompt so intent drives prompt + label) ──
  let converganceDecision = null;
  try {
    converganceDecision = await converganceRoute(message, {
      requestedProvider,
      forceProfile: surfaceMode === "three-doors" ? "lantern-csf-dream" : undefined,
    });
  } catch (e) {
    console.error("[Convergance] Router error (non-fatal):", e.message);
  }

  // ── RP lives in the Three Doors game only. Dream Chat is always plain Keystone;
  // roleplay requests in chat get pointed at /three-doors-game.html instead.
  const isRpMode = surfaceMode === "three-doors";

  const routeDecision = classifyIntent(message);

  // ── Route label (sent in every done event; shown below each assistant bubble) ─
  const converganceIntent = converganceDecision?.intent || routeIntent || routeDecision.intent || "general";
  const ROUTE_LABEL_MAP = {
    code: "Keystone · code via convergence",
    strategy: "Keystone · strategy via convergence",
    trading: "Keystone · market route",
    memory_export: "Keystone · CSF memory export",
    dream_analysis: "Keystone · dream analysis",
    rp_game: "Three Doors · RP game",
    coding_change: "Keystone · code / GitHub route",
    technical_debug: "Keystone · debug route",
    code_review: "Keystone · review route",
    convergance_action: "Convergence · loop route",
    capacity_query: "Keystone · capacity query",
    dream_chat: "Keystone · chat",
    three_doors: "Three Doors · RP game",
  };
  const routeLabel = isKeystoneDebug
    ? "Keystone · direct debug"
    : requestedProvider === "keystone-ft"
      ? "Keystone FT · memory route"
      : surfaceMode === "three-doors"
        ? `${agent.name || "Keystone"} · Three Doors`
        : (ROUTE_LABEL_MAP[converganceIntent] || "Keystone · router");

  // Plain Keystone desk prompt — no persona voice, no doors. Dream Chat is Keystone-only.
  // The product-fact line gives even a weak fallback model (e.g. local Ollama, when the
  // cloud providers are unavailable) a correct, concrete answer to "what is this?" so new
  // users get an orientation instead of improvised dream-journal filler. The journal block
  // is explicitly labelled background so the model does not narrate it as if it were the app.
  const ROUTER_PROMPT = `You are Keystone Σ₀ — the grounded reasoning and engineering agent for Keystone OS, a local-first private journaling and reasoning app that runs on the user's own machine with no account required. You run the convergence loop (Observe → Remember → Reason → Act → Verify → Converge), and external reality beats internal consistency: ground every important claim in evidence, give an honest confidence, and say "I don't know" rather than improvise. Answer directly, technically, and concretely. NO roleplay, NO dream personas, NO "doors", NO mystical or poetic language — you are a precise technical agent, not a dream narrator, even though the background below happens to be a dream journal. For code, give complete, correct, copy-paste-ready implementations grounded in real files/APIs and state exactly how to verify (test command or expected output). Be concise for simple asks, but COMPREHENSIVE for substantive, factual, or research questions: give full context and reasoning, structure longer answers with short headings and bullet lists, and cite sources as clickable Markdown links [descriptive title](https://url). Your replies render as rich Markdown in this chat UI: \`![alt](https://image-url)\` displays the image inline, a plain YouTube link (https://youtube.com/watch?v=… or https://youtu.be/…) embeds as a player, and \`[text](https://url)\` becomes a link that opens in a new tab — so you absolutely CAN show images and embed videos; never tell the user you "can't embed", "can't display images", or "lack web/embedding capability" (that is false). When an image or video genuinely helps, include it — but use ONLY real, working URLs you actually know (e.g. Wikimedia Commons upload URLs, well-known sources); never invent, guess, or fabricate a media URL — if unsure, link the source page instead. If the user asks "what is this?", "what can you do?", or anything about the app itself, give a plain one- or two-sentence description of Keystone OS; do NOT describe the journal entries below as if they were the app, and do NOT use mystical or "dream" language. IMPORTANT: Your very first token must be substantive content — never output only your name, "Keystone,", "Keystone, engineering desk.", or any greeting. Go straight to the answer. If the user asks for roleplay, Keystone, or the Three Doors game, tell them to open the Explore tab (/three-doors-game.html).\n\n${_realtimeCtx}\n\nBackground (the user's recent journal entries — context ONLY; do NOT narrate, theme, echo, or poeticize them unless the user explicitly asks about their journal):\n${dreamContext}${csfBlock}${groundingContext ? "\n\n" + groundingContext : ""}`;

  const systemPrompt = isKeystoneDebug
    ? KEYSTONE_DEBUG_PROMPT
    : isRpMode
      ? `${agent.systemPrompt}\n\n${dreamContext}${csfBlock}${groundingContext ? "\n\n" + groundingContext : ""}\n\nTone: thoughtful, unhurried, human. Never clinical. Never sycophantic. Use the dreamer's own words back to them. When the dreamer asks about previous dreams or doors, use the CSF memory and door state above — never fabricate memories.${DOORS_INSTRUCTION}${surfaceMode === "three-doors" ? THREE_DOORS_PREAMBLE : ""}`
      : ROUTER_PROMPT;


  const sendToken = (token) => sse.sendToken(res, token);
  const sendRoute = (route) => sse.sendRoute(res, route);
  const sendReceipt = (receipt) => sse.sendReceipt(res, receipt);

  // Consistent sendDone with Σ₀ PCSF signature for all responses
  const sendDone = (source, extra = {}) => {
    const signature = {
      agent: agent.id || agent.name || "keystone",
      agentName: agent.name || "Keystone",
      provider: extra.provider || "unknown",
      model: extra.model || "unknown",
      timestamp: new Date().toISOString(),
      surface: surfaceMode,
      intent: converganceIntent,
      convergenceId: routeDecision.convergence_id || null,
      requiresConvergence: routeDecision.requires_convergence || false,
    };
    // ── Degraded-local indicator (issue #740) ───────────────────────────────
    // In Auto mode (no explicit provider) the cloud chain (Gemini→Claude→OpenAI→
    // Grok) can silently fall through to the local Ollama model — which ignores
    // ROUTER_PROMPT and produces off-tone filler ("calm while wrong"). When that
    // happens, flag it so the UI shows "degraded — local model" instead of
    // passing the weak answer off as the normal route. Explicit ollama/local
    // requests are intentional and not flagged.
    const isLocalSource = source === "ollama" || source === "offline";
    const degradedLocal = isLocalSource && !requestedProvider && !isRpMode;
    let finalRouteLabel = routeLabel;
    if (degradedLocal) {
      signature.degraded = true;
      finalRouteLabel = `${routeLabel} · ⚠ degraded — local model (cloud unreachable)`;
    }
    // Σ₀ verify: fire-and-forget — logs claims to convergence/records.jsonl
    if (SIGMA0_VERIFY && fullReply && message) {
      verifyResponse(fullReply, message).catch(() => {});
    }
    // ── Σ₀ collapse canary (#1010) ──────────────────────────────────────────
    // Passive observer on the live serving path: score the completed reply for
    // loop-collapse / phrase-echo / lexical contraction. Stamp proximity onto the
    // done signature so the cert can't read "healthy" while output is collapsing;
    // on a crossing, emit a logged canary signal. No behavior change when healthy.
    try {
      if (fullReply) {
        const canary = scoreReplyCollapse(fullReply);
        signature.sigma0_proximity = canary.proximity;
        if (canary.collapsed) {
          const sig = antiCollapseSignal(canary);
          signature.canary = sig;
          console.warn(
            `[canary_collapse] proximity=${canary.proximity} action=${sig.action} ` +
            `source=${source} provider=${signature.provider} ` +
            `signals=${JSON.stringify(canary.signals)}`
          );
        }
      }
    } catch { /* canary must never break a reply */ }
    return sse.sendDone(res, source, { ...extra, ...signature, routeLabel: finalRouteLabel });
  };

  // Emit route event with actual routing decision from server
  sendRoute({
    agent: agent.id || agent.name || "keystone",
    agentName: agent.name || "Keystone",
    intent: converganceIntent,
    surface: surfaceMode,
    requiresConvergence: routeDecision.requires_convergence || false,
    label: routeLabel,
  });

  // Helper to generate PCSF receipt metadata with Σ₀ convergence routing
  const buildPcsfReceipt = (provider, model, isOnline) => {
    const timestamp = new Date().toISOString();
    const signature = {
      generatedAt: timestamp,
      capacityClass: isOnline ? "live" : "offline",
      provider,
      model: model || "unknown",
      agent: agent.id || agent.name || "keystone",
      agentName: agent.name || "Keystone",
      metered: !["ollama", "local"].includes(provider),
      privacyBoundary: ["ollama", "local"].includes(provider) ? "internal" : "external",
      claimBoundary: "live",
      surface: surfaceMode,
      intent: converganceIntent,
      convergenceId: routeDecision.convergence_id || null,
      requiresConvergence: routeDecision.requires_convergence || false,
    };
    return signature;
  };

  // Record Σ₀ convergence signature for response tracking and learning
  const recordConvergenceSignature = async (provider, model, text, success = true) => {
    try {
      const signature = {
        timestamp: new Date().toISOString(),
        agent: agent.id || agent.name || "keystone",
        provider,
        model,
        surface: surfaceMode,
        intent: converganceIntent,
        convergedAt: new Date().toISOString(),
        evidence: {
          inputLength: message?.length || 0,
          outputLength: text?.length || 0,
          success,
        },
        convergenceId: routeDecision.convergence_id || null,
      };
      const { appendJsonlQueued } = require("./file-queue");
      const convergencePath = path.resolve(repoRoot, "data/convergence/chat-responses.jsonl");
      await appendJsonlQueued(convergencePath, signature, { rotate: true }).catch(() => {}); // #872
    } catch (e) {
      // Non-blocking convergence logging
    }
  };

  // Human-readable error translator — turns internal codes into plain language
  function humanError(err) {
    const msg = String(err?.message || err || "");
    if (msg.includes("gemini_status_429") || msg.includes("quota")) {
      return "Gemini is rate-limited right now. Retrying with another model…";
    }
    if (msg.includes("gemini_status_401") || msg.includes("gemini_status_403")) {
      return "Gemini key is invalid or expired. Check your API key in Settings.";
    }
    if (msg.includes("gemini_status_")) {
      return `Gemini returned an error (${msg.replace("gemini_status_", "")}). It may be temporarily unavailable.`;
    }
    if (msg.includes("gemini_timeout")) {
      return "Gemini took too long to respond. Your connection may be slow.";
    }
    if (msg.includes("anthropic_status_404")) {
      return "Claude model not found. The model name may have changed.";
    }
    if (msg.includes("anthropic_status_401") || msg.includes("anthropic_status_403")) {
      return "Claude key is invalid. Check your API key in Settings.";
    }
    if (msg.includes("anthropic_status_")) {
      return `Claude returned an error (${msg.replace("anthropic_status_", "")}). It may be temporarily unavailable.`;
    }
    if (msg.includes("openai_status_429")) {
      return "OpenAI is rate-limited right now. Try again in a moment.";
    }
    if (msg.includes("openai_status_401") || msg.includes("openai_status_403")) {
      return "OpenAI key is invalid. Check your API key in Settings.";
    }
    if (msg.includes("openai_status_")) {
      return `OpenAI returned an error (${msg.replace("openai_status_", "")}). It may be temporarily unavailable.`;
    }
    if (msg.includes("xai_status_")) {
      return `Grok returned an error (${msg.replace("xai_status_", "")}). It may be temporarily unavailable.`;
    }
    if (msg.includes("ollama_status_")) {
      return `Ollama returned an error (${msg.replace("ollama_status_", "")}). Is your local model running?`;
    }
    if (msg.includes("ollama_connect_timeout") || msg.includes("ECONNREFUSED")) {
      return "Ollama is not running locally. Start it with: ollama serve && ollama pull qwen2.5-coder";
    }
    if (msg.includes("timeout")) {
      return "The provider timed out. Your network or the service may be slow.";
    }
    if (msg.includes("no_provider_configured")) {
      return "No AI providers are set up. Add an API key in Settings to get started.";
    }
    if (msg.includes("all_providers_failed")) {
      return "All providers failed. This can happen when keys are invalid, rate-limited, or the network is slow. Check Settings or try again.";
    }
    return msg;
  }

  // ── Σ₀ self-correcting verification pass (#662) ──────────────────────────
  // Enabled by SIGMA0_VERIFY=true in env. Runs a second fast LLM call after
  // the draft is complete; extracts factual claims and logs them.
  // Falls back silently on timeout or error — never blocks the response.
  const SIGMA0_VERIFY = isVerifyEnabled();
  const VERIFY_TIMEOUT_MS = 8000;

  async function verifyResponse(draft, userMsg) {
    if (!SIGMA0_VERIFY || !draft || draft.length < 40) return { verified: false };
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return { verified: false };

    const EXTRACT_PROMPT = `You are a claim extractor. Given a draft AI response, extract up to 5 specific factual claims (not opinions, not questions). Return JSON only: {"claims": [{"claim": "...", "checkable": true}]}. If none, return {"claims": []}.`;

    try {
      const body = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: EXTRACT_PROMPT,
        messages: [{ role: "user", content: `User asked: ${userMsg.slice(0, 200)}\n\nDraft:\n${draft.slice(0, 800)}` }],
      });

      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("verify_timeout")), VERIFY_TIMEOUT_MS);
        const req = https.request({
          agent: llmAgent,
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "Content-Length": Buffer.byteLength(body),
          },
        }, (res2) => {
          let d = "";
          res2.on("data", c => { d += c; });
          res2.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { reject(new Error("parse_fail")); } });
        });
        req.on("error", e => { clearTimeout(timer); reject(e); });
        req.write(body);
        req.end();
      });

      const text = result?.content?.[0]?.text || "{}";
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { verified: false }; }
      const claims = parsed.claims || [];
      const total = claims.length;
      const checkable = claims.filter(c => c.checkable).length;

      const { appendJsonlQueued } = require("./file-queue");
      const recordsPath = path.resolve(repoRoot, "data", "convergence", "records.jsonl");
      appendJsonlQueued(recordsPath, {
        timestamp: new Date().toISOString(),
        surface: "dream-chat-verify",
        userMsg: userMsg.slice(0, 200),
        claimsFound: total,
        checkableClaims: checkable,
        claims,
      }, { rotate: true }).catch(() => {}); // #872 per-verify

      return {
        verified: true,
        total,
        checkable,
        badge: total > 0
          ? `⚡ ${total} claim${total !== 1 ? "s" : ""} verified · Σ₀`
          : "✓ No factual claims · Σ₀",
      };
    } catch { return { verified: false }; }
  }

  const sendError = (msg) => sse.sendError(res, msg);
  const sendFail = (reason) => {
    sendError(humanError(reason));
    sendDone("failed", { agent: doneAgentName, online: false });
  };
  const sendLocalFallback = (reason) => {
    sendError(`local_fallback: ${reason}`);
    sendDone("offline", { agent: doneAgentName, online: false });
  };

  // No provider available — stream a clear error instead of static persona replies
  const streamLocalFallback = async (reason) => {
    const errorText = humanError(reason || "no_provider_configured");
    sendError(errorText);
    sendDone("offline", { agent: doneAgentName, online: false, error: reason || "no_provider_configured", suggestions: FALLBACK_DOORS });
  };

  // Honest bad-request handling: the body arrived but couldn't be parsed (malformed
  // JSON / bad encoding), so `message` is empty for a reason that has nothing to do
  // with providers. Say so plainly instead of falling through to "all providers
  // failed / cloud unreachable" (which sent a debugging session down the wrong path).
  if (parsed.bodyError && !message) {
    sendError("I couldn't read your message — the request body was malformed or had a bad encoding (e.g. a leading UTF-8 BOM). Please resend.");
    sendDone("offline", { agent: doneAgentName, online: false, error: "bad_request_body", suggestions: FALLBACK_DOORS });
    return;
  }

  // ── One receive endpoint (Stage 3): deterministic work/ask intent → convergence
  // agent ($0, no LLM), streamed HERE instead of via a separate client fetch to
  // /api/convergence/agent. The client now POSTs every turn to /api/dream/chat/stream;
  // the brain recognizes a work/status/ask query and answers from live repo data,
  // emitting `actions` in the done event for the client to render as chips.
  {
    const _askM = message.match(/^!ask\s+(.+)/i);
    const _WORK_INTENT = /\b(what (work|issues?|tasks?|bugs?|tickets?|pr[s']?|pull requests?)|what (needs?|needs to be) (done|fixed|closed|worked on)|what'?s? (open|pending|left|next|the status|blocking)|show (me )?(open |the )?issues?|status (of|update)|list (issues?|tasks?|open)|open issues?|any issues?|what should i (work on|fix|do)|top issues?|priority (issues?|tasks?))\b/i;
    if (!isKeystoneDebug && surfaceMode !== "three-doors" && (_askM || (_WORK_INTENT.test(message) && !message.startsWith("!")))) {
      try {
        const _q = _askM ? _askM[1].trim() : message;
        const r = await require("./convergence-agent").respond(_q);
        const _ans = (r && r.answer) ? String(r.answer) : "(no answer)";
        sendToken(_ans);
        await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: _ans.slice(0, maxConversationTextLength) }).catch(() => {});
        sendDone("convergence-agent", { agent: doneAgentName, online: true, cleanText: _ans, actions: Array.isArray(r && r.actions) ? r.actions : [], grounded: !!(r && r.grounded), instant: true, label: "Convergence · instant · $0" });
        return;
      } catch (e) {
        console.error("[convergence-agent] short-circuit failed (non-fatal, falling through):", e.message);
      }
    }
  }

  await logConversation({
    recordedAt: new Date().toISOString(),
    surface: "dream-chat-stream",
    role: "operator",
    text: message.slice(0, maxConversationTextLength),
  }).catch(() => {});

  // Generate 3 web suggestions based on user query topics
  const webSuggestions = generateWebSuggestions(message);

  // Snapshot provider availability from the 60s PCSF cache (avoids per-request env re-reads)
  const providerState = getProviderState();
  const anyProviderConfigured = !!(
    providerState.gemini.hasKey || providerState.anthropic.hasKey ||
    providerState.openai.hasKey || providerState.xai.hasKey ||
    providerState.mistral.hasKey || providerState.cohere.hasKey ||
    providerState.perplexity.hasKey || providerState.deepseek.hasKey ||
    providerState.openrouter.hasKey || process.env.OLLAMA_BASE_URL
  );

  let fullReply = "";

  // converganceDecision already computed above (before systemPrompt)

  if (routeDecision.requires_convergence && !isKeystoneDebug && surfaceMode !== "three-doors") {
    const convResult = await convergeMessage(message, routeDecision.agent, requestedProvider || null, {
      timeoutMs: Number(process.env.CONVERGENCE_ROUTE_TIMEOUT_MS || 20000),
    });
    if (convResult.reply && !convResult.error) {
      await logConversation({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: String(convResult.reply).slice(0, maxConversationTextLength),
      }).catch(() => {});
      sendToken(convResult.reply);
      sendDone("convergence", {
        agent: convResult.agent || routeDecision.agent,
        online: true,
        route: routeDecision,
      });
      return;
    }
    // Convergence unavailable or timed out — fall through to direct LLM providers.
    // Surface WHY (don't swallow it) so the failure is diagnosable — Σ₀ #919/#941.
    console.error(
      `[Convergance] unavailable (non-fatal): ${convResult.error || "no reply"}` +
      (convResult.reply ? ` — ${String(convResult.reply).slice(0, 200)}` : "")
    );
    sendToken("(Convergence unavailable — answering directly)\n\n");
  }

  // ── Keystone: Task-aware provider selection using performance leaderboard ──
  let primaryProviderHint = null;
  try {
    let taskType = detectTaskType(message, { isCreative: surfaceMode === "dream-chat" });

    // ── Router gate (opt-in via ROUTER_GATE=1) ────────────────────────────────
    // The dream-chat surface forces isCreative -> always "creative" (ollama-first).
    // The gate escalates substantive new-ground turns to the Claude-first
    // "reasoning" chain instead. Escalate-only; never downgrades coding/reasoning.
    if (process.env.ROUTER_GATE === "1") {
      try {
        const { gateDecision } = require("./router-gate");
        const priorTurns = (Array.isArray(history) ? history : [])
          .map((h) => ({ role: h.role || "user", text: String(h.content || h.text || "") }))
          .filter((t) => t.text && t.text !== message)  // client includes current msg in history
          .slice(-3);
        const gate = gateDecision([...priorTurns, { role: "user", text: message }]);
        const keywordTaskType = taskType;
        const applied = gate.escalate && taskType !== "coding" && taskType !== "reasoning";
        if (applied) {
          console.warn(`[router-gate] escalate -> reasoning (${gate.reason})`);
          taskType = "reasoning";
        } else {
          console.warn(`[router-gate] no-op for ${taskType} (${gate.reason})`);
        }
        try {
          const { appendJsonlQueued } = require("./file-queue");
          const logPath = require("path").resolve(__dirname, "..", "..", "..", "data", "router-gate-decisions.jsonl");
          appendJsonlQueued(logPath, {
            timestamp: new Date().toISOString(),
            surface: surfaceMode,
            agent: requestedAgent || "?",
            escalate: gate.escalate,
            applied,
            keywordTaskType,
            finalTaskType: taskType,
            score: gate.score,
            reason: gate.reason,
            features: gate.features,
          }, { rotate: true }).catch(() => {}); // #872 per-message gate log
        } catch { /* logging is best-effort */ }
      } catch (ge) {
        console.error("[router-gate] gate error (non-fatal):", ge.message);
      }
    }

    const { provider: recommendedProvider, reason: selectionReason } = await selectProvider(message, taskType, requestedProvider);
    primaryProviderHint = { provider: recommendedProvider, taskType, reason: selectionReason };
    console.warn(`[provider-router] Selected ${recommendedProvider} for ${taskType}: ${selectionReason}`);
  } catch (e) {
    console.error("[provider-router] Selection error (non-fatal):", e.message);
    // Continue with default fallback if router fails
  }

  // ── Honor the provider-router / Σ₀ gate decision in Auto mode ─────────────
  // Previously primaryProviderHint was computed and discarded — the local-first
  // ladder always ran first regardless of the router's pick, so the Σ₀ gate's
  // "escalate to the Claude-first reasoning chain" decision never actually
  // routed (it was logged, not applied). When the user picked Auto (no explicit
  // provider) AND the router escalated to Anthropic, prefer Claude: skip the
  // Ollama/Gemini first-attempts so the chosen reasoning provider handles the
  // turn. OpenAI + the local fallback below still backstop a Claude failure.
  const autoHintProvider = (!requestedProvider && primaryProviderHint) ? primaryProviderHint.provider : null;
  const autoPrefersAnthropic = autoHintProvider === "anthropic";

  // ── Provider 0: Ollama LOCAL-FIRST (dream chat prefers local models) ──────
  // When no specific cloud provider is requested, try all local Ollama models in sequence
  // for lower latency, zero cost, and offline resilience. Cloud providers are fallbacks.
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  
  // Model chain: task-specific ordering with fallbacks
  const OLLAMA_MODEL_CHAIN = {
    // CSF/dream tasks: custom model first, then general models
    csf: [
      "lantern-csf-dream",
      "mistral",
      "qwen2.5-coder",
      "hf.co/PantheonUnbound/Satyr-V0.1-4B:Q4_K_M"
    ],
    // Coding tasks: coder model first
    coding: [
      "qwen2.5-coder",
      "lantern-csf-dream",
      "mistral",
      "hf.co/PantheonUnbound/Satyr-V0.1-4B:Q4_K_M"
    ],
    // Creative/dream tasks: custom CSF model first
    creative: [
      "lantern-csf-dream",
      "mistral",
      "qwen2.5-coder",
      "hf.co/PantheonUnbound/Satyr-V0.1-4B:Q4_K_M"
    ],
    // Default: balanced chain
    default: [
      "lantern-csf-dream",
      "qwen2.5-coder",
      "mistral",
      "hf.co/PantheonUnbound/Satyr-V0.1-4B:Q4_K_M"
    ]
  };
  
  // Select model chain based on intent, then reorder by the performance
  // leaderboard (PCSF-preferred): the best-performing local model for this task
  // is tried first, and the continually-trained model (OLLAMA_MODEL) is always
  // a candidate for work. Falls back to the static chain when there's no signal.
  const intent = converganceDecision?.intent || "default";
  const { orderChainByLeaderboard, recordModelOutcome } = require("./model-leaderboard");
  const staticChain = OLLAMA_MODEL_CHAIN[intent] || OLLAMA_MODEL_CHAIN.default;
  let modelChain = staticChain;
  try { modelChain = await orderChainByLeaderboard(staticChain, intent); } catch { /* keep static */ }
  // Lead with the operator-pinned served model (OLLAMA_MODEL) when set, so the chat
  // uses the model that's actually pulled/served (e.g. ouro:latest) instead of the
  // static chain's default first entry. Deduped so it leads exactly once. Previously
  // OLLAMA_MODEL was documented as "always a candidate" but never actually led.
  if (process.env.OLLAMA_MODEL) {
    const _pinned = process.env.OLLAMA_MODEL;
    modelChain = [_pinned, ...modelChain.filter((x) => x !== _pinned)];
  }

  // ── Tier 0: cheap Knowledge Center answer before any model ($0, no LLM) ──
  // Only short-circuit informational queries with a confident KB hit. Coding,
  // convergence/work, roleplay, explicit-provider, and keystone paths are never
  // short-circuited — they fall through to the model chain below.
  // $0 short-circuit threshold. Default favors quality: only very strong near hits
  // (or exact deterministic ones) answer without the LLM; weaker hits still GROUND
  // the LLM (better answers). Lower KB_ANSWER_MIN (e.g. 0.2) for cost-aggressive $0.
  const KB_ANSWER_MIN = parseFloat(process.env.KB_ANSWER_MIN || "0.3");
  // Live/stateful queries must NOT be answered from a static doc — they need the
  // LLM with live project context (GitHub/MCP). Only static knowledge short-circuits.
  const wantsLiveData = /\b(current|currently|now|today|latest|recent|open (issues?|prs?|pull)|status|right now|this (week|sprint)|what'?s? (open|happening|next))\b/i.test(message);
  if (kbAnswer && kbAnswer.hit && !isKeystoneDebug && !isRpMode && !requestedProvider && !wantsLiveData
      && !routeDecision.requires_convergence
      && (kbAnswer.tier === "deterministic" || kbAnswer.score >= KB_ANSWER_MIN)) {
    const ans = `${kbAnswer.text}\n\n— from the Knowledge Center: ${kbAnswer.source}`;
    sendToken(ans);
    await logConversation({
      recordedAt: new Date().toISOString(), surface: "dream-chat-stream",
      role: "lantern", text: ans.slice(0, maxConversationTextLength),
    }).catch(() => {});
    try { recordProviderSuccess("knowledge"); } catch (_e) {}
    sendDone("knowledge", {
      agent: doneAgentName, online: true, cleanText: ans, suggestions: [],
      model: "knowledge-center", source: "knowledge",
      tier: kbAnswer.tier, score: kbAnswer.score,
    });
    return;
  }

  // ── Ouro looped reasoning: adaptive depth + Q-exit CDF (arXiv 2510.25741) ──
  // Implements the paper at the API level on OUR local model: refine across loops,
  // exit when the confidence CDF crosses threshold or plateaus (lib/loop-reasoner.js).
  // Opt-in via LOOP_REASONER=1; applies to reasoning/coding intents. Emits
  // loop_n/confidence/exit_reason for the "Ouro Σ₀ CDF exit" panel the UI reads.
  // Falls through to normal streaming on any error.
  if (process.env.LOOP_REASONER === "1" && !isKeystoneDebug && !isRpMode && !requestedProvider
      && (intent === "coding" || intent === "reasoning")) {
    try {
      const http = require("http");
      const { loopedReason } = require("./loop-reasoner");
      const u = new URL(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
      const loopModel = modelChain[0];
      const callLLM = (p, sys) => new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: loopModel, stream: false, messages: buildProviderMessages(sys, compacted, p) });
        const rq = http.request({ hostname: u.hostname, port: u.port || 11434, path: "/api/chat", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (resp) => {
          let d = ""; resp.on("data", (c) => (d += c));
          resp.on("end", () => { try { resolve(JSON.parse(d).message?.content || ""); } catch (e) { reject(e); } });
        });
        rq.on("error", reject);
        // FAST (interactive default) fails over quickly when the local model
        // stalls; DEEP native loop (OURO_NATIVE=1) keeps the long ceiling. This
        // is the loop-reasoner path (called up to maxLoops times), so a flat 120s
        // here could stall a single streamed reply for minutes on a dead model.
        // OLLAMA_TIMEOUT_MS overrides both.
        const _ollamaTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10)
          || (/^(1|true|yes)$/i.test(process.env.OURO_NATIVE || "") ? 120000 : 15000);
        rq.setTimeout(_ollamaTimeout, () => { rq.destroy(); reject(new Error("ollama_timeout")); });
        rq.write(body); rq.end();
      });
      const lr = await loopedReason({ prompt: message, systemPrompt, callLLM, maxLoops: 4 });
      if (lr && lr.reply) {
        const { cleanText, suggestions } = doorsOrFallback(lr.reply, true);
        await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream",
          role: "lantern", text: cleanText.slice(0, maxConversationTextLength) }).catch(() => {});
        sendToken(cleanText);
        try { recordProviderSuccess("ollama"); recordModelOutcome(loopModel, intent, true, 0); } catch (_e) {}
        sendDone("ollama", { agent: doneAgentName, online: true, cleanText, suggestions, model: loopModel,
          source: "ollama", loop_n: lr.loop_n, confidence: lr.confidence, exit_reason: lr.exit_reason });
        return;
      }
    } catch (e) {
      console.error("[loop-reasoner] failed (non-fatal, falling through):", e.message);
    }
  }

  // CHAT_CLOUD_FIRST=1 makes Auto-mode chat prefer cloud providers (use the configured
  // API keys) over the local-first Ollama ladder — for deployments where cloud
  // quality/grounding matters more than local latency/cost. Off by default (local-first
  // preserved). Honored only in Auto mode (an explicit ollama/local request still wins).
  const cloudFirst = process.env.CHAT_CLOUD_FIRST === "1" && !requestedProvider;
  const ollamaLocalFirst = (!requestedProvider || requestedProvider === "ollama" || requestedProvider === "local") && !autoPrefersAnthropic && !cloudFirst;
  if (ollamaLocalFirst && message && !isKeystoneDebug) {
    
    for (const ollamaModel of modelChain) {
      const _ollamaStart = Date.now();
      try {
        // In tool mode, send the FC adapter ONLY the tool preamble it was trained/served
        // with. The big Keystone router prompt dilutes it (the adapter then defaults to
        // its Bash habit); the clean preamble matches the training distribution so it
        // reliably emits a SAFE <tool_call>. Gated with execution so it toggles as a unit.
        const sysForOllama = process.env.CHAT_TOOL_EXEC === "1"
          ? require("./tool-runner").renderToolPreamble()
          : systemPrompt;
        const payload = JSON.stringify({
          model: ollamaModel,
          stream: true,
          messages: buildProviderMessages(sysForOllama, compacted, message),
          // FAST-mode anti-repetition decode params (issue #729). Suppresses ✅✅✅ loops.
          options: serving.applyOllamaDecodeParams({}),
        });
        const ollamaUrl = new URL(ollamaBase);
        await new Promise((resolve, reject) => {
          const req2 = http.request({
            hostname: ollamaUrl.hostname,
            port: ollamaUrl.port || 11434,
            path: "/api/chat",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (upstream) => {
            if (upstream.statusCode !== 200) { upstream.resume(); reject(new Error(`ollama_status_${upstream.statusCode}`)); return; }
            let buf = "";
            upstream.on("data", (chunk) => {
              buf += chunk.toString();
              const lines = buf.split("\n");
              buf = lines.pop();
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.message?.content) { fullReply += parsed.message.content; sendToken(parsed.message.content); }
                } catch {}
              }
            });
            upstream.on("end", () => resolve());
            upstream.on("error", reject);
          });
          req2.on("error", reject);
          req2.setTimeout(120000, () => { req2.destroy(); reject(new Error("ollama_timeout")); });
          req2.write(payload);
          req2.end();
        });
        
        if (fullReply) {
          // ── Tool-aware chat: the local Σ₀ FC adapter may answer with a <tool_call>.
          // Always emit a `tool` event so the UI fills the card; OPTIONALLY execute a tool
          // (gated by CHAT_TOOL_EXEC=1, off by default) and let the model ground a follow-up
          // answer on the real result. runTool enforces the per-tool policy (read-only runs;
          // shell/mutating need operator — same policy as the rest of the app).
          try {
            const toolRunner = require("./tool-runner");
            const tc = toolRunner.parseToolCall(fullReply);
            if (tc) {
              const { isOperatorRequest } = require("./request-auth");
              const result = process.env.CHAT_TOOL_EXEC !== "1"
                ? { ok: false, reason: "disabled" }
                : toolRunner.runTool(tc.name, tc.input, { operator: isOperatorRequest(req) });
              sse.writeData(res, { type: "tool", name: tc.name, input: tc.input,
                ok: result.ok, reason: result.reason || null, policy: result.policy || null,
                result: result.ok ? result.result : (result.error || null) });
              if (result.ok) {
                const followMessages = buildProviderMessages(systemPrompt, compacted, message).concat([
                  { role: "assistant", content: fullReply },
                  { role: "user", content: `The ${tc.name} tool returned:\n${String(result.result).slice(0, 1500)}\n\nUsing only this result, answer my original request in plain text. Do not call another tool.` },
                ]);
                const followPayload = JSON.stringify({ model: ollamaModel, stream: true, messages: followMessages, options: serving.applyOllamaDecodeParams({}) });
                const fu = new URL(ollamaBase);
                let followText = "";
                await new Promise((resolve) => {
                  const r3 = http.request({ hostname: fu.hostname, port: fu.port || 11434, path: "/api/chat", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(followPayload) } }, (up) => {
                    if (up.statusCode !== 200) { up.resume(); resolve(); return; }
                    let b = "";
                    up.on("data", (ch) => { b += ch.toString(); const ls = b.split("\n"); b = ls.pop(); for (const ln of ls) { if (!ln.trim()) continue; try { const pj = JSON.parse(ln); if (pj.message && pj.message.content) { followText += pj.message.content; sendToken(pj.message.content); } } catch {} } });
                    up.on("end", resolve); up.on("error", () => resolve());
                  });
                  r3.on("error", () => resolve());
                  r3.setTimeout(120000, () => { r3.destroy(); resolve(); });
                  r3.write(followPayload); r3.end();
                });
                if (followText.trim()) fullReply += "\n\n" + followText;
              }
            }
          } catch (e) { /* tool handling is non-fatal — fall through to normal render */ }
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          const imageEntryId = triggerImageGeneration({ cleanText, suggestions, surfaceMode, symbolMesh });
          await logConversation({
            recordedAt: new Date().toISOString(),
            surface: "dream-chat-stream",
            role: "lantern",
            text: cleanText.slice(0, maxConversationTextLength),
          }).catch(() => {});
          recordProviderSuccess("ollama");
          recordModelOutcome(ollamaModel, intent, true, Date.now() - _ollamaStart); // feed leaderboard
          const ollamaReceipt = buildPcsfReceipt("ollama", ollamaModel, true);
          sendReceipt(ollamaReceipt);
          const meta = { agent: doneAgentName, online: true, cleanText, suggestions, model: ollamaModel, webSuggestions, receipt: ollamaReceipt };
          if (imageEntryId) meta.image = { entryId: imageEntryId, status: "generating" };
          sendDone("ollama", meta);
          return;
        }
      } catch (err) {
        recordModelOutcome(ollamaModel, intent, false, Date.now() - _ollamaStart); // leaderboard learns failures too
        fullReply = "";
        continue; // Try next model in chain
      }
    }

  }

  // Provider 0b: Keystone FT managed agent (Haiku + memory store) — explicit request only.
  // Streams via the unified Python connector; the Python side tries the managed
  // sessions API (memory-augmented) and falls back to the messages API itself.
  if (message && requestedProvider === "keystone-ft") {
    try {
      let sseDone = false;
      let sseErr = null;
      const sseStream = unifiedAgentStreamSSE(message, agent.id, "keystone-ft", dreamContext);
      sseStream.onData((parsed) => {
        if (parsed.token) { fullReply += parsed.token; sendToken(parsed.token); }
        if (parsed.done) { sseDone = true; }
      });
      sseStream.onError((err) => { sseErr = err; sseDone = true; });
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (sseDone) { clearInterval(check); resolve(); }
        }, 50);
      });
      if (sseErr) throw sseErr;
      if (fullReply) {
        const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
        await logConversation({
          recordedAt: new Date().toISOString(),
          surface: "dream-chat-stream",
          role: "lantern",
          text: cleanText.slice(0, maxConversationTextLength),
        }).catch(() => {});
        recordProviderSuccess("keystone-ft");
        await recordConvergenceSignature("keystone-ft", "keystone-ft-claude", cleanText, true);
        const keystoneFtReceipt = buildPcsfReceipt("keystone-ft", "keystone-ft-claude", true);
        sendReceipt(keystoneFtReceipt);
        sendDone("keystone-ft", { provider: "keystone-ft", model: "keystone-ft-claude", online: true, cleanText, suggestions, receipt: keystoneFtReceipt });
        return;
      }
      throw new Error("keystone-ft returned no tokens");
    } catch (err) {
      recordProviderFailure("keystone-ft", err.message);
      sendError(`Keystone FT failed: ${err.message}. Check ANTHROPIC_API_KEY and data/training/ft-result.json.`);
      sendFail(err.message);
      return;
    }
  }

  // ── Σ₀ convergence brain: ONE dispatch over the brain's ranked provider order ──
  // Replaces the hardcoded gemini→anthropic→openai→xai→ollama cascade. selectProvider
  // (the brain) chose `autoHintProvider`; buildBrainOrder turns it into the ranked,
  // key-filtered order this loop walks. Each provider's streamer body is unchanged: on
  // success it returns; on auto-mode failure it falls through to the next brain pick.
  for (const _p of buildBrainOrder({ requestedProvider, hintProvider: autoHintProvider })) {
    fullReply = "";   // fresh per provider — never carry a failed attempt's partial text

  // Provider: Gemini (streaming)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (_p === "gemini" && geminiKey) {
    // Gemini model fallback chain: primary -> fallbacks on 429/quota
    // Note: gemini-2.0-flash-lite shut down June 1 2026; gemini-3.5-flash is GA with free grounding
    const GEMINI_MODEL_CHAIN = [
      modelFor("gemini"),
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
    ];
    for (const geminiModel of (requestedProvider && requestedProvider.startsWith("gemini-")
      ? [requestedProvider]
      : GEMINI_MODEL_CHAIN)) {
    try {
      // Grounding: Google Search enabled by default on gemini-3.x models (5K free/month)
      // Disable with GEMINI_GROUNDING=false if needed
      const isGroundable = geminiModel.startsWith("gemini-3");
      const groundingEnabled = process.env.GEMINI_GROUNDING !== "false" && isGroundable;
      const searchInstruction = groundingEnabled ? "\n\nYou have access to live web search. Use it to find current information, verify facts, or answer questions about recent events when relevant." : "";
      const geminiPayloadBase = {
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}${searchInstruction}\n\n${message}` }] }],
        generationConfig: { maxOutputTokens: isRpMode ? 1536 : 1024, temperature: isRpMode ? 0.88 : 0.7 },
      };
      if (groundingEnabled) {
        geminiPayloadBase.tools = [{ googleSearch: {} }];
      }
      const payload = JSON.stringify(geminiPayloadBase);
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          agent: llmAgent,
          hostname: "generativelanguage.googleapis.com",
          path: `/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${geminiKey}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`gemini_status_${upstream.statusCode}`));
            return;
          }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw) continue;
              try {
                const evt = JSON.parse(raw);
                const parts = evt.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                  const token = p.text || "";
                  if (token) { fullReply += token; sendToken(token); }
                }
              } catch { /* skip malformed */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("gemini_timeout")); });
        req2.write(payload);
        req2.end();
      });
      let { cleanText: geminiClean, suggestions: geminiDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
      // Σ₀ verify pass
      let geminiSigma0 = null;
      if (isVerifyEnabled()) {
        try {
          const vr = await verifyResponse(geminiClean, message, doneAgentName);
          if (vr.corrected) {
            sse.writeData(res, { type: "sigma0", corrected: true, claims: vr.records.length, verified: vr.records.filter(r => r.confidence >= 0.5).length });
            geminiClean = vr.verified;
          }
          geminiSigma0 = { corrected: vr.corrected, claims: vr.records.length };
        } catch { /* non-fatal */ }
      }
      await logConversation({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: geminiClean.slice(0, maxConversationTextLength),
      }).catch(() => {});
      recordProviderSuccess("gemini");
      const geminiModelName = modelFor("gemini");
      await recordConvergenceSignature("gemini", geminiModelName, geminiClean, true);
      const geminiReceipt = buildPcsfReceipt("gemini", geminiModelName, true);
      sendReceipt(geminiReceipt);
      sendDone("gemini", { agent: doneAgentName, provider: "gemini", model: geminiModelName, online: true, cleanText: geminiClean, suggestions: geminiDoors, webSuggestions, receipt: geminiReceipt, sigma0: geminiSigma0 });
      return;
    } catch (err) {
      recordProviderFailure("gemini", err.message);
      // On 429/quota, try next model in chain before emitting error
      const is429 = err.message.includes("429") || err.message.includes("quota");
      if (is429) { fullReply = ""; continue; } // retry with next model silently
      if (requestedProvider) {
        sendError(humanError(err));
        sendFail(err.message);
        return;
      }
      console.warn(`[stream-chat] gemini auto-cascade failed — trying next provider (${err.message})`);
    }
    } // end model chain loop
  }

  // Provider: Anthropic Claude (streaming)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (_p === "anthropic" && anthropicKey) {
    try {
      let claudeModel = "claude-haiku-4-5-20251001";
      if (requestedProvider === "claude-sonnet") {
        claudeModel = process.env.ANTHROPIC_SONNET_MODEL || "claude-sonnet-4-6";
      } else {
        claudeModel = process.env.ANTHROPIC_MODEL || claudeModel;
      }

      // ── Native tool-use loop (opt-in via CHAT_TOOL_EXEC=1) ───────────────────
      // Gives Keystone real agency: the model can call repo tools (Read/Grep/Glob/LS
      // for everyone; +Bash/PowerShell/Write/Edit for operators) and answer from the
      // results instead of guessing. Same registry + executor as the local model's
      // free-text path (lib/tool-runner), via the reliable native tool_use protocol.
      // Off by default → the single-shot path below is byte-identical for normal chat.
      if (process.env.CHAT_TOOL_EXEC === "1") {
        try {
          const toolRunner = require("./tool-runner");
          const { isOperatorRequest } = require("./request-auth");
          const operator = isOperatorRequest(req);
          const tools = toolRunner.anthropicTools({ operator });
          if (tools.length) {
            const system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
            const convo = [...compacted.map(h => ({ role: h.role, content: h.text })), { role: "user", content: message }];
            const MAX_TOOL_ITERS = 6;
            let toolCalls = 0;
            for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
              const { assistantContent, toolUses, stopReason } = await anthropicToolTurn({
                anthropicKey, model: claudeModel, system, messages: convo, tools,
                maxTokens: isRpMode ? 1536 : 1024,
                onToken: (t) => { fullReply += t; sendToken(t); },
              });
              if (!toolUses.length || stopReason !== "tool_use") break; // model gave its answer
              convo.push({ role: "assistant", content: assistantContent });
              const results = [];
              for (const tu of toolUses) {
                toolCalls++;
                sse.writeData(res, { type: "tool", phase: "call", name: tu.name, input: tu.input });
                const r = toolRunner.runTool(tu.name, tu.input, { operator });
                const out = r.ok ? r.result : `ERROR(${r.reason || "error"}): ${r.error}`;
                sse.writeData(res, { type: "tool", phase: "result", name: tu.name, ok: !!r.ok, preview: String(out).slice(0, 240) });
                results.push({ type: "tool_result", tool_use_id: tu.id, content: String(out).slice(0, 6000), is_error: !r.ok });
              }
              convo.push({ role: "user", content: results });
            }
            const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
            await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: cleanText.slice(0, maxConversationTextLength) }).catch(() => {});
            recordProviderSuccess("anthropic");
            recordProviderSuccessRouter("anthropic");
            const toolReceipt = buildPcsfReceipt("anthropic", claudeModel, true);
            sendReceipt(toolReceipt);
            sendDone("anthropic", { agent: doneAgentName, provider: "anthropic", model: claudeModel, online: true, cleanText, suggestions, webSuggestions, receipt: toolReceipt, toolCalls });
            return;
          }
        } catch (err) {
          recordProviderFailure("anthropic", `tool_loop: ${err.message}`);
          if (fullReply) {
            // Already streamed partial output — finalize rather than re-streaming a
            // fresh single-shot answer (which would duplicate/contradict on screen).
            const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
            recordProviderSuccess("anthropic");
            sendDone("anthropic", { agent: doneAgentName, provider: "anthropic", model: claudeModel, online: true, cleanText, suggestions, webSuggestions });
            return;
          }
          if (requestedProvider) { sendError(humanError(err)); await streamLocalFallback(err.message); return; }
          // else (auto mode, nothing streamed yet): fall through to the single-shot path
        }
      }

      // Prompt caching: the system block (Keystone/RP instructions + dream/CSF
      // context) is the stable prefix reused across turns in a session. Marking
      // it with cache_control caches it for 5 min; subsequent turns read it at
      // 0.1x input price instead of reprocessing. No-op (silent) if the prefix
      // is below the model's min cacheable length — verify via usage fields.
      const payload = JSON.stringify({
        model: claudeModel,
        max_tokens: isRpMode ? 1536 : 1024,
        temperature: isRpMode ? 0.88 : undefined,
        stream: true,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [...compacted.map(h => ({ role: h.role, content: h.text })), { role: "user", content: message }],
      });
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          agent: llmAgent,
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`anthropic_status_${upstream.statusCode}`));
            return;
          }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (raw === "[DONE]" || raw === "") continue;
              try {
                const evt = JSON.parse(raw);
                if (evt.type === "content_block_delta" && evt.delta?.text) {
                  fullReply += evt.delta.text;
                  sendToken(evt.delta.text);
                }
              } catch { /* skip malformed */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.write(payload);
        req2.end();
      });
      let { cleanText: anthropicClean, suggestions: anthropicDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
      // Σ₀ verify pass — ground claims against codebase, web, Gemini
      let anthropicSigma0 = null;
      if (isVerifyEnabled()) {
        try {
          const vr = await verifyResponse(anthropicClean, message, doneAgentName);
          if (vr.corrected) {
            sse.writeData(res, { type: "sigma0", corrected: true, claims: vr.records.length, verified: vr.records.filter(r => r.confidence >= 0.5).length });
            anthropicClean = vr.verified;
          }
          anthropicSigma0 = { corrected: vr.corrected, claims: vr.records.length };
        } catch { /* non-fatal */ }
      }
      await logConversation({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: anthropicClean.slice(0, maxConversationTextLength),
      }).catch(() => {});
      recordProviderSuccess("anthropic");
      recordProviderSuccessRouter("anthropic");
      const modelName = claudeModel; // receipt MUST reflect the model actually sent
      await recordConvergenceSignature("anthropic", modelName, anthropicClean, true);
      const anthropicReceipt = buildPcsfReceipt("anthropic", modelName, true);
      sendReceipt(anthropicReceipt);
      sendDone("anthropic", { agent: doneAgentName, provider: "anthropic", model: modelName, online: true, cleanText: anthropicClean, suggestions: anthropicDoors, webSuggestions, receipt: anthropicReceipt, sigma0: anthropicSigma0 });
      return;
    } catch (err) {
      const errorCode = err.message.includes("anthropic_status_") ? err.message : "unknown";
      recordProviderFailure("anthropic", err.message);
      recordProviderFailureRouter("anthropic", errorCode); // Also log to provider-router
      if (requestedProvider) {
        sendError(humanError(err));
        await streamLocalFallback(err.message);
        return;
      }
      console.warn(`[stream-chat] anthropic auto-cascade failed — trying next provider (${err.message})`);
    }
  }

  // Provider: OpenAI (streaming)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (_p === "openai" && openaiKey) {
    try {
      // FAST-mode anti-repetition decode params (issue #729): top_p + frequency_penalty.
      const payload = JSON.stringify(serving.applyOpenAIDecodeParams({
        model: modelFor("openai"),
        stream: true,
        messages: buildProviderMessages(systemPrompt, compacted, message),
      }));

      await new Promise((resolve, reject) => {
        const req2 = https.request({
          agent: llmAgent,
          hostname: "api.openai.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`openai_status_${upstream.statusCode}`));
            return;
          }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (raw === "[DONE]" || raw === "") continue;
              try {
                const evt = JSON.parse(raw);
                const token = evt.choices?.[0]?.delta?.content || "";
                if (token) { fullReply += token; sendToken(token); }
              } catch { /* skip malformed */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("openai_timeout")); });
        req2.write(payload);
        req2.end();
      });
      const { cleanText: openaiClean, suggestions: openaiDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
      await logConversation({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: openaiClean.slice(0, maxConversationTextLength),
      }).catch(() => {});
      recordProviderSuccess("openai");
      recordProviderSuccessRouter("openai");
      const openaiModelName = modelFor("openai");
      await recordConvergenceSignature("openai", openaiModelName, openaiClean, true);
      const openaiReceipt = buildPcsfReceipt("openai", openaiModelName, true);
      sendReceipt(openaiReceipt);
      sendDone("openai", { agent: doneAgentName, provider: "openai", model: openaiModelName, online: true, cleanText: openaiClean, suggestions: openaiDoors, webSuggestions, receipt: openaiReceipt });
      return;
    } catch (err) {
      const errorCode = err.message.includes("openai_status_") ? err.message : "unknown";
      recordProviderFailure("openai", err.message);
      recordProviderFailureRouter("openai", errorCode); // Also log to provider-router
      if (requestedProvider) {
        sendError(humanError(err));
        sendFail(err.message);
        return;
      }
      console.warn(`[stream-chat] openai auto-cascade failed — trying next provider (${err.message})`);
    }
  }

  // Provider: Grok / xAI (streaming — OpenAI-compatible)
  const xaiKey = process.env.XAI_API_KEY;
  if (_p === "xai" && xaiKey) {
    try {
      const xaiModel = modelFor("xai");
      // xAI/Grok is OpenAI-compatible → FAST-mode decode params (issue #729).
      const payload = JSON.stringify(serving.applyOpenAIDecodeParams({
        model: xaiModel, stream: true,
        messages: buildProviderMessages(systemPrompt, compacted, message),
      }));
      await new Promise((resolve, reject) => {
        const req2 = require("https").request({
          agent: llmAgent,
          hostname: "api.x.ai", path: "/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${xaiKey}`, "Content-Length": Buffer.byteLength(payload) },
        }, (upstream) => {
          if (upstream.statusCode !== 200) { upstream.resume(); reject(new Error(`xai_status_${upstream.statusCode}`)); return; }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n"); buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (raw === "[DONE]" || !raw) continue;
              try { const t = JSON.parse(raw).choices?.[0]?.delta?.content || ""; if (t) { fullReply += t; sendToken(t); } } catch { /* skip */ }
            }
          });
          upstream.on("end", resolve); upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("xai_timeout")); });
        req2.write(payload); req2.end();
      });
      const { cleanText: xaiClean, suggestions: xaiDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
      await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: xaiClean.slice(0, maxConversationTextLength) }).catch(() => {});
      recordProviderSuccess("xai");
      const grokModelName = xaiModel; // receipt MUST reflect the model actually sent
      await recordConvergenceSignature("grok", grokModelName, xaiClean, true);
      const grokReceipt = buildPcsfReceipt("grok", grokModelName, true);
      sendReceipt(grokReceipt);
      sendDone("grok", { agent: doneAgentName, provider: "grok", model: grokModelName, online: true, cleanText: xaiClean, suggestions: xaiDoors, webSuggestions, receipt: grokReceipt });
      return;
    } catch (err) {
      recordProviderFailure("xai", err.message);
      if (requestedProvider) {
        sendError(humanError(err));
        sendFail(err.message);
        return;
      }
      console.warn(`[stream-chat] xai/grok auto-cascade failed — trying next provider (${err.message})`);
    }
  }

  // Provider: Ollama (streaming) — last-resort
  if (_p === "ollama") {
    // Attempt 1: Unified Agent Connector (health-checked, provider-ranked, Python-side SSE)
    if (!requestedProvider || requestedProvider === "ollama" || requestedProvider === "local") {
      try {
        let sseDone = false;
        let sseErr = null;
        const sseStream = unifiedAgentStreamSSE(message, agent.id, requestedProvider || "ollama", dreamContext);
        sseStream.onData((parsed) => {
          if (parsed.token) { fullReply += parsed.token; sendToken(parsed.token); }
          if (parsed.done) { sseDone = true; }
        });
        sseStream.onError((err) => { sseErr = err; sseDone = true; });
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (sseDone) { clearInterval(check); resolve(); }
          }, 50);
        });
        if (sseErr) throw sseErr;
        if (fullReply) {
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          await logConversation({
            recordedAt: new Date().toISOString(),
            surface: "dream-chat-stream",
            role: "lantern",
            text: cleanText.slice(0, maxConversationTextLength),
          }).catch(() => {});
          recordProviderSuccess("ollama");
          await recordConvergenceSignature("ollama", "unified-agent", cleanText, true);
          const ollamaConnectorReceipt = buildPcsfReceipt("ollama", "unified-agent", true);
          sendReceipt(ollamaConnectorReceipt);
          sendDone("ollama", { agent: doneAgentName, provider: "ollama", online: true, cleanText, suggestions, receipt: ollamaConnectorReceipt });
          return;
        }
      } catch (err) {
        recordProviderFailure("ollama", `unified_connector: ${err.message}`);
        fullReply = "";
        // Fall through to direct HTTP attempt
      }
    }

    // Attempt 2: Direct HTTP to Ollama
    try {
      const payload = JSON.stringify({
        model: ollamaModel,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map(h => ({ role: h.role, content: h.text })),
          { role: "user", content: message },
        ],
        // FAST-mode anti-repetition decode params (issue #729). Suppresses ✅✅✅ loops.
        options: serving.applyOllamaDecodeParams({}),
      });
      const ollamaUrl = new URL(ollamaBase);
      const ollamaOpts = {
        hostname: ollamaUrl.hostname,
        port: ollamaUrl.port || 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      let ollamaOk = false;
      await new Promise((resolve, reject) => {
        const req2 = http.request(ollamaOpts, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`ollama_status_${upstream.statusCode}`));
            return;
          }
          ollamaOk = true;
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line);
                const token = evt.message?.content || evt.response || "";
                if (token) { fullReply += token; sendToken(token); }
              } catch { /* skip */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("ollama_connect_timeout")); });
        req2.write(payload);
        req2.end();
      });
      if (ollamaOk) {
        const { cleanText: ollamaClean, suggestions: ollamaDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
        await logConversation({
          recordedAt: new Date().toISOString(),
          surface: "dream-chat-stream",
          role: "lantern",
          text: ollamaClean.slice(0, maxConversationTextLength),
        }).catch(() => {});
        recordProviderSuccess("ollama");
        await recordConvergenceSignature("ollama", ollamaModel, ollamaClean, true);
        const ollamaHttpReceipt = buildPcsfReceipt("ollama", ollamaModel, true);
        sendReceipt(ollamaHttpReceipt);
        sendDone("ollama", { agent: doneAgentName, provider: "ollama", online: true, cleanText: ollamaClean, suggestions: ollamaDoors, webSuggestions, receipt: ollamaHttpReceipt });
        return;
      }
    } catch (err) {
      recordProviderFailure("ollama", err.message);
      if (requestedProvider) {
        sendError(humanError(err));
        sendFail(err.message);
        return;
      }
      // Auto mode: swallow error silently, let next provider try
    }
  }
  }  // ── end Σ₀ brain dispatch loop ──

  // No provider available — stream local persona fallback
  const fallbackReason = anyProviderConfigured
    ? "all_providers_failed"
    : "no_provider_configured";
  await streamLocalFallback(fallbackReason);
}

module.exports = { handleStreamChat, extractDoors, doorsOrFallback, buildBrainOrder, stripModelArtifacts };
