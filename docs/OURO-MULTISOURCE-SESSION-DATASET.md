# Ouro multi-source session dataset

The private Kaggle dataset `lanternfounder/ouro-claude-sessions` must contain
`training-data.claude-combined.json`. Kaggle mounts it at:

`/kaggle/input/ouro-claude-sessions/training-data.claude-combined.json`

The historical name is retained for compatibility. The JSON array now combines:

- the existing scrubbed Claude training corpus;
- successful Claude Code tool trajectories;
- successful Codex function calls with matching function-call outputs;
- ChatGPT export turns with authentic tool calls and matching tool results.

Plain ChatGPT conversations are not labeled as tool examples. Missing or
errored tool results are rejected. Every generated row includes source, hashed
session, tool-use, and hashed call provenance under `metadata`.

## Build locally

Generated session data is private and gitignored:

```powershell
python scripts/build_claude_session_dataset.py `
  --base models/lantern-sigma0-coder/training-data-rebalanced.jsonl `
  --chatgpt-source C:\private\chatgpt-export\conversations.json `
  --out models/lantern-sigma0-coder/training-data.claude-combined.json
```

The builder discovers Claude under `CLAUDE_PROJECTS_DIR` (or
`~/.claude/projects`) and Codex under `CODEX_HOME` (or `~/.codex`). ChatGPT has
no implicit filesystem scan: pass `--chatgpt-source` or set
`CHATGPT_SESSION_EXPORT`.

Automatic Claude and Codex discovery is restricted to session paths/working
directories containing `lantern-os`. Change that marker with `--match`; explicit
source paths remain available for deliberately scoped imports.

Run with `--dry-run` first. The summary reports discovered files, source rows,
tool rows, skipped/error records, redactions, and deterministic deduplication.
Review the summary and private output before uploading it to Kaggle.

No raw transcript or generated combined dataset belongs in Git.
