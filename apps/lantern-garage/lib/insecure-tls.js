"use strict";

const https = require("https");

// On Windows, Node's bundled CA store sometimes can't verify cloud-provider certs
// ("unable to verify the first certificate", typically local AV/TLS interception).
// Disabling verification is a SCOPED workaround — it is NOT enabled on other
// platforms unless explicitly opted in, because it exposes the API key in the
// request headers (and, for the self-edit engine, the response is applied as a code
// diff) to a man-in-the-middle. #869
//
//   LANTERN_INSECURE_TLS=1  → force-enable anywhere
//   LANTERN_INSECURE_TLS=0  → force-disable (even on Windows)
//   unset                   → insecure ONLY on win32; verification ON elsewhere
//
// This is the single source of truth; self-edit-engine.js, routes/providers.js, and
// stream-chat.js all import `llmAgent` from here so the gate can never drift apart.
const INSECURE_TLS =
  process.env.LANTERN_INSECURE_TLS === "1" ||
  (process.platform === "win32" && process.env.LANTERN_INSECURE_TLS !== "0");

// `undefined` => Node uses its default global agent (TLS verification ON).
const llmAgent = INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

module.exports = { INSECURE_TLS, llmAgent };
