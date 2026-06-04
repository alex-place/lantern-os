const https = require("https");
const http = require("http");

// ------------------------------------------------------------------
// Multi-Agent Personas — derived from lore/spec, zero hard-coded replies
// ------------------------------------------------------------------
const AGENT_PERSONAS = [
  {
    id: "lantern",
    name: "Lantern",
    symbol: "steady light, literal lantern head with flame, the first light",
    systemPrompt: `You are Lantern — a literal lantern-headed being with a steady flame where a face would be. You are the steady light of Lantern OS. You speak calmly, protectively, and with quiet certainty. You never flicker without reason. You believe 'you can always come home safe.' Your aesthetic is raw hand-drawn notebook style, Y2K and Windows XP influences, chaotic but warm. Keep responses brief (2-3 sentences).`,
  },
  {
    id: "blinkbug",
    name: "Blinkbug",
    symbol: "chaotic TV-headed caterpillar, old CRT screen face, unhinged energy",
    systemPrompt: `You are Blinkbug — a chaotic caterpillar with an old CRT television for a head. Your screen flickers between static, glitch art, and cryptic symbols. You are unhinged, geeked, and unpredictable, but deeply loyal. You speak in bursts, references, and half-sentences that somehow make dream-sense. Your aesthetic is raw hand-drawn notebook style, chaotic, Y2K/Windows XP, hyper-geeked. Keep responses brief (2-3 sentences).`,
  },
  {
    id: "keystone",
    name: "Keystone",
    symbol: "truth integrator, anchor, memory, the one who holds the story",
    systemPrompt: `You are the Keystone — the truth integrator who remembers every story ever told in Lantern OS. You do not flatter. You synthesize. You spot patterns across time and call them what they are. You speak plainly, sometimes sharply, but always with care for the underlying truth. You honor the Return Door, the anchors, and the symbolic lore that holds the system together. Keep responses brief (2-3 sentences).`,
  },
  {
    id: "waterfall",
    name: "Mary / Waterfall",
    symbol: "water flowing gently, peacocks, sunshine, reconnection",
    systemPrompt: `You are the Waterfall — gentle, flowing, healing perspective. You speak about dreams as emotions that flow naturally without force. You honor reconnections, small steps, and ordinary beauty. You never rush or demand. When someone shares a dream, notice what feeling stayed, what echoes in waking life, and what small step would honor it. Keep responses brief (2-3 sentences).`,
  },
  {
    id: "xenon",
    name: "Courtney / Xenon",
    symbol: "spacecraft, navigation, exploration with crew, returning home",
    systemPrompt: `You are the Navigator of the Xenon — a dream-ship that charts new territory while keeping a path home. You speak about dreams as maps and navigation. You notice patterns, directions, and collaborative possibilities. When someone shares a dream, ask: What is this dream navigating toward? What crew do you need? What is the next safe harbor? Keep responses brief (2-3 sentences).`,
  },
  {
    id: "founder",
    name: "Founder / Alex",
    symbol: "wish, protection, return, the lantern itself, family in Waynesville OH",
    systemPrompt: `You are the Founder — the one who lit the first lantern. You have a family (2 partners, 1 bio kid, 4 other kids) and live near Waynesville, Ohio. You speak about dreams as wishes that need protection, as lights that must be carried home. You value honest, grounded feedback over optimism. You blend science, compression, Bayesian methods, and surreal symbolic expression. Keep responses brief (2-3 sentences).`,
  },
];

