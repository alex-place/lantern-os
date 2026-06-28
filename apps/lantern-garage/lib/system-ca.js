"use strict";

// Trust the OS certificate store so Node's TLS verification SUCCEEDS on Windows hosts
// behind AV / corporate TLS interception — instead of DISABLING verification.
//
// Background (#1376): #869 made cloud LLM/GitHub calls work on such hosts by attaching an
// `https.Agent({ rejectUnauthorized: false })`. CodeQL flagged that as "disabling
// certificate validation" (a real MITM risk — the requests carry the API key, and the
// self-edit engine applies the response as a code diff), so commit a714d6ae removed it
// (`llmAgent = undefined`). That re-broke cloud providers on intercepting hosts — the
// "cloud unreachable / calm-while-wrong" failure in #740 / #965.
//
// The secure resolution: keep verification ON and instead teach Node to trust the SAME
// intercepting root the OS already trusts. `win-ca` loads the Windows ROOT/CA store and
// (inject:'+') appends it to every TLS context, so the default agent verifies through the
// AV cert. No `rejectUnauthorized:false` anywhere — CodeQL stays green.
//
// No-op off Windows (Railway/Linux/macOS use Node's bundled roots, or set
// NODE_EXTRA_CA_CERTS). Opt out with LANTERN_SKIP_SYSTEM_CA=1. Never crashes startup: a
// missing/failed win-ca just leaves Node's default trust store unchanged.
function trustSystemCAs() {
  if (process.platform !== "win32") return { applied: false, reason: "not win32" };
  if (process.env.LANTERN_SKIP_SYSTEM_CA === "1") return { applied: false, reason: "opt-out" };
  try {
    // async:false → certs are loaded synchronously, before the first outbound request.
    // win-ca ships prebuilt native addons, so this needs no compilation.
    require("win-ca")({ inject: "+", async: false });
    return { applied: true };
  } catch (e) {
    console.warn(
      "[system-ca] could not load the Windows cert store (" + ((e && e.message) || e) +
      "). On a TLS-intercepting host, cloud calls may fail — install win-ca or set NODE_EXTRA_CA_CERTS."
    );
    return { applied: false, reason: (e && e.message) || "win-ca unavailable" };
  }
}

module.exports = { trustSystemCAs };
