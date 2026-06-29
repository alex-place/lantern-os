/**
 * Swarm Orchestrator — Lantern OS
 *
 * Expands the provider chain from sequential fallback to a swarm architecture
 * where different models handle different jobs, with optional parallel execution
 * and consensus voting.
 *
 * Job types:
 *   chat       — general dream chat, reflection, persona dialogue
 *   coding     — code generation, editing, review
 *   reasoning  — complex analysis, math, logic puzzles
 *   vision     — image description, multimodal understanding
 *   summarize  — compression, extraction, tl;dr
 *   creative   — story generation, symbol invention, poetic language
 *   research   — factual lookup, search-augmented answers
 *
 * Swarm modes:
 *   single     — best provider for job (default)
 *   parallel   — run top-N providers simultaneously, return first successful
 *   consensus  — run top-N, vote on best response via cheap judge model
 *   council    — each provider gets a role (creative, critic, synthesizer)
 */

const https = require("https");
const http = require("http");
const { getProviderState, recordProviderSuccess, recordProviderFailure } = require("./provider-cache");

// ── Expanded provider roster ──
const PROVIDER_CONFIG = {
  gemini: {
    envKey: "GEMINI_API_KEY",
    altEnvKey: "GOOGLE_API_KEY",
    baseUrl: "generativelanguage.googleapis.com",
    path: (model) => `/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    defaultModel: "gemini-2.5-flash",
    modelChain: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
    strengths: ["chat", "summarize", "vision"],
    costTier: "free/cheap",
    streamFormat: "gemini",
  },
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "api.anthropic.com",
    path: () => "/v1/messages",
    // Sonnet 4.6 (not Haiku) is the swarm/convergence anchor: parallel/consensus/
    // council all pick this per-provider default, and Anthropic is the synthesizer
    // (index 2) for reasoning-job councils — strong reasoning at near-Haiku latency.
    // modelChain order is preserved: pickModel() returns [1] (sonnet) for coding jobs.
    defaultModel: "claude-sonnet-4-6",
    modelChain: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"],
    strengths: ["chat", "coding", "creative", "reasoning"],
    costTier: "medium",
    streamFormat: "anthropic",
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    baseUrl: "api.openai.com",
    path: () => "/v1/chat/completions",
    defaultModel: "gpt-4.1-mini",
    modelChain: ["gpt-4.1-mini", "gpt-4.1", "o3-mini"],
    strengths: ["chat", "coding", "reasoning", "vision"],
    costTier: "medium",
    streamFormat: "openai",
  },
  xai: {
    envKey: "XAI_API_KEY",
    baseUrl: "api.x.ai",
    path: () => "/v1/chat/completions",
    defaultModel: "grok-4.3",
    modelChain: ["grok-4.3", "grok-4.1-fast", "grok-4"],
    strengths: ["chat", "vision", "creative"],
    costTier: "medium",
    streamFormat: "openai",
  },
  ollama: {
    envKey: "OLLAMA_BASE_URL",
    baseUrl: null, // constructed from env
    path: () => "/api/chat",
    defaultModel: "llama3.2",
    modelChain: ["llama3.2", "qwen3:30b", "phi4:14b", "deepseek-r1"],
    strengths: ["chat", "coding", "reasoning", "summarize"],
    costTier: "local",
    streamFormat: "ollama",
  },
  // ── New providers ──
  mistral: {
    envKey: "MISTRAL_API_KEY",
    baseUrl: "api.mistral.ai",
    path: () => "/v1/chat/completions",
    defaultModel: "mistral-large-latest",
    modelChain: ["mistral-large-latest", "codestral-latest", "mistral-medium"],
    strengths: ["chat", "coding", "creative"],
    costTier: "cheap",
    streamFormat: "openai",
  },
  cohere: {
    envKey: "COHERE_API_KEY",
    baseUrl: "api.cohere.com",
    path: () => "/v2/chat",
    defaultModel: "command-r-plus",
    modelChain: ["command-r-plus", "command-r", "command-light"],
    strengths: ["chat", "summarize", "research"],
    costTier: "cheap",
    streamFormat: "cohere",
  },
  perplexity: {
    envKey: "PERPLEXITY_API_KEY",
    baseUrl: "api.perplexity.ai",
    path: () => "/chat/completions",
    defaultModel: "sonar-pro",
    modelChain: ["sonar-pro", "sonar", "sonar-reasoning"],
    strengths: ["research", "chat", "summarize"],
    costTier: "cheap",
    streamFormat: "openai",
  },
  deepseek: {
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "api.deepseek.com",
    path: () => "/chat/completions",
    defaultModel: "deepseek-chat",
    modelChain: ["deepseek-chat", "deepseek-reasoner"],
    strengths: ["chat", "coding", "reasoning"],
    costTier: "cheap",
    streamFormat: "openai",
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "openrouter.ai",
    path: () => "/api/v1/chat/completions",
    defaultModel: "openai/gpt-4.1-mini",
    modelChain: ["openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5", "google/gemini-2.5-flash"],
    strengths: ["chat", "coding", "reasoning", "vision", "creative", "summarize", "research"],
    costTier: "medium",
    streamFormat: "openai",
  },
};

// ── Job → best provider mapping (primary + 2 alternates) ──
const JOB_ASSIGNMENTS = {
  chat:      ["gemini", "openai", "anthropic"], // anthropic last = council synthesizer (Sonnet)
  coding:    ["anthropic", "openai", "mistral"],
  reasoning: ["openai", "deepseek", "anthropic"],
  vision:    ["gemini", "xai", "openai"],
  summarize: ["gemini", "cohere", "openai"],
  creative:  ["anthropic", "xai", "mistral"],
  research:  ["perplexity", "openrouter", "cohere"],
};

// ── Council roles for council mode ──
const COUNCIL_ROLES = {
  creative:     { promptSuffix: "Be imaginative and poetic." },
  critic:       { promptSuffix: "Be concise and skeptical. Point out flaws." },
  synthesizer:  { promptSuffix: "Synthesize the best ideas into one clear answer." },
};

function getApiKey(config) {
  if (config.envKey === "OLLAMA_BASE_URL") {
    return process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  }
  return process.env[config.envKey] || (config.altEnvKey ? process.env[config.altEnvKey] : undefined);
}

function isProviderAvailable(providerId) {
  const config = PROVIDER_CONFIG[providerId];
  if (!config) return false;
  const key = getApiKey(config);
  return !!key;
}

function pickModel(providerId, job, requestedModel) {
  const config = PROVIDER_CONFIG[providerId];
  if (requestedModel) return requestedModel;
  // Job-specific model selection
  if (providerId === "anthropic" && job === "coding") return config.modelChain[1]; // sonnet
  if (providerId === "openai" && job === "reasoning") return config.modelChain[2]; // o3-mini
  if (providerId === "deepseek" && job === "reasoning") return config.modelChain[1]; // deepseek-reasoner
  if (providerId === "mistral" && job === "coding") return config.modelChain[1]; // codestral
  if (providerId === "perplexity") return config.modelChain[0]; // sonar-pro
  return config.defaultModel;
}

// ── Build payload per provider format ──
function buildPayload(providerId, model, systemPrompt, message, history) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (history?.length) {
    for (const h of history) {
      messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.text });
    }
  }
  messages.push({ role: "user", content: message });

  if (providerId === "gemini") {
    return JSON.stringify({
      contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + message }] }],
      generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
    });
  }
  if (providerId === "anthropic") {
    const userMessages = messages.filter(m => m.role !== "system");
    return JSON.stringify({
      model, max_tokens: 1024, stream: true,
      system: systemPrompt,
      messages: userMessages.map(m => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
    });
  }
  return JSON.stringify({ model, stream: true, messages });
}

function buildHeaders(providerId, apiKey, payload) {
  const base = { "Content-Type": "application/json" };
  if (providerId === "gemini") {
    return { ...base, "x-goog-api-key": apiKey, "Content-Length": Buffer.byteLength(payload) };
  }
  if (providerId === "cohere") {
    return { ...base, "Authorization": `Bearer ${apiKey}`, "Accept": "application/json", "Content-Length": Buffer.byteLength(payload) };
  }
  if (providerId === "openrouter") {
    return { ...base, "Authorization": `Bearer ${apiKey}`, "HTTP-Referer": "https://lantern-os.local", "X-Title": "Lantern OS", "Content-Length": Buffer.byteLength(payload) };
  }
  return { ...base, "Authorization": `Bearer ${apiKey}`, "Content-Length": Buffer.byteLength(payload) };
}

// ── Parse SSE chunks per provider ──
function makeTokenExtractor(providerId) {
  return (line) => {
    const text = line.replace(/^data: /, "").trim();
    if (!text || text === "[DONE]") return null;
    try {
      const d = JSON.parse(text);
      if (providerId === "gemini") {
        return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }
      if (providerId === "anthropic") {
        return d.delta?.text || d.content_block?.text || "";
      }
      return d.choices?.[0]?.delta?.content || "";
    } catch {
      return null;
    }
  };
}

// ── Single provider call ──
function callProvider(providerId, model, systemPrompt, message, history) {
  return new Promise((resolve, reject) => {
    const config = PROVIDER_CONFIG[providerId];
    const apiKey = getApiKey(config);
    if (!apiKey) return reject(new Error(`${providerId}_no_key`));

    const payload = buildPayload(providerId, model, systemPrompt, message, history);
    const extract = makeTokenExtractor(providerId);
    const isOllama = providerId === "ollama";
    const hostname = isOllama ? new URL(apiKey).hostname : config.baseUrl;
    const port = isOllama ? (new URL(apiKey).port || 11434) : 443;
    const useHttps = !isOllama;

    const opts = {
      hostname, port, path: config.path(model),
      method: "POST",
      headers: buildHeaders(providerId, apiKey, payload),
    };

    const client = useHttps ? https : http;
    let full = "";
    const req = client.request(opts, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${providerId}_status_${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const token = extract(line);
          if (token) full += token;
        }
      });
      res.on("end", () => {
        recordProviderSuccess(providerId);
        resolve({ provider: providerId, model, text: full.trim() });
      });
      res.on("error", reject);
    });
    req.on("error", (e) => reject(new Error(`${providerId}_connect_${e.code || "error"}`)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`${providerId}_timeout`)); });
    req.write(payload);
    req.end();
  });
}

// ── Swarm orchestration ──

/**
 * Run a single job with the best available provider.
 */
async function swarmSingle(job, systemPrompt, message, history, requestedProvider, requestedModel) {
  const candidates = requestedProvider
    ? [requestedProvider]
    : (JOB_ASSIGNMENTS[job] || JOB_ASSIGNMENTS.chat);

  for (const pid of candidates) {
    if (!isProviderAvailable(pid)) continue;
    const model = pickModel(pid, job, requestedModel);
    try {
      const result = await callProvider(pid, model, systemPrompt, message, history);
      return result;
    } catch (err) {
      recordProviderFailure(pid, err.message);
      // Try next candidate
    }
  }
  throw new Error("all_providers_failed");
}

/**
 * Run top-N providers in parallel, return the first successful response.
 */
async function swarmParallel(job, systemPrompt, message, history, n = 3) {
  const candidates = (JOB_ASSIGNMENTS[job] || JOB_ASSIGNMENTS.chat)
    .filter(pid => isProviderAvailable(pid))
    .slice(0, n);

  if (candidates.length === 0) throw new Error("no_provider_configured");

  return Promise.race(
    candidates.map(pid =>
      callProvider(pid, pickModel(pid, job), systemPrompt, message, history)
        .catch(err => {
          recordProviderFailure(pid, err.message);
          return null;
        })
    )
  ).then(result => result || Promise.reject(new Error("all_providers_failed")));
}

/**
 * Run top-N providers, collect all responses, vote on best.
 * Cheap judge: use shortest successful response as heuristic,
 * or fallback to first successful.
 */
async function swarmConsensus(job, systemPrompt, message, history, n = 3) {
  const candidates = (JOB_ASSIGNMENTS[job] || JOB_ASSIGNMENTS.chat)
    .filter(pid => isProviderAvailable(pid))
    .slice(0, n);

  if (candidates.length === 0) throw new Error("no_provider_configured");

  const results = await Promise.allSettled(
    candidates.map(pid =>
      callProvider(pid, pickModel(pid, job), systemPrompt, message, history)
        .catch(err => { recordProviderFailure(pid, err.message); throw err; })
    )
  );

  const successes = results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  if (successes.length === 0) throw new Error("all_providers_failed");
  if (successes.length === 1) return successes[0];

  // Simple consensus: pick the median-length response (avoids both too-short and too-verbose)
  successes.sort((a, b) => a.text.length - b.text.length);
  const winner = successes[Math.floor(successes.length / 2)];
  winner.consensus = {
    votes: successes.length,
    providers: successes.map(s => s.provider),
    selected: "median_length",
  };
  return winner;
}

/**
 * Council mode: a real two-round debate, not a single blind pass.
 *
 *   Round 1 — each council member answers under a distinct LENS (perspective).
 *             Lenses are role-prompts, so a council still convenes even when only
 *             one provider is available (providers are assigned round-robin).
 *   Round 2 — a synthesizer provider READS every member's answer, then produces
 *             (a) one grounded answer and (b) an explicit DISSENT record of where
 *             the members disagreed. Dissent is preserved, not silently dropped.
 *
 * Returns { provider, model, text, council:{ members, dissent[], synthesizer } }.
 */
async function swarmCouncil(job, systemPrompt, message, history) {
  const available = (JOB_ASSIGNMENTS[job] || JOB_ASSIGNMENTS.chat)
    .filter(pid => isProviderAvailable(pid));

  if (available.length === 0) throw new Error("no_provider_configured");

  // Task-aware lenses: analytical jobs argue correctness/risk/alternative;
  // everything else uses the creative/critic pairing.
  const lenses = (job === "reasoning" || job === "coding")
    ? [
        { role: "correctness", suffix: "Focus on correctness and rigor. Reason step by step." },
        { role: "risk",        suffix: "Be skeptical. Surface flaws, edge cases, and failure modes." },
        { role: "alternative", suffix: "Propose a genuinely different approach the others may miss." },
      ]
    : [
        { role: "creative", suffix: COUNCIL_ROLES.creative.promptSuffix },
        { role: "critic",   suffix: COUNCIL_ROLES.critic.promptSuffix },
      ];

  // ── Round 1: members deliberate, each under its own lens ──
  // Distinct providers run in parallel; lenses sharing a provider run sequentially
  // so we don't fire concurrent same-key requests (which rate-limit / collide).
  const reusesProvider = available.length < lenses.length;
  const runMember = (lens, i) => {
    const pid = available[i % available.length];
    const rolePrompt = systemPrompt + "\n\n[Council role — " + lens.role + ": " + lens.suffix + "]";
    return callProvider(pid, pickModel(pid, job), rolePrompt, message, history)
      .then(r => ({ ...r, role: lens.role }))
      .catch(err => { recordProviderFailure(pid, err.message); return null; });
  };
  let members;
  if (reusesProvider) {
    members = [];
    for (let i = 0; i < lenses.length; i++) {
      const m = await runMember(lenses[i], i);
      if (m) members.push(m);
    }
  } else {
    members = (await Promise.all(lenses.map(runMember))).filter(Boolean);
  }
  if (members.length === 0) throw new Error("all_providers_failed");

  // Resilience: some "available" providers may have a key but be dead (quota/rate
  // limit). If that left lenses unfilled, re-run them on a provider that DID answer
  // so the council still convenes with multiple perspectives instead of collapsing
  // to one voice. Sequential to avoid concurrent same-key collisions.
  if (members.length < lenses.length) {
    const working = [...new Set(members.map(m => m.provider))];
    const filled = new Set(members.map(m => m.role));
    let w = 0;
    for (const lens of lenses) {
      if (filled.has(lens.role)) continue;
      const pid = working[w++ % working.length];
      const rolePrompt = systemPrompt + "\n\n[Council role — " + lens.role + ": " + lens.suffix + "]";
      try {
        const r = await callProvider(pid, pickModel(pid, job), rolePrompt, message, history);
        members.push({ ...r, role: lens.role });
      } catch (_e) { /* best-effort; council proceeds with what it has */ }
    }
  }

  // ── Round 2: synthesizer reads the whole council, then synthesizes + records dissent ──
  const synthPid = available[available.length - 1]; // job assignment puts the synthesizer last
  const memberDigest = members
    .map(m => `### Council member — ${m.role} (via ${m.provider})\n${m.text}`)
    .join("\n\n");
  const synthSystem = systemPrompt +
    "\n\n[You are the council SYNTHESIZER. Read every member answer below, then respond in this exact order: " +
    "(1) the single best, well-grounded answer; (2) keep any CONFIDENCE line the instructions above asked for, immediately after the answer; " +
    "(3) as the very last block, a section headed exactly 'DISSENT:' with one bullet per substantive disagreement " +
    "formatted 'role vs role — what they disagreed on'. If the members fully agree, write 'DISSENT: none'.]";
  const synthMessage = `Original question:\n${message}\n\nCouncil member answers:\n${memberDigest}`;

  let synth;
  try {
    synth = await callProvider(synthPid, pickModel(synthPid, job), synthSystem, synthMessage, []);
  } catch (_e) {
    // Synthesizer unreachable → fall back to the longest member answer (no dissent).
    members.sort((a, b) => b.text.length - a.text.length);
    synth = { provider: members[0].provider, model: members[0].model, text: members[0].text };
  }

  // Split the DISSENT section out so callers (UI + ConvergenceRecord) can surface it.
  let answer = String(synth.text);
  let dissent = [];
  const dm = answer.match(/\n*DISSENT:\s*([\s\S]*)$/i);
  if (dm) {
    answer = answer.slice(0, dm.index).trim();
    const body = dm[1].trim();
    if (body && !/^none[.!]?$/i.test(body)) {
      dissent = body.split("\n")
        .map(l => l.replace(/^[-*•\d.\)\s]+/, "").trim())
        .filter(Boolean);
    }
  }

  return {
    provider: synth.provider,
    model: synth.model,
    text: answer || String(synth.text),
    council: {
      members: members.map(m => ({ provider: m.provider, role: m.role, text: m.text })),
      dissent,
      synthesizer: `${synth.provider}/${synth.model}`,
    },
  };
}

/**
 * Main entry point.
 *
 * @param {Object} opts
 * @param {string} opts.job — job type (chat, coding, reasoning, vision, summarize, creative, research)
 * @param {string} opts.mode — swarm mode (single, parallel, consensus, council)
 * @param {string} opts.systemPrompt
 * @param {string} opts.message
 * @param {Array}  opts.history
 * @param {string} [opts.provider] — force a specific provider
 * @param {string} [opts.model] — force a specific model
 */
async function swarmOrchestrate(opts) {
  const { job = "chat", mode = "single", systemPrompt, message, history, provider, model } = opts;
  switch (mode) {
    case "parallel": return swarmParallel(job, systemPrompt, message, history);
    case "consensus": return swarmConsensus(job, systemPrompt, message, history);
    case "council": return swarmCouncil(job, systemPrompt, message, history);
    default: return swarmSingle(job, systemPrompt, message, history, provider, model);
  }
}

module.exports = {
  swarmOrchestrate,
  swarmSingle,
  swarmParallel,
  swarmConsensus,
  swarmCouncil,
  isProviderAvailable,
  PROVIDER_CONFIG,
  JOB_ASSIGNMENTS,
};
