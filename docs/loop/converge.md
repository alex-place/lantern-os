# Converge — the sixth stage of the convergence loop

**Converge is where a single interaction becomes lasting capability.** Once a result has been verified, this stage records what happened so the whole system is a little better prepared next time — and then the loop begins again.

## What it means in Unisona

Each meaningful outcome is written down as a **convergence record**: a *hypothesis*, the *evidence* gathered, the *result*, and a *confidence* level. These records are one of Unisona's four core objects (alongside Memory, Tasks, and Tools), and they're what let the system measure whether it's actually getting better rather than just busier.

Converge is why Unisona improves through **experience, not retraining**. It doesn't modify a model's weights; it accumulates verified records and better memory, so future runs retrieve stronger context and repeat what worked. You can see this stage in the convergence **metrics** and agent-status surfaces.

Then the loop closes: what was learned here feeds back into **[Observe](/repo/docs/loop/observe.md)** and **[Remember](/repo/docs/loop/remember.md)**, so the next question starts from a smarter baseline. **Observe → Remember → Reason → Act → Verify → Converge → Observe…** — that single loop is the entire system.

## Where it sits in the loop

Converge takes the verified result from **[Verify](/repo/docs/loop/verify.md)**, records it, and hands what it learned back to the start of the loop.

## The convergence loop

Observe → Remember → Reason → Act → Verify → Converge — then back to Observe.

- **[Observe](/repo/docs/loop/observe.md)** — take in the world
- **[Remember](/repo/docs/loop/remember.md)** — recall what matters
- **[Reason](/repo/docs/loop/reason.md)** — decide what to do
- **[Act](/repo/docs/loop/act.md)** — do it with real tools
- **[Verify](/repo/docs/loop/verify.md)** — check it against reality
- **[Converge](/repo/docs/loop/converge.md)** — record the outcome and improve *(you are here)*

See the [North Star briefing](/repo/docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the whole picture.
