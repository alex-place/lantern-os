/**
 * feature-flags.js — Admin-managed feature flag + navigation visibility store.
 *
 * A single persistent JSON file is the source of truth for two admin-controlled
 * concerns:
 *
 *   1. Feature flags  — named on/off switches an admin can create and toggle.
 *      Consumed client-side via `data-flag="<key>"` elements (see auth-gate.js)
 *      and server-side via isFlagEnabled(key).
 *
 *   2. Navigation visibility — per-page { hidden, disabled } overrides for the
 *      global nav. `hidden` removes the link; `disabled` greys the link AND blocks
 *      the page server-side for non-admins (a kill-switch).
 *
 * This is NOT the health-driven feature-graph (lib/feature-graph.js). That system
 * activates features from provider health/latency. This one is a deliberate,
 * persisted admin control surface. Kept as a single small store, not a subsystem.
 *
 * Storage: data/admin/feature-flags.json (latest-wins single document).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const surfaceRegistry = require("./surface-registry");

// lib/ →  → apps/ → repo root
const REPO_ROOT = path.resolve(__dirname, "..");
const STORE_DIR = path.join(REPO_ROOT, "data", "admin");
const STORE_PATH = path.join(STORE_DIR, "feature-flags.json");

/**
 * Canonical navigation pages, keyed by the href the global header renders.
 * The admin page lists exactly these. This set must stay in lock-step with the
 * links the header renders — the inline `.nav-links` in public/index.html.
 * assertNavInSync() (called at server startup) warns at boot if they drift (#1880).
 * Add a page here + a link there.
 */
const NAV_PAGES = [
  { path: "/chat.html",        label: "Chat" },
  { path: "/stock-trader.html",  label: "Trader" },
  { path: "/create.html",            label: "Create" },
  { path: "/explore.html",           label: "Explore" },
  { path: "/knowledgecenter.html",   label: "Help" },
];

/**
 * Canonical "known" flags. These always appear in the admin UI (default OFF) even
 * before anyone creates them, so a safety-critical switch is discoverable rather than
 * hidden until typed by hand. A stored record (created/toggled by an admin) always
 * wins over the default here; deleting one just returns it to the default-OFF state.
 *
 * kalshi_live_trading is an ADDITIONAL AND-gate on real-money orders (see
 * kalshi-api.tradingEnabled): OFF can only keep the exchange path in dry-run, never
 * arm it. It sits under the same admin/Patreon gate as this whole page.
 */
const KNOWN_FLAGS = [
  {
    key: "kalshi_live_trading",
    label: "Kalshi live trading",
    description:
      "Master switch for placing REAL-money Kalshi orders. OFF = dry-run only. " +
      "In addition to this flag, a live order still requires KALSHI_TRADING_ENABLED=1, " +
      "the kill-switch file absent, and valid credentials. Scope stays weather-edge, 1 contract.",
    danger: true,
  },
];

let _cache = null;

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function emptyConfig() {
  return { version: 1, flags: Object.create(null), navigation: {}, updatedAt: null };
}

/** Load the config document (cached). Never throws — falls back to empty. */
function loadConfig() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      _cache = {
        version: parsed.version || 1,
        flags: nullProtoFlags(parsed.flags),
        navigation: parsed.navigation && typeof parsed.navigation === "object" ? parsed.navigation : {},
        updatedAt: parsed.updatedAt || null,
      };
      return _cache;
    }
  } catch (e) {
    console.error("[feature-flags] failed to read store, using empty config:", e.message);
  }
  _cache = emptyConfig();
  return _cache;
}

function saveConfig(cfg) {
  ensureDir();
  cfg.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_PATH, JSON.stringify(cfg, null, 2));
  _cache = cfg;
  return cfg;
}

// ── Feature flags ──────────────────────────────────────────────────────────

/**
 * All flags as an array of full records (admin view). Known flags are merged in so
 * they always show (default OFF) even when nobody has created them yet; a stored
 * record overrides the default. `known`/`danger` are surfaced so the UI can protect
 * them (no delete, confirm-on-enable).
 */
