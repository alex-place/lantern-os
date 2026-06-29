"use strict";
/**
 * creator-runtime.js — bridge so in-process chat tools (lib/tool-runner) can reach
 * the server's LIVE Creator Suite JobQueue singleton (the same instance JobWorker
 * polls) instead of constructing a detached copy whose jobs would never be processed.
 *
 * server.js calls setCreatorRuntime({ jobQueue, repoRoot }) once at startup. The
 * creator tools call getCreatorRuntime() lazily at execution time. When the runtime
 * is unset (e.g. a unit test loading tool-runner without the server), tools return a
 * clean "runtime unavailable" instead of throwing.
 */

let _ctx = { jobQueue: null, repoRoot: null };

function setCreatorRuntime(ctx = {}) {
  _ctx = { ..._ctx, ...ctx };
}

function getCreatorRuntime() {
  return _ctx;
}

module.exports = { setCreatorRuntime, getCreatorRuntime };
