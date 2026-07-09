# Verify — the fifth stage of the convergence loop

**Verify is the safety stage: nothing is accepted without evidence.** After Unisona acts, it checks the result against external reality *before* treating it as true. This is the step most AI systems skip — and the one that keeps Unisona honest.

## What it means in Unisona

The rule is simple and strict: *every important claim needs a claim, its evidence, a confidence level, and a source.* An answer that can't be backed by something real — a tool result, a cited page, a file that was actually read — is flagged, not asserted. Unisona would rather say "I don't know" plainly than improvise, and it never invents sources, URLs, or facts about you.

In practice this shows up as **grounding** (tying answers to real evidence), **fact-checking**, and a **drift canary** that watches for the model drifting into confident-but-unanchored territory. Verification is deliberately placed *before* a result becomes an input to the next step, so a mistake gets caught instead of compounding.

## Where it sits in the loop

Verify scrutinizes the output of **[Act](/repo/docs/loop/act.md)**. What survives — with its evidence and confidence attached — is passed to **[Converge](/repo/docs/loop/converge.md)** to be recorded.

## The convergence loop

Observe → Remember → Reason → Act → Verify → Converge — then back to Observe.

- **[Observe](/repo/docs/loop/observe.md)** — take in the world
- **[Remember](/repo/docs/loop/remember.md)** — recall what matters
- **[Reason](/repo/docs/loop/reason.md)** — decide what to do
- **[Act](/repo/docs/loop/act.md)** — do it with real tools
- **[Verify](/repo/docs/loop/verify.md)** — check it against reality *(you are here)*
- **[Converge](/repo/docs/loop/converge.md)** — record the outcome and improve

See the [North Star briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the whole picture.
