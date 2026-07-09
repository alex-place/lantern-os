# Reason — the third stage of the convergence loop

**Reason is where Unisona decides what to do.** With a fresh observation and the relevant memory in hand, this is the stage that plans: what the user actually wants, which tools would help, and how to put together a useful answer.

## What it means in Unisona

Reasoning is done by a large language model — and in Unisona the model is **interchangeable**. Claude, GPT, Gemini, Grok, or a local on-device model can each plug into the same loop; the system routes to whichever is the best fit (and can fall back if one is unavailable). The loop never assumes a specific brand of intelligence.

The model doesn't just produce text — it decides which **capabilities** to invoke. Should it search the web? Read a file? Generate a document? Look at a repository or market data? Those decisions are made here, and carried out in the next stage. Reason also sets the standard for the answer: deliver substance first, make reasonable assumptions rather than interrogating you with forms, and mark real gaps honestly instead of bluffing.

## Where it sits in the loop

Reason turns the context assembled by **[Remember](/repo/docs/loop/remember.md)** into a plan. When that plan calls for doing something in the world, it hands off to **[Act](/repo/docs/loop/act.md)**.

## The convergence loop

Observe → Remember → Reason → Act → Verify → Converge — then back to Observe.

- **[Observe](/repo/docs/loop/observe.md)** — take in the world
- **[Remember](/repo/docs/loop/remember.md)** — recall what matters
- **[Reason](/repo/docs/loop/reason.md)** — decide what to do *(you are here)*
- **[Act](/repo/docs/loop/act.md)** — do it with real tools
- **[Verify](/repo/docs/loop/verify.md)** — check it against reality
- **[Converge](/repo/docs/loop/converge.md)** — record the outcome and improve

See the [North Star briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the whole picture.
