### Removed

- api: `GET /api/csf/search` (#2534) — it spawned `src/csf_search.py`, a file that doesn't exist anywhere in the repo, so every call failed with a spawn error; nothing in the UI, src, or tests called it (chat memory retrieval uses the `recall_memory` tool path, not this route).
