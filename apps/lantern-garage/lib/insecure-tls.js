"use strict";

// TLS verification is ON for every LLM / provider / GitHub HTTPS call — no certificate
// validation is disabled anywhere (so CodeQL's "disabling certificate validation" finding
// stays satisfied without an inline suppression).
//
// On Windows hosts behind AV / corporate TLS interception, Node's bundled CA store can't
// verify the intercepting cert ("unable to verify the first certificate"). Rather than
// disable verification (the #869 `rejectUnauthorized:false` workaround CodeQL flagged, which
// then re-broke cloud providers when reverted — #740 / #965 / #1376), the OS root store is
// loaded once at startup in lib/system-ca.js (via win-ca) so verification SUCCEEDS through
// the same root the OS already trusts.
//
// `llmAgent` stays `undefined` (Node's default global agent), so the existing consumers
// (`stream-chat.js`, `self-edit-engine.js`, `routes/providers.js`, `lib/update-check.js`)
// keep `agent: llmAgent` unchanged — it now relies on the system-CA trust above. On a host
// where the OS store can't be loaded, set NODE_EXTRA_CA_CERTS (preferred); we never disable
// validation in code.
const llmAgent = undefined;

// INSECURE_TLS retained (always false) for backward-compatible imports; nothing disables
// validation anymore.
module.exports = { INSECURE_TLS: false, llmAgent };
