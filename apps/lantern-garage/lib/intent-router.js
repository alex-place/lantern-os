/**
 * Intent Router - Capability Registry & Intent Classification
 *
 * Exports:
 * - CAPABILITY_REGISTRY: Array of extensible agent capability declarations.
 * - classifyIntent(message): #342 route decision object.
 * - getAgent(agentId): registry lookup.
 *
 * MVP routing is deterministic and rule-based. The contract is intentionally
 * shaped so embedding/model classification can replace the scoring later.
 */

const CAPABILITY_REGISTRY = [
  {
    id: "keystone",
    name: "Keystone (Code Coordinator)",
    intents: ["code"],
    triggers: [
      /\b(code|repo|github|pull request|pr|branch|commit|push|merge|deploy)\b/i,
      /\b(implement|integrate|wire|refactor|bug|fix|debug|error|trace|review|lint|test)\b/i,
      /\b(router|route|endpoint|api|server|client|ui|handler)\b/i,
      /\b(function|class|var|const|return|throw|import|export)\b/i,
      /\b(crash|fail|broke|broken|issue|problem|exception)\b/i,
      /\b(clean up|rewrite|optimize|simplify|performance)\b/i,
    ],
    surface: "convergence",
    converges: true,
    blocking: true,
    input_contract: { message: "string", context: "object" },
    output_contract: { plan: "string", files: "string[]", changes: "string", verification: "string" },
    description: "Code coordination, repository work, GitHub issues, refactoring, and bug fixes.",
  },
  {
    id: "founder",
    name: "Founder",
    intents: ["strategy"],
    triggers: [
      /\b(strategy|plan|planning|roadmap|vision|design|architecture)\b/i,
      /\b(decision|choice|trade.?off|priority|prioritize|scope)\b/i,
      /\b(build|product|feature|launch|ship|release)\b/i,
      /\b(business|market|growth|opportunity|direction)\b/i,
    ],
    surface: "convergence",
    converges: true,
    blocking: true,
    input_contract: { message: "string", context: "object" },
    output_contract: { recommendation: "string", risks: "string[]", next_action: "string" },
    description: "Strategic planning, architecture, high-level decisions, and roadmap work.",
  },
  {
    id: "csf",
    name: "CSF & Memory",
    intents: ["memory_export"],
    triggers: [
      /\b(memory export|export my dreams|archive my dreams|csf export)\b/i,
      /\b(export|import|archive|backup|extract|dump|serialize)\b/i,
      /\b(csf|convergence.?fitted|binary|format|compression)\b/i,
      /\b(data|dataset|corpus|knowledge|base)\b/i,
    ],
    surface: "csf_export",
    converges: false,
    blocking: false,
    input_contract: { message: "string", export_scope: "object" },
    output_contract: { artifact: "string", status: "string" },
    description: "Memory export, CSF archival, data convergence, and symbolic compression.",
  },
  {
    id: "trading",
    name: "Trading & Markets",
    intents: ["trading"],
    triggers: [
      /\b(trading?|trade|invest|portfolio|position|stock)\b/i,
      /\b(market|price|ticker|symbol|buy|sell|order)\b/i,
      /\b(alpaca|broker|brokerage|account|balance)\b/i,
      /\b(profit|loss|gain|return|pnl|risk)\b/i,
    ],
    surface: "convergence",
    converges: true,
    blocking: true,
    input_contract: { message: "string", portfolio_context: "object" },
    output_contract: { summary: "string", actions: "string[]", risk: "string" },
    description: "Trading, markets, positions, Alpaca integration, and portfolio management.",
  },
].map((cap) => ({
  ...cap,
  // Backward-compatible aliases for older call sites/tests.
  canConverge: cap.converges,
  isBlocking: cap.blocking,
}));

function classifyIntent(message) {
  if (!message || typeof message !== "string") {
    return fallbackRoute("Empty or invalid message");
  }

  const scores = CAPABILITY_REGISTRY.map((cap) => {
    let matchCount = 0;
    for (const trigger of cap.triggers) {
      if (trigger.test(message)) matchCount++;
    }
    return {
      capabilityId: cap.id,
      capabilityName: cap.name,
      intent: cap.intents[0] || "unknown",
      surface: cap.surface,
      confidence: matchCount > 0 ? Math.min(matchCount / cap.triggers.length, 1) : 0,
      matchCount,
      canConverge: cap.canConverge,
      isBlocking: cap.isBlocking,
    };
  });

  scores.sort((a, b) => b.confidence - a.confidence || b.matchCount - a.matchCount);
  const topMatch = scores[0];
  if (!topMatch || topMatch.confidence === 0) {
    return fallbackRoute("No explicit intent triggers matched; defaulting to Keystone reflection");
  }

  return {
    intent: topMatch.intent,
    agent: topMatch.capabilityId,
    surface: topMatch.surface,
    confidence: topMatch.confidence,
    reason: `Matched ${topMatch.matchCount} trigger(s) from ${topMatch.capabilityName} capability`,
    requires_convergence: topMatch.canConverge,
  };
}

function fallbackRoute(reason) {
  // Dream persona deleted (2026-06-26): an unmatched message answers as the plain
  // technical Keystone agent on the direct provider path — never a poetic/dream voice.
  return {
    intent: "general",
    agent: "keystone",
    surface: "chat",
    confidence: 0,
    reason,
    requires_convergence: false,
  };
}

function getAgent(agentId) {
  return CAPABILITY_REGISTRY.find((a) => a.id === agentId) || null;
}

module.exports = {
  CAPABILITY_REGISTRY,
  classifyIntent,
  getAgent,
};
