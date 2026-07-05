### /api/flourishing status stops pointing at a non-existent seeder (#2094)

`emptyWorldStatus()` told users to "run integrations/human-flourishing-frameworks/seed_data.py"
to populate the world model, but that script and its directory don't exist and the HFF page
surface was already cut — a permanently misleading instruction. The message now honestly
reports that no snapshot is present and the backend serves an empty-but-valid structure until
one is written. Loop stage: **Verify** (no phantom instructions).
