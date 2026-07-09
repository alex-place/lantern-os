# Act — the fourth stage of the convergence loop

**Act is where Unisona does things, not just talks about them.** Reasoning decides what would help; Act carries it out with real tools that produce real results.

## What it means in Unisona

Unisona's capabilities are actual tool calls, the same way Claude, ChatGPT, or Gemini use tools — not scripted flows or keyword tricks. Depending on what the deployment offers, Act can: search the web and fetch pages, generate a Word/Excel/PowerPoint document you can download, read and write your workspace files, pull market data, and read a repository or open GitHub issues and pull requests.

The discipline here is **honesty about actions**: Unisona only claims it did something if the tool call actually ran this turn and returned a result. It shows the work inline, or says what it *will* do — never invents a document it didn't create or a change it didn't make. Bigger jobs can be dispatched to background agents and tracked in **Work** and **Orchestration**.

## Where it sits in the loop

Act executes the plan from **[Reason](/repo/docs/loop/reason.md)** and produces concrete outputs — a file, an answer, a change. Those outputs don't get trusted automatically; they go straight to **[Verify](/repo/docs/loop/verify.md)**.

## The convergence loop

Observe → Remember → Reason → Act → Verify → Converge — then back to Observe.

- **[Observe](/repo/docs/loop/observe.md)** — take in the world
- **[Remember](/repo/docs/loop/remember.md)** — recall what matters
- **[Reason](/repo/docs/loop/reason.md)** — decide what to do
- **[Act](/repo/docs/loop/act.md)** — do it with real tools *(you are here)*
- **[Verify](/repo/docs/loop/verify.md)** — check it against reality
- **[Converge](/repo/docs/loop/converge.md)** — record the outcome and improve

See the [North Star briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the whole picture.
