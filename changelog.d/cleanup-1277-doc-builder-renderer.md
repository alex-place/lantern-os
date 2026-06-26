### Cleanup
- Document generation (`lib/document-builder.js`) now reuses the canonical Markdown block renderer from `lib/markdown-render.js` instead of a second hand-rolled parser, so generated PDFs/HTML pick up nested lists, recursive blockquotes, and safe inline escaping for free (#1277).
