---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Engineering Mode for Dream Chat

## Overview

Dream Chat now supports **Engineering Mode** — a distinct operational state that switches the interface from RP/dream character to plain-language code coordination. When engineering mode is active, Dream Chat functions as a structured coding agent that generates actionable instructions for repository changes, PR fixes, and code integration work.

## How It Works

### Automatic Detection

Dream Chat automatically detects engineering-mode requests by scanning for specific keywords in the user's message. Triggers include:

**Repo/Code Changes:**
- "make changes directly in github"
- "make a change"
- "change the code"
- "integrate this"
- "wire this into lantern-os"
- "add to repo"

**GitHub/PR Work:**
- "prep a PR for claude code"
- "fix the latest PR"
- "scan latest PR and request changes"
- "review the PR"
- "merge the PR"

**Claude Code Handoff:**
- "make a handoff to claude code"
- "handoff to claude code"
- "use claude code"

**General Engineering:**
- "bug fix"
- "fix this bug"
- "refactor"
- "add tests"
- "implement"
- "deploy"

### Mode Behavior

When engineering mode activates:

1. **Agent Selection**: Automatically selects the `engineer` persona (Claude Code)
2. **System Prompt**: Injects a plain-language engineering prompt that emphasizes structure and actionability
3. **Dream Context Removed**: No dream journal context, no symbols mesh, no dream-specific framing
4. **No Doors**: Suppresses the three-door choices that appear in dream mode
5. **No Web Search**: Disables automatic web grounding (engineering mode stays focused)
6. **Plain Language**: Responses use direct, technical language with zero RP or metaphor

### Output Format

When asked to make code changes, the engineer persona structures responses as:

```markdown
## Problem
[What needs to change and why]

## Approach
[How you'll accomplish this]

## Files to Change
- path/to/file.js: [description of change]
- path/to/file.py: [description of change]

## Changes
[Inline diffs, copy-paste commands, git instructions, or exact code blocks]

## Verification
[How to test the change works]

## Notes
[Anything Claude Code or a developer needs to know]
```

This format is designed to be:
- Copy-paste ready
- Self-contained
- Immediately actionable
- Ground truth for code changes

## Examples

### Example 1: Code Integration

**User:** "integrate the trading agent into dream chat"

**Response (Engineering Mode):**
```markdown
## Problem
The trading agent needs to be wired into the Dream Chat interface so users can place orders, check portfolio status, and get trading signals without leaving the chat.

## Approach
1. Add trading context to the dream system prompt when user mentions market/stock keywords
2. Add a trading provider check to stream-chat.js
3. Add trading-related quick-start buttons to dream-chat.html

## Files to Change
- apps/lantern-garage/lib/stream-chat.js: Add trading context detection
- apps/lantern-garage/public/dream-chat.html: Add trading buttons
- apps/lantern-garage/lib/dream-chat.js: Add trading keywords to keystone detection

## Changes
[Exact code blocks]

## Verification
1. Open Dream Chat
2. Type "Check my portfolio"
3. Verify trading endpoint responds
4. Confirm trading buttons appear in empty state

## Notes
- Requires IBKR_ACCOUNT_ID and IBKR_LIVE_URL env vars
- Trading context should only activate for authenticated users
```

### Example 2: Bug Fix

**User:** "fix the latest PR — it's not mergeable"

**Response (Engineering Mode):**
```markdown
## Problem
PR #339 is blocked due to:
1. Oversized PR (714k characters, exceeds 256k review limit)
2. Mixed concerns: trader integration, Three-Doors breadcrumbs, Phase 4 narration
3. No workflow run found for current HEAD

## Approach
Split into focused, mergeable PRs:
1. PR-A: Trader integration only (routes, lib, endpoints)
2. PR-B: Three-Doors improvements (breadcrumbs, UX)
3. PR-C: Phase 4 narration + status report

## Changes
[git commands to create new branches and cherry-pick commits]

## Verification
1. Each PR < 256k characters
2. Each PR focuses on single concern
3. All tests pass
4. Workflow triggers for each PR

## Notes
- Keep master-targeting PRs atomic
- Test each split independently
```

### Example 3: Make a Handoff

**User:** "make a handoff to claude code to integrate three doors"

