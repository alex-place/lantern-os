### Chat: the Creator video pipeline (create.html) is now callable in dream-chat

The short-form video pipeline that lived only on `create.html` / `entry.html` is now exposed as three operator-gated chat tools, so a user can drive it conversationally instead of switching pages. This strengthens the **Act** stage of the loop — capabilities are Tools in the one registry (ADR-0008), advertised == executed.

- **New tools in `lib/tool-runner.js`** (native `tool_use`, same registry that renders the preamble and dispatches execution):
  - `list_creator_projects` — list saved Creator projects (id, title, status) to find an `entryId`.
  - `analyze_video` — start highlight analysis (motion/scene/audio) on a project, or create one from a repo-relative `filePath`. Returns a `jobId`.
  - `creator_job_status` — poll a job; reports progress and, on completion, the highlight count + an `/entry.html?id=…` deep link.
- **`lib/creator-runtime.js`** — a tiny bridge so the in-process tools reach the server's **live** `JobQueue` singleton (the same instance `JobWorker` polls), instead of a detached copy whose jobs would never run. `server.js` populates it at startup.
- Operator-only (they spawn ffmpeg): the tools are not `guest_safe`, so the public chat surface still can't reach them; `runTool` enforces this regardless of the advertised set.
- Verified end-to-end against a real project: chat called all three tools and reported "complete. It found 2 highlights"; the `JobWorker` ran real ffmpeg motion analysis and completed the job.
