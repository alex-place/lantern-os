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
  "watch.html":             "Observe",   // market watch — tracking watchlist/charts/signals (the trader's Observe surface; trading split to stock-trader.html)
  "welcome.html":           "Observe",   // first-run entry into the loop (#2079)
  "chat.html":        "Reason",    // THE product: observe→remember→reason→act→verify
  "explore.html":           "Remember",  // retrieval feed over the memory archive
  "knowledgecenter.html":   "Remember",  // grounding knowledge base
  "wide-search.html":       "Remember",  // cross-archive search
  "orchestration.html":     "Act",       // agent orchestration / dispatch
  "work.html":              "Act",       // autowork queue
  "admin-flags.html":       "Act",       // the boundary control itself (feature flags)
  // Verify, not Converge. This page is the External Reality Rule applied to
  // ourselves — its own copy says so — reporting verified-patch rate, honesty
  // rate and provenance as [claim, evidence, confidence]. Converge is still
  // served by system-health.html, which is where convergence/health actually
  // lives. Re-tagged when #3109 retired the five orphaned Verify pages (proof,
  // calibration, factcheck, grounding-diff, drift): verification is a FUNCTION
  // the product performs, not a page a user visits, and this is the surface that
  // performs it.
  "metrics.html":           "Verify",    // outcome metrics: claim → evidence → confidence
  "system-health.html":           "Converge",  // systems-health observability
};

// ── EXTENSION — optional capabilities beside the loop ────────────────────────────
// { surface: [module, flag|null] }
const EXTENSION = {
  // trading terminal cluster
  // trading.html retired (#2488) — 302s to /stock-trader.html (see routes/pages.js REDIRECTS); no file, so no registry entry.
  "kalshi-terminal.html":          ["trading", "TRADING_ENABLED"],
  "stock-trader.html":             ["trading", "TRADING_ENABLED"],
  "options.html":                  ["trading", "TRADING_ENABLED"], // options trader (shadow) + live chain + advisory strategies — no orders placeable
  "contest.html":                  ["trading", "TRADING_ENABLED"], // public paper-trading contest leaderboard (#2552); join is sign-in-gated, any tier
  // creator / document tooling
  "create.html":                   ["creator", "CREATOR_ENABLED"],
  // broker (IBKR) connect help — gated with the trading cluster it belongs to
  "ibkr-setup-guide.html":         ["trading", "TRADING_ENABLED"],
  // media
  "fallout-radio.html":            ["media", "RADIO_ENABLED"],
  // account / auth / billing
  "auth.html":                     ["account", null],
  "terms.html":                    ["account", null],
  "entry.html":                    ["account", null],
  // profile.html retired → 302s to /settings.html (profile merged into settings; see routes/pages.js REDIRECTS); no file, so no registry entry.
  "accounts.html":                 ["account", null], // staff account-support console (admin/tech_support): multi-auth + password fixes
  "reset-password.html":           ["account", null],
  "pricing.html":                  ["account", null],
  // upgrade-lab.html retired (#2473) — 302s to /pricing.html (see routes/pages.js REDIRECTS); no file, so no registry entry.
  // api-keys-settings.html retired → 302s to /settings.html (see routes/pages.js REDIRECTS); no file, so no registry entry.
  "settings.html":                 ["account", null], // user settings: General / Account / Billing / Connections (#settings-rework); API keys/connectors live on orchestration.html
  // project meta
  "changelog.html":                ["meta", null],
  "whats-new.html":                ["meta", null],
  "faq.html":                      ["meta", null],
};

// ── SUBSYSTEMS — top-level NON-HTML subsystems (bots + background services) ──────
// ADR-0013 follow-up (#1948): the surface boundary must cover more than
// public/*.html. These are the background services server.js manages plus the
// bot/MCP processes it spawns — classified by the SAME rule: CORE names a loop
// stage; EXTENSION names a module. `entry` cites the artifact (verified to exist by
// the contract test, so entries can't be fabricated or go stale); `flag` is the env
// gate in server.js (null = not env-gated here). Grounded against server.js spawns.
const SUBSYSTEMS = {
  // CORE — background services that ARE a loop stage
  "mcp-server":       { tier: "core", stage: "Act",      entry: "src/mcp_server/server.py",           flag: "LANTERN_MCP_SERVER" },

  // EXTENSION — optional capabilities beside the loop
  "news-collector":   { tier: "extension", module: "trading",   entry: "apps/lantern-garage/lib/news-collector.js",   flag: "TRADING_ENABLED" },
  "kalshi-collector": { tier: "extension", module: "trading",   entry: "apps/lantern-garage/lib/kalshi-collector.js", flag: "TRADING_ENABLED" },
  "brake-monitor":    { tier: "extension", module: "trading",   entry: "apps/lantern-garage/lib/brake-monitor.js",    flag: "BRAKE_MONITOR" },
  "crypto-collector": { tier: "extension", module: "trading",   entry: "apps/lantern-garage/lib/crypto-collector.js", flag: "KALSHI_CRYPTO_OBSERVER" },
  "job-worker":       { tier: "extension", module: "creator",   entry: "apps/lantern-garage/lib/job-worker.js",       flag: "CREATOR_ENABLED" },
  "cloudflare-tunnel":{ tier: "extension", module: "ops",       entry: "apps/lantern-garage/server.js",               flag: "LANTERN_CLOUDFLARE_TUNNEL" },
};