function listFlags() {
  const { flags } = loadConfig();
  const byKey = new Map();
  for (const k of KNOWN_FLAGS) {
    byKey.set(k.key, { key: k.key, label: k.label, description: k.description, enabled: false, known: true, danger: !!k.danger });
  }
  for (const key of Object.keys(flags)) {
    const known = byKey.get(key);
    byKey.set(key, { key, ...flags[key], known: !!known, danger: known ? !!known.danger : false });
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Compact { key: enabledBoolean } map for public client consumption. */
function getPublicFlags() {
  const { flags } = loadConfig();
  const out = {};
  for (const key of Object.keys(flags)) out[key] = !!flags[key].enabled;
  return out;
}

/** True only if the flag exists and is enabled. Unknown flags are off. */
function isFlagEnabled(key) {
  const { flags } = loadConfig();
  return !!(flags[key] && flags[key].enabled);
}

/**
 * The flag's enabled state, or `fallback` when the flag has never been created.
 * Unlike isFlagEnabled() (which treats unknown flags as off), this lets a caller
 * default a gate ON until an admin explicitly creates+disables it — used for the
 * Patreon auth gate, which must not silently drop open on a fresh install.
 */
function isFlagEnabledOr(key, fallback) {
  const { flags } = loadConfig();
  const rec = flags[normalizeKey(key)];
  return rec ? !!rec.enabled : !!fallback;
}

/**
 * Create or update a flag. Returns the stored record.
 * Only provided fields change; `enabled` defaults to false on first create.
 */
function setFlag(key, { label, description, enabled } = {}, actor = "admin") {
  const k = normalizeKey(key);
  if (!k) throw new Error("flag key is required");
  const cfg = loadConfig();
  const existing = cfg.flags[k] || {};
  cfg.flags[k] = {
    label: label !== undefined ? String(label) : existing.label || k,
    description: description !== undefined ? String(description) : existing.description || "",
    enabled: enabled !== undefined ? !!enabled : !!existing.enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  saveConfig(cfg);
  return { key: k, ...cfg.flags[k] };
}

function deleteFlag(key) {
  const k = normalizeKey(key);
  const cfg = loadConfig();
  if (!cfg.flags[k]) return false;
  delete cfg.flags[k];
  saveConfig(cfg);
  return true;
}

// ── Navigation visibility ──────────────────────────────────────────────────

/**
 * Full nav config for the admin page and the header: every canonical page
 * merged with its stored override.
 * → [{ path, label, hidden, disabled, updatedAt, updatedBy }]
 */
function getNavConfig() {
  const { navigation } = loadConfig();
  return NAV_PAGES.map((page) => {
    const o = navigation[page.path] || {};
    // Σ₀ boundary default (surface-registry): the DEFAULT app foregrounds the loop.
    // An EXTENSION surface is hidden from the nav unless its gating flag is enabled,
    // so trading/creator/etc. are opt-in, not equals of the loop. CORE surfaces and
    // always-on shell modules (account/meta, flag === null) are never default-hidden.
    // An explicit admin override (hidden set either way) always wins over this default.
    const surface = page.path.replace(/^\//, "");
    const cls = surfaceRegistry.classify(surface);
    // An extension is "on" if its env gate is set (how deployments enable it) OR an
    // admin toggled it on in the flag store — check both, not just the admin store.
    const extEnabled = (flag) => !!process.env[flag] || isFlagEnabled(flag);
    // NAV_FOREGROUND extensions (e.g. the trader) are a product mainstay — kept in
    // the default nav even while gated (ADR-0023).
    const defaultHidden = !!(cls && cls.tier === "extension" && cls.flag
      && !extEnabled(cls.flag) && !surfaceRegistry.isNavForegrounded(surface));
    return {
      path: page.path,
      label: page.label,
      hidden: o.hidden !== undefined ? !!o.hidden : defaultHidden,
      disabled: !!o.disabled,
      updatedAt: o.updatedAt || null,
      updatedBy: o.updatedBy || null,
    };
  });
}

/** Compact { path: { hidden, disabled } } map (header consumption). */
function getNavMap() {
  const out = {};
  for (const entry of getNavConfig()) {
    out[entry.path] = { hidden: entry.hidden, disabled: entry.disabled };
  }
  return out;
}

/** True if a page is admin-disabled (kill-switch). Unknown pages are enabled. */
function isPageDisabled(pagePath) {
  const { navigation } = loadConfig();
  const o = navigation[pagePath];
  return !!(o && o.disabled);
}

/**
 * Set the hidden/disabled override for one nav page. Only canonical pages are
 * accepted so the override map can't drift from the rendered nav.
 */
function setNavEntry(pagePath, { hidden, disabled } = {}, actor = "admin") {
  if (!NAV_PAGES.some((p) => p.path === pagePath)) {
    throw new Error(`unknown nav page: ${pagePath}`);
  }
  const cfg = loadConfig();
  const existing = cfg.navigation[pagePath] || {};
  cfg.navigation[pagePath] = {
    hidden: hidden !== undefined ? !!hidden : !!existing.hidden,
    disabled: disabled !== undefined ? !!disabled : !!existing.disabled,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  saveConfig(cfg);
  return { path: pagePath, ...cfg.navigation[pagePath] };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * JS reserved property names. Even after normalization these must never become
 * flag keys: `cfg.flags["__proto__"] = {…}` invokes the prototype setter and
 * stores nothing (the endpoint then reports a misleading success), and a raw
 * `flags["constructor"]` read off a normal object would resolve to Object's
 * constructor. We reject them so setFlag's empty-key guard returns a clean 400.
 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Copy stored flags into a prototype-less map. Belt-and-suspenders against
 * prototype surprises: with no Object.prototype in the chain, a stray reserved
 * key (or a direct flags[key] read in isFlagEnabled) can never resolve to an
 * inherited member.
 */
function nullProtoFlags(src) {
  const out = Object.create(null);
  if (src && typeof src === "object") {
    for (const k of Object.keys(src)) out[k] = src[k];
  }
  return out;
}

/** Flag keys are lowercase, alnum + dot/underscore/hyphen. Reserved names rejected. */
function normalizeKey(key) {
  const k = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return RESERVED_KEYS.has(k) ? "" : k;
}

/**
 * Extract the canonical nav entries the global header actually renders — the
 * internal-page anchors inside `<div class="nav-links">…</div>` in index.html.
 * Returns [{ path, label }]. External links (Patreon) are skipped. This is the
 * one source the header renders from, so NAV_PAGES is validated against it
 * rather than against a hand-kept second copy. Returns null if index.html or
 * the nav-links block can't be read (assertion then no-ops, fail-open).
 */
function readHeaderNavEntries() {
  try {
    const indexPath = path.join(REPO_ROOT, "public", "index.html");
    const html = fs.readFileSync(indexPath, "utf8");
    const block = html.match(/<div class="nav-links">([\s\S]*?)<\/div>/i);
    if (!block) return null;
    const entries = [];
    const anchorRe = /<a\s+href="(\/[^"]*\.html)"[^>]*>([^<]*)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(block[1])) !== null) {
      entries.push({ path: m[1], label: m[2].trim() });
    }
    return entries;
  } catch {
    return null;
  }
}

/**
 * Startup assertion (#1880): warn if NAV_PAGES has drifted out of lock-step with
 * the links the global header renders (index.html .nav-links). Non-fatal — logs
 * the specific drift so a page added to one list but not the other is caught at
 * boot instead of silently breaking nav visibility / flag gating.
 * Returns { ok, problems[] } for testability.
 */
function assertNavInSync(log = console.warn) {
  const header = readHeaderNavEntries();
  if (!header) return { ok: true, problems: [], skipped: true };

  const problems = [];
  const navByPath = new Map(NAV_PAGES.map((p) => [p.path, p.label]));
  const hdrByPath = new Map(header.map((p) => [p.path, p.label]));

  for (const { path: p, label } of header) {
    if (!navByPath.has(p)) problems.push(`header link ${p} ("${label}") missing from NAV_PAGES`);
    else if (navByPath.get(p) !== label) {
      problems.push(`label drift for ${p}: header "${label}" vs NAV_PAGES "${navByPath.get(p)}"`);
    }
  }
  for (const { path: p, label } of NAV_PAGES) {
    if (!hdrByPath.has(p)) problems.push(`NAV_PAGES entry ${p} ("${label}") has no header link in index.html`);
  }

  if (problems.length) {
    log(`[feature-flags] NAV_PAGES out of sync with header nav (#1880):\n  - ${problems.join("\n  - ")}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Test/maintenance hook: drop the in-memory cache so the next read re-loads. */
function _resetCache() {
  _cache = null;
}

module.exports = {
  NAV_PAGES,
  KNOWN_FLAGS,
  STORE_PATH,
  listFlags,
  getPublicFlags,
  isFlagEnabled,
  isFlagEnabledOr,
  setFlag,
  deleteFlag,
  getNavConfig,
  getNavMap,
  isPageDisabled,
  setNavEntry,
  normalizeKey,
  readHeaderNavEntries,
  assertNavInSync,
  _resetCache,
};
