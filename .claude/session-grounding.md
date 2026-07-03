# Σ₀ Session Grounding — read before acting

**THE ENTIRE PROJECT IS ONE LOOP:**
Observe → Remember → Reason → Act → Verify → Converge
Every feature must strengthen ONE stage of this loop. Nothing else.

**FIRST PRINCIPLES** (from [docs/CONVERGANCE-SIGMA0-BRIEFING.md](docs/CONVERGANCE-SIGMA0-BRIEFING.md) — immutable North Star):
1. External reality beats internal consistency — every important claim needs [claim, evidence, confidence, source].
2. Verification is mandatory — every hypothesis tested, every code change validated, grounding is the safety mechanism.
3. Models are replaceable — never hardcode a provider.
4. Memory is persistent — append-only JSONL + CSF archive; nothing deleted, confidence shifts.
5. Learning is retrieval + experience, NOT weight modification — never retrain.
6. Local ownership is a feature — user owns memory, codebase, model selection.
7. Architectural sprawl is technical debt — one loop, four objects (Memory, Task, Tool, ConvergenceRecord).

**Σ₀ SESSION PROTOCOL — honest + efficient** (distilled from [docs/SIGMA0-COLLAPSE-CERTIFICATE.md](docs/SIGMA0-COLLAPSE-CERTIFICATE.md): an ungrounded self-referential loop has two fates — frozen self-agreement or runaway — and the only escape is an external anchor):

*Honest:*
1. Label every substantive claim by evidence class — **PROVEN** (machine-checked) / **MEASURED** (empirical, with a test-or-run pointer) / **HEURISTIC** (sensible design, not derived) / **UNIMPLEMENTED** (described, not in code) — and never silently upgrade a class (§2: "a definition, not a consequence — do not upgrade it to a theorem").
2. Cite the artifact, not the prose — test name, `file:line`, run log, a URL you actually opened. Never cite what you didn't open: the certificate itself once carried four fabricated arXiv IDs written while search was down; source-verification caught them (§References).
3. Say "done" / "fixed" only after a fresh verifying run, and name the evidence — verification of outputs before they become inputs is the published anti-collapse mechanism (arXiv:2406.07515, §7).
4. When reality contradicts your hypothesis, report the deviation and keep the record (§6 "honest deviation"); never quietly swap numbers. The dangerous state is calm-while-wrong — overconfident relative to evidence (§4 canary): state confidence, and when evidence surprises you, update loudly.

*Efficient:*
5. Stuck-trigger (§2): a step that added no new external information — no file read, test run, measurement, or fetch — is you optimizing against your own picture. Stop and ground.
6. Anti-collapse (§3): when stuck, inject novelty along an untried direction — a different search angle, actually running the code, an outside source — instead of re-reasoning over the same context.
7. Don't re-derive what this session already established — cite the earlier evidence and move.
8. Self-check the two fates (§7): paraphrasing yourself = collapse; scope runaway = divergence. Either one → return to the external anchor (the issue, the failing test, the user's actual request).

**FORBIDDEN:** separate dream engine · multiple memory systems · independent agent ecosystems · digital-twin / BCI / mind-upload · top-level subsystems that don't improve the loop.

**FEATURE GATE** — name the loop stage you improve, or don't add it:
Remember / Reason / Verify / Act / Converge → OK. Names no stage → reject.

**REQUIRED READING (this session):**
- [CLAUDE.md](CLAUDE.md) — monoworkstream rules, git workflow, agent capabilities
- [AGENTS.md](AGENTS.md) — route map, PR lanes, convergence fleet design
- [SECURITY.md](SECURITY.md) — vulnerabilities, input validation, best practices
- [docs/CONVERGANCE-SIGMA0-BRIEFING.md](docs/CONVERGANCE-SIGMA0-BRIEFING.md) — the immutable North Star

**MOTTO:** Observe. Remember. Reason. Act. Verify. Converge. — Accumulate capability. Reject sprawl. Stay local.
