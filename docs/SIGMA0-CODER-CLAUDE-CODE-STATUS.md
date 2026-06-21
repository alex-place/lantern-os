---
title: Σ₀ Coder in Claude Code — Integration Status
created: 2026-06-21
status: honest / evidence-tagged
---

# Σ₀ Coder in Claude Code — Integration Status

Can the local Σ₀ Ouro-1.4B coder drive **Claude Code** (and the in-app chat) as a
tool-using agent, instead of a frontier cloud model? This is the honest status. For the
model itself see [Σ₀ Ouro Coder](SIGMA0-OURO-CODER.md); for the next training step see the
[retraining handoff](research/2026-06-21-sigma0-coder-retraining-handoff.md); to run it on a
second machine see the [dev-box setup guide](SIGMA0-CODER-DEVBOX-SETUP.md).

## The gap, and the bridge that closes it
Claude Code speaks only the Anthropic Messages API (`/v1/messages`); the Ouro server speaks
the Ollama API. `scripts/ouro_anthropic_bridge.py` translates between them — injecting the
tool definitions into the prompt, parsing the model's `<tool_call>` back into Anthropic
`tool_use` blocks, and supporting forced `tool_choice` (prefill). **The protocol round-trips
cleanly** [verified: curl + headless `claude -p`].

## What works
- **Bridge** — Anthropic ↔ Ollama with tool injection + parse + forced mode. ✓
- **Standalone agent loop** (`scripts/sigma0_coder_agent.py`) — forced-ReAct over sandboxed
  tools; drove a real task end-to-end and finished grounded (counted 121 `.py` files). ✓
- **Tool-aware in-app chat** — the garage renders the adapter's `<tool_call>` as a card and
  (gated by `CHAT_TOOL_EXEC`, operator-gated for shell/mutating) executes it through one
  canonical tool registry. Merged to master (v1.7.14). ✓
- **FC-retrained adapter** — a QLoRA pass taught the *trigger*: under auto `tool_choice` it
  now spontaneously emits `tool_use`, where the stock adapter was 0/3. ✓

## The honest blocker — model reliability, not plumbing
The integration is solved; the 1.4B adapter is not reliable enough to *drive* Claude Code:
- It **under-triggers / over-refuses** — 0/3 tool calls on Claude-Code-shaped requests
  (memorized refusal templates), erratic across phrasings [verified: bridge test 2026-06-21].
- It is **Bash-biased** (the harvest was Bash-heavy) and weak at multi-step grounding.
- Hard ceiling: Claude Code's **~20k-token system prompt** overwhelms a model trained at
  seq 1024.

Net vs. the first attempt: stock model **couldn't call tools at all**; retrained model
**can, just not reliably yet.** Real progress, not done.

## Next lever
The [retraining handoff](research/2026-06-21-sigma0-coder-retraining-handoff.md): rebalance
the corpus (downweight Bash, diversify the 3 refusal strings → 150+, drop negatives
25%→~10%), add Hammer function-masking, 2 epochs — targeting the BFCL irrelevance/relevance
axis. A reliable trigger is the gate before a full Claude-Code run is worth doing (with the
live session stopped, so two model processes don't crash the 8 GB GPU).
