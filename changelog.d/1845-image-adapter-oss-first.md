feat(image): OSS-first image-model registry + provider-selecting /api/image/ai-generate (#1845)

New `apps/lantern-garage/lib/image-model-registry.js` gives image generation the
same interchangeable-provider contract the LLM registry already gives reasoning:
built-in DEFAULTS + a gitignored `data/models/image-registry.json` overlay,
TTL-cached, with a per-kind SSRF allowlist (ComfyUI → loopback only, OpenAI →
api.openai.com) and a 3s async, key-safe reachability probe.

`/api/image/ai-generate` now selects a provider through `resolveImageChain()`
(OSS-first, rank-order) and dispatches via a driver map, preserving the exact
`{ok,url,model}` response contract. The local Flux.1-schnell (Apache-2.0) lead has
no driver yet and is unreachable, so the chain resolves to OpenAI exactly as before
— no behavior change. Once the ComfyUI driver lands (Phase 3, #1847) the OSS
provider leads automatically; `IMAGE_OSS_ONLY=1` forbids closed providers entirely.
Empty chain returns a graceful `{ok:false}` (never a 500), so the client keyless
fallback still runs. Phase 1 of epic #1844.
