Fixed: Knowledge Center index no longer mints junk sections from code-block
contents. `split_sections` in `build_knowledge_index.py` was treating `#` comment
lines *inside* ```` ``` ```` fenced blocks as markdown headings, which truncated
real sections to a bare opening fence (`text: "```bash"`, 1 token) and coined
bogus headings from shell comments / URLs. These stubs leaked into chat as junk
answers (e.g. asking "is ollama running" returned `` ```bash `` + a QUICKSTART.md
citation). The splitter is now fence-aware, and `knowledge-router.js` guards
retrieval + deterministic/near answers behind a `hasProse()` check so a
prose-less section can never be served verbatim. Index rebuilt.
