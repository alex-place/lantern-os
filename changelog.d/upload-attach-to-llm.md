### Fixed
- File upload from the home page and chat now attaches the file to the conversation so the LLM can read it. Removed the auto-PDF → Knowledge Center diversion and the blocking `window.prompt()` docx dialog; `.docx` still keeps the optional improve-&-rewrite flow. (#1514)

### Added
- Document extractor now parses all common document types for chat attachments: `.docx` (mammoth), `.xlsx`/`.xlsm` (exceljs), `.pptx` (jszip), in addition to the existing PDF, image-OCR, and plain-text formats (`.txt/.md/.csv/.tsv/.json/.xml/.html/.yaml/.log`). (#1514)
