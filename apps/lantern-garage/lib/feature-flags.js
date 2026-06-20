/**
 * feature-flags.js — Admin-managed feature flag + navigation visibility store.
 *
 * A single persistent JSON file is the source of truth for two admin-controlled
 * concerns:
 *
 *   1. Feature flags  — named on/off switches an admin can create and toggle.
 *      Consumed client-side via `data-flag="<key>"` elements (see shared-header.js)
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

// lib/ → apps/lantern-garage/ → apps/ → repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const STORE_DIR = path.join(REPO_ROOT, "data", "admin");
const STORE_PATH = path.join(STORE_DIR, "feature-flags.json");

/**
 * Canonical navigation pages, keyed by the href the global header renders.
 * The admin page lists exactly these, so the page set stays in lock-step with
 * the links in public/js/shared-header.js. Add a page here + a link there.
 */
const NAV_PAGES = [
  { path: "/dream-chat.html",        label: "Chat" },
  { path: "/trader-dashboard.html",  label: "Trader" },
  { path: "/create.html",            label: "Create" },
  { path: "/explore.html",           label: "Explore" },
  { path: "/knowledgecenter.html",   label: "Help" },
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

/** All flags as an array of full records (admin view). */
function listFlags() {
  const { flags } = loadConfig();
  return Object.keys(flags)
    .sort()
    .map((key) => ({ key, ...flags[key] }));
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
    return {
      path: page.path,
      label: page.label,
      hidden: !!o.hidden,
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

/** Test/maintenance hook: drop the in-memory cache so the next read re-loads. */
function _resetCache() {
  _cache = null;
}

module.exports = {
  NAV_PAGES,
  STORE_PATH,
  listFlags,
  getPublicFlags,
  isFlagEnabled,
  setFlag,
  deleteFlag,
  getNavConfig,
  getNavMap,
  isPageDisabled,
  setNavEntry,
  normalizeKey,
  _resetCache,
};
