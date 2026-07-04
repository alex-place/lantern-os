// request-auth.js — recognize a trusted operator request (#770, hardened #839).
//
// The un-scoped (no-sessionId) conversation read returns the GLOBAL cross-session log,
// and the un-scoped DELETE clears everyone's history. Those are operator-only actions and
// must not be exposed to anonymous/public callers. A request is trusted iff it is an
// UN-PROXIED loopback hit (the local operator dashboard) OR carries a matching
// OPERATOR_TOKEN header.

const crypto = require("crypto");

// Headers that only ever appear on traffic relayed through a reverse proxy or tunnel. A
// genuine same-machine request to 127.0.0.1 carries none of these. lantern-os.net is fronted
// by a Cloudflare named tunnel → 127.0.0.1, so EVERY external visitor reaches Node from a
// loopback socket; without this guard the loopback check below would treat the entire internet
// as the local operator (#839). Mirrors PROXY_HEADERS in lib/auth-middleware.js.
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
  "true-client-ip",
];

/** True if the request arrived via a reverse proxy / tunnel (so the socket IP is not the caller). */
function isProxied(req) {
  const headers = (req && req.headers) || {};
  return PROXY_HEADERS.some((h) => headers[h]);
}

/** A direct, un-proxied hit from the local machine. Proxied traffic never qualifies. */
function isLoopback(req) {
  if (isProxied(req)) return false; // relayed through a proxy/tunnel → not a local hit
  const addr = (req && req.socket && req.socket.remoteAddress) || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Constant-time string compare (avoids leaking token length/prefix via timing). */
function tokensEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** The operator token carried on a request, if any (Node lower-cases header names). */
function requestToken(req) {
  const h = (req && req.headers) || {};
  return h["x-operator-token"] || h["x-unisona-token"] || "";
}

function isOperatorRequest(req, env = process.env) {
  // Desktop hardening (ADR-0014 G4): on an end-user box the user — and any local
  // process, or a malicious web page performing DNS-rebind / CSRF against
  // 127.0.0.1 — is loopback, so loopback ALONE must not confer operator rights.
  // When UNISONA_LOCAL_TOKEN is set (the launcher mints one per boot), trust is
  // gated on that token instead of the socket address. Unset → today's behaviour.
  const localToken = env && env.UNISONA_LOCAL_TOKEN;
  if (localToken) {
    return tokensEqual(requestToken(req), localToken);
  }

  if (isLoopback(req)) return true; // un-proxied local operator dashboard (servers)
  const token = env && env.OPERATOR_TOKEN;
  if (!token) return false;                 // no token configured → remote callers untrusted
  return tokensEqual(requestToken(req), token); // remote, but holds the operator token
}

module.exports = {
  isOperatorRequest,
  isLoopback,
  isProxied,
  tokensEqual,
  requestToken,
  PROXY_HEADERS,
};
