---
issue: 1142
status: implemented
date: 2026-06-24
---

# Kaggle Ouro multi-source session dataset

The private Ouro dataset builder now combines the existing Claude corpus with
successful Claude Code trajectories, Codex function calls, and explicitly
provided ChatGPT exports containing authentic tool calls and results.

Grounding rules:

- Codex and ChatGPT tool rows require a matching successful tool result.
- Plain ChatGPT conversations are not labeled as tool-use examples.
- Secrets, home paths, and email addresses are redacted.
- Session and tool-call provenance is hashed.
- Automatic discovery is scoped to `lantern-os`; broader sources must be
  explicitly supplied.
- Output is deterministic and deduplicated.
- Generated transcripts and combined datasets remain private and gitignored.

The Kaggle kernel now requires
`/kaggle/input/ouro-claude-sessions/training-data.claude-combined.json` and
fails closed when the private dataset is not attached.

Validation used synthetic Claude, Codex, and ChatGPT fixtures plus a bounded
dry-run over one real local Claude session and one real local Codex session.
