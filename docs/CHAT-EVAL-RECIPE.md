# Running a chat capability / benchmark test manually

A runbook for driving `dream-chat.html` through a prompt suite (golden benchmark
*or* freeform capability list) and scoring the results — written down so the next
run skips the legwork this one paid for. Every gotcha below was hit live on
2026-07-09 while running HumanEval-chat + a 20-prompt capability suite.

## TL;DR — the fast path

1. **Server:** start the `lantern-dev` preview config (`server-dev.js`, port 4178,
   `CHAT_TOOL_EXEC=1`). Confirm `curl http://127.0.0.1:4178/api/health` is UP and
   `/api/providers/status` shows at least one provider `hasKey:true`.
2. **Warm the provider once** (see gotcha #1) with a throwaway turn before you
   start counting — the first turn of a cold session can spuriously error.
3. **Drive plain turns.** Set `#input`, dispatch an `input` event, click `#send-btn`.
   Do **not** pass `routeIntent: "coding_change"` unless you are specifically
   testing the coder route — it stalls in the local-first dev config (gotcha #2).
   The router classifies coding prompts correctly on its own.
4. **Pace off the disk log, not the DOM** (gotcha #3 + #4): after each send, poll
   `data/conversations/garage-conversations.jsonl` for the new `role:"lantern"`
   row that follows your `role:"operator"` prompt. This survives the 30s
   `preview_eval` cap *and* a mid-run server crash.
5. **Grade:**
   - Golden coding benchmark → reuse the real sandbox:
     `from eval_humaneval_ouro import make_candidate, run_test` (in `scripts/`).
     Wrap the reply as a ```python fence and run the canonical unit test.
   - Open-ended prompts → LLM-judged (no ground truth). Only a few are objectively
     checkable (fact-check, code-review, SQL, curl→requests) — verify those hard.

For the fully automated coding path, `scripts/eval_humaneval_chat.py` already
drives `POST /api/dream/chat/stream` over all 164 problems and writes a
`data/eval/leaderboard.jsonl` row. Use it for the headline number; use this manual
recipe when you want the *browser* path or a non-coding suite.

## Gotchas (each cost real time — don't rediscover them)

1. **Cold-start provider error.** The first message of a fresh session (or the
   first after a restart) can return *"No AI providers are set up"* /
   *"AI unavailable"* even when `/api/providers/status` shows all keys present —
   provider `health` is still `"untested"`. It self-heals on the next turn. Warm
   with one throwaway send first. Tracked in
   [#2128](https://github.com/alex-place/lantern-os/issues/2128).

2. **`routeIntent: "coding_change"` hangs** when `KEYSTONE_SERVE_OURO=1` but no
   Ouro is actually served: the SSE emits only the `route` event, then nothing.
   Plain turns route around it. Tracked in
   [#2321](https://github.com/alex-place/lantern-os/issues/2321).

3. **`preview_eval` has a hard 30s cap.** A batch runner or any single slow turn
   (long generations run 20–30s) will time out the eval even though the send
   already fired. Don't batch turns inside one eval — send one at a time,
   fire-and-forget, and recover the reply from the disk log.

4. **The server can crash mid-run** on a long generation and take all in-page JS
   state with it (`preview_list` empties, port goes dead). The conversation log
   `data/conversations/garage-conversations.jsonl` is the source of truth — every
   turn persists there (capped at 4000 chars/entry). Rebuild results from it.
   Tracked in [#2320](https://github.com/alex-place/lantern-os/issues/2320).

5. **Rendered code blocks use `<br>` for newlines.** `textContent` collapses them
   and destroys Python indentation. When extracting from the DOM, replace
   `<br>` → `\n` on `innerHTML`, strip tags, then decode entities. (The disk log
   stores clean text, so pacing off disk sidesteps this entirely.)

6. **Groundedness bands are noisy on closed-context tasks.** A faithful
   "summarize this provided text" answer came back `red`. Don't treat the band as
   a pass/fail gate when judging. Tracked in
   [#2322](https://github.com/alex-place/lantern-os/issues/2322).

7. **Placeholders/attachments.** Many capability prompts reference an attachment or
   a `[placeholder]`. Supply a small inline stand-in (dataset, transcript, snippet)
   so the turn is runnable, and note in the report that a real attachment would
   change the result.

## Selectors & storage reference

| Thing | Where |
|---|---|
| Input textarea | `#input` (dispatch `input` event after setting `.value`) |
| Send button | `#send-btn` |
| Assistant messages | `#messages .message.agent` → `.message-content` |
| Groundedness band | `.message-content[data-groundedness-band]` (green/amber/red) |
| Persisted turns | `data/conversations/garage-conversations.jsonl` (`role`: `operator`=human, `lantern`=assistant) |
| HumanEval dataset (offline) | `HF_HOME=D:\hf-cache`, `HF_DATASETS_OFFLINE=1` |
| Coding grader | `scripts/eval_humaneval_ouro.py` → `make_candidate`, `run_test` |
| Full coding harness | `scripts/eval_humaneval_chat.py` (writes `data/eval/leaderboard.jsonl`) |
