"use strict";

/**
 * Canonical public origin for absolute links that LEAVE the server — OAuth
 * redirect targets and, critically, password-reset / email-verification links.
 *
 * These must not be attacker-controllable: a forged `Host` header would otherwise
 * point a genuine security email at an attacker's domain, handing over a valid
 * reset token on click (host-header / reset poisoning, #2604). So prefer the
 * operator-configured origin and only fall back to the request Host for loopback
 * dev, where there is no proxy in front to spoof it.
 *
 * Production MUST set PUBLIC_BASE_URL (or OAUTH_REDIRECT_BASE). When it isn't set
 * and the request is non-loopback, we still build a link from the Host (there is
 * no other origin to use) but warn once so the misconfiguration is visible.
 */
let _warnedHostFallback = false;

function canonicalOrigin(req) {
  const configured = (process.env.PUBLIC_BASE_URL || process.env.OAUTH_REDIRECT_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;

  const host = (req && req.headers && req.headers.host) || "127.0.0.1:4177";
  const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:|$)/.test(host);
  if (!isLoopback && !_warnedHostFallback) {
    _warnedHostFallback = true;
    console.warn(
      "[base-url] PUBLIC_BASE_URL is not set on a non-loopback deploy — security links " +
      "fall back to the request Host header, which is spoofable. Set PUBLIC_BASE_URL."
    );
  }
  const fwdProto = req && req.headers && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = isLoopback
    ? "http"
    : (fwdProto || (req && req.socket && req.socket.encrypted ? "https" : "http"));
  return `${proto}://${host}`;
}

module.exports = { canonicalOrigin };
