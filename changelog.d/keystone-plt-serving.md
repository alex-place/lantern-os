### Added
- **keystone-sigma0-plt serving wrapper + gated registry entry** (Stage-2 plumbing, ADR-0011).
  `models/keystone-sigma0-plt/serve_keystone_plt.py` is an Ollama-compatible HTTP server
  (`/api/tags` + `/api/chat`, optional `--logprobs` exposing the −log2p surprise "leak") so the
  Keystone chat can reach the PLT model as a local backend. Registered in `local-model-registry.js`
  as **`verified:false`** — KNOWN to the chat but **NON-LEADING** (grounding gate, #1597): reachable
  only when the server runs and `KEYSTONE_PLT_ENDPOINT` points at it, and it cannot LEAD until
  faithful parity (vLLM `--ref` `top1≥0.99`) + an on-box eval win. No KV cache yet (full-recompute
  decode → slow); interactive chat use is the follow-up. Improves the **Reason** stage (a local
  looped backend we own) without letting an unverified model displace a known-good lead.
