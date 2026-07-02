# Autowork is never headless — background runs surface live in dream-chat

Autowork runs started outside the chat (the auto-dispatch daemon, CI/fleet POSTs)
were invisible: the only trace was JSONL logs and a draft PR appearing on GitHub.
Now every run routes through the Keystone chat UX:

- New `GET /api/convergence/autonomous-work/active` lists every in-flight autowork
  run (whoever started it), derived from the append-only step log.
- `GET /api/convergence/autonomous-work/status?runId=…` now returns the full step
  history so a client can attach mid-run and replay the panel.
- Runs are source-tagged (`chat` / `auto-dispatch` / `fleet`); the fleet route's
  crash path now logs a terminal `result` record under the real runId.
- dream-chat polls the active feed and attaches the existing live autowork step
  panel (with Approve / Rework / Discard actions on the PR) to any background run.

Loop stage: **Observe** (and Verify — daemon work is now reviewable where it happens).
