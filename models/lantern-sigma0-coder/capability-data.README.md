# capability-data.jsonl — Keystone OS Capability Training Data

**Issue:** #1100  
**Status:** seed dataset, ready to mix into future Ouro training runs  
**Format:** `{instruction, input, output}` — same as `fc-toolace.jsonl` and the coding corpus  

## What this covers

| Category | Rows | Tools taught |
|---|---|---|
| Web lookup | 17 | `web_search`, `web_fetch` |
| Document generation | 8 | `generate_document`, `list_document_templates` |
| Workspace I/O | 12 | `workspace_read`, `workspace_write`, `workspace_list` |
| Combined (multi-tool intent) | 4 | all of the above |
| **Total** | **41** | |

Plain-answer rows (where no tool call is needed) are included as negatives
to prevent over-triggering.

## Format

Each row:
```json
{
  "instruction": "<PREAMBLE with tool schema>\nUser: <user message>",
  "input": "",
  "output": "<tool_call>{...}</tool_call>  OR  plain-text answer"
}
```

Tool calls use the canonical Keystone format:
```
<tool_call>{"name": "TOOL_NAME", "input": {...}}</tool_call>
```

## How to regenerate / extend

```bash
python scripts/build_capability_dataset.py --validate
# Writes models/lantern-sigma0-coder/capability-data.jsonl
```

To add more trajectories: add rows in the appropriate `*_rows()` function in
`scripts/build_capability_dataset.py`. Keep negatives balanced (~15–20% of rows).

## Mixing into an Ouro training run

This corpus is intentionally separate from the coding corpus
(`training-data.claude-combined.json`) to allow curriculum-learning:
1. Train on coding data first (existing Ouro v1/v2 runs)
2. Fine-tune on capability data (this file) to add tool-routing ability for new tasks

Mix ratio TBD based on eval results from #1059/#1060.
