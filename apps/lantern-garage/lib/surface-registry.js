/**
 * surface-registry.js — the Σ₀ surface boundary (single source of truth).
 *
 * The North Star forbids architectural sprawl: "name the loop stage you improve, or
 * don't add it." With ~45 public HTML surfaces, that rule had no teeth — nothing
 * declared which surfaces ARE the Observe→Remember→Reason→Act→Verify→Converge loop and
 * which are optional extensions bolted on beside it. This registry draws that line so it
 * is explicit, auditable, and gateable, instead of undifferentiated sprawl.
 *
 * Grounded in the modular-monolith boundary pattern: clear module boundaries prevent
 * organic sprawl, enforced by a contract test that runs before merge (see
 * test/surface-boundary.test.js — it fails if any public surface is unclassified).
 * Refs: https://modularmonoliths.com/ ;
 * https://microsoft.github.io/multi-agent-reference-architecture/docs/design-options/Modular-Monolith.html
 *
 * Each top-level public/*.html surface is exactly one of:
 *   - CORE       → directly serves one loop stage. `stage` names which.
 *   - EXTENSION  → an optional capability beside the loop. `module` names the cluster;
 *                  `flag` (optional) is the env var that gates it via lib/feature-graph.js.
 *
 * This is the CURRENT boundary, not a target. Moving a surface between tiers is a
 * deliberate edit here; adding a surface without classifying it fails the contract test.
 */

"use strict";

// The one loop. A core surface must name exactly one of these stages.
const LOOP_STAGES = ["Observe", "Remember", "Reason", "Act", "Verify", "Converge"];

// ── CORE — the convergence loop itself ──────────────────────────────────────────
const CORE = {
  "index.html":             "Observe",   // hub / entry into the loop
  "dream-chat.html":        "Reason",    // THE product: observe→remember→reason→act→verify
  "explore.html":           "Remember",  // retrieval feed over the memory archive
  "knowledgecenter.html":   "Remember",  // grounding knowledge base
  "rag-house.html":         "Remember",  // RAG document house
  "wide-search.html":       "Remember",  // cross-archive search
  "proof.html":             "Verify",    // claims / evidence / proof surface
  "calibration.html":       "Verify",    // grounding calibration
  "factcheck.html":         "Verify",    // fact-check / grounding gate
  "grounding-diff.html":    "Verify",    // grounding diff inspector
  "drift.html":             "Verify",    // collapse + 42-state canary monitor (verification safety)
  "orchestration.html":     "Act",       // agent orchestration / dispatch
  "work.html":              "Act",       // autowork queue
  "admin-flags.html":       "Act",       // the boundary control itself (feature flags)
  "agent-status.html":      "Converge",  // agent observability
  "agent-leaderboard.html": "Converge",  // agent convergence leaderboard
  "metrics.html":           "Converge",  // convergence metrics
  "systems.html":           "Converge",  // systems-health observability
  "replay.html":            "Converge",  // git-bisect over past convergence records
};

// ── EXTENSION — optional capabilities beside the loop ────────────────────────────
// { surface: [module, flag|null] }
const EXTENSION = {
  // trading terminal cluster
  "trading.html":                  ["trading", "TRADING_ENABLED"],
  "kalshi-terminal.html":          ["trading", "TRADING_ENABLED"],
  "stock-trader.html":             ["trading", "TRADING_ENABLED"],
  // creator / document tooling
  "create.html":                   ["creator", "CREATOR_ENABLED"],
  // media
  "fallout-radio.html":            ["media", "RADIO_ENABLED"],
  // game — playable surface beside the loop (linked from Explore as a game card)
  "three-doors-game.html":         ["game", "GAMES_ENABLED"],
  // account / auth / billing
  "auth.html":                     ["account", null],
  "entry.html":                    ["account", null],
  "profile.html":                  ["account", null],
  "pricing.html":                  ["account", null],
  "upgrade-lab.html":              ["account", null],
  "api-keys-settings.html":        ["account", null],
  // project meta
  "changelog.html":                ["meta", null],
  "whats-new.html":                ["meta", null],
  "faq.html":                      ["meta", null],
};

// ── SPRAWL POLICY — teeth for the boundary (enforced by test/surface-boundary.test.js) ──
// Classification alone only *labels* sprawl. Two rules push back on it so the North Star's
// "name the loop stage you improve, or don't add it" is enforced, not just documented:
//
//   1. BUDGET — extensions may not outpace the core loop. When the extension:core ratio
//      exceeds this cap the contract test FAILS: either add core value, or raise the cap
//      deliberately (a one-line, reviewable edit that makes "we chose more sprawl" explicit
//      instead of letting it accrete silently).
const MAX_EXTENSION_RATIO = 0.85; // 15:19 ≈ 0.79 — ratcheted down as surfaces were cut.
//
//   2. GATEABLE — every extension must be switch-off-able (name an env `flag`), EXCEPT the
//      always-on shell modules below (login/account + project-meta pages that must always
//      render). This makes "optional capability beside the loop" true in practice, not paper.
const ALWAYS_ON_MODULES = new Set(["account", "meta"]);

/** Classify one top-level surface filename. Returns null if unclassified. */
function classify(surface) {
  if (Object.prototype.hasOwnProperty.call(CORE, surface)) {
    return { tier: "core", stage: CORE[surface] };
  }
  if (Object.prototype.hasOwnProperty.call(EXTENSION, surface)) {
    const [module, flag] = EXTENSION[surface];
    return { tier: "extension", module, flag };
  }
  return null;
}

/** Given the list of top-level public *.html filenames, return any not in the registry. */
function unclassified(htmlFilenames) {
  return htmlFilenames.filter((f) => classify(f) === null).sort();
}

/** Registry summary: counts + the extension:core ratio (the sprawl number to watch). */
function summary() {
  const core = Object.keys(CORE).length;
  const ext = Object.keys(EXTENSION).length;
  const byModule = {};
  for (const [, [module]] of Object.entries(EXTENSION)) byModule[module] = (byModule[module] || 0) + 1;
  return { core, extension: ext, ratio: +(ext / Math.max(1, core)).toFixed(2), byModule };
}

module.exports = { LOOP_STAGES, CORE, EXTENSION, MAX_EXTENSION_RATIO, ALWAYS_ON_MODULES, classify, unclassified, summary };
