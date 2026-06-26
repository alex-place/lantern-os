### Autowork-from-chat: feature + code-review fixes

The Keystone chat "+" work tool, vision, document/image generation, and the
"Run as autowork → linked PR" suggest-then-confirm flow, hardened by a code review:

- **#1273** — uploaded text attachments now reach the model: their content is folded
  into the grounding context for every provider path (was parsed then silently dropped).
- **#1274** — `parseDocRequest` no longer hijacks coding requests that merely mention
  "pdf/document/report/memo"; the document noun must be the verb's direct object.
- **#1275** — the Convergence Oracle only grounds questions that actually hit a
  cosmic-time band (no more cosmology grounding prepended to every chat prompt).
- **#1276** — cross-session recall requires ≥2 distinctive shared terms and presents
  excerpts as possibly-relevant context rather than asserting them as fact.
- **#1277** — document generation reuses the canonical `renderBlock` Markdown renderer
  instead of a second hand-rolled parser.
