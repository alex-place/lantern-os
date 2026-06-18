const https = require("https");
const http = require("http");
const path = require("path");
const { AGENT_PERSONAS, DREAM_DOORS, selectAgent, parseBangCommand, verifyResponse } = require("./dream-chat");
const { modelFor } = require("./provider-models");
const { readRecentDreams, normalizeDreamerUser } = require("./dreamer-store");
const { appendConversationEntry } = require("./conversation-store");
const { getProviderState, recordProviderSuccess, recordProviderFailure } = require("./provider-cache");
const { swarmOrchestrate } = require("./swarm-orchestrator");
const { unifiedAgentStreamSSE } = require("./unified-agent");
const sse = require("./stream-chat/sse");
const { parseStreamChatRequest } = require("./stream-chat/request");
const { formatCSFContextForPrompt, saveDoorChoice } = require("./csf-memory");
const { route: converganceRoute, buildBehaviorPreamble } = require("./convergance-os/model-router");
const { THREE_DOORS_PREAMBLE } = require("./convergance-os/profiles");
const { generateDoorSceneImage } = require("./image-generation");
const { webSearchMcp, formatGroundingContext, needsGrounding, extractSearchQuery } = require("./web-search-client");
const { generatePlan, generatePatch } = require("./self-edit-engine");
const { selectProvider, recordProviderSuccess: recordProviderSuccessRouter, recordProviderFailure: recordProviderFailureRouter } = require("./provider-router");
const { detectTaskType } = require("./task-detector");
const { classifyIntent } = require("./intent-router");
const { convergeMessage } = require("./convergence-adapter");
const { keystoneRun, KEYSTONE_SYSTEM_PROMPT } = require("./keystone-runtime");
const { unifiedAgentStreamSSE: unifiedStreamSSE } = require("./unified-agent");

const repoRoot = path.resolve(__dirname, "../../../");

const maxConversationTextLength = 4000;

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
    appendJsonlQueued(metricsPath, metric).catch(() => {});
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
    const roleLabel = role === "assistant" ? "Lantern" : "Dreamer";
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

