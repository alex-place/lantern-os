### Added — Local Qwen→Ouro crystallization teacher (cloud-free distillation)

The Σ₀ trace-distillation flywheel can now use a **local** teacher. `gen_sigma0_traces.py`
gained a pluggable teacher backend (`--teacher-backend auto|cloud|local`,
`--teacher-endpoint`): a teacher id that looks local (e.g. `qwen2.5-coder:7b`) auto-routes to
any Ollama-compatible `/api/chat` server instead of the Anthropic cloud API. This lets the
verified-capable local **Qwen2.5-Coder-7B** crystallize its coding skill into the small
looped **Ouro-1.4B** student with **no cloud dependency, key, or rate limit**.

The hard gate is unchanged: a teacher solution trains the student **only if it executes
green** against the task's asserts (the Σ₀ ground-truth gate — unverified traces train
hallucination). Promotion is still HumanEval `pass@1` eval-gated against the live incumbent.

Also: `load_tasks()` tolerates list-valued `asserts` (the `ouro-corpus-raw.json` shape),
`extract_code()` strips a teacher's in-fence `self-check:` trailer before verifying, the
`meta.teacher` provenance label reflects the real backend, and stdout is forced UTF-8 so the
`✓/✗` status glyphs don't crash a cp1252 Windows console.

**Measured seed run (2026-07-02):** Qwen distilled 63 execution-green traces from 192 tasks
(verified_rate 0.33); a fresh QLoRA candidate scored HumanEval-20 pass@1 **0.10** vs the
incumbent's **0.65**, so the eval gate **rejected** it and left `final/` untouched — the
flywheel working as designed. The finding: distilling into a *fresh* adapter from base
narrows the model; the follow-up is to continue-train from the incumbent and grow/harden the
corpus. Design + full numbers:
[docs/research/2026-07-02-qwen-teacher-ouro-crystallization.md](../docs/research/2026-07-02-qwen-teacher-ouro-crystallization.md).
</content>
