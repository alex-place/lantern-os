# Issue Framing Rules & Etiquette — Lantern OS

## Purpose
Keep the issue tracker actionable, searchable, and kind. Every issue is a contract between the reporter and the person who will eventually close it.

## Before You File
1. **Search first.** Use `gh issue list --search "keywords"`.
2. **One concern per issue.** Do not bundle a bug + feature request + question.
3. **Reproduce on latest.** `git pull` and restart the server before claiming a bug.

## Title Convention
Prefix with bracketed type and a verb:
- `[BUG]` — Something is broken.
- `[FEAT]` — New capability.
- `[REFACTOR]` — Restructure without behavior change.
- `[DOOR]` — 3 Doors game content or engine.
- `[DOCS]` — Documentation only.

Bad:  `help`
Good: `[BUG] dream-chat-orion.html freezes when all providers fail`

## Body Etiquette
- **Reproduction steps** are mandatory for bugs. Include exact inputs, env vars, and observed output.
- **Expected vs Actual** — state both explicitly.
- **No screenshots of text.** Paste text inside triple backticks.
- **Attach traces** — if the server logs something, include the line.
- **Label honestly.** Use `needs-triage` if unsure. Use `p0` only for revenue- or data-loss-blocking issues.

## Labels — Locked Meanings
| Label | Meaning |
|-------|---------|
| `p0` | Revenue or data loss blocked. Fix today. |
| `context-window` | Affects AI agent context size or modularity. |
| `canon` | Changes 3 Doors lore, characters, or symbolic rules. |
| `not-closed` | Issue was closed prematurely; needs reopen criteria. |
| `needs-evidence` | Reporter must attach logs, commit range, or test case. |
| `master-backlog` | Deferred until post-convergence. Do not start work. |

## Closing Rules
- Close with a commit reference: `Closes #47`.
- If closing as duplicate, reference the original issue.
- If closing because the reporter never supplied evidence, wait 14 days and use label `needs-evidence`.

## Automation
The `scripts/issue-batch.js` helper can bulk-create issues from a JSON manifest. See `scripts/issue-batch.md` for schema.