function doorsOrFallback(text, skipDoors = false) {
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

      // Get the selected provider for LLM calls
      const provider = requestedProvider || selectProvider(message, history);
      let llmFn;

      try {
        // Call keystoneRun with the appropriate LLM provider
        keystoneRun(issue, repoRoot, async (opts) => {
          // Unified LLM call using the selected provider
          const systemPrompt = opts.system || KEYSTONE_SYSTEM_PROMPT;
          const messages = opts.messages || [{ role: "user", content: opts.input || "" }];

          const response = await unifiedStreamSSE({
            systemPrompt,
            messages,
            provider,
            model: null, // Let unified-agent pick the best model
            user,
          });

          return response;
        }, { verbose: true, maxFiles: 10 })
          .then((result) => {
            if (result.status === "success") {
              sendToken(`\n✅ Keystone execution complete\n\n`);
              sendToken(`**Plan:**\n${result.plan}\n\n`);
              sendToken(`**Files changed:**\n${result.applied.map((f) => `  - ${f.path}`).join("\n")}\n\n`);

              if (result.tests && result.tests.success) {
                sendToken(`✓ Tests passed\n\n`);
              } else if (result.tests) {
                sendToken(`⚠️ Tests output:\n${result.tests.output}\n\n`);
              }

              sendDone("keystone", {
                agent: "Keystone",
                provider,
                status: "success",
                filesChanged: result.applied.length,
                testsRun: !!result.tests,
              });
            } else {
              sendToken(`\n❌ Keystone failed: ${result.error}\n`);
              sendToken(`Phase: ${result.phase}\n`);
              sendDone("keystone", { agent: "Keystone", provider, status: "failed", error: result.error });
            }
            res.end();
          })
          .catch((err) => {
            sendToken(`\n❌ Error: ${err.message}\n`);
            sendDone("keystone", { agent: "Keystone", provider, status: "error", error: err.message });
            res.end();
          });
      } catch (e) {
        sendToken(`Error: ${e.message}\n`);
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
      // Route the task to Keystone via the normal LLM chain (same as !three-doors fallthrough).
      // Keystone's system prompt handles dev/GitHub tasks directly.
      const taskContent = (cmd.args || "").trim() || message.replace(/^!\S+\s*/, "").trim();
      message = taskContent
        ? `[Convergence task] ${taskContent}`
        : message.replace(/^!\S+\s*/, "").trim() || message;
      requestedAgent = requestedAgent || "keystone";
      // fall through to normal SSE chat routing below
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
        || cmd.name === "converge" || cmd.name === "convergance") {
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
  // Personas (Lantern et al.) live in the Three Doors game surface, where the
  // game may request a specific guide via body.agent (defaults to Lantern).
  const agent = surfaceMode === "three-doors"
    ? (AGENT_PERSONAS.find((a) => a.id === (requestedAgent || "lantern"))
        || AGENT_PERSONAS.find((a) => a.id === "lantern")
        || selectAgent(message))
    : (AGENT_PERSONAS.find((a) => a.id === "keystone") || selectAgent(message));

  // ── Keystone debug mode ───────────────────────────────────────────────
  // When Keystone is selected, bypass persona/doors and talk raw to the model
  // about app dev, repo state, and convergence. Direct API access from the UX.
  const isKeystoneDebug = agent.id === "keystone" && (mcpFlag || message.startsWith("[Convergence task]"));

  // Name reported in done events — Keystone at the desk, the persona (Lantern) in the game
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
  const compacted = compactHistory(history);
  const historyContext = compacted.length > 0
    ? `\nPrior conversation turns:\n${compacted.map(h => `${h.role === "assistant" ? "Lantern" : "Dreamer"}: ${h.text}`).join("\n")}`
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
  const KEYSTONE_DEBUG_PROMPT = `You are Keystone, a direct debug interface for Lantern OS development. You have access to the full repo context below. Respond as a senior engineer — concise, honest, actionable. No dream persona, no doors, no metaphors.\n\n${_realtimeCtx}\n\nRepo state:\n- Server: apps/lantern-garage/server.js (modular routes under routes/)\n- Streaming: lib/stream-chat.js (Gemini→Claude→OpenAI→Grok→Ollama chain)\n- Dream journal: ${allRecent.length} entries in data/dream_journal/\n- Providers configured: ${['GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','XAI_API_KEY'].filter(k => process.env[k]).join(', ') || 'none'}\n- Symbol mesh: ${symbolMesh.slice(0, 5).join(', ') || 'empty'}\n- Co-occurrence: ${topPairs || 'none'}\n${historyContext}\n\nYou can EXECUTE commands. When you output a single-line bash code block, the UI renders a ▶ Run button.\nONLY use these exact commands (anything else is blocked):\n\nTESTS: \`npm test\` or \`node tests/test_dream_journal_api.js\` or \`node tests/test_dream_journal_chat.js\` or \`node tests/test_dream_chat_multiturns.js\` or \`node tests/test_dream_journal_keystone.js\`\nGIT: \`git status\` \`git diff --stat\` \`git log --oneline -N\` \`git add FILE\` \`git commit -m "MSG"\` \`git push origin master\` \`git branch\`\nPR: \`gh pr create --repo alex-place/lantern-os --head cdblasioli-gif:master --base master --title "TITLE" --body "BODY"\`\nORCH: \`python src/convergence_io_engine.py health\` or \`loop\` or \`inspect\`\nREAD: \`cat FILE\` \`head -N FILE\`\n\nWhen asked to do something, output the EXACT command in a bash code block. The user clicks ▶ to run it. Do NOT suggest commands outside this list.\n\nAnswer directly. Reference file paths. Check data/pcsf/ for state. Check manifests/dream-journal-v1-agent-slots.json and csf/ingest/*.md for work queue.`;

  // ── Web Search Grounding ───────────────────────────────────────────
  let groundingContext = "";
  if (!isKeystoneDebug && needsGrounding(message)) {
    const searchQuery = extractSearchQuery(message);
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
        ? `${agent.name || "Lantern"} · Three Doors`
        : (ROUTE_LABEL_MAP[converganceIntent] || "Keystone · router");

  const _now = new Date();
  const _realtimeCtx = `Current date/time: ${_now.toISOString()} (${_now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ${_now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })})`;

  // Plain Keystone desk prompt — no persona voice, no doors. Dream Chat is Keystone-only.
  const ROUTER_PROMPT = `You are Keystone, the engineering desk agent for Lantern OS. Answer directly, technically, and concisely — no roleplay, no dream personas, no door suggestions. Never reply with only your name or a greeting — always provide a substantive answer. If the user asks for roleplay, Lantern, or the Three Doors game, tell them to open the Explore tab (/three-doors-game.html).\n\n${_realtimeCtx}\n\nContext:\n${dreamContext}${csfBlock}${groundingContext ? "\n\n" + groundingContext : ""}`;

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
    return sse.sendDone(res, source, { ...extra, ...signature, routeLabel });
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
      await appendJsonlQueued(convergencePath, signature).catch(() => {});
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

  await appendConversationEntry({
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
      await appendConversationEntry({
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
    // Convergence unavailable or timed out — fall through to direct LLM providers
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
          console.log(`[router-gate] escalate -> reasoning (${gate.reason})`);
          taskType = "reasoning";
        } else {
          console.log(`[router-gate] no-op for ${taskType} (${gate.reason})`);
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
          }).catch(() => {});
        } catch { /* logging is best-effort */ }
      } catch (ge) {
        console.error("[router-gate] gate error (non-fatal):", ge.message);
      }
    }

    const { provider: recommendedProvider, reason: selectionReason } = await selectProvider(message, taskType, requestedProvider);
    primaryProviderHint = { provider: recommendedProvider, taskType, reason: selectionReason };
    console.log(`[provider-router] Selected ${recommendedProvider} for ${taskType}: ${selectionReason}`);
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
  
  // Select model chain based on intent or use default
  const intent = converganceDecision?.intent || "default";
  const modelChain = OLLAMA_MODEL_CHAIN[intent] || OLLAMA_MODEL_CHAIN.default;
  
  const ollamaLocalFirst = (!requestedProvider || requestedProvider === "ollama" || requestedProvider === "local") && !autoPrefersAnthropic;
  if (ollamaLocalFirst && message && !isKeystoneDebug) {
    
    for (const ollamaModel of modelChain) {
      try {
        const payload = JSON.stringify({
          model: ollamaModel,
          stream: true,
          messages: buildProviderMessages(systemPrompt, compacted, message),
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
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          const imageEntryId = triggerImageGeneration({ cleanText, suggestions, surfaceMode, symbolMesh });
          await appendConversationEntry({
            recordedAt: new Date().toISOString(),
            surface: "dream-chat-stream",
            role: "lantern",
            text: cleanText.slice(0, maxConversationTextLength),
          }).catch(() => {});
          recordProviderSuccess("ollama");
          const ollamaReceipt = buildPcsfReceipt("ollama", ollamaModel, true);
          sendReceipt(ollamaReceipt);
          const meta = { agent: doneAgentName, online: true, cleanText, suggestions, model: ollamaModel, webSuggestions, receipt: ollamaReceipt };
          if (imageEntryId) meta.image = { entryId: imageEntryId, status: "generating" };
          sendDone("ollama", meta);
          return;
        }
      } catch (err) {
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
        await appendConversationEntry({
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

  // Provider 1: Gemini (streaming) — cloud fallback
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey && message && ((!requestedProvider && !autoPrefersAnthropic) || requestedProvider === "gemini" || requestedProvider === "google" || requestedProvider.startsWith("gemini-"))) {
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
      if (process.env.SIGMA0_VERIFY === "true") {
        try {
          const vr = await verifyResponse(geminiClean, message, doneAgentName);
          if (vr.corrected) {
            sse.writeData(res, { type: "sigma0", corrected: true, claims: vr.records.length, verified: vr.records.filter(r => r.confidence >= 0.5).length });
            geminiClean = vr.verified;
          }
          geminiSigma0 = { corrected: vr.corrected, claims: vr.records.length };
        } catch { /* non-fatal */ }
      }
      await appendConversationEntry({
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
      // Auto mode: swallow error silently, let next provider try
    }
    } // end model chain loop
  }

  // Provider 2: Anthropic Claude (streaming)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && message && (!requestedProvider || requestedProvider === "claude" || requestedProvider === "anthropic" || requestedProvider === "claude-sonnet")) {
    try {
      let claudeModel = "claude-haiku-4-5-20251001";
      if (requestedProvider === "claude-sonnet") {
        claudeModel = process.env.ANTHROPIC_SONNET_MODEL || "claude-sonnet-4-6";
      } else {
        claudeModel = process.env.ANTHROPIC_MODEL || claudeModel;
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
      if (process.env.SIGMA0_VERIFY === "true") {
        try {
          const vr = await verifyResponse(anthropicClean, message, doneAgentName);
          if (vr.corrected) {
            sse.writeData(res, { type: "sigma0", corrected: true, claims: vr.records.length, verified: vr.records.filter(r => r.confidence >= 0.5).length });
            anthropicClean = vr.verified;
          }
          anthropicSigma0 = { corrected: vr.corrected, claims: vr.records.length };
        } catch { /* non-fatal */ }
      }
      await appendConversationEntry({
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
      // Auto mode: swallow error silently, let next provider try
    }
  }

  // Provider 3: OpenAI (streaming)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && message && (!requestedProvider || requestedProvider === "openai" || requestedProvider === "gpt")) {
    try {
      const payload = JSON.stringify({
        model: modelFor("openai"),
        stream: true,
        messages: buildProviderMessages(systemPrompt, compacted, message),
      });

      await new Promise((resolve, reject) => {
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
      await appendConversationEntry({
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
      // Auto mode: swallow error silently, let next provider try
    }
  }

  // Provider 4: Grok / xAI (streaming — OpenAI-compatible)
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey && message && (!requestedProvider || requestedProvider === "grok" || requestedProvider === "xai")) {
    try {
      const xaiModel = modelFor("xai");
      const payload = JSON.stringify({
        model: xaiModel, stream: true,
        messages: buildProviderMessages(systemPrompt, compacted, message),
      });
      await new Promise((resolve, reject) => {
        const req2 = require("https").request({
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
      await appendConversationEntry({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: xaiClean.slice(0, maxConversationTextLength) }).catch(() => {});
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
      // Auto mode: swallow error silently, let next provider try
    }
  }

  // Provider 5: Ollama (streaming) — last-resort fallback (local-first already tried above)
  if (message && (!requestedProvider || requestedProvider === "ollama" || requestedProvider === "local")) {
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
          await appendConversationEntry({
            recordedAt: new Date().toISOString(),
            surface: "dream-chat-stream",
            role: "lantern",
            text: cleanText.slice(0, maxConversationTextLength),
          }).catch(() => {});
          recordProviderSuccess("ollama");
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
        await appendConversationEntry({
          recordedAt: new Date().toISOString(),
          surface: "dream-chat-stream",
          role: "lantern",
          text: ollamaClean.slice(0, maxConversationTextLength),
        }).catch(() => {});
        recordProviderSuccess("ollama");
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

  // No provider available — stream local persona fallback
  const fallbackReason = anyProviderConfigured
    ? "all_providers_failed"
    : "no_provider_configured";
  await streamLocalFallback(fallbackReason);
}

module.exports = { handleStreamChat, extractDoors, doorsOrFallback };
