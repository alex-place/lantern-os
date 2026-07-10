# unisona.ai-Σ₀ PLT — Handoff (2026-07-01)

**What this is:** the pick-up sheet for the "loopcoder swap" — bootstrapping our own
proprietary Σ₀ coder ([ADR-0011](adr/0011-proprietary-sigma0-base-model.md))
from the Apache-2.0 LoopCoder-V2 Parallel Loop Transformer. Read the [README](../models/keystone-sigma0-plt/README.md)
for the architecture; this doc is **only what's left to do and how**.

---

## TL;DR

The owned PLT is now the **sole local coder** (leads coding/reasoning/default in
`local-model-registry.js`, served on `:11435`), loads 4-bit (~6.4 GB), and decodes at
~7.8 tok/s with the KV cache. But it is **`verified:false`** — it leads because it's the
*only* local coder, **not** because it won an eval. The two real gates are still open and
both need a **≥24 GB GPU** (not available on the 8 GB dev box): **faithful parity** and the
**eval win vs a frontier coder**.

## State of play (verified 2026-07-05)

| Gate | Status | Evidence |
|---|---|---|
| Own the modeling code | ✅ done | `modeling_keystone_plt.py`, merged PR #1645 |
| Stage-0 smoke — loads + generates | ✅ PASS | 4-bit, missing=0/unexpected=0, 2/3 coherent — `data/convergence/keystone-plt-parity-log.jsonl` |
| Speed — interactive-usable | ✅ BUILD | KV cache 4.29 → 7.83 tok/s (static), PR #1766. Locked by `tests/test_keystone_plt_kv_cache.py` |
| Serving + registry entry | ✅ landed | `serve_keystone_plt.py` (:11435) + sole-coder registry entry, #1758 |
| First measured eval (internal) | ✅ **RUN 2026-07-05** | coding-golden-25, 4-bit @ :11435: **88% pass@1 (22/25)**, reproduced across 2 runs — `data/eval/leaderboard.jsonl` label `keystone-plt-golden25-4bit` (ts 1783298248 + 1783299024). Misses: caesar_cipher, anagram (1/3), roman_to_int (0/5). ~150 s/problem at 4-bit on a 12 GB 4070 SUPER (needs ≥24 GB for throughput). |
| First **external** eval (HumanEval subset) | ✅ **RUN 2026-07-05** | HumanEval-20 via the chat path (routes local → PLT :11435): **55% pass@1 (11/20)** — `leaderboard.jsonl` label `keystone-plt-humaneval20-4bit`. **All 9 failures were `no-parse` = truncated, not wrong logic.** Root cause: model emits no stop token → greedy runs the full `num_predict`; at 256 tok (≈120 s) it fits the chat's ~120 s local timeout but truncates long solutions; raising to 640 tok pushed gen >300 s → chat times out → fallback → the `-640tok` row is a **0/20 infra artifact, not a capability read**. So 55% is a **timeout-bound floor on 12 GB**; true capability is higher. Fix = raise lantern local timeout or run bf16 on ≥24 GB. |
| **Faithful parity (top1≥0.99 vs vLLM)** | ⛔ **PENDING** | needs ≥24 GB — `parity: null` in the log |
| Eval win vs frontier coder | ⛔ pending | internal golden-25 (88%) + external HumanEval-20 (55%, timeout-bound) done. **Local untruncated eval empirically shown NON-VIABLE (2026-07-05):** raising PLT_NUM_PREDICT→640 + OLLAMA_TIMEOUT_MS→500 s still failed — one 640-tok generation takes **>8 min** at 4-bit on 12 GB (~1.3 tok/s), past any timeout → no-parse. The full untruncated HumanEval-164 head-to-head **must** run bf16 on ≥24 GB (cloud L4/A100). Harness ready: **`scripts/eval_humaneval_plt_direct.py`** (hits the PLT shim directly, no lantern node) — runbook in its docstring. |
| `verified:true` (earned lead) | ⛔ no | gated on parity **and** eval win (External Reality Rule) |
| ADR-0011 founder decision | ⛔ Proposed | `#1666` — only Alex flips it |

