### Chat: `!report-card` produces a grounded, letter-grade self-assessment

- New `!report-card` bang command in dream-chat streams an honest, evidence-grounded scorecard of Keystone OS — graded dimensions, a real receipt per row, a "what would raise it" note on weak rows, and a candid Overall grade. Strengthens the Verify stage of the loop: an outside read of the system the user can check.
- Σ₀ discipline by construction (`apps/lantern-garage/lib/report-card.js`): the evidence bundle (git state, real surface counts, eval/benchmark numbers, a `node --check` boot probe) is gathered **deterministically in Node**, so the model can only synthesize grades from real measurements — it can't invent a receipt. Missing evidence is graded "not measured", never faked.
- Synthesis routes through `callLlm`'s auto cascade (Vertex leads, the funded path; #1285) rather than the credit-starved direct API-key providers, and streams in the type-based SSE format the chat UI requires.
- Companion `report-card` Claude Code skill (`.claude/skills/report-card/`) captures the same methodology for editor use.