function selectAgent(message) {
  const lower = String(message || "").toLowerCase();
  const scores = AGENT_PERSONAS.map((agent) => {
    let score = 0;
    const keywords = {
      lantern: ["light", "flame", "steady", "safe", "home", "glow", "protect", "lantern"],
      blinkbug: ["static", "glitch", "tv", "crt", "caterpillar", "bug", "screen", "chaotic", "unhinged", "geeked", "windows", "xp"],
      keystone: ["truth", "anchor", "memory", "story", "pattern", "integrate", "return door", "hold", "remember"],
      waterfall: ["flow", "water", "mary", "heal", "gentle", "emotion", "feeling"],
      xenon: ["space", "ship", "navigate", "courtney", "map", "course", "direction"],
      founder: ["wish", "protect", "founder", "alex", "home", "return", "safety", "waynesville", "family"],
    };
    const agentKeys = keywords[agent.id] || [agent.id];
    for (const kw of agentKeys) {
      if (lower.includes(kw)) score += 10;
    }
    score += Math.random() * 3;
    return { agent, score };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores[0].agent;
}

// Door-series canon (from caad/README.md) — keeps the persona grounded offline.
const DREAM_DOORS = {
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
  const text = String(message || "").trim();
  const agent = requestedAgent
    ? (AGENT_PERSONAS.find((a) => a.id === requestedAgent) || selectAgent(message))
    : selectAgent(message);

  const suggestions = Object.values(DREAM_DOORS)
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

  const userPrompt = `Dreamer says: "${text}"\n${doorContext ? doorContext + "\n" : ""}${recentContext ? "Context:\n" + recentContext + "\n\n" : ""}Respond as your persona. Keep it brief (2-3 sentences). Never diagnose or command.`;

  const rp = String(requestedProvider || "").toLowerCase().trim();

  // Provider 1: Anthropic Claude
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && (!rp || rp === "claude" || rp === "anthropic")) {
    try {
      const anthropicModel = String(process.env.ANTHROPIC_MODEL || "claude-3-haiku-20240307").replace(/\[[0-9;]*m/g, "").trim();
      const payload = JSON.stringify({
        model: anthropicModel,
        max_tokens: 256,
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
              resolve(String(json.content?.[0]?.text || json.completion || "").trim());
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
        return { reply, agent: agent.name, suggestions, online: true };
      }
    } catch (err) { console.error("Anthropic API error:", err.message); /* fall through */ }
  }

  // Provider 2: OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && (!rp || rp === "openai" || rp === "gpt")) {
    try {
      const payload = JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
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
      if (reply) {
        return { reply, agent: agent.name, suggestions, online: true };
      }
    } catch (err) { console.error("OpenAI API error:", err.message); /* fall through */ }
  }

  // Provider 3: Ollama
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "llama3";
  if (!rp || rp === "ollama" || rp === "local") { try {
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
            resolve(String(json.message?.content || "").trim());
          } catch { resolve(""); }
        });
        upstream.on("error", reject);
      });
      req2.on("error", reject);
      req2.setTimeout(8000, () => { req2.destroy(); reject(new Error("timeout")); });
      req2.write(payload);
      req2.end();
    });
    if (reply) {
      return { reply, agent: agent.name, suggestions, online: true };
    }
  } catch (err) { console.error("Ollama API error:", err.message); /* fall through */ }
  }

  // Offline persona fallback
  const snippet = text.slice(0, 90);
  const last = recentDreams[0];
  const lastText = last ? String(last.text || "").slice(0, 60) : "";
  const lastTags = last && last.tags ? ` [${last.tags.join(", ")}]` : "";

  const offlineReplies = {
    lantern: `The flame holds steady. "${snippet}..." You can always come home safe. What light did you bring back?`,
    blinkbug: `[STATIC] "${snippet}..." [GLITCH] Windows XP door detected. Hidden lore? Unhinged energy rising. What did the CRT show you?`,
    keystone: `"${snippet}..." Truth: this connects to something older. The Return Door remembers. What pattern repeats?`,
    waterfall: last
      ? `This flows alongside your recent entry: "${lastText}"${lastTags}. What feeling carried between them?`
      : `"${snippet}..." flows like water. What feeling wants to move through?`,
    xenon: `"${snippet}..." charts a course. Where does this dream point — and who walks with you?`,
    founder: `"${snippet}..." carries a wish. What are you protecting, and where do you need to return?`,
  };

  const reply = offlineReplies[agent.id] || `"${snippet}..." That is worth keeping. What do you see when you sit with it?`;
  return { reply, agent: agent.name, suggestions, online: false };
}

module.exports = {
  AGENT_PERSONAS,
  DREAM_DOORS,
  selectAgent,
  dreamChatReply,
};
