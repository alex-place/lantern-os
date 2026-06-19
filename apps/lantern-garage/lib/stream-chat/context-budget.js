// Token-budgeted chat context assembly (REMEMBER stage — issue #772).
//
// THE PROBLEM THIS SOLVES
// The client only ever sends the last 6 turns (conversationHistory.slice(-6)) and
// the old server path just trimmed those to 6 × 1000 chars. Anything older was
// *silently dropped* — no summary, no budget, no signal. A long session lost its
// own beginning with no trace.
//
// THE FIX (this module is the pure core)
// Given the full set of prior turns, assemble a context that:
//   1. keeps the most recent turns VERBATIM until a token budget is filled, and
//   2. folds everything older into a rolling, deterministic summary that rides
//      in front of the verbatim turns.
// The budget is derived from the *active model's* context window (see
// contextWindowFor) minus the room reserved for the system prompt, the model's
// output, the current message, and a safety margin — capped so we never ship a
// novel of history on every turn even when the window is huge.
//
// Pure + synchronous + dependency-free on purpose: it is unit-tested in isolation
// (tests/test_context_budget.js) and the I/O + persistence live one layer up in
// session-summary-store.js. The summary is extractive (no LLM call) so it is
// cheap, deterministic, and testable; an abstractive LLM summariser can be
// swapped in behind the same boundary later without touching callers.

// ── Token estimation ────────────────────────────────────────────────────────
// ~4 chars/token is the standard rough heuristic across GPT/Claude tokenizers.
// We only need it to be monotonic and in the right ballpark for budgeting — an
// exact tokenizer would add a heavy dependency for no real gain here.
const CHARS_PER_TOKEN = 4;
const PER_MSG_OVERHEAD = 4; // role/formatting overhead charged per message

function estimateTokens(text) {
  const len = String(text == null ? "" : text).length;
  return Math.ceil(len / CHARS_PER_TOKEN);
}

// ── Model context windows ───────────────────────────────────────────────────
// Conservative windows per provider family. Cloud models are far larger than we
// would ever want to fill, so MAX_HISTORY_TOKENS (below) is the practical cap;
// the window is the hard ceiling we must never cross.
const CONTEXT_WINDOWS = {
  anthropic: 200000,
  openai: 128000,
  gemini: 1000000,
  xai: 131072,
  ollama: 8192,
  local: 8192,
};

const DEFAULT_LOCAL_WINDOW = 8192; // dream-chat is local-first in Auto mode

// Resolve the window to budget against. In Auto mode (no explicit provider) the
// turn runs LOCAL-FIRST, so we budget for the small local window — that is the
// safe floor: a context that fits the local model also fits every cloud model in
// the fallback cascade. An explicit cloud provider gets its larger window.
// (Auto mode therefore sends ~CHAT_LOCAL_CONTEXT_TOKENS of history even if the
// cascade ends up on a cloud model — still far more than the old fixed 6-turn
// slice, and capped by CHAT_MAX_HISTORY_TOKENS regardless. To force a larger
// cloud-sized budget, set CHAT_CONTEXT_BUDGET_TOKENS or request a provider.)
function contextWindowFor({ requestedProvider } = {}) {
  const hard = parseInt(process.env.CHAT_CONTEXT_BUDGET_TOKENS, 10);
  if (hard > 0) return hard;
  const localDefault = parseInt(process.env.CHAT_LOCAL_CONTEXT_TOKENS, 10) || DEFAULT_LOCAL_WINDOW;
  if (!requestedProvider) return localDefault;
  const p = String(requestedProvider).toLowerCase();
  if (p === "ollama" || p === "local") return localDefault;
  if (p.startsWith("gemini") || p === "google") return CONTEXT_WINDOWS.gemini;
  if (p.startsWith("claude") || p === "anthropic" || p === "keystone-ft") return CONTEXT_WINDOWS.anthropic;
  if (p === "openai" || p === "gpt") return CONTEXT_WINDOWS.openai;
  if (p === "grok" || p === "xai") return CONTEXT_WINDOWS.xai;
  return localDefault;
}

// ── Budget tunables (all env-overridable) ───────────────────────────────────
function maxHistoryTokens() {
  return parseInt(process.env.CHAT_MAX_HISTORY_TOKENS, 10) || 6000;
}
function systemReserveTokens() {
  // Headroom for the system prompt + grounding blocks. An estimate on purpose:
  // the exact system string isn't known when context is assembled, and providers
  // truncate gracefully if it runs slightly long.
  return parseInt(process.env.CHAT_SYSTEM_RESERVE_TOKENS, 10) || 2048;
}
const MARGIN_TOKENS = 512;
const MIN_HISTORY_BUDGET = 256;
const MIN_VERBATIM_BUDGET = 256;

const SUMMARY_HEADER = "[Earlier in this conversation — condensed so the start isn't lost]";
// Neutral, minimal acknowledgement. Kept deliberately bland so a weak local model
// can't narrate it back as a substantive prior claim ("as I established earlier…").
const SUMMARY_ACK = "Understood.";

// Merge consecutive same-role turns into one (joining text). Conversation logs are
// NOT guaranteed to alternate — a turn whose provider reply failed to persist
// leaves an orphan user turn, so the log can hold user→user runs that a provider
// (Anthropic especially) would reject. A turn that absorbs real content loses its
// _synthetic marker (it is no longer pure scaffolding).
function coalesceRoles(seq) {
  const out = [];
  for (const m of seq) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.text = `${last.text}\n${m.text}`;
      if (!m._synthetic && last._synthetic) delete last._synthetic;
    } else {
      out.push(m._synthetic ? { role: m.role, text: m.text, _synthetic: true } : { role: m.role, text: m.text });
    }
  }
  return out;
}