> **⚠️ Regression watch:** PR #1766's KV cache was silently reverted once by a stale
> worktree-sync commit (`2fd3598c`) and the follow-up restore missed this file; it was
> re-restored on 2026-07-01. If decode speed suddenly drops back to ~4 tok/s, check
> `modeling_keystone_plt.py` is the **788-line** cached version, not the 387-line
> pre-cache one. See [[stale-worktree-sync-clobber]].

---

## What needs to be done now (priority order)

### P0 · Faithful parity — the one blocking gate
Run the definitive check on a **≥24 GB** GPU (Colab L4/A100). This proves the hand-written
forward matches the trained weights.
```bash
# on a >=24GB box (or open models/keystone-sigma0-plt/colab_parity.ipynb)
python download_and_patch.py --out ./checkpoint          # ~18 GB, one time
# capture a vendor reference (vLLM fork yxing-bj/vllm): fixed input_ids -> ref_logits.pt
python check_parity.py --model ./checkpoint --dtype bf16 --ref ref_logits.pt   # want top1_agree >= 0.99
```
- **If it fails**, try the 3 reconstructed boundaries (commented in `modeling_keystone_plt.py`):
  (1) CLP shift `plt_clp_shift`, (2) sliding-window off-by-one, (3) per-loop norm placement.
- Tracked in [#1743](https://github.com/alex-place/lantern-os/issues/1743).

### P1 · Eval win vs a frontier coder — flips `verified:true`
```bash
python models/keystone-sigma0-plt/serve_keystone_plt.py   # serves on :11435
$env:KEYSTONE_PLT_ENDPOINT = "http://127.0.0.1:11435"
python scripts/eval_humaneval_chat.py                     # head-to-head
```
On a win: set `verified: true` + the **measured** `capabilityScore` on the
`keystone-sigma0-plt` entry. Tracked in #1743 (Stage 2).

### P1 · Trained Adaptive Loop Gate — the real capability/speed lever
Naively cutting to 1 loop hits 8.69 tok/s but **0/3 coherent** — a blunt cut destroys
quality. The headroom needs a *trained* halt gate ([ADAPTIVE-LOOP-GATE.md](../models/keystone-sigma0-plt/ADAPTIVE-LOOP-GATE.md),
adapter-only on a frozen base, default-off). Needs parity first, then GPU training via
`train_lora.py`. Tracked in #1743 (Stage 1).

### Deferred · T2/T3 speed (torchao int4 + torch.compile)
`torch.compile` doesn't help under bnb-nf4 (6.65 < 7.83); the compile win needs torchao
int4, **blocked on this Windows env** (installing torchao breaks `trust_remote_code`
loading). Needs a separate newer-torch env or a ≥24 GB Linux box. Not blocking — the static
cache already clears BUILD. Tracked in [#1771](https://github.com/alex-place/lantern-os/issues/1771).

### Gate · ADR-0011 founder decision (#1666)
Alex's call, now with BUILD + serving + sole-coder evidence. Agents leave it `Proposed`.

---

## Key files & pointers

| Thing | Where |
|---|---|
| Package + runbook | `models/keystone-sigma0-plt/` (`README.md`) |
| Modeling code (with KV cache) | `models/keystone-sigma0-plt/modeling_keystone_plt.py` (788 lines) |
| Stage-0 gate | `check_parity.py` · `colab_parity.ipynb` |
| Serve wrapper | `serve_keystone_plt.py` (:11435) |
| KV-cache regression test | `tests/test_keystone_plt_kv_cache.py` |
| Registry | `apps/lantern-garage/lib/local-model-registry.js` (`keystone-sigma0-plt`, sole local coder, `verified:false`) |
| Eval harness | `scripts/eval_humaneval_chat.py` · `experiments/humaneval_runner.py` |
| On-box checkpoint | `D:/keystone-sigma0-plt-ckpt` |
| Evidence logs | `data/convergence/{loopcoder-probe-log,keystone-plt-parity-log}.jsonl` |
| Decision / tracking | ADR-0011 · `#1666` founder gate · `#1743` parity+ALG+eval · `#1771` torchao |

## The finish line

`verified:true` requires: **parity PASS on 24 GB → eval win vs a frontier coder → flip the
registry entry**. Until then it's the sole local coder by operator choice — a hand-served
model that leads by default, not a reproduced-capability lead.
