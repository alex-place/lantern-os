# Remember — the second stage of the convergence loop

**Remember is what makes Unisona yours.** A normal chatbot forgets you the moment the tab closes. Unisona keeps a durable, private memory of what you've told it and what it has learned, and brings the relevant pieces back when they matter.

## What it means in Unisona

Memory is **append-only**: new facts, notes, and results are added to a log rather than overwriting the old — nothing is silently lost, and confidence in a fact can shift over time instead of vanishing. On top of that log sits the **CSF archive**, a compact, searchable store of everything worth keeping.

When you ask something, Unisona doesn't just read your latest message — it **retrieves** the notes, past conversations, documents, and profile details that bear on it, and feeds those into the answer. That's why a returning user doesn't have to re-explain themselves. You can browse this memory yourself in **Explore** and the **Knowledge Center**.

Crucially, Unisona improves by *remembering more and retrieving better* — not by retraining a model. Your experience is stored as data you own, not baked into weights.

## Where it sits in the loop

Remember takes a fresh observation from **[Observe](/repo/docs/loop/observe.md)** and surrounds it with relevant context. That enriched picture is what **[Reason](/repo/docs/loop/reason.md)** thinks with.

## The convergence loop

Observe → Remember → Reason → Act → Verify → Converge — then back to Observe.

- **[Observe](/repo/docs/loop/observe.md)** — take in the world
- **[Remember](/repo/docs/loop/remember.md)** — recall what matters *(you are here)*
- **[Reason](/repo/docs/loop/reason.md)** — decide what to do
- **[Act](/repo/docs/loop/act.md)** — do it with real tools
- **[Verify](/repo/docs/loop/verify.md)** — check it against reality
- **[Converge](/repo/docs/loop/converge.md)** — record the outcome and improve

See the [North Star briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the whole picture.
