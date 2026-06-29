### Fixed
- File upload from the home page and chat now attaches the file to the conversation so the LLM can read it. Removed the auto-PDF → Knowledge Center diversion and the blocking `window.prompt()` docx dialog; only `.docx` keeps the optional improve-&-rewrite flow. (#1514)
