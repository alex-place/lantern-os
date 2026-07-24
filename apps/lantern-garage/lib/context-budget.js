"use strict";
// #2852 (Observe) — a context-budget layer so the loop stays bounded regardless of run duration
// (AgentFold context-folding; Self-GC 2607.00692; InfiAgent file-centric state).
//
// foldContext() is the DECISION core: given the running context (oldest→newest) and a token
// budget, it decides which items to KEEP in the live window vs EXTERNALIZE (evict), preserving a
// recency floor and pinned/high-value items. Externalized items are RETURNED for the caller to
// persist to the EXISTING memory store (csf-memory) and recall on demand — this adds no new
// store, it's the eviction policy that lets the spiral run indefinitely without unbounded
// context growth. Pure; never throws.

const CHARS_PER_TOKEN = 4; // cheap length→token estimate (no tokenizer dependency)

function estimateTokens(text) {
  return Math.ceil(String(text == null ? "" : text).length / CHARS_PER_TOKEN);
}
function _itemTokens(it) {
  return estimateTokens(it && (it.text != null ? it.text : it.content));
}

/**
 * Fold a chronological context list to fit a token budget.
 * @param {Array<{text?:string, content?:string, pinned?:boolean}>} items  oldest → newest
 * @param {{budgetTokens:number, keepRecent?:number}} opts
 * @returns {{kept:Array, externalized:Array, keptTokens:number, budgetTokens:number, folded:boolean}}
 *   kept + externalized partition `items` (chronological order preserved within each).
 *   keptTokens may exceed budget ONLY because pinned/recency-floor items are hard-kept.
 */
function foldContext(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const budget = Math.max(0, Number(opts.budgetTokens) || 0);
  const keepRecent = Math.max(0, Number(opts.keepRecent) || 0);
  const n = list.length;
  const tokens = list.map(_itemTokens);
  const total = tokens.reduce((a, b) => a + b, 0);

  if (total <= budget) {
    return { kept: list.slice(), externalized: [], keptTokens: total, budgetTokens: budget, folded: false };
  }

  const keep = new Set();
  let used = 0;
  // 1) pinned items are always kept (they count against the budget)
  for (let i = 0; i < n; i++) {
    if (list[i] && list[i].pinned) { keep.add(i); used += tokens[i]; }
  }
  // 2) recency floor — the last `keepRecent` items are hard-kept (newest first)
  for (let i = n - 1, c = 0; i >= 0 && c < keepRecent; i--, c++) {
    if (!keep.has(i)) { keep.add(i); used += tokens[i]; }
  }
  // 3) fill the remaining budget with the newest items that still fit
  for (let i = n - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    if (used + tokens[i] <= budget) { keep.add(i); used += tokens[i]; }
  }

  const kept = [];
  const externalized = [];
  for (let i = 0; i < n; i++) (keep.has(i) ? kept : externalized).push(list[i]);
  return { kept, externalized, keptTokens: used, budgetTokens: budget, folded: true };
}

module.exports = { foldContext, estimateTokens, CHARS_PER_TOKEN };
