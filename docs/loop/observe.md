# Observe — the first stage of the convergence loop

**Observe is how Unisona takes in the world.** Everything starts here: your message, the files you attach, and anything Unisona pulls in on your behalf — a web page, today's market data, the contents of a repository, an email. Nothing happens until something is observed.

## What it means in Unisona

When you type into the chat or drop in a document, that becomes an **observation** — a concrete input the rest of the loop can work from. Attachments (PDF, Word, spreadsheets, images) are read and turned into plain text so the assistant can actually use them, not just acknowledge them. When a question needs fresh facts, Observe reaches outside the model — a live web search, a market quote, a file read — rather than guessing from training data.

The guiding rule (the **External Reality Rule**) is set right here: *external reality beats internal consistency.* An answer built on something Unisona actually observed is worth more than one that only sounds right.

## Where it sits in the loop

Observe is the front door. What it takes in is handed to **[Remember](/repo/docs/loop/remember.md)**, which brings back everything relevant you've told Unisona before — so a new observation is never considered in isolation.

## The convergence loop

Observe → Remember → Reason → Act → Verify → Converge — then back to Observe.

- **[Observe](/repo/docs/loop/observe.md)** — take in the world *(you are here)*
- **[Remember](/repo/docs/loop/remember.md)** — recall what matters
- **[Reason](/repo/docs/loop/reason.md)** — decide what to do
- **[Act](/repo/docs/loop/act.md)** — do it with real tools
- **[Verify](/repo/docs/loop/verify.md)** — check it against reality
- **[Converge](/repo/docs/loop/converge.md)** — record the outcome and improve

See the [North Star briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the whole picture.
