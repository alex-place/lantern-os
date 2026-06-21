---
author: Alex Place
created: 2026-06-04
updated: 2026-06-20
---

# Security Policy

Keystone OS is a private, local-first workspace. Treat local state as sensitive:
journal data, RAG records, runtime receipts, secrets, tokens, operator notes,
and private test artifacts must not be committed or shared publicly.

## Reporting Security Issues

Do not open public issues for secrets, authentication bypasses, private data
exposure, unsafe remote dispatch, tunnel exposure, or local MCP/tooling leaks.

Use a private channel with the repository owner and include:

- A short description of the issue.
- The affected file, service, route, or workflow.
- Reproduction steps, if safe to share.
- Whether the issue was locally verified.
- Any redacted evidence paths or logs.

## Local-First Verification

Before trusting a remote endpoint, tunnel, mirrored surface, or advertised tool
catalog, verify the local source of truth:

- Git state and dirty worktree risk.
- Local service health.
- Actual exposed MCP tools.
- Queue, task, and log state when dispatch is involved.

## Secret Handling

- Keep real secrets in ignored local environment files or a secret manager.
- Commit only safe examples such as `.env.example`.
- Rotate any secret that appears in Git history, logs, screenshots, or public
  surfaces.

## Critical Security Fixes (2026-06-08)

### File Serving Path Traversal (routes/files.js)
**Status:** ✅ FIXED

Replaced unsafe `startsWith()` boundary check with `path.relative()` + denylist.
Prevents access to `.env*`, `data/private/`, runtime files, and secrets.

### Python Command Injection (routes/dream.js)
**Status:** ✅ FIXED

Removed user input interpolation from Python `-c` scripts. All untrusted data
(userId, choice, entry content) now passed via stdin JSON with `sys.stdin.read()`.

### HTTP Security Headers (http-utils.js, server.js)
**Status:** ✅ FIXED

Removed CORS wildcard (`Access-Control-Allow-Origin: *`). Added CSP, X-Frame-Options,
Permissions-Policy, Referrer-Policy to all HTML responses.

### Best Practices (All Agents)

1. **NEVER interpolate user input into:**
   - Python `-c` or `-m` scripts
   - Shell commands
   - SQL queries (if applicable)
   - File paths (use `path.relative()` for boundary checks)

2. **ALWAYS:**
   - Use `path.relative(root, target)` for file operations
   - Pass untrusted data via stdin, temp files, or argv with argparse
   - Validate input types and lengths
   - Maintain deny-lists for sensitive directories

3. **Test before commit:**
   ```bash
   npm run test:api --prefix apps/lantern-garage
   curl http://localhost:4177/repo/../../../.env  # Should 403 Forbidden
   ```