// Normalise a turn sequence into one safe to hand to any provider. The real
// current user message is appended AFTER this downstream, so the result must:
//   - be empty, or
//   - start with a user turn (Anthropic requires the first message to be user),
//   - strictly alternate user/assistant, and
//   - end on an assistant turn (so the appended user message doesn't collide).
// We coalesce → append a synthetic assistant ack if it would trail on user
// (lossless: keeps the summary / last user turn) → drop any leading orphan
// assistant turn.
function normalizeProviderSequence(seq) {
  let out = coalesceRoles(seq);
  if (out.length && out[out.length - 1].role === "user") {
    out.push({ role: "assistant", text: SUMMARY_ACK, _synthetic: true });
  }
  while (out.length && out[0].role === "assistant") out.shift();
  return out;
}

// ── Rolling summary (deterministic / extractive) ────────────────────────────
function condenseTurn(turn, maxWords = 24) {
  const label = turn && turn.role === "assistant" ? "Keystone" : "You";
  const words = String((turn && turn.text) || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const clipped = words.slice(0, maxWords).join(" ");
  const ell = words.length > maxWords ? "…" : "";
  return clipped ? `- ${label}: ${clipped}${ell}` : `- ${label}: (no text)`;
}

// Build a rolling summary from overflow turns (oldest → newest). Keeps the most
// RECENT condensed lines within maxTokens and drops the oldest, noting how many
// were elided so the model knows the trail goes back further.
function buildRollingSummary(turns, { maxTokens = 1500, maxWordsPerTurn = 24 } = {}) {
  const lines = (turns || []).map((t) => condenseTurn(t, maxWordsPerTurn));
  if (lines.length === 0) return "";
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(lines[i]) + 1;
    if (used + cost > maxTokens && kept.length) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  const dropped = lines.length - kept.length;
  const head = dropped > 0 ? `(…${dropped} earlier turn${dropped === 1 ? "" : "s"} elided)\n` : "";
  return head + kept.join("\n");
}

// ── Budgeted assembly ───────────────────────────────────────────────────────
// turns: full prior turns, oldest → newest, each { role: 'user'|'assistant', text }.
// Returns a drop-in `compacted` array plus the summary and accounting `meta`.
function assembleBudgetedContext({
  turns,
  currentMessage = "",
  contextWindow = DEFAULT_LOCAL_WINDOW,
  maxOutputTokens = 1024,
  systemReserve = systemReserveTokens(),
  marginTokens = MARGIN_TOKENS,
  maxHistory = maxHistoryTokens(),
  summaryMaxTokens = null,
} = {}) {
  const clean = (turns || []).filter(
    (t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.length > 0
  );

  const window = Math.max(1024, contextWindow | 0);
  const windowBudget = window - maxOutputTokens - systemReserve - estimateTokens(currentMessage) - marginTokens;
  const historyBudget = Math.max(MIN_HISTORY_BUDGET, Math.min(maxHistory, windowBudget));
  const summaryReserve = Math.max(
    0,
    Math.min(historyBudget, summaryMaxTokens == null ? Math.floor(historyBudget * 0.35) : summaryMaxTokens)
  );
  const verbatimBudget = Math.max(MIN_VERBATIM_BUDGET, historyBudget - summaryReserve);

  // Walk newest → oldest, keeping turns verbatim until the budget is spent.
  // The single most recent turn is always kept (even if it alone is over budget).
  const kept = [];
  let used = 0;
  let cut = clean.length; // clean[0..cut-1] overflow into the summary; clean[cut..] kept verbatim
  for (let i = clean.length - 1; i >= 0; i--) {
    const cost = estimateTokens(clean[i].text) + PER_MSG_OVERHEAD;
    if (used + cost > verbatimBudget && kept.length) {
      cut = i + 1;
      break;
    }
    kept.unshift(clean[i]);
    used += cost;
    cut = i;
  }

  const overflow = clean.slice(0, cut);
  const summary = overflow.length ? buildRollingSummary(overflow, { maxTokens: summaryReserve }) : "";

  // Raw sequence: the rolling summary (a user-role context block) then the
  // verbatim turns. normalizeProviderSequence() then makes it provider-safe —
  // starts user, strictly alternates, ends assistant — coalescing the summary
  // into a following user turn when adjacent (so no fake ack is needed there).
  const raw = [];
  if (summary) raw.push({ role: "user", text: `${SUMMARY_HEADER}\n${summary}` });
  for (const k of kept) raw.push({ role: k.role, text: k.text });
  const compacted = normalizeProviderSequence(raw);

  return {
    compacted,
    summary,
    meta: {
      window,
      historyBudget,
      verbatimBudget,
      summaryReserve,
      keptVerbatim: kept.length,
      summarized: overflow.length,
      usedTokens: used,
    },
  };
}

module.exports = {
  estimateTokens,
  contextWindowFor,
  condenseTurn,
  buildRollingSummary,
  coalesceRoles,
  normalizeProviderSequence,
  assembleBudgetedContext,
  CONTEXT_WINDOWS,
  SUMMARY_HEADER,
  SUMMARY_ACK,
};