**Response (Engineering Mode):**
```markdown
## Work Packet: Three-Doors Kitchen-Sink Integration

### Context
Keystone OS integrates the Three-Doors Kingdome (3-stage game) into the main Dream Chat interface. Users should be able to start the game from quick-start chips, see breadcrumbs of prior choices, and have choices feed into convergence memory.

### Goals
1. Wire !three-doors command to game engine
2. Show breadcrumbs of choice history
3. Store choices in CSF memory
4. Handle image generation sidecar

### Entry Point
- File: apps/lantern-garage/public/js/dream-chat.js
- Function: startThreeDoors()  (line ~1100)
- Current state: Documented but incomplete

### Next Step for Claude Code
1. Read apps/lantern-garage/public/js/dream-chat.js: line 1100-1200
2. Check three_doors_engine.py for API contract
3. Implement startThreeDoors() with full game loop
4. Add breadcrumb UI below messages
5. Test with game flow start → door selection → convergence

### Acceptance Criteria
- Game launches from quick-start chips
- Choices stored in CSF delta
- Breadcrumbs render correctly
- Image generation queued (non-blocking)

---
**Ready for Claude Code. Use `/claude-code --handoff` to continue.**
```

## Implementation Details

### Frontend (JavaScript)

**File:** `apps/lantern-garage/public/js/dream-chat.js`

Added:
- `ENGINEERING_TRIGGERS` array: List of keywords that activate engineering mode
- `detectEngineeringMode(msg)`: Function that checks if message contains engineering keywords
- Updated `sendMessage()`: Passes `engineeringMode` flag to backend

### Backend (Node.js)

**File:** `apps/lantern-garage/lib/stream-chat/request.js`

Modified:
- `parseStreamChatRequest()`: Extracts `engineeringMode` from request body
- Returned parsed object includes `engineeringMode` boolean

**File:** `apps/lantern-garage/lib/stream-chat.js`

Modified:
- `handleStreamChat()`: Receives `engineeringMode` flag
- Forces `agent = "engineer"` when `engineeringMode === true`
- Skips web search grounding in engineering mode
- Uses plain engineer system prompt (no dream context, no doors)
- Passes `engineeringMode` to `doorsOrFallback()` to suppress door suggestions

**File:** `apps/lantern-garage/lib/dream-chat.js`

Added:
- New `engineer` persona with plain-language system prompt
- Persona specifies structured output format
- Explicitly notes "no RP, no character, no metaphor"

### Engineer Persona System Prompt

```
You are Claude Code — a plain-language software engineering agent...

## Style
- No RP, no character, no metaphor. Plain technical language only.
- Respond as if preparing work for a coding agent or Claude Code CLI.
- Structured sections: Problem, Approach, Changes, Verification, Notes.

## Key behaviors
- Detect repo context from the user's message
- Prepare complete, copy-paste-ready instructions for code changes
- Format as a self-contained work packet when asked for handoff
- Ground in lantern-os repository structure

## Output format for code changes
[See example above]
```

## When to Use Engineering Mode

### Use Engineering Mode When:
- User asks for code changes, repo edits, or integrations
- PR review, fixing, or preparation is requested
- Handoff to Claude Code is needed
- Bug fixes or implementations are requested
- Git/GitHub operations need coordination

### Don't Use Engineering Mode When:
- User is journaling, reflecting, or sharing dreams
- User wants symbolic/archetypal guidance
- User is exploring Three-Doors game
- General conversation is happening
- Code questions are context-less (e.g., "what's React?")

## Migration & Testing

### Backward Compatibility
- All existing dream-chat functionality unchanged
- Engineering mode is **opt-in** via keywords
- Falls back to dream mode if no engineering keywords detected
- No breaking changes to API or UI

### Testing Engineering Mode

1. **Start Dream Chat:**
   ```bash
   npm start --prefix apps/lantern-garage
   ```

2. **Type engineering requests:**
   - "make changes directly in github"
   - "prep a PR for claude code"
   - "fix the latest PR"
   - "wire this into lantern-os"

3. **Verify:**
   - Response is plain language (no dream persona)
   - No three-door choices appear
   - Agent name shows "Claude Code"
   - Output is structured (Problem, Approach, Changes, etc.)

## Future Enhancements

- [ ] GitHub PR parser: fetch actual PR diffs and analyze blockers
- [ ] Git context loader: pass current branch, uncommitted changes, recent history
- [ ] Smart handoff formatter: auto-generate work packets with file diffs
- [ ] Engineering mode commands: !rebase, !split-pr, !test-suite
- [ ] Integration with Claude Code CLI: one-click handoff execution
- [ ] Convergence loop integration: engineering work triggers convergence checks

## Related Files

- `CLAUDE.md` — Project instructions and guidelines
- `AGENTS.md` — Monoworkstream rules and agent lanes
- `apps/lantern-garage/server.js` — Main server entry point
- `apps/lantern-garage/lib/dream-chat.js` — Agent personas and selection
- `apps/lantern-garage/lib/stream-chat.js` — SSE streaming handler

---

**Status:** ✅ Implemented and ready for use  
**Author:** Claude Code  
**Date:** 2026-06-12  
**Last Updated:** 2026-06-12
