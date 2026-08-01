/**
 * The ONE resolved data root (#3088).
 *
 * Modules used to each recompute `path.join(process.cwd(), "data", …)` or a
 * hand-counted `../../..`, so the store a module read depended on the cwd of
 * whoever started the process:
 *
 *   node apps/lantern-garage/server.js      → <repo>/data/…
 *   npm start --prefix apps/lantern-garage  → <repo>/apps/lantern-garage/data/…
 *
 * That split silently forked the profile store: `setUserRole()` written by a CLI
 * script landed in one root while the running server read the other, so a role
 * change "succeeded" and never took effect. Same class of bug had already eaten a
 * trading ledger and swept runtime state.
 *
 * Resolution is cwd-INDEPENDENT: anchored on this file's location, i.e. the repo
 * root that contains apps/lantern-garage. `LANTERN_DATA_DIR` overrides it (tests,
 * or a deploy that keeps state on a mounted volume).
 */

const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const DATA_ROOT = process.env.LANTERN_DATA_DIR
  ? path.resolve(process.env.LANTERN_DATA_DIR)
  : path.join(REPO_ROOT, "data");

/** Join a path under the single data root: dataPath("profiles", "index.jsonl"). */
function dataPath(...segments) {
  return path.join(DATA_ROOT, ...segments);
}

module.exports = { REPO_ROOT, DATA_ROOT, dataPath };
