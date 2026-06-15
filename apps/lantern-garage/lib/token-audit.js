const fs = require("fs");
const path = require("path");

// ── Token Audit System ───────────────────────────────────────────────
// Comprehensive logging of all LLM API calls with token counts and costs

const TOKEN_COSTS = {
  anthropic: {
    "claude-opus-4-8": { input: 0.015, output: 0.075 },
    "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
    "claude-haiku-4-5": { input: 0.0008, output: 0.004 },
  },
  openai: {
    "gpt-4-turbo": { input: 0.01, output: 0.03 },
    "gpt-4": { input: 0.03, output: 0.06 },
    "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  },
  gemini: {
    "gemini-1.5-pro": { input: 0.0075, output: 0.03 },
    "gemini-1.5-flash": { input: 0.00075, output: 0.003 },
  },
};

class TokenAudit {
  constructor(auditLogPath) {
    this.auditLogPath = auditLogPath || path.join(process.env.REPO_ROOT || __dirname, "..", "..", "data", "convergence-audit.jsonl");
    this.stats = {
      totalRequests: 0,
      totalTokens: 0,
      totalCost: 0,
      byProvider: {},
      byModel: {},
      byAgent: {},
    };
    this.loadStats();
  }

  loadStats() {
    try {
      if (fs.existsSync(this.auditLogPath)) {
        const lines = fs.readFileSync(this.auditLogPath, "utf8").trim().split("\n").filter(l => l);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "token_usage") {
              this.stats.totalRequests++;
              this.stats.totalTokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
              this.stats.totalCost += entry.cost || 0;

              if (entry.provider) {
                if (!this.stats.byProvider[entry.provider]) {
                  this.stats.byProvider[entry.provider] = { requests: 0, tokens: 0, cost: 0 };
                }
                this.stats.byProvider[entry.provider].requests++;
                this.stats.byProvider[entry.provider].tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
                this.stats.byProvider[entry.provider].cost += entry.cost || 0;
              }

              if (entry.model) {
                if (!this.stats.byModel[entry.model]) {
                  this.stats.byModel[entry.model] = { requests: 0, tokens: 0, cost: 0 };
                }
                this.stats.byModel[entry.model].requests++;
                this.stats.byModel[entry.model].tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
                this.stats.byModel[entry.model].cost += entry.cost || 0;
              }

              if (entry.agent) {
                if (!this.stats.byAgent[entry.agent]) {
                  this.stats.byAgent[entry.agent] = { requests: 0, tokens: 0, cost: 0 };
                }
                this.stats.byAgent[entry.agent].requests++;
                this.stats.byAgent[entry.agent].tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
                this.stats.byAgent[entry.agent].cost += entry.cost || 0;
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch (err) {
      console.warn("[token-audit] Failed to load stats:", err.message);
    }
  }

  calculateCost(provider, model, inputTokens, outputTokens) {
    const costs = TOKEN_COSTS[provider]?.[model];
    if (!costs) return 0;
    return (inputTokens * costs.input) + (outputTokens * costs.output);
  }

  logTokenUsage(auditEntry) {
    const {
      provider,
      model,
      agent,
      inputTokens = 0,
      outputTokens = 0,
      userMessage = "",
      responseLength = 0,
      status = "success",
      error = null,
      duration = 0,
    } = auditEntry;

    const cost = this.calculateCost(provider, model, inputTokens, outputTokens);
    const timestamp = new Date().toISOString();

    const entry = {
      type: "token_usage",
      timestamp,
      provider,
      model,
      agent,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost,
      status,
      error,
      duration,
      userMessageLength: userMessage.length,
      responseLength,
    };

    // Append to audit log
    try {
      const dir = path.dirname(this.auditLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.auditLogPath, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("[token-audit] Failed to write audit log:", err.message);
    }

    // Update in-memory stats
    this.stats.totalRequests++;
    this.stats.totalTokens += inputTokens + outputTokens;
    this.stats.totalCost += cost;

    if (!this.stats.byProvider[provider]) {
      this.stats.byProvider[provider] = { requests: 0, tokens: 0, cost: 0 };
    }
    this.stats.byProvider[provider].requests++;
    this.stats.byProvider[provider].tokens += inputTokens + outputTokens;
    this.stats.byProvider[provider].cost += cost;

    if (!this.stats.byModel[model]) {
      this.stats.byModel[model] = { requests: 0, tokens: 0, cost: 0 };
    }
    this.stats.byModel[model].requests++;
    this.stats.byModel[model].tokens += inputTokens + outputTokens;
    this.stats.byModel[model].cost += cost;

    if (agent && !this.stats.byAgent[agent]) {
      this.stats.byAgent[agent] = { requests: 0, tokens: 0, cost: 0 };
    }
    if (agent) {
      this.stats.byAgent[agent].requests++;
      this.stats.byAgent[agent].tokens += inputTokens + outputTokens;
      this.stats.byAgent[agent].cost += cost;
    }

    return entry;
  }

  getStats() {
    return {
      ...this.stats,
      generatedAt: new Date().toISOString(),
      auditLogPath: this.auditLogPath,
    };
  }

  getProviderStats(provider) {
    return this.stats.byProvider[provider] || { requests: 0, tokens: 0, cost: 0 };
  }

  getModelStats(model) {
    return this.stats.byModel[model] || { requests: 0, tokens: 0, cost: 0 };
  }

  getAgentStats(agent) {
    return this.stats.byAgent[agent] || { requests: 0, tokens: 0, cost: 0 };
  }

  getDailySummary() {
    try {
      if (!fs.existsSync(this.auditLogPath)) return [];

      const lines = fs.readFileSync(this.auditLogPath, "utf8").trim().split("\n").filter(l => l);
      const byDate = {};

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "token_usage") {
            const date = entry.timestamp.split("T")[0];
            if (!byDate[date]) {
              byDate[date] = { date, requests: 0, tokens: 0, cost: 0 };
            }
            byDate[date].requests++;
            byDate[date].tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
            byDate[date].cost += entry.cost || 0;
          }
        } catch { /* skip */ }
      }

      return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    } catch (err) {
      console.warn("[token-audit] Failed to get daily summary:", err.message);
      return [];
    }
  }
}

// Export singleton instance
module.exports = {
  TokenAudit,
  createTokenAudit: (path) => new TokenAudit(path),
};
