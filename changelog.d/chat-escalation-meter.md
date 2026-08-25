### Chat escalation meter: measure how often a turn actually needs the expensive tier

New `lib/chat-escalation-meter.js` + `GET /api/metrics/escalation`, hooked at the single
`logConversation` funnel in `lib/stream-chat.js` so one site covers all ~15 provider legs. Records
derived scalars only — tier, sizes, latency, a one-way session hash — never message text, because
the trader surface carries positions and P&L through this same chat path; fail-open so metering
can never break a turn. 20 unit tests.

Why: measured from the product (`docs/research/2026-07-27-in-house-model-spec-grounded-in-the-product.md`),
serving 10,000 users' ordinary chat on the cheap tier costs ~$5.9k/mo — trivial against $20 Pro —
while one frontier turn costs 37–67× a cheap one. The escalation premium *is* the cost curve, and
that number existed for the coding path (`keystone-escalation.readRolloverShare`) but never for
chat. First reading, backfilled over 35 real turns: **0% realized, 2.9% demand** — against the
spec's own 20% assumption, so the cost case for owning a model is weaker than assumed (n=35 is far
below the 1,000-turn bar; not decisive). The capability case — calibrated confidence, positions
that stay on the box, latency inside the decision — is unaffected.

Two traps caught and pinned with tests: substring tier matching classified `gemini-2.5-pro` as
cheap (`mini` inside "ge-mini-"), which would have understated the rate; and a realized rate of 0
means "escalation is switched off", not "nobody needed it" — so the meter also computes the router
gate in measure-only mode and reports `POLICY-BOUND` rather than `BUILD-NEGATIVE` in that case.

Docs: ADR-0024 and ADR-0026 carry **Proposed** amendments (re-scope Phase 1 from pretraining a
frontier model to post-training an open base into a verifier; add a batched cloud deployment shape
since an 8GB box cannot serve thousands, plus a calibration check in the accept gate). ADR-0030
gains concrete Phase-1 content (fuse the model's early-exit signal with the Spiral's escalation
trigger). `SIGMA0-OURO-CODER.md` records a verified doc/code gap: the documented verified-halt
includes held-out checks, and the shipped spiral harness implements none.
