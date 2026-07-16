### Fixed

- chat: the Three-Doors `[DOORS:…]` control marker no longer appears in the finished chat bubble (#2497). The strip now lives in `renderMarkdown()` itself, so streaming, finalize, and history replay of persisted messages all render the same clean prose; door chips are unaffected (they parse the raw text separately).
