// request-auth.js — recognize a trusted operator request (#770).
//
// The un-scoped (no-sessionId) conversation read returns the GLOBAL cross-session log,
// and the un-scoped DELETE clears everyone's history. Those are operator-only actions and
// must not be exposed to anonymous/public callers. A request is trusted iff it comes from
// loopback (the local operator dashboard) OR carries a matching OPERATOR_TOKEN header.

function isLoopback(req) {
  const addr = (req && req.socket && req.socket.remoteAddress) || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isOperatorRequest(req, env = process.env) {
  if (isLoopback(req)) return true;
  const token = env && env.OPERATOR_TOKEN;
  if (!token) return false;                 // no token configured → remote callers untrusted
  const header = req && req.headers && (req.headers["x-operator-token"] || req.headers["X-Operator-Token"]);
  return Boolean(header) && header === token;
}

module.exports = { isOperatorRequest, isLoopback };
