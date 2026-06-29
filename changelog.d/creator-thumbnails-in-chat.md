### Chat: Creator project thumbnails render inline + markdown replay fidelity

- **`list_creator_projects` / `creator_job_status` now surface thumbnails.** Each project's `/media/<thumbnail>` is returned as a markdown image, so the chat shows a small gallery of 9:16 stills instead of plain text. Paths are normalized to URL separators and `encodeURI`'d.
- **`renderMarkdown` now accepts site-absolute image/link URLs.** The image and link rules required `https?://`, so a `/media/…` thumbnail rendered as raw `![..](..)` text. They now also accept `/`-rooted paths (`safeUrl` already gated these) — fixes thumbnails and any other site-absolute markdown link/image in chat.
- **Replayed agent turns render markdown (durability fix).** History replay (`dream-chat.js loadConversationHistory`) escaped agent text instead of running `renderMarkdown`, so on reload/session-switch all markdown — bold, links, code, and now thumbnails — showed literal. Agent text now replays through the same `renderMarkdown` as the live SSE finalize; user text stays escaped.
- Verified live and after a full page reload: `list_creator_projects` renders two 720×1280 thumbnails inline.
