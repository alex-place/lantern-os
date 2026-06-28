"use strict";

/**
 * route-contract.js — the single source of truth for coding-route selection.
 *
 * Implements ADR-0009 (one routing contract): coding is cloud-primary when a
 * cloud key is reachable; local is the offline/verified backstop; explicit user
 * choice always wins; the router only classifies (it never generates).
 *
 * This module is a PURE decision function — no I/O, no provider calls — so the
 * contract is testable in isolation. Environment variables are passed in as
 * `env` (inputs to the contract), not read ambiently, and default to
 * `process.env`.
 *
 * It is extracted behavior-preservingly from the inline coding-route block that
 * lived in lib/stream-chat.js (the "locked design 2026-06-26"). Migrating the
 * remaining scattered routing call sites here is a follow-up (see ADR-0009).
 */

/**
 * Resolve which provider should LEAD a turn, applying the coding-route rule.
 *
 * @param {object} opts
 * @param {string|null} opts.requestedProvider  Explicit user provider choice, if any.
 * @param {boolean}     opts.isCodingIntent      Whether the turn was classified as coding.
 * @param {string|null} opts.autoHintProvider    The router/Σ₀ hint for Auto mode (may be
 *                                                "ollama"/"local"/a cloud name/null).
 * @param {object}      [opts.env=process.env]    Environment (CODING_LOCAL_FIRST, keys).
 * @returns {string|null} The provider hint to lead with (unchanged when the rule
 *                        does not apply, so callers can keep their existing flow).
 */
function resolveCodingRoute({ requestedProvider, isCodingIntent, autoHintProvider, env } = {}) {
  env = env || process.env;

  // Rule 1: explicit user mode wins — never override a requested provider.
  if (requestedProvider) return autoHintProvider ?? null;

  // Developer escape hatch: restore the old coding-goes-local-first behavior.
  const codingLocalFirst = env.CODING_LOCAL_FIRST === "1";

  // Rule 3: coding is cloud-primary. Only intervene when the turn is coding, the
  // user hasn't pinned a provider, the escape hatch is off, and the current hint
  // is empty or points at a local model (i.e. nothing already chose cloud).
  const hintIsLocalOrEmpty =
    !autoHintProvider || autoHintProvider === "ollama" || autoHintProvider === "local";

  if (isCodingIntent && !codingLocalFirst && hintIsLocalOrEmpty) {
    if (env.ANTHROPIC_API_KEY) return "anthropic";
    if (env.OPENAI_API_KEY) return "openai";
    // Rule 4: no cloud key reachable → leave the local hint; the offline coder
    // backstop downstream handles the turn.
  }

  return autoHintProvider ?? null;
}

/**
 * Convenience predicate: does the resolved route prefer Anthropic? Mirrors the
 * `autoPrefersAnthropic` flag the dispatch ladder keys off.
 */
function prefersAnthropic(opts) {
  return resolveCodingRoute(opts) === "anthropic";
}

module.exports = { resolveCodingRoute, prefersAnthropic };
