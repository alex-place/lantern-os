# Convergence Record — OSS Image-Model Adapter (Phase 1)

- **Date:** 2026-07-01
- **Issue:** #1845 (epic #1844) · lane: alex
- **Loop stage:** Act (better tool execution / provider observability) + North Star #6 (local ownership)

## Hypothesis

Three Doors image generation can be routed through a single OSS-first provider
registry — mirroring `lib/local-model-registry.js` — so that a locally-owned
Apache-2.0 generator (Flux.1-schnell via ComfyUI) leads once available, while
closed cloud providers (OpenAI Images) survive only as a reachability-gated
fallback. Phase 1 lands the adapter + route dispatch with **no user-visible
behavior change**.

## Evidence

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| Extension, not sprawl | Clones registry+driver-dispatch pattern; one new file, one refactored route; no new memory/serving path | 0.9 | Architecture council (PROCEED-WITH-CHANGES) |
| No behavior change while ComfyUI absent | Reachability gate: comfyui unreachable → chain resolves to `[openai-images]`; response contract `{ok,url,model}` preserved | 0.9 | Unit test (chain=`[openai-images]`) + route mock (no 500) |
| No 500 regression on empty chain | Null/empty chain → `{ok:false}` 502, never a crash; client keyless-falls-back | 1.0 | Route mock test both cases |
| SSRF blocked | Operator overlay endpoints allowlisted per kind (comfyui→loopback, openai→api.openai.com); violating entries dropped | 0.9 | Unit test + Security council |
| Boot probe safe | 3s hard timeout, async fire-and-forget, presence-only key check (`!!`), never logs key value | 0.85 | Security council + code review |
| OSS-only enforceable | `IMAGE_OSS_ONLY=1` drops all closed providers → empty chain until local lands | 1.0 | Unit test |

## Council (!convergance)

Three adversarial members (architecture/anti-sprawl, security, correctness) — all
returned **PROCEED-WITH-CHANGES**. Must-fixes folded in:

- Correctness: preserve `{ok,url,model}`; null-check → `{ok:false}` not 500;
  memoized reachability (no boot race); real fallback-chain iteration.
- Security: per-kind endpoint allowlist (SSRF); 3s async probe, no key logging;
  prompt via JSON body (no interpolation); overlay gitignored + schema-sanitized.
- Architecture: OSS-first **rank-order** (image quality is subjective, not
  capability-gated); comfyui stub a true `{ok:false}` no-op; missing JSON → DEFAULTS.

## Result

Adapter landed and verified at the logic + route level. Local OSS generation
(ComfyUI driver), R2 CDN persistence, and IP-Adapter character consistency are
Phases 2–4 (#1846–#1848).

**Confidence (overall): 0.88** — reproduced on-box via unit + route tests; the
one unreproduced claim (real image render) is deferred to Phase 3 when the local
provider exists.
