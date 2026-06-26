### Orchestration: non-stream autowork route brought to parity (no-cloud message + task-mode)

- The non-stream `POST /api/convergence/autonomous-work` route — the one the auto-pull **fleet** loop (`lib/auto-dispatch.js`) calls — now handles an out-of-credits/quota plan failure the same way the SSE stream route does: it returns an actionable `502 {ok:false, error:"no_cloud_model", message}` ("Autowork needs a working cloud model… add credits") instead of a generic `500` that leaked `err.stack`.
- Both autowork routes now accept a free-form `{ task }` body: with no issue number, the task is filed as a real GitHub issue (via the existing `createIssueFromTask`) and worked through the unchanged research → plan → patch → test → PR pipeline. The bare-issue 400 is now `issue_number_or_task_required`.
- Reuses the stream route's conventions (inline no-cloud regex, shared `createIssueFromTask` from `self-edit-engine`) so a future fix to one route can't silently miss the other.
