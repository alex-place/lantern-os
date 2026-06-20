// Creator Intelligence — feature flags
// All V10 behavior ships behind these. Defaults are conservative: anything
// unproven is OFF so the stable dashboard is never destabilized. Every flag
// is overridable via an environment variable (truthy = "1"/"true"/"on").

"use strict";

const FLAG_DEFS = {
  creatorIntelligence: { env: "LANTERN_CI_ENABLED", default: false },
  safeZoneV2: { env: "LANTERN_CI_SAFEZONE_V2", default: false },
  captionEngineV3: { env: "LANTERN_CI_CAPTION_V3", default: false },
  variantEngineV2: { env: "LANTERN_CI_VARIANT_V2", default: false },
  // Export validation is pure ffprobe measurement and safe to run — on by default.
  exportValidator: { env: "LANTERN_CI_EXPORT_VALIDATOR", default: true },
  researchReport: { env: "LANTERN_CI_RESEARCH_REPORT", default: false },
  // Analytics calibration: imports the operator's OWN first-party analytics and
  // joins them to measured features. Read/ingest of first-party data is always
  // legitimate; gated off by default so it never runs unprompted.
  calibration: { env: "LANTERN_CI_CALIBRATION", default: false },
};

function envTruthy(value) {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return undefined; // unrecognized → fall back to default
}

/**
 * Resolve all flags from defaults + environment overrides.
 * @returns {Object<string, boolean>}
 */
function resolveFlags(env = process.env) {
  const flags = {};
  for (const [name, def] of Object.entries(FLAG_DEFS)) {
    const override = envTruthy(env[def.env]);
    flags[name] = override === undefined ? def.default : override;
  }
  return flags;
}

/**
 * Check a single flag by name.
 * @param {string} name
 * @returns {boolean}
 */
function isEnabled(name, env = process.env) {
  const def = FLAG_DEFS[name];
  if (!def) return false;
  const override = envTruthy(env[def.env]);
  return override === undefined ? def.default : override;
}

module.exports = { FLAG_DEFS, resolveFlags, isEnabled };