// ── SPRAWL POLICY — teeth for the boundary (enforced by test/surface-boundary.test.js) ──
// Classification alone only *labels* sprawl. Two rules push back on it so the North Star's
// "name the loop stage you improve, or don't add it" is enforced, not just documented:
//
//   1. BUDGET — extensions may not outpace the core loop. When the extension:core ratio
//      exceeds this cap the contract test FAILS: either add core value, or raise the cap
//      deliberately (a one-line, reviewable edit that makes "we chose more sprawl" explicit
//      instead of letting it accrete silently).
// 17:12 = 1.42. Re-baselined by #3109, which retired 13 ORPHANED surfaces — pages
// with no inbound nav path from anywhere on the site. Seven of those were CORE
// (proof, calibration, factcheck, grounding-diff, drift, replay, rag-house) and
// only four were extensions, so deleting dead weight pushed the ratio UP even
// though the absolute surface count fell 42 → 29.
//
// The cap exists to stop extensions outgrowing the loop. That is not what
// happened here: the extension count barely moved, the core count fell because
// unreachable core pages were removed. Raising the cap records that as a
// deliberate re-baseline rather than letting a cleanup read as sprawl. Tighten it
// again if core surfaces are added back.
const MAX_EXTENSION_RATIO = 1.45;
//
//   2. GATEABLE — every extension must be switch-off-able (name an env `flag`), EXCEPT the
//      always-on shell modules below (login/account + project-meta pages that must always
//      render). This makes "optional capability beside the loop" true in practice, not paper.
const ALWAYS_ON_MODULES = new Set(["account", "meta"]);

// ── NAV FOREGROUND — extensions the product owner keeps in the DEFAULT nav ───────
// The default app foregrounds the loop (ADR-0023): extension nav links are hidden
// until their flag is on. These surfaces are an explicit exception — a deliberate
// product decision to treat them as a first-class mainstay of the nav even though
// they remain EXTENSIONs in the Σ₀ boundary (they don't serve a loop stage). The
// trader is served to everyone (guest read-only), so its nav link is always shown.
const NAV_FOREGROUND = new Set(["stock-trader.html"]);

/** True if this extension surface should stay in the default nav despite being gated. */
function isNavForegrounded(surface) {
  return NAV_FOREGROUND.has(surface);
}

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

/** Classify one non-HTML subsystem by name. Returns null if unregistered. */
function classifySubsystem(name) {
  const s = Object.prototype.hasOwnProperty.call(SUBSYSTEMS, name) ? SUBSYSTEMS[name] : null;
  if (!s) return null;
  return s.tier === "core"
    ? { tier: "core", stage: s.stage, entry: s.entry, flag: s.flag || null }
    : { tier: "extension", module: s.module, entry: s.entry, flag: s.flag || null };
}

/** Registry summary: counts + the extension:core ratio (the sprawl number to watch). */
function summary() {
  const core = Object.keys(CORE).length;
  const ext = Object.keys(EXTENSION).length;
  const byModule = {};
  for (const [, [module]] of Object.entries(EXTENSION)) byModule[module] = (byModule[module] || 0) + 1;
  const subCore = Object.values(SUBSYSTEMS).filter((s) => s.tier === "core").length;
  const subExt = Object.values(SUBSYSTEMS).filter((s) => s.tier === "extension").length;
  return {
    core,
    extension: ext,
    ratio: +(ext / Math.max(1, core)).toFixed(2),
    byModule,
    subsystems: { core: subCore, extension: subExt, total: subCore + subExt },
  };
}

module.exports = { LOOP_STAGES, CORE, EXTENSION, SUBSYSTEMS, MAX_EXTENSION_RATIO, ALWAYS_ON_MODULES, NAV_FOREGROUND, isNavForegrounded, classify, classifySubsystem, unclassified, summary };
