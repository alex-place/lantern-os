chore(brand): sweep "Keystone" / "Keystone OS" → unisona.ai across prose and user-visible copy

Completes the #2250 rebrand: the user-visible brand was already Unisona on the
HTML surfaces, but ~700 prose mentions of "Keystone"/"Keystone OS" survived in
docs, system prompts, SSE route labels, generated-document metadata, and the
Knowledge Center doc titles. All are now **unisona.ai**.

- Case-sensitive, standalone-word sweep (722 replacements, 209 files) + hand
  polish of the chat identity prompts (`stream-chat.js` KEYSTONE_IDENTITY /
  ROUTER_PROMPT / debug prompt, `personas.json`, `dream-chat.js` fallback).
- Left intact, by design: `keystone-*` code ids, file names, env vars
  (`KEYSTONE_*`), the `keystone` persona id and `keystone-ft` model tag, the
  Three Doors in-game character "Keystone" (fiction, not brand), append-only
  data logs, and dated historical records (handoffs/worklogs/research/CHANGELOG).
- `data/knowledge/doc-catalog.json` retitled and the Knowledge Center +
  RAG index regenerated with the repo's own builders (`build_doc_library.js`,
  `build_knowledge_index.py`).
- Brand guidelines now codify the rule ("Keystone" retired like "Lantern OS");
  brand-guard allowlist comments updated; GitHub release display name renamed.
- Also swept the #2250 residue "Unisona OS" → unisona.ai (footer copyright,
  page titles, PWA manifest, all four locale files, update banner).
- Lockstep test updates (route labels, identity strings, fixtures). Verified:
  brand guard green across 41 surfaces, `node --check` on server + libs, the
  touched offline node tests, and the affected pytest files.

Loop stage: Verify — one honest brand across every surface the user (and the
model itself) reads; the identity block no longer teaches the assistant a name
the UI never shows.
