// request-auth.js — recognize a trusted operator request (#770, hardened #839).
//
// The un-scoped (no-sessionId) conversation read returns the GLOBAL cross-session log,
// and the un-scoped DELETE clears everyone's history. Those are operator-only actions and
// must not be exposed to anonymous/public callers. A request is trusted iff it is an
// UN-PROXIED loopback hit (the local operator dashboard) OR carries a matching
// OPERATOR_TOKEN header.

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

function isOperatorRequest(req, env = process.env) {
  if (isLoopback(req)) return true; // un-proxied local operator dashboard
  const token = env && env.OPERATOR_TOKEN;
  if (!token) return false;                 // no token configured → remote callers untrusted
  const header = req && req.headers && (req.headers["x-operator-token"] || req.headers["X-Operator-Token"]);
  return Boolean(header) && header === token; // remote, but holds the operator token
}

module.exports = { isOperatorRequest, isLoopback, isProxied, PROXY_HEADERS };
