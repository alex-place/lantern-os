### Chat coding intent → autowork → linked PR (suggest-then-confirm)

A free-form coding request in Keystone chat (intent `coding_change` / `code_review` /
`technical_debug`) now answers normally **and** surfaces a one-click **"Run as autowork →"**
action under the reply. Clicking it files a GitHub issue from the request, then runs the
existing cloud-model autowork pipeline (plan → patch → tests → commit → push → **linked
draft PR**) with a live step panel. No PR is opened unless the user clicks — keeping the
loop honest (no hidden agency).

- `self-edit-engine.js`: `createIssueFromTask()` / `taskTitle()` — file a free-form task as a
  tracked issue so the pipeline stays issue-linked (every PR references a real issue).
- `autonomous-work/stream`: accepts `{ task }` (not just `{ issue }`); files the issue first,
  then works it identically. Empty body now errors `issue_number_or_task_required`.
- `dream-chat-ui.js`: the suggestion button + generalized `runAutowork(target)` (issue **or**
  `{ task }`), with a "File issue" step in the live panel for task mode.
