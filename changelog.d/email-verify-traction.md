Instrument email verification as a MEASURED signup event. The verify-email
handler now emits a verified `signup` traction event (once per confirmation,
guarded on the pre-update flag) into the adoption ledger (`lib/traction.js` →
`data/traction/events.jsonl`), so a confirmed email finally shows up in
telemetry / the report card instead of being a silent `updateProfile`. The
default operator identity set now includes the operator's Google-login gmail so
dogfooded confirmations classify as `operator` and never inflate external
adoption. Loop stage: OBSERVE.
