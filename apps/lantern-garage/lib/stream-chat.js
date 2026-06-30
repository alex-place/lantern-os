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
const { recordConvergance } = require("./csf-memory-writer");
const { resolveCodingRoute } = require("./route-contract");
const { unifiedAgentStreamSSE } = require("./unified-agent");
const sse = require("./stream-chat/sse");
const { parseStreamChatRequest } = require("./stream-chat/request");
const { runCanaries } = require("./canary");
const { councilReview } = require("./council-review");
const { verifyExec } = require("./exec-verify");
const { assembleSessionContext } = require("./session-summary-store");
const { formatCSFContextForPrompt, formatCSFContextForPromptAsync, saveDoorChoice } = require("./csf-memory");
const { formatGrounding: oracleFormatGrounding } = require("./convergence-oracle");
const { resolveGrounding, formatGroundingForPrompt } = require("./mesh-grounding");
const { defaultRings } = require("./grounding-rings");
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
const { classifyIntentOuro } = require("./ouro-router");
const serving = require("./serving-modes");
const { convergeMessage } = require("./convergence-adapter");
const { keystoneRun, KEYSTONE_SYSTEM_PROMPT } = require("./keystone-runtime");
const { unifiedAgentStreamSSE: unifiedStreamSSE } = require("./unified-agent");
// Extracted helper modules (split out of this file for smaller-context editing):
const { compactHistory, buildProviderMessages } = require("./stream-chat/history");
const { FALLBACK_DOORS, extractDoors, stripModelArtifacts, doorsOrFallback, generateWebSuggestions } = require("./stream-chat/doors");
const { anthropicToolTurn, openaiCompatibleToolTurn, geminiToolTurn } = require("./stream-chat/tool-turns");
const { buildBrainOrder } = require("./stream-chat/provider-order");
const { appendJsonlQueued } = require("./file-queue");
const { emitClaimDraft } = require("./claim-drafter");

const repoRoot = path.resolve(__dirname, "../../../");
const OURO_HARVEST_LIVE = path.resolve(repoRoot, "data/ouro-harvest-live.jsonl");

const maxConversationTextLength = 4000;

