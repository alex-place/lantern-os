refactor(chat): one assistant + real tool calls — remove keyword personas and scripted skill flows

The chat now works like Claude/ChatGPT/Gemini: ONE assistant whose capabilities
are native tool calls, instead of keyword-routed personas and form-filling
skill scripts. "help me work on my resume" gets substantive help in the first
reply (using the attached resume) rather than a demand for ten template fields.

Removed (Reason-stage simplification, replaced with real tools):

- `selectAgent()` keyword scoring across trader/engineer/job_application/Σ₀
  fallback personas — every path now resolves the single `keystone` assistant
  (`data/contexts/personas.json`, rewritten as a conversational + tool-using
  contract with Σ₀ grounding intact).
- `TASK_LENSES` / `dynamicAgentFor()` regex prompt lenses — PCSF provider
  ranking already gets its taskType from `detectTaskType`.
- The keyword-triggered trading context stuffer in `dreamChatReply` that
  pre-fetched from the removed port-5050 Python trader (#1959) — market data
  is the model calling `trader_market_status`/`trader_quote`/`trader_positions`.
- The forced `<REQUIREMENT>…<CONFIDENCE>` Σ₀ reply format on local coding
  turns (sigma0 persona) — grounding rules live in the one assistant prompt.
- Fixed `AGENT_PERSONAS.creed` in the Tomorrow-Door analysis path (property
  access on an array — always undefined, so the path threw before streaming).

Reframed as conversational tools:

- `generate_document` / `list_document_templates`: every template field is
  optional; the tool descriptions now tell the model to draft from the
  conversation and attachments, mark gaps like "[add phone]", and never make
  the user fill in a field list (no fabricated user facts — Σ₀).
- `ROUTER_PROMPT` (the live chat system prompt) gains the working-style rules:
  substance in the first reply, at most one clarifying question, attachments
  are first-class, tools on the model's own initiative.

Live-test round 2 (operator dogfood findings, Σ₀-council-reviewed and
web-grounded — resumes are expected as .docx by employers/ATS, and frontier
assistants deliver real document files):

- generate_document now defaults to a REAL .docx (md→docx via the exported
  document-builder renderDocx — ZIP/OOXML, not renamed HTML), writes it to the
  user workspace, and returns a clickable download link served by the new
  operator-gated GET /api/workspace/download route (workspace docs are PII).
- New document_request intent (model-router) so "update my resume" no longer
  keyword-ties into coding_change/technical_debug: document turns get the
  "Keystone · documents" label and never surface the "Run as autowork" offer
  (plus a client-side _looksLikeDocument belt in dream-chat-ui).
- Prompt honesty: attachments are pre-extracted to text (docx/pdf/xlsx/pptx/
  images) — the assistant must never claim it cannot read an attached file.

Docs/tests updated: CLAUDE.md, docs/ARCHITECTURE.md, skills/job_application/
SKILL.md, tests/test_dream_chat_routing.js (was asserting the removed 6-persona
design and already failing; now also covers document_request classification),
tests/regression/agent-compliance.js Rule 8, document-generation.test.js
(docx-default + ZIP-magic + download-link cases).
