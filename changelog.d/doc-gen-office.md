### Chat document generation: add .docx / .xlsx / .pptx (#1237)

`POST /api/document/generate` (and the chat's "make me a …" flow) now produces **Office
formats** in addition to pdf/md/html — the model writes Markdown, then a Node generator lib
renders it:

- **.docx** (`docx`) — Markdown → Word: headings, **bold**/*italic*/`code` runs, bullet &
  numbered lists, blockquotes, code blocks, and tables.
- **.xlsx** (`exceljs`) — the model emits a Markdown table → a real worksheet (bold header,
  auto-filter, sized columns); non-table content falls back to a readable outline.
- **.pptx** (`pptxgenjs`) — a Markdown outline (`#` deck title, `##` per slide, `-` bullets)
  → a slide deck.

Wiring:
- `lib/document-builder.js`: shared `mdBlocks()` tokenizer + `renderDocx/renderXlsx/renderPptx`;
  the model system prompt is shaped per format (prose / table / slide outline).
- `lib/http-utils.js`: `sendFile` now serves the OOXML MIME types (so the OS opens them in
  Word/Excel/PowerPoint); the download route keeps the attachment filename.
- `public/js/dream-chat-ui.js`: `parseDocRequest` detects "word/docx", "spreadsheet/excel",
  "deck/slides/powerpoint" → the right `format` ("make me a Word doc / spreadsheet / deck about X").

Verified on the dev preview: all three generate as valid OOXML files through the running
server with correct content (docx headings+table, xlsx bold-header table with auto-filter,
3-slide pptx) and MIME types; `parseDocRequest` picks the right format for each phrasing.