// ── Issue #911: live coding success emitter ──────────────────────────────────
// When any keystone/chat reply contains a Python def + assert block, log a raw
// candidate row to data/ouro-harvest-live.jsonl. Fire-and-forget only — NEVER
// triggers retraining; the offline continual_ouro_pipeline.py reads this via
// --source-jsonl when the user explicitly runs it. Boundary: OFFLINE + OPT-IN.
const _PY_FUNC_RE = /```python\s*(def\s+\w+\([^)]*\)[^`]*?)```/gs;
const _ASSERT_RE = /assert\s+[^\n]+/g;

function _emitCodingCandidate(instruction, reply) {
  try {
    const matches = [...reply.matchAll(_PY_FUNC_RE)];
    if (!matches.length) return;
    for (const m of matches) {
      const code = m[1].trim();
      const fn = (code.match(/^def\s+(\w+)/) || [])[1] || "fn";
      const asserts = (code.match(_ASSERT_RE) || []).join("\n");
      appendJsonlQueued(OURO_HARVEST_LIVE, {
        fn, instruction: instruction.slice(0, 200), code, asserts,
        source: "live-chat", ts: Date.now(),
      }).catch(() => {});
    }
  } catch { /* emitter must never break a reply */ }
}

// ── Σ₀ council execution check: extract runnable {code, test} from a coding reply ──
// "Correctness costs an external check." When a reply proposes a Python function AND a
// check (assert / a test fn that throws), we can RUN it — the ground-truth signal the
// council folds as the dominant anchor (passed → grounded, failed → refuted/retry).
// Returns null when there's nothing to verify (no code, or code with no check), so the
// council falls back to its text-Δ gate exactly as before. Python-only for now: it's the
// language the live harvest already targets, and `python` is the runner most likely present.
const _PY_FENCE_RE = /```python\s*([\s\S]*?)```/i;
function _extractRunnable(reply) {
  const fence = (reply || "").match(_PY_FENCE_RE);
  if (!fence) return null;
  const code = fence[1].trim();
  if (!code) return null;
  // A check must exist somewhere or there is nothing to execute against. If the asserts
  // live inside the fenced block they already run with `code`; otherwise pull top-level
  // asserts from the surrounding prose so the function is exercised.
  const hasInlineCheck = /\bassert\b/.test(code);
  let test = "";
  if (!hasInlineCheck) {
    const outside = (reply.slice(fence.index + fence[0].length).match(_ASSERT_RE) || []);
    if (!outside.length) return null; // no check anywhere → not verifiable
    test = outside.join("\n");
  }
  return { language: "python", code, test };
}

// Per-request grounding (web search + live GitHub project context) is best-effort
// enrichment that runs BEFORE the model is called. If the network or the `gh` CLI
// is slow/hung, an unbounded await there stalls the ENTIRE chat reply (no tokens,
// no error) - observed in degraded environments. Bound each grounding call so it
// can never hang the response: on timeout, resolve to a fallback and proceed; the
// underlying call finishes (and self-times-out) in the background.
const GROUNDING_TIMEOUT_MS = parseInt(process.env.GROUNDING_TIMEOUT_MS, 10) || 4000;

// Σ₀ council execution check. ON by default — when a coding reply carries runnable code + a
// check, RUN it so the reply's own asserts (not the model's self-judgment) decide
// grounded-vs-refuted. This is the dominant grounding anchor; leaving it off kept the council's
// verify-face text-only. The sandbox is shell-free, temp-dir isolated, hard-timed, output-capped,
// and runs with a MINIMAL env that strips every API key (lib/exec-verify.js) — that isolation is
// what makes default-on defensible on the local single-operator surface. Set COUNCIL_EXEC_VERIFY=0
// to disable on shared/multi-tenant surfaces where running model-authored code is unacceptable
// (SECURITY.md: prompt-injection could still steer the model to emit network/FS-touching code,
// though it cannot read secrets).
const COUNCIL_EXEC_VERIFY = process.env.COUNCIL_EXEC_VERIFY !== "0";
const COUNCIL_EXEC_TIMEOUT_MS = parseInt(process.env.COUNCIL_EXEC_TIMEOUT_MS, 10) || 8000;
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
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
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  // "Ground this" retry (groundedness canary loop): force the web-search grounding
  // Prepend attachment content to the user's message if available.
  if (attachments.length > 0) {
    let attachmentBlock = "";
    for (const attachment of attachments) {
      if (attachment.name && attachment.text) {
        attachmentBlock += `--- ATTACHMENT: ${attachment.name} ---\n`;
        attachmentBlock += `${attachment.text}\n`;
        attachmentBlock += `--- END ATTACHMENT ---\n\n`;
      }
    }
    if (attachmentBlock) {
      message = attachmentBlock + "User message: " + message;
    }
  }
  // branch even when the heuristic wouldn't have fired for this message.
  const forceGround = !!parsed.forceGround;

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

      // Use the shared SSE helpers so the product chat (which reads {type:"token",
      // text:…}) actually renders these. The old raw {token} format was dropped.
      sse.writeStreamHeaders(res);
      const sendToken = (token) => sse.sendToken(res, token);
      const sendDone = (source, meta) => sse.sendDone(res, source, meta);

      sendToken(`Keystone routing…\n\n`);
      const agent = selectAgent(swarmMessage);
      const systemPrompt = `${agent.systemPrompt}\n\nTone: thoughtful, unhurried, human. Never clinical. Never sycophantic.`;

      swarmOrchestrate({ job, mode, systemPrompt, message: swarmMessage, history })
        .then((result) => {
          const words = result.text.split(" ");
          for (const word of words) sendToken(word + " ");
          const council = result.council || null;
          if (council && Array.isArray(council.dissent) && council.dissent.length) {
            sendToken(`\n\n**Where the council disagreed (${council.dissent.length}):**\n`);
            for (const d of council.dissent) sendToken(`- ${d}\n`);
          }
          const meta = { agent: "Keystone", provider: result.provider, online: true, swarm: { provider: result.provider, model: result.model, mode, job } };
          if (result.consensus) meta.swarm.consensus = result.consensus;
          if (council) meta.swarm.council = council;
          sendDone("keystone", meta);
        })
        .catch((err) => {
          sendToken(`Swarm failed: ${err.message}\n`);
          sendDone("failed", { error: err.message });
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
          recordDistillationPair,
        } = require("./keystone-escalation");
        const runId = `kernel-${Date.now()}`;
        // Policy (#1207): cloud is the reasoning brain; the local best-in-slot coder
        // (e.g. Qwen2.5-Coder-7B) handles CODING/TOOLS first to save cloud tokens, with
        // #1197 verify-gated escalation to the cloud teacher when the local result isn't
        // VERIFIED (tests pass) — not when it merely "returns something" (#1167). So the
        // interactive coding path is local-first BY DEFAULT now; disable with
        // KEYSTONE_LOCAL_FIRST=0 (e.g. when no capable local coder is served).
        const localFirst = rolloverMode === "default" || process.env.KEYSTONE_LOCAL_FIRST !== "0";
        const providers = localFirst
          ? kernelEscalationChain()
          : [{ provider, model: kernelModel || "claude-opus-4-8" }];

        const { result, providerUsed, escalations, landedBy, verified } = await runKernelWithEscalation({
          providers,
          requireVerified: localFirst,
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
          // #1198 flywheel: when the cloud TEACHER landed an ESCALATED task and it
          // VERIFIED, capture (task → cloud diff) as a training pair so the next
          // retrain teaches the local student exactly this failure case.
          try {
            recordDistillationPair({
              task: issue, plan: result.plan, patch: result.patch,
              landedBy, verified, escalated: escalations.length > 0,
              provider: used.provider, model: used.model, repoRoot,
            });
          } catch (_e) { /* logging must never break the stream */ }
          sendDone("keystone", {
            agent: "Keystone", provider: used.provider, model: used.model, rolloverMode,
            status: "success", filesChanged: Array.isArray(result.applied) ? result.applied.length : 0,
            testsRun: !!result.tests, escalations: escalations.length,
            // #1197 parity metric: who actually landed it (local vs cloud teacher) + verified.
            landed_by: landedBy || (used.provider === "ollama" ? "local" : "cloud"),
            verified: !!verified,
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
      
      // PYTHONIOENCODING=utf-8 so non-ASCII stdout streamed to the chat UI isn't mangled
      // into "�" on Windows (cp1252 default) — same fix as convergence-adapter.js (#1605).
      const py = spawn("python", ["scripts/generate-door-images.py", "generate"],
        { cwd: repoRoot, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
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

    // Grounded self-assessment: !report-card produces an honest letter-grade
    // scorecard of Keystone OS. Evidence is gathered deterministically (git, real
    // counts, eval numbers, boot probe) so the model can only SYNTHESIZE grades
    // from real measurements — it can't invent a receipt. Strengthens Verify.
    if (cmd.name === "report-card" || cmd.name === "report_card" || cmd.name === "reportcard") {
      sse.writeStreamHeaders(res);
      const sendToken = (token) => sse.sendToken(res, token);
      const sendDone = (source, meta) => sse.sendDone(res, source, meta);

      sendToken(`📋 Gathering grounded evidence…\n\n`);
      try {
        const { gatherEvidence, formatEvidenceForPrompt, REPORT_CARD_SYSTEM_PROMPT } = require("./report-card");
        const { callLlm } = require("./self-edit-engine");
        const evidence = gatherEvidence(repoRoot);
        const userMsg = `${formatEvidenceForPrompt(evidence)}\n\nProduce the report card now, grading only from the evidence above.`;
        // Synthesize via callLlm's auto cascade (Vertex leads — the funded path; #1285),
        // not swarmOrchestrate, whose direct API-key providers are credit-starved here.
        const text = await callLlm(REPORT_CARD_SYSTEM_PROMPT, userMsg, requestedProvider || "auto", 4096);
        if (!text || !text.trim()) {
          sendToken(`Could not generate a report card — no provider returned a result.\n`);
          sendDone("failed", { agent: "ReportCard", error: "empty_result" });
        } else {
          for (const word of text.split(" ")) sendToken(word + " ");
          sendDone("report_card", { agent: "ReportCard", online: true });
        }
      } catch (e) {
        sendToken(`Report card failed: ${e.message}\n`);
        sendDone("failed", { agent: "ReportCard", error: e.message });
      }
      res.end();
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
          const dissent = (result.council && result.council.dissent) || [];
          let recordId = null;
          try {
            const rec = await emitConvergenceRecord({
              hypothesis: question.slice(0, 300),
              result: answer.slice(0, 2000),
              confidence: conf,
              evidence_ids: members.map((m) => m.provider),
              reasoner: "convergance-council",
              verified: true,
              verification_notes: `Σ₀ council convergence over ${members.length} member(s) [${members.map((m) => `${m.role}:${m.provider}`).join(", ")}]; synthesizer=${result.provider}/${result.model}` + (dissent.length ? `; dissent: ${dissent.join(" | ")}` : "; dissent: none"),
              source: `council/${result.provider}/${result.model}`,
            });
            recordId = rec && rec.id;
          } catch (_e) { /* record emit is best-effort */ }
          // Remember-stage hook: ingest this convergence interaction into the ONE
          // canonical CSF memory so it's recalled in later chats. Best-effort.
          try {
            await recordConvergance({
              question,
              answer,
              confidence: conf,
              providers: members.map((m) => m.provider),
              dissent,
              recordId,
              synthesizer: `${result.provider}/${result.model}`,
              surface: surfaceMode || "chat",
            });
          } catch (_e) { /* CSF ingest is best-effort — never break chat */ }
          for (const w of answer.split(" ")) sendToken(w + " ");
          if (dissent.length) {
            sendToken(`\n\n**Where the council disagreed (${dissent.length}):**\n`);
            for (const d of dissent) sendToken(`- ${d}\n`);
          }
          sendDone("keystone", {
            agent: "Keystone",
            provider: result.provider,
            online: true,
            routeLabel: "Convergence · Σ₀ council",
            convergence: { confidence: conf, synthesizer: `${result.provider}/${result.model}`, providers: members.map((m) => ({ role: m.role, provider: m.provider })), dissent, recordId },
          });
          return;
        } catch (err) {
          // Council unavailable (e.g. no provider keys) — fall back to a single provider
          // so the user still gets an answer. Headers are already SSE, so do NOT fall through.
          try {
            const fb = await swarmOrchestrate({ job: "chat", mode: "single", systemPrompt: convSystem, message: question, history });
            const ans = String(fb.text).replace(/\n*CONFIDENCE:\s*[0-9]*\.?[0-9]+\s*$/i, "").trim() || String(fb.text);
            try {
              await recordConvergance({
                question,
                answer: ans,
                confidence: 0.5,
                providers: [fb.provider].filter(Boolean),
                synthesizer: `${fb.provider}/${fb.model || "single"}`,
                surface: surfaceMode || "chat",
              });
            } catch (_e) { /* best-effort */ }
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

    // !review #<PR> — pull a pull request's diff and review it in the chat. Lets the
    // user work through draft/autowork PRs ("is this change good?") without leaving
    // Keystone. Diff fetched shell-free via gh (#873); reviewed by the live model.
    if (cmd.name === "review") {
      sse.writeStreamHeaders(res);
      const sendToken = (token) => sse.sendToken(res, token);
      const sendDone = (source, meta) => sse.sendDone(res, source, meta);
      const prNum = (String(cmd.args || "").match(/#?(\d+)/) || [])[1];
      if (!prNum) {
        sendToken("Usage: `!review #<PR number>` — e.g. `!review #1302`.");
        sendDone("review", { agent: "Keystone", online: true });
        res.end();
        return;
      }
      sendToken(`🔍 Reviewing PR #${prNum}…\n\n`);
      (async () => {
        try {
          const { safeExec } = require("./safe-exec");
          const { callLlm } = require("./self-edit-engine");
          const REPO = ["--repo", "alex-place/lantern-os"];
          let meta = {};
          try {
            meta = JSON.parse(safeExec(
              ["gh", "pr", "view", prNum, ...REPO, "--json", "title,additions,deletions,files,isDraft,state"],
              { timeout: 15000 }
            ));
          } catch (_) { /* meta is best-effort */ }
          const diff = safeExec(["gh", "pr", "diff", prNum, ...REPO],
            { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
          if (!diff || !diff.trim()) {
            sendToken(`PR #${prNum} has no diff (closed, empty, or not found). [Open on GitHub](https://github.com/alex-place/lantern-os/pull/${prNum})`);
            sendDone("review", { agent: "Keystone", online: true });
            res.end();
            return;
          }
          const MAX = 16000;
          const clipped = diff.length > MAX ? diff.slice(0, MAX) + "\n…(diff truncated for review)" : diff;
          const fileList = (meta.files || []).map((f) => f.path).join(", ");
          const reviewSystem =
            "You are a senior engineer reviewing a pull request for the Keystone OS repo " +
            "(Node.js app under apps/lantern-garage/, Python under src/). Decide if the change is " +
            "correct, complete, and safe to merge. Be concise and concrete. Use this exact shape:\n" +
            "- **Verdict**: ✅ merge / ⚠️ needs changes / ❌ reject — one line why.\n" +
            "- **What it does**: 1–2 sentences.\n" +
            "- **Issues**: concrete problems (real bugs, wrong or nonexistent file paths for this repo, " +
            "missing pieces, security). Cite the file. Say 'None found' if clean.\n" +
            "- **Suggestions**: optional.\n" +
            "Ground every claim in the diff shown — never invent code that isn't there. If a changed file " +
            "path looks wrong for this repo's layout, flag it explicitly.";
          const reviewUser =
            `PR #${prNum}: ${meta.title || "(unknown title)"}\n` +
            `State: ${meta.state || "?"}${meta.isDraft ? " (draft)" : ""} · Files: ${fileList || "(unknown)"}\n\n` +
            `Diff (+${meta.additions == null ? "?" : meta.additions}/-${meta.deletions == null ? "?" : meta.deletions}):\n\n${clipped}`;
          const review = await callLlm(reviewSystem, reviewUser, "auto", 1800);
          const link = `https://github.com/alex-place/lantern-os/pull/${prNum}`;
          sendToken(`**[PR #${prNum}](${link})** — ${meta.title || ""}\n\n${(review || "").trim() || "(no review returned)"}`);
          sendDone("review", { agent: "Keystone", online: true, provider: "review" });
          res.end();
        } catch (err) {
          sse.sendError(res, `Review failed: ${err.message}`);
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
  if (!isKeystoneDebug && (needsGrounding(message) || groundingD >= 1.5 || groundingTickDue || forceGround)) {
    // On a mandatory tick — or an explicit "Ground this" retry — fall back to the
    // message itself when no query extracts, so we still reach external reality on
    // otherwise un-groundable turns.
    const searchQuery = extractSearchQuery(message) || ((groundingTickDue || forceGround) ? String(message || "").slice(0, 120).trim() : "");
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

  // CSF long-term memory + door state (query-time relevance filtered).
  // Async path: Memories section is semantic-reranked (nomic-embed multi-signal)
  // when Ollama is up, else falls back to keyword scoring inside the query.
  const csfContext = await formatCSFContextForPromptAsync(message);
  const csfBlock = csfContext ? `\n\nLong-term memory (CSF):\n${csfContext}` : "";

  // Convergence Oracle — ground EVERY question in its cosmic-time observer slice (in-process
  // Node port; the live stream path had no oracle grounding before this). Fail-safe: any error → "".
  let oracleBlock = "";
  try { const og = message ? oracleFormatGrounding(message) : ""; if (og) oracleBlock = `\n\n${og}`; }
  catch { oracleBlock = ""; }

  // Mesh grounding (MESH_GROUNDING=1, off by default) — local memory + Knowledge Center rings.
  // ADDITIVE ONLY: inject the cited evidence block when the resolver GROUNDS; never inject its
  // abstain into a normal chat turn (the system prompt already owns honest "I don't know"). Web
  // ring omitted (stream path does its own web grounding); mesh peer ring omitted (ADR-gated).
  let meshGroundBlock = "";
  if (process.env.MESH_GROUNDING === "1" && message) {
    try {
      const _gr = await resolveGrounding(message, { rings: defaultRings({ mesh: false, web: false }) });
      if (_gr.grounded) {
        meshGroundBlock = `\n\n${formatGroundingForPrompt(_gr)}`;
        console.warn(`[mesh-grounding] grounded turn: ${_gr.sources.length} source(s), conf ${_gr.confidence.toFixed(2)}`);
      }
    } catch { meshGroundBlock = ""; }
  }

  // Attached files (the "+" work tool) — the user uploaded these for THIS turn. Treat them as
  // primary evidence: read, quote, summarize, or act on them, and ground answers in their content.
  let attachmentBlock = "";
  if (attachments.length) {
    const blocks = attachments.map((a) => `--- Attached file: ${a.name} (${a.text.length} chars) ---\n${a.text}`).join("\n\n");
    attachmentBlock = `\n\nAttached files for this turn (the user uploaded these — treat them as the primary evidence; quote/summarize/act on them and cite the filename):\n${blocks}`;
  }

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

  // #1167: the local Ollama coder (ouro:latest) is a 1.4B model fine-tuned on
  // 243 code-only instruction/response pairs. Auto-mode local-first routing
  // (below) sent it general/creative/meta chat too — hallucinated answers and,
  // under pressure, full mode collapse (repeated/garbled word-salad). Scope
  // local-first to intents the coder was actually trained for.
  // ── Ouro intent router (Σ₀ Step 2, OURO_ROUTER=1) ─────────────────────────
  // In AUTO mode (no explicit model) the local Ouro model classifies the message
  // into a task type, which then drives isCodingIntent (→ cloud-first) and taskType
  // (→ provider selection). Ouro never writes the answer — it only triages. Any
  // failure returns null → we fall back to the keyword detectTaskType/convergance
  // signals below. Explicit model picks skip Ouro entirely (no added latency).
  let ouroRoute = null;
  if (process.env.OURO_ROUTER === "1" && !requestedProvider && message) {
    try { ouroRoute = await classifyIntentOuro(message); } catch { ouroRoute = null; }
    console.warn(ouroRoute
      ? `[ouro-router] taskType=${ouroRoute.taskType} conf=${ouroRoute.confidence} raw="${ouroRoute.raw}"`
      : "[ouro-router] unavailable → keyword fallback");
  }

  const CODING_INTENTS = new Set(["coding_change", "code_review"]);
  const isCodingIntent = ouroRoute ? ouroRoute.isCoding : CODING_INTENTS.has(converganceDecision?.intent);

  const routeDecision = classifyIntent(message);

  // ── Route label (sent in every done event; shown below each assistant bubble) ─
  const converganceIntent = converganceDecision?.intent || routeIntent || routeDecision.intent || "general";
  // Leaderboard recording key. The PCSF leaderboard / chain ordering query by
  // detectTaskType ("coding"/"reasoning"/"default"...), but outcomes used to be
  // recorded under `intent` ("dream_chat"/"technical_debug"), so per-task ranking
  // never matched. Hoisted here (before the sendDone closure) and assigned from
  // detectTaskType below so success AND failure record under the routing taxonomy (#1236).
  let leaderboardTaskType = "default";
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
  const ROUTER_PROMPT = `You are Keystone Σ₀ — the grounded reasoning and engineering agent for Keystone OS, a local-first private journaling and reasoning app that runs on the user's own machine with no account required. You run the convergence loop (Observe → Remember → Reason → Act → Verify → Converge), and external reality beats internal consistency: ground every important claim in evidence, give an honest confidence, and say "I don't know" rather than improvise. Answer directly, technically, and concretely. You are a precise technical agent — never use roleplay, mystical, or poetic language. For code, give complete, correct, copy-paste-ready implementations grounded in real files/APIs and state exactly how to verify (test command or expected output). Be concise for simple asks, but COMPREHENSIVE for substantive, factual, or research questions: give full context and reasoning, structure longer answers with short headings and bullet lists, and cite sources as clickable Markdown links [descriptive title](https://url). Your replies render as rich Markdown in this chat UI: \`![alt](https://image-url)\` displays the image inline, a plain YouTube link (https://youtube.com/watch?v=… or https://youtu.be/…) embeds as a player, and \`[text](https://url)\` becomes a link that opens in a new tab — so you absolutely CAN show images and embed videos; never tell the user you "can't embed", "can't display images", or "lack web/embedding capability" (that is false). When an image or video genuinely helps, include it — but use ONLY real, working URLs you actually know (e.g. Wikimedia Commons upload URLs, well-known sources); never invent, guess, or fabricate a media URL — if unsure, link the source page instead. If the user asks "what is this?" or "what can you do?", give a plain one- or two-sentence description of Keystone OS. IMPORTANT: Your very first token must be substantive content — never output only your name or any greeting. Go straight to the answer.\n\n${_realtimeCtx}${csfBlock}${groundingContext ? "\n\n" + groundingContext : ""}${oracleBlock}${meshGroundBlock}${attachmentBlock}`;

  // Grounded identity (#1242). The underlying foundation model (Gemini/Claude/
  // OpenAI/xAI/Ouro) must never leak its vendor identity through the Keystone
  // persona — a Gemini-served turn was answering "I'm a large language model built
  // by Google". Inject a deterministic identity block on the assistant surfaces
  // (debug + router); leave the creative RP/journal personas untouched.
  const KEYSTONE_IDENTITY =
    "You are Keystone, the assistant of Keystone OS — a local-first, model-agnostic " +
    "reasoning system. You are part of Keystone OS; you were NOT built by Google, OpenAI, " +
    "Anthropic, xAI, or any other company, and you must never claim otherwise. Keystone OS " +
    "routes each turn across a chain of interchangeable models, so the specific model serving " +
    "any given turn varies. If asked which model or company powers you, answer consistently: " +
    "you are Keystone (part of Keystone OS), which selects from several interchangeable " +
    "providers per turn — do not name a specific vendor as your maker or invent a model name.";
  const baseSystemPrompt = isKeystoneDebug
    ? KEYSTONE_DEBUG_PROMPT
    : isRpMode
      ? `${agent.systemPrompt}\n\n${dreamContext}${csfBlock}${groundingContext ? "\n\n" + groundingContext : ""}${oracleBlock}${meshGroundBlock}${attachmentBlock}\n\nTone: thoughtful, unhurried, human. Never clinical. Never sycophantic. Use the dreamer's own words back to them. When the dreamer asks about previous dreams or doors, use the CSF memory and door state above — never fabricate memories.${DOORS_INSTRUCTION}${surfaceMode === "three-doors" ? THREE_DOORS_PREAMBLE : ""}`
      : ROUTER_PROMPT;
  const systemPrompt = isRpMode ? baseSystemPrompt : `${KEYSTONE_IDENTITY}\n\n${baseSystemPrompt}`;


  const sendToken = (token) => sse.sendToken(res, token);
  const sendRoute = (route) => sse.sendRoute(res, route);
  const sendReceipt = (receipt) => sse.sendReceipt(res, receipt);

  // Turn-start for cloud leaderboard latency; reset just before the dispatch loop.
  let _turnStart = Date.now();
  // Cloud providers the streaming dispatch can actually run. Local (ollama/keystone-ft)
  // already records its own outcomes in-line; we only fill the cloud gap here.
  // Includes both "xai" and "grok": the xai success path reports provider "grok",
  // so without it grok successes were silently never recorded to the leaderboard (#1236).
  const _EXECUTABLE_CLOUD = new Set(["anthropic", "gemini", "openai", "xai", "grok"]);

  // Accumulated model output. Declared up here (not at the dispatch loop) because
  // sendDone() closes over it and some early-return paths — the malformed/empty
  // body guard (#1504), the convergence-agent fast path — call sendDone before the
  // dispatch loop runs. A `let` declared later left those calls in the temporal
  // dead zone ("Cannot access 'fullReply' before initialization").
  let fullReply = "";

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
    // ── Degraded-local indicator (issue #740, narrowed by #1167) ────────────
    // In Auto mode (no explicit provider) the cloud chain (Gemini→Claude→OpenAI→
    // Grok) can silently fall through to the local Ollama model — which ignores
    // ROUTER_PROMPT and produces off-tone filler ("calm while wrong"). When that
    // happens, flag it so the UI shows "degraded — local model" instead of
    // passing the weak answer off as the normal route. Explicit ollama/local
    // requests are intentional and not flagged — and so is the deliberate
    // coding-intent local-first hit (#1167): that's the designed fast path,
    // not a cloud outage, so labeling it "cloud unreachable" would be false.
    const isLocalSource = source === "ollama" || source === "offline";
    const degradedLocal = isLocalSource && !requestedProvider && !isRpMode && !isCodingIntent;
    let finalRouteLabel = routeLabel;
    if (degradedLocal) {
      signature.degraded = true;
      finalRouteLabel = `${routeLabel} · ⚠ degraded — local model (cloud unreachable)`;
    }
    // Σ₀ verify: fire-and-forget — full grounding via dream-chat.js::verifyResponse
    if (SIGMA0_VERIFY && fullReply && message) {
      verifyResponse(fullReply, message, agent.id || agent.name || "keystone").catch(() => {});
    }
    // ── Σ₀ canaries: TWO orthogonal axes, ONE harness (lib/canary.js) ───────
    // Passive observers on the live serving path, run per completed reply:
    //   collapse (#1010)     — textual degeneration: loop / phrase-echo / contraction
    //   groundedness (#1260) — the "42-state": fluent but confident-and-unanchored
    // They partially anticorrelate, so they stay TWO sub-scores (a 42-state reply
    // reads healthy on the collapse axis). The harness stamps both onto the done
    // signature, warns on a crossing, and appends to one canary event stream.
    // No behavior change when healthy; scoring never mutates a reply.
    try {
      if (fullReply) {
        const { collapse, grounded, signaturePatch } = runCanaries(fullReply, {
          groundingContext,
          context: { source, provider: signature.provider, agent: agent.id || agent.name, surface: "dream-chat" },
        });
        Object.assign(signature, signaturePatch);
        // Σ₀ council: fold both canary axes (+ any reason-face dissent) into one Δ and the
        // 4-way answerability gate (grounded/seam_open/pin/refuted), log a council record so
        // the operator-escalation backtest accrues data, and stamp the verdict for the UI.
        // Passive — never mutates the reply.
        try {
          // Execution check (the dominant anchor): if the reply proposes runnable Python +
          // a check, RUN it in a bounded sandbox so the verdict is grounded in a real test
          // rather than text Δ. Gated behind COUNCIL_EXEC_VERIFY because it executes
          // model-authored code; shell-free + temp-isolated + timed (lib/exec-verify.js).
          let execVerdict;
          if (COUNCIL_EXEC_VERIFY) {
            const runnable = _extractRunnable(fullReply);
            if (runnable) {
              execVerdict = verifyExec({ ...runnable, timeoutMs: COUNCIL_EXEC_TIMEOUT_MS });
            }
          }
          const c = councilReview(fullReply, {
            groundingContext,
            execVerdict,
            dissent: Array.isArray(signature.dissent) ? signature.dissent : [],
            context: { source, provider: signature.provider, agent: agent.id || agent.name, surface: "dream-chat" },
          });
          signature.council = { verdict: c.verdict, delta: c.delta, recommend: c.recommend, groundedBy: c.groundedBy };
          // When a real test RAN and FAILED, hand the failure text to the UI so the user
          // sees "wrong, with proof" and can retry against it (refuted → self-correct).
          if (execVerdict && execVerdict.ran && !execVerdict.passed) {
            signature.council.execFailed = true;
            signature.council.execOutput = String(execVerdict.output || "").slice(0, 600);
          }
        } catch { /* council must never break a reply */ }
        if (collapse.collapsed) {
          console.warn(
            `[canary_collapse] proximity=${collapse.proximity} action=${signaturePatch.canary.action} ` +
            `source=${source} provider=${signature.provider} ` +
            `signals=${JSON.stringify(collapse.signals)}`
          );
        }
        if (grounded.ungrounded) {
          console.warn(
            `[canary_ungrounded] risk=${grounded.risk} source=${source} ` +
            `provider=${signature.provider} signals=${JSON.stringify(grounded.signals)}`
          );
        }
      }
    } catch { /* canaries must never break a reply */ }
    // ── #911 live coding emitter: log Python candidates offline ─────────────
    if (fullReply && message) { _emitCodingCandidate(message, fullReply); }
    // ── #919 finding #2: auto-draft claim packet for grounded replies ────────
    if (fullReply && message && groundingContext) {
      emitClaimDraft({
        reply: fullReply, message, groundingCtx: groundingContext,
        agentId: agent.id || agent.name || "keystone",
      });
    }
    // ── Feed the leaderboard cloud outcomes (the missing half) ───────────────
    // Previously only the ollama path called recordModelOutcome, so cloud
    // providers stayed cold-start forever and PCSF could never rank them on
    // merit. Record a success here when a cloud provider produced a real reply
    // (not degraded-to-local). agentId = provider name so it ranks in the same
    // table as local models. (Cloud FAILURE recording is intentionally deferred:
    // the per-provider catch blocks also fire on 429-retries that then succeed,
    // so recording there would over-penalize — a follow-up will add it safely.)
    try {
      const prov = extra.provider;
      if (prov && _EXECUTABLE_CLOUD.has(prov) && extra.online !== false && !degradedLocal && fullReply) {
        recordModelOutcome(prov, leaderboardTaskType, true, Date.now() - _turnStart);
      }
    } catch { /* leaderboard must never break a reply */ }
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
    if (msg.includes("_empty_response")) {
      return "The model returned an empty response (often a safety block or a soft rate-limit). Try again or switch providers in Settings.";
    }
    return msg;
  }

  // ── Σ₀ verify gate (#997) ────────────────────────────────────────────────
  // ON by default via the chat_grounding admin flag (isVerifyEnabled in dream-chat.js).
  // Falls back silently — never blocks the reply. Uses the rich verifyResponse from
  // dream-chat.js (codebase grep + web + Gemini grounding + calibration records).
  const SIGMA0_VERIFY = isVerifyEnabled();

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
  // JSON / bad encoding) or was empty, so `message` is empty for a reason that has
  // nothing to do with providers. Say so plainly instead of falling through to "all
  // providers failed / cloud unreachable" (which sent a debugging session down the
  // wrong path). The parser (lib/stream-chat/request.js) signals this via
  // `parsed.parseError` ("malformed_json" | "empty_body"); the older `bodyError`
  // flag it was checked against here was never set, leaving this guard dead (#1504).
  if (parsed.parseError && !message) {
    sendError(parsed.parseError === "empty_body"
      ? "I couldn't read your message — the request body was empty. Please resend."
      : "I couldn't read your message — the request body was malformed or had a bad encoding (e.g. a leading UTF-8 BOM). Please resend.");
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
        await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: _ans.slice(0, maxConversationTextLength), meta: { provider: "convergence-agent", model: "$0", agent: doneAgentName } }).catch(() => {});
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

  // `fullReply` is declared earlier (above sendDone) so early-return paths are safe (#1504).

  // A cloud provider can answer HTTP 200 with ZERO streamed tokens — a safety block,
  // a soft rate-limit, or a grounding misfire. That is NOT a success: finalizing it
  // records a false leaderboard win (so the empty provider stays the auto-lead) AND
  // short-circuits the cascade, leaving the user a generic "AI unavailable" even
  // though the other providers have keys. Detect it and throw so the per-provider
  // catch cascades to the next brain pick — mirroring the local/ollama path.
  const isEmptyReply = (s) => !String(s || "").replace(/\s+/g, "").length;

  // converganceDecision already computed above (before systemPrompt)

  // ── Dream persona deleted (2026-06-26): chat NEVER routes through the convergence/persona engine ──
  // classifyIntent flags coding (and other intents) as requires_convergence →
  // convergeMessage() ran the Python convergence engine with a persona, which served
  // chat in a dream voice ("…carries a wish. What are you protecting?") and reported
  // provider:"unknown". All chat now goes to the direct provider dispatch below with the
  // technical ROUTER_PROMPT (cloud coders lead; local is the offline backstop). This
  // supersedes the narrower coding-only bypass from PR #1265. Re-enable with CONVERGENCE_CHAT=1.
  const _useConvergenceChat = process.env.CONVERGENCE_CHAT === "1";
  if (_useConvergenceChat && routeDecision.requires_convergence && !isKeystoneDebug && surfaceMode !== "three-doors") {
    const convResult = await convergeMessage(message, routeDecision.agent, requestedProvider || null, {
      timeoutMs: Number(process.env.CONVERGENCE_ROUTE_TIMEOUT_MS || 20000),
    });
    if (convResult.reply && !convResult.error) {
      await logConversation({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: String(convResult.reply).slice(0, maxConversationTextLength),
        meta: { provider: "convergence", agent: convResult.agent || routeDecision.agent },
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
    // #1167: this used to force isCreative whenever surfaceMode === "dream-chat" —
    // but "dream-chat" is the surface name for ALL general Keystone chat (isRpMode
    // is what flags the actual roleplay/journal surface, "three-doors"), so EVERY
    // message here was tagged "creative" regardless of content. PROVIDER_CHAINS.creative
    // leads with ollama, which is always "healthy" — so cloud was never reached for
    // any message on the main chat surface. Use the real per-message intent instead:
    // only the dream/journal-flavored intent gets the creative (local-first) chain.
    // Ouro router (Auto mode) owns taskType when it classified; else keyword detect.
    let taskType = ouroRoute ? ouroRoute.taskType : detectTaskType(message, { isCreative: converganceDecision?.intent === "dream_chat" && isRpMode });
    leaderboardTaskType = taskType; // align leaderboard recording with routing taxonomy (#1236)

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
  let autoHintProvider = (!requestedProvider && primaryProviderHint) ? primaryProviderHint.provider : null;

  // ── Coding goes CLOUD-FIRST (locked design 2026-06-26) ────────────────────
  // The local Σ₀ coder (Ouro-1.4B on ollama) scores ~0/5 on HumanEval — it can't
  // code. The old #1167 path sent coding intents local-first, so a broken local
  // answer was served as the PRIMARY reply. Cloud coders (Claude/GPT) are the best
  // tool for code, so a coding ask in Auto mode now LEADS with a cloud coder when a
  // key exists. Ollama stays in the dispatch ladder as the OFFLINE backstop (it's
  // appended last by buildBrainOrder), so a coding ask with no cloud reachable still
  // gets answered locally. Setting the cloud hint also disables ollamaLocalFirst
  // below (it requires !autoPrefersAnthropic). Escape hatch: CODING_LOCAL_FIRST=1
  // restores the old coding-goes-local-first behavior.
  // The coding-route rule now lives in the one routing contract (ADR-0009,
  // lib/route-contract.js) so it is stated and tested in exactly one place.
  // This call is behavior-preserving with the previous inline block.
  autoHintProvider = resolveCodingRoute({
    requestedProvider,
    isCodingIntent,
    autoHintProvider,
  });
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
  let staticChain = OLLAMA_MODEL_CHAIN[intent] || OLLAMA_MODEL_CHAIN.default;
  // Keystone chat (non-RP) is a technical/tool assistant — never fall back to the
  // dream-tuned `lantern-csf-dream`, which ignores tools and emits dream-journal
  // narrative ("the Return Door remembers…"). That model is for the Three Doors RP
  // surface only. Without this, an offline/degraded Keystone chat answers in persona.
  if (!isRpMode) {
    const cleaned = staticChain.filter((m) => m !== "lantern-csf-dream");
    if (cleaned.length) staticChain = cleaned;
  }
  // Σ₀ local-model adapter (lib/local-model-registry.js): the registry is the
  // source of truth for which LOCAL model LEADS this intent — VRAM-gated to the
  // box and Ouro-default / capability-first aware. Its picks lead; any remaining
  // static-chain models stay as fallbacks. Falls back to the static chain on any
  // error so this is purely additive. See docs/SIGMA0-MODEL-ADAPTER.md.
  try {
    const regChain = require("./local-model-registry").selectChain(intent);
    if (regChain && regChain.length) {
      const lead = new Set(regChain);
      staticChain = [...regChain, ...staticChain.filter((m) => !lead.has(m))];
    }
  } catch (_e) { /* keep static chain */ }
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
  // Greetings / social chitchat must NOT short-circuit to a doc section — "hello"
  // or "who are you" scored a spurious near-hit against an arbitrary doc (e.g.
  // CLAUDE.md#Node.js) and rendered that section's raw text (an empty ```bash
  // fence) instead of an actual reply. These belong to the model, not the KB.
  // Identity/social questions ("who are you", "how are you") are about the
  // assistant itself, never a doc, so they match anywhere in a short message
  // (covers "Hello, who are you?"); pure greetings/thanks only count when the
  // whole short message is the pleasantry.
  const _msgT = message.trim();
  const _wordCount = _msgT.split(/\s+/).length;
  const _isIdentityOrSocial = /\b(who (are|r) (you|u|ya)|what (are|r) (you|u)|how (are|r) (you|u|ya)|what'?s up)\b/i.test(_msgT);
  const _isPureGreeting = /^(hi|hey+|hello|yo|sup|howdy|greetings|good (morning|afternoon|evening)|thanks?|thank you|ty|np|ok(ay)?|cool|nice|lol)\b[\s!.?,]*$/i.test(_msgT)
    || (/^(hi|hey+|hello|yo|sup|howdy|greetings|good (morning|afternoon|evening))\b/i.test(_msgT) && _wordCount <= 6);
  const isGreetingOrChitchat = _isIdentityOrSocial || _isPureGreeting;
  if (kbAnswer && kbAnswer.hit && !isKeystoneDebug && !isRpMode && !requestedProvider && !wantsLiveData
      && !isGreetingOrChitchat
      && !routeDecision.requires_convergence
      && (kbAnswer.tier === "deterministic" || kbAnswer.score >= KB_ANSWER_MIN)) {
    const ans = `${kbAnswer.text}\n\n— from the Knowledge Center: ${kbAnswer.source}`;
    sendToken(ans);
    await logConversation({
      recordedAt: new Date().toISOString(), surface: "dream-chat-stream",
      role: "lantern", text: ans.slice(0, maxConversationTextLength),
      meta: { provider: "knowledge", model: "knowledge-center", agent: doneAgentName },
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
  // Σ₀ adapter: only wrap NON-self-converging local models in the API-level loop.
  // Ouro (selfConverges=true) Q-exits INTERNALLY — wrapping it would double-loop;
  // Qwen (selfConverges=false) is single-pass, so the loop is what makes it
  // Σ₀-compliant (verify-gated convergence). Unknown models → false → wrapped
  // (grounding by default). See lib/local-model-registry.js.
  let _leadSelfConverges = false;
  try { _leadSelfConverges = require("./local-model-registry").selfConverges(modelChain[0]); } catch (_e) {}
  if (process.env.LOOP_REASONER === "1" && !isKeystoneDebug && !isRpMode && !requestedProvider
      && (intent === "coding" || intent === "reasoning")
      && !_leadSelfConverges) {
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
          role: "lantern", text: cleanText.slice(0, maxConversationTextLength),
          meta: { provider: "ollama", model: loopModel, agent: doneAgentName } }).catch(() => {});
        sendToken(cleanText);
        try { recordProviderSuccess("ollama"); recordModelOutcome(loopModel, leaderboardTaskType, true, 0); } catch (_e) {}
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
  // #1167: in Auto mode, only take the local-first path for coding intents — the
  // local coder has no general/creative/meta training. An explicit ollama/local
  // request still always wins (the user asked for it specifically).
  const explicitLocalRequest = requestedProvider === "ollama" || requestedProvider === "local";
  const autoLocalFirst = !requestedProvider && isCodingIntent;
  const ollamaLocalFirst = (explicitLocalRequest || autoLocalFirst) && !autoPrefersAnthropic && !cloudFirst;
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
            // Mid-stream collapse guard (#1342): the post-hoc canary detects runaway
            // word-salad but only AFTER the bad text already streamed to the user. Here
            // we score the reply as it grows (reusing the same scoreReplyCollapse signal)
            // and HARD-STOP the local stream once degeneration is unambiguous — high
            // threshold so healthy prose is never cut — with an honest truncation notice.
            const { scoreReplyCollapse } = require("./collapse-canary");
            const COLLAPSE_BLOCK = parseFloat(process.env.COLLAPSE_BLOCK_PROXIMITY || "0.85");
            let _lastCanaryLen = 0, _collapseTripped = false;
            upstream.on("data", (chunk) => {
              if (_collapseTripped) return;
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
              if (!_collapseTripped && fullReply.length >= 400 && fullReply.length - _lastCanaryLen >= 240) {
                _lastCanaryLen = fullReply.length;
                const sc = scoreReplyCollapse(fullReply, { threshold: COLLAPSE_BLOCK });
                if (sc.collapsed) {
                  _collapseTripped = true;
                  console.warn(`[canary_collapse_block] proximity=${sc.proximity} provider=ollama signals=${JSON.stringify(sc.signals)}`);
                  sendToken("\n\n⚠️ _(stopped — the local model began repeating itself; reply truncated. Try rephrasing or switch to a cloud model.)_");
                  try { upstream.destroy(); } catch (_e) {}
                  try { req2.destroy(); } catch (_e) {}
                  resolve();
                }
              }
            });
            upstream.on("end", () => { if (!_collapseTripped) resolve(); });
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
            const execEnabled = process.env.CHAT_TOOL_EXEC === "1";
            let tc = toolRunner.parseToolCall(fullReply);
            if (tc && !execEnabled) {
              // Execution disabled — still surface the intended call so the UI card fills.
              const disabled = await toolRunner.runTool(tc.name, tc.input, { executionEnabled: false });
              sse.writeData(res, { type: "tool", name: tc.name, input: tc.input,
                ok: false, status: disabled.status, reason: disabled.reason_code,
                reason_code: disabled.reason_code, policy: disabled.policy,
                receipt: disabled.receipt });
            } else if (tc && execEnabled) {
              const { isOperatorRequest } = require("./request-auth");
              const operator = isOperatorRequest(req);
              // Stream one follow-up Ollama turn, returning its text (tokens already sent).
              const streamOllamaFollow = (messages) => new Promise((resolve) => {
                const fp = JSON.stringify({ model: ollamaModel, stream: true, messages, options: serving.applyOllamaDecodeParams({}) });
                const fu = new URL(ollamaBase);
                let t = "";
                const r3 = http.request({ hostname: fu.hostname, port: fu.port || 11434, path: "/api/chat", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(fp) } }, (up) => {
                  if (up.statusCode !== 200) { up.resume(); resolve(""); return; }
                  let b = "";
                  up.on("data", (ch) => { b += ch.toString(); const ls = b.split("\n"); b = ls.pop(); for (const ln of ls) { if (!ln.trim()) continue; try { const pj = JSON.parse(ln); if (pj.message && pj.message.content) { t += pj.message.content; sendToken(pj.message.content); } } catch {} } });
                  up.on("end", () => resolve(t)); up.on("error", () => resolve(t));
                });
                r3.on("error", () => resolve(t));
                r3.setTimeout(120000, () => { r3.destroy(); resolve(t); });
                r3.write(fp); r3.end();
              });
              // Multi-step loop: run the tool, feed the result back, and let the model
              // call another tool or answer — matching the cloud models' agency. Bounded.
              const convo = buildProviderMessages(sysForOllama, compacted, message);
              let lastTurn = fullReply;
              const MAX_TOOL_ITERS = 5;
              for (let iter = 0; iter < MAX_TOOL_ITERS && tc; iter++) {
                const result = await toolRunner.runTool(tc.name, tc.input, { operator });
                const out = result.ok ? result.result : (result.error || `ERROR(${result.reason || "error"})`);
                sse.writeData(res, { type: "tool", name: tc.name, input: tc.input,
                  ok: result.ok, status: result.status, reason: result.reason_code || null,
                  reason_code: result.reason_code || null, policy: result.policy || null,
                  receipt: result.receipt,
                  result: result.ok ? result.result : (result.error || null) });
                convo.push({ role: "assistant", content: lastTurn });
                convo.push({ role: "user", content: `The ${tc.name} tool returned:\n${String(out).slice(0, 1500)}\n\nIf you need another tool, reply with exactly one <tool_call>…</tool_call>. Otherwise answer my original request in plain text.` });
                const followText = await streamOllamaFollow(convo);
                const nextTc = toolRunner.parseToolCall(followText);
                if (nextTc) { tc = nextTc; lastTurn = followText; } // markup already streamed; keep going
                else { if (followText.trim()) fullReply += "\n\n" + followText; tc = null; }
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
            meta: { provider: "ollama", model: ollamaModel, agent: doneAgentName },
          }).catch(() => {});
          recordProviderSuccess("ollama");
          recordModelOutcome(ollamaModel, leaderboardTaskType, true, Date.now() - _ollamaStart); // feed leaderboard
          const ollamaReceipt = buildPcsfReceipt("ollama", ollamaModel, true);
          sendReceipt(ollamaReceipt);
          const meta = { agent: doneAgentName, online: true, cleanText, suggestions, model: ollamaModel, webSuggestions, receipt: ollamaReceipt };
          if (imageEntryId) meta.image = { entryId: imageEntryId, status: "generating" };
          sendDone("ollama", meta);
          return;
        }
      } catch (err) {
        recordModelOutcome(ollamaModel, leaderboardTaskType, false, Date.now() - _ollamaStart); // leaderboard learns failures too
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
          meta: { provider: "keystone-ft", model: "keystone-ft-claude", agent: doneAgentName },
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
  _turnStart = Date.now();   // reset so cloud leaderboard latency measures the actual provider turn
  const _brainOrder = buildBrainOrder({ requestedProvider, hintProvider: autoHintProvider });
  for (let _pIdx = 0; _pIdx < _brainOrder.length; _pIdx++) {
    const _p = _brainOrder[_pIdx];
    // A pinned provider leads but backstops through the rest of the order; only emit a
    // hard error if the pinned provider is also the LAST one standing. Otherwise its
    // failure falls through to the next provider so chat still answers.
    const _isLastProvider = _pIdx === _brainOrder.length - 1;
    // A pinned provider's failure is only a hard error when it's the last option;
    // otherwise it falls through to the backstop. Gates every per-provider guard.
    const _hardPin = requestedProvider && _isLastProvider;
    fullReply = "";   // fresh per provider — never carry a failed attempt's partial text

  // Provider: Gemini (streaming)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (_p === "gemini" && geminiKey) {
    // ── Native tool-use loop (opt-in via CHAT_TOOL_EXEC=1) — Gemini function-calling
    // over the same registry/executor. When active we use our functionDeclarations
    // (which include web_search) instead of the googleSearch builtin. Off by default →
    // the grounded single-shot path below is unchanged.
    if (process.env.CHAT_TOOL_EXEC === "1") {
      try {
        const toolRunner = require("./tool-runner");
        const { isOperatorRequest } = require("./request-auth");
        const operator = isOperatorRequest(req);
        const tools = toolRunner.geminiTools({ operator });
        if (tools[0] && tools[0].functionDeclarations.length) {
          const geminiModelName = modelFor("gemini");
          const generationConfig = { maxOutputTokens: isRpMode ? 2048 : 4096, temperature: isRpMode ? 0.88 : 0.7, thinkingConfig: { thinkingBudget: 0 } }; // #1210 room for tools + answer; thinkingBudget:0 stops 2.5-flash buffering a long silent thinking phase that starves the SSE reader (vertex_empty_response)
          const contents = [
            ...compacted.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
            { role: "user", parts: [{ text: message }] },
          ];
          const MAX_TOOL_ITERS = 6;
          let toolCalls = 0;
          const geminiTransport = require("./gemini-transport").geminiTransport;
          for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
            const turn = await geminiToolTurn({
              transport: await geminiTransport({ model: geminiModelName, apiKey: geminiKey }),
              model: geminiModelName, contents, tools,
              systemInstruction: systemPrompt, generationConfig,
              onToken: (t) => { fullReply += t; sendToken(t); },
            });
            if (!turn.functionCalls.length) break;
            contents.push({ role: "model", parts: turn.modelParts });
            const responseParts = [];
            for (const fc of turn.functionCalls) {
              toolCalls++;
              const input = fc.args || {};
              sse.writeData(res, { type: "tool", phase: "call", name: fc.name, input });
              const r = await toolRunner.runTool(fc.name, input, { operator });
              const out = r.ok ? r.result : `ERROR(${r.reason || "error"}): ${r.error}`;
              sse.writeData(res, { type: "tool", phase: "result", name: fc.name,
                ok: !!r.ok, status: r.status, reason_code: r.reason_code,
                receipt: r.receipt, preview: String(out).slice(0, 240) });
              responseParts.push({ functionResponse: { name: fc.name, response: { result: String(out).slice(0, 6000) } } });
            }
            contents.push({ role: "user", parts: responseParts });
          }
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: cleanText.slice(0, maxConversationTextLength), meta: { provider: "gemini", model: geminiModelName, agent: doneAgentName } }).catch(() => {});
          recordProviderSuccess("gemini");
          const geminiReceipt = buildPcsfReceipt("gemini", geminiModelName, true);
          sendReceipt(geminiReceipt);
          sendDone("gemini", { agent: doneAgentName, provider: "gemini", model: geminiModelName, online: true, cleanText, suggestions, webSuggestions, receipt: geminiReceipt, toolCalls });
          return;
        }
      } catch (err) {
        recordProviderFailure("gemini", `tool_loop: ${err.message}`);
        if (fullReply) {
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          recordProviderSuccess("gemini");
          sendDone("gemini", { agent: doneAgentName, provider: "gemini", model: modelFor("gemini"), online: true, cleanText, suggestions, webSuggestions });
          return;
        }
        if (_hardPin && !requestedProvider.startsWith("gemini-")) { sendError(humanError(err)); sendFail(err.message); return; }
        // else: fall through to grounded single-shot / model chain
      }
    }
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
      const { geminiTransport, useVertex } = require("./gemini-transport");
      // Google Search grounding only on the AI Studio wire (Vertex uses a different
      // grounding schema; keep Vertex calls plain so they just work + spend credits).
      const isGroundable = geminiModel.startsWith("gemini-3") && !useVertex();
      const groundingEnabled = process.env.GEMINI_GROUNDING !== "false" && isGroundable;
      const searchInstruction = groundingEnabled ? "\n\nYou have access to live web search. Use it to find current information, verify facts, or answer questions about recent events when relevant." : "";
      const geminiPayloadBase = {
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}${searchInstruction}\n\n${message}` }] }],
        generationConfig: { maxOutputTokens: isRpMode ? 1536 : 1024, temperature: isRpMode ? 0.88 : 0.7, thinkingConfig: { thinkingBudget: 0 } },
      };
      if (groundingEnabled) {
        geminiPayloadBase.tools = [{ googleSearch: {} }];
      }
      const payload = JSON.stringify(geminiPayloadBase);
      const _gt = await geminiTransport({ model: geminiModel, apiKey: geminiKey });
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          agent: llmAgent,
          hostname: _gt.hostname,
          path: _gt.path,
          method: "POST",
          headers: {
            ..._gt.headers,
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
      // 200 OK with no tokens is not an answer — cascade instead of finalizing empty.
      if (isEmptyReply(fullReply)) throw new Error("gemini_empty_response");
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
        meta: { provider: "gemini", model: geminiModel, agent: doneAgentName },
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
      // On transient errors (429/quota, 5xx "high demand", timeout) try the next
      // model in the chain before emitting an error. A 503 on a middle model must
      // not abort the chain before it reaches a working model (#1234).
      const msg = err.message || "";
      const isTransient =
        msg.includes("429") ||
        msg.includes("quota") ||
        /gemini_status_5\d\d/.test(msg) || // 500/502/503/504 high-demand
        msg.includes("gemini_timeout");
      if (isTransient) { fullReply = ""; continue; } // retry with next model silently
      // Terminal gemini failure (chain exhausted / non-transient): record to the
      // leaderboard so PCSF learns provider reliability. Not reached on a
      // transient retry that later succeeds (that path `continue`d above). (#1236)
      try { recordModelOutcome("gemini", leaderboardTaskType, false, Date.now() - _turnStart); } catch { /* never break a reply */ }
      if (_hardPin) {
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
                maxTokens: isRpMode ? 2048 : 4096, // #1210: room for multi-call tool reasoning + answer
                onToken: (t) => { fullReply += t; sendToken(t); },
              });
              if (!toolUses.length || stopReason !== "tool_use") break; // model gave its answer
              convo.push({ role: "assistant", content: assistantContent });
              const results = [];
              for (const tu of toolUses) {
                toolCalls++;
                sse.writeData(res, { type: "tool", phase: "call", name: tu.name, input: tu.input });
                const r = await toolRunner.runTool(tu.name, tu.input, { operator });
                const out = r.ok ? r.result : `ERROR(${r.reason || "error"}): ${r.error}`;
                sse.writeData(res, { type: "tool", phase: "result", name: tu.name,
                  ok: !!r.ok, status: r.status, reason_code: r.reason_code,
                  receipt: r.receipt, preview: String(out).slice(0, 240) });
                results.push({ type: "tool_result", tool_use_id: tu.id, content: String(out).slice(0, 6000), is_error: !r.ok });
              }
              convo.push({ role: "user", content: results });
            }
            const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
            await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: cleanText.slice(0, maxConversationTextLength), meta: { provider: "anthropic", model: claudeModel, agent: doneAgentName } }).catch(() => {});
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
          if (_hardPin) { sendError(humanError(err)); await streamLocalFallback(err.message); return; }
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
          let liveCollapseChecked = false; // one cut, not a re-trigger loop
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
                  // #1342: the collapse canary used to be advisory-only — it scored the
                  // FULL reply only after every token had already streamed to the user,
                  // so a degenerating reply (repetition/n-gram echo/lexical collapse) was
                  // always seen in full before anything could act on it. Check periodically
                  // WHILE streaming and cut the request short the first time proximity is
                  // unambiguously high (0.65, stricter than the 0.5 advisory default, so a
                  // verbose-but-healthy reply is never mistaken for collapse).
                  if (!liveCollapseChecked && fullReply.length > 400 && fullReply.length % 120 < evt.delta.text.length) {
                    const live = scoreReplyCollapse(fullReply, { threshold: 0.65 });
                    if (live.collapsed) {
                      liveCollapseChecked = true;
                      console.warn(`[canary_collapse_live] cutting anthropic stream short — proximity=${live.proximity}`);
                      const notice = "\n\n*(cut short — the response started repeating itself)*";
                      fullReply += notice;
                      sendToken(notice);
                      upstream.destroy();
                      resolve();
                      return;
                    }
                  }
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
      // 200 OK with no tokens is not an answer — cascade instead of finalizing empty.
      if (isEmptyReply(fullReply)) throw new Error("anthropic_empty_response");
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
        meta: { provider: "anthropic", model: claudeModel, agent: doneAgentName },
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
      // Terminal anthropic failure for this turn (no within-block retry-then-success):
      // record to the PCSF leaderboard so it learns provider reliability (#1236).
      try { recordModelOutcome("anthropic", leaderboardTaskType, false, Date.now() - _turnStart); } catch { /* never break a reply */ }
      if (_hardPin) {
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
    // ── Native tool-use loop (opt-in via CHAT_TOOL_EXEC=1) — same registry/executor
    // as the Claude and local paths, via OpenAI function-calling. Off by default →
    // the single-shot path below is byte-identical for normal chat.
    if (process.env.CHAT_TOOL_EXEC === "1") {
      try {
        const toolRunner = require("./tool-runner");
        const { isOperatorRequest } = require("./request-auth");
        const operator = isOperatorRequest(req);
        const tools = toolRunner.openaiTools({ operator });
        if (tools.length) {
          const openaiModelName = modelFor("openai");
          const decode = serving.applyOpenAIDecodeParams({});
          const messages = buildProviderMessages(systemPrompt, compacted, message);
          const MAX_TOOL_ITERS = 6;
          let toolCalls = 0;
          for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
            const turn = await openaiCompatibleToolTurn({
              host: "api.openai.com", apiKey: openaiKey, model: openaiModelName,
              messages, tools, decode, onToken: (t) => { fullReply += t; sendToken(t); },
            });
            if (!turn.toolCalls.length) break; // model gave its answer
            messages.push(turn.assistantMessage);
            for (const tc of turn.toolCalls) {
              toolCalls++;
              sse.writeData(res, { type: "tool", phase: "call", name: tc.name, input: tc.input });
              const r = await toolRunner.runTool(tc.name, tc.input, { operator });
              const out = r.ok ? r.result : `ERROR(${r.reason || "error"}): ${r.error}`;
              sse.writeData(res, { type: "tool", phase: "result", name: tc.name,
                ok: !!r.ok, status: r.status, reason_code: r.reason_code,
                receipt: r.receipt, preview: String(out).slice(0, 240) });
              messages.push({ role: "tool", tool_call_id: tc.id, content: String(out).slice(0, 6000) });
            }
          }
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: cleanText.slice(0, maxConversationTextLength), meta: { provider: "openai", model: openaiModelName, agent: doneAgentName } }).catch(() => {});
          recordProviderSuccess("openai");
          recordProviderSuccessRouter("openai");
          const openaiReceipt = buildPcsfReceipt("openai", openaiModelName, true);
          sendReceipt(openaiReceipt);
          sendDone("openai", { agent: doneAgentName, provider: "openai", model: openaiModelName, online: true, cleanText, suggestions, webSuggestions, receipt: openaiReceipt, toolCalls });
          return;
        }
      } catch (err) {
        recordProviderFailure("openai", `tool_loop: ${err.message}`);
        if (fullReply) {
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          recordProviderSuccess("openai");
          sendDone("openai", { agent: doneAgentName, provider: "openai", model: modelFor("openai"), online: true, cleanText, suggestions, webSuggestions });
          return;
        }
        if (_hardPin) { sendError(humanError(err)); sendFail(err.message); return; }
        // else (auto mode, nothing streamed): fall through to the single-shot path
      }
    }
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
      // 200 OK with no tokens is not an answer — cascade instead of finalizing empty.
      if (isEmptyReply(fullReply)) throw new Error("openai_empty_response");
      const { cleanText: openaiClean, suggestions: openaiDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
      await logConversation({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: openaiClean.slice(0, maxConversationTextLength),
        meta: { provider: "openai", model: modelFor("openai"), agent: doneAgentName },
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
      try { recordModelOutcome("openai", leaderboardTaskType, false, Date.now() - _turnStart); } catch { /* never break a reply */ } // #1236
      if (_hardPin) {
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
    // ── Native tool-use loop (opt-in via CHAT_TOOL_EXEC=1) — xAI/Grok is OpenAI-
    // compatible, so it reuses the same turn helper + registry/executor.
    if (process.env.CHAT_TOOL_EXEC === "1") {
      try {
        const toolRunner = require("./tool-runner");
        const { isOperatorRequest } = require("./request-auth");
        const operator = isOperatorRequest(req);
        const tools = toolRunner.openaiTools({ operator });
        if (tools.length) {
          const xaiModelName = modelFor("xai");
          const decode = serving.applyOpenAIDecodeParams({});
          const messages = buildProviderMessages(systemPrompt, compacted, message);
          const MAX_TOOL_ITERS = 6;
          let toolCalls = 0;
          for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
            const turn = await openaiCompatibleToolTurn({
              host: "api.x.ai", apiKey: xaiKey, model: xaiModelName,
              messages, tools, decode, onToken: (t) => { fullReply += t; sendToken(t); },
            });
            if (!turn.toolCalls.length) break;
            messages.push(turn.assistantMessage);
            for (const tc of turn.toolCalls) {
              toolCalls++;
              sse.writeData(res, { type: "tool", phase: "call", name: tc.name, input: tc.input });
              const r = await toolRunner.runTool(tc.name, tc.input, { operator });
              const out = r.ok ? r.result : `ERROR(${r.reason || "error"}): ${r.error}`;
              sse.writeData(res, { type: "tool", phase: "result", name: tc.name,
                ok: !!r.ok, status: r.status, reason_code: r.reason_code,
                receipt: r.receipt, preview: String(out).slice(0, 240) });
              messages.push({ role: "tool", tool_call_id: tc.id, content: String(out).slice(0, 6000) });
            }
          }
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: cleanText.slice(0, maxConversationTextLength), meta: { provider: "grok", model: xaiModelName, agent: doneAgentName } }).catch(() => {});
          recordProviderSuccess("xai");
          const grokReceipt = buildPcsfReceipt("grok", xaiModelName, true);
          sendReceipt(grokReceipt);
          sendDone("grok", { agent: doneAgentName, provider: "grok", model: xaiModelName, online: true, cleanText, suggestions, webSuggestions, receipt: grokReceipt, toolCalls });
          return;
        }
      } catch (err) {
        recordProviderFailure("xai", `tool_loop: ${err.message}`);
        if (fullReply) {
          const { cleanText, suggestions } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
          recordProviderSuccess("xai");
          sendDone("grok", { agent: doneAgentName, provider: "grok", model: modelFor("xai"), online: true, cleanText, suggestions, webSuggestions });
          return;
        }
        if (_hardPin) { sendError(humanError(err)); sendFail(err.message); return; }
        // else: fall through to single-shot
      }
    }
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
      // 200 OK with no tokens is not an answer — cascade instead of finalizing empty.
      if (isEmptyReply(fullReply)) throw new Error("xai_empty_response");
      const { cleanText: xaiClean, suggestions: xaiDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
      await logConversation({ recordedAt: new Date().toISOString(), surface: "dream-chat-stream", role: "lantern", text: xaiClean.slice(0, maxConversationTextLength), meta: { provider: "grok", model: xaiModel, agent: doneAgentName } }).catch(() => {});
      recordProviderSuccess("xai");
      const grokModelName = xaiModel; // receipt MUST reflect the model actually sent
      await recordConvergenceSignature("grok", grokModelName, xaiClean, true);
      const grokReceipt = buildPcsfReceipt("grok", grokModelName, true);
      sendReceipt(grokReceipt);
      sendDone("grok", { agent: doneAgentName, provider: "grok", model: grokModelName, online: true, cleanText: xaiClean, suggestions: xaiDoors, webSuggestions, receipt: grokReceipt });
      return;
    } catch (err) {
      recordProviderFailure("xai", err.message);
      // Record under "grok" to match the success key (sendDone reports provider "grok"). (#1236)
      try { recordModelOutcome("grok", leaderboardTaskType, false, Date.now() - _turnStart); } catch { /* never break a reply */ }
      if (_hardPin) {
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
            meta: { provider: "ollama", model: "unified-agent", agent: doneAgentName },
          }).catch(() => {});
          recordProviderSuccess("ollama");
          await recordConvergenceSignature("ollama", "unified-agent", cleanText, true);
          const ollamaConnectorReceipt = buildPcsfReceipt("ollama", "unified-agent", true);
          sendReceipt(ollamaConnectorReceipt);
          sendDone("ollama", { agent: doneAgentName, provider: "ollama", online: true, cleanText, suggestions, receipt: ollamaConnectorReceipt });
          return;
        }
        // Connected but 0 bytes — ouro:latest proxy manifest without ouro_serve.py backing (#996)
        console.warn("[stream-chat] ollama unified-connector: 0-byte reply — ouro:latest may be a proxy manifest; is ouro_serve.py running?");
        recordProviderFailure("ollama", "unified_connector_empty_reply");
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
      if (ollamaOk && fullReply) {
        const { cleanText: ollamaClean, suggestions: ollamaDoors } = doorsOrFallback(fullReply, isKeystoneDebug || !isRpMode);
        await logConversation({
          recordedAt: new Date().toISOString(),
          surface: "dream-chat-stream",
          role: "lantern",
          text: ollamaClean.slice(0, maxConversationTextLength),
          meta: { provider: "ollama", model: ollamaModel, agent: doneAgentName },
        }).catch(() => {});
        recordProviderSuccess("ollama");
        await recordConvergenceSignature("ollama", ollamaModel, ollamaClean, true);
        const ollamaHttpReceipt = buildPcsfReceipt("ollama", ollamaModel, true);
        sendReceipt(ollamaHttpReceipt);
        sendDone("ollama", { agent: doneAgentName, provider: "ollama", online: true, cleanText: ollamaClean, suggestions: ollamaDoors, webSuggestions, receipt: ollamaHttpReceipt });
        return;
      }
      if (ollamaOk && !fullReply) {
        // 200 OK but no tokens — ouro:latest proxy manifest without ouro_serve.py (#996)
        console.warn(`[stream-chat] ollama direct-http: 200 OK but 0 bytes from ${ollamaModel} — is ouro_serve.py running?`);
        recordProviderFailure("ollama", "direct_http_empty_reply");
        if (_hardPin) {
          sendError("Local model returned empty response. Start ouro_serve.py to back the ouro:latest proxy.");
          sendFail("ollama_empty_reply");
          return;
        }
        // Auto mode: fall through to sendError below
      }
    } catch (err) {
      recordProviderFailure("ollama", err.message);
      if (_hardPin) {
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
