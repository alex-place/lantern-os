# VTD tiny-model handoff — 2026-07-22 (PC crashed under load; state pushed)

**Branch:** `claude/spiral-harness` (PR #2832 tail; the main body merged in #2823). Everything below
is committed here. The PC was crashing under combined load (Ollama + exec subprocesses + installs),
so all my background jobs are dead/killed; nothing is left running.

## Where the science stands (all exec-verified; ledger records cited)

| experiment | dose | config | held-out MBPP [400–450) | verdict |
|---|---|---|---|---|
| baseline 0.5B (`Qwen2.5-Coder-0.5B-Instruct`) | — | — | **21/50 (42%)** | fragile but real |
| retrieval (few-shot own traces) | 6 traces | — | 6/6 → 2/6 on DP set | **harmful** (template contamination) |
| VTD run 1 (`cr-mrvvxsuc`) | 63 traces | lr 2e-4, 6ep, r16 | 15/50, **−6** | **harmful** (memorized, damaged instruct) |
| VTD run 2 (`cr-mrvxt1li`) | 204 traces | lr 5e-5, 3ep, r8 | 21/50, **±0** (3 fixed / 3 regressed) | **neutral — dose-response confirmed** |

Direction: more data + gentler = less damage + real fixes. Crossover to a net lift needs the next
order of magnitude of traces → TACO.

## Artifacts on this branch
- `data/eval/spiral/vtd-corpus-all.jsonl` — 204 verified MBPP traces (63 + 141; 45 frontier rescues).
- `data/eval/spiral/vtd-taco-1.jsonl` — **30 partial TACO traces** (batch 1 died at ~34/400 in the crash).
- `data/eval/taco-easy.jsonl` — **1,581 normalized TACO-verified EASY stdio problems** (via
  `scripts/fetch_taco.py`; source `likaixin/TACO-verified`, 12,898 rows, canonical BAAI/TACO's
  loading script is unsupported by modern `datasets`).
- `data/eval/mbpp-full.jsonl` — 500 normalized MBPP problems (`scripts/fetch_mbpp.py`).
  **Held-out slices — never train on:** MBPP [400–450); reserve TACO [1400–1500) similarly.

## Artifacts on disk (NOT in git)
- Adapters: `D:\lantern-train\qwen05-vtd\final` (run 1), `D:\lantern-train\qwen05-vtd2\final` (run 2).
- Base model cached: `D:\hf-cache` (`Qwen/Qwen2.5-Coder-0.5B-Instruct`).
- Logs: `D:\lantern-train\*-train.log`, `*-eval.log`, `gen*.log`.

## ⚠ Gotchas the next session must know
1. **LlamaFactory venv (`D:\venvs\llamafactory`) has a BROKEN torch**: pip's resolver replaced the
   cu121 torch with **2.13.0+cpu (cuda False)** during `pip install llamafactory`. Fix before use:
   `D:\venvs\llamafactory\Scripts\pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121 --force-reinstall`
   then verify `torch.cuda.is_available()`. (LF 0.9.5 + transformers 5.6.0 installed.)
2. **One heavy job at a time on this box.** The crash came from concurrent load. Unload Ollama models
   first (`POST /api/generate {"model":..., "keep_alive":0}`), run trainers/generators **detached**
   (PowerShell `Start-Process`) — an attached run died mid-CUDA once already ("device not ready").
3. **Licensing (founder policy, `cr-mrwcmob0`):** unisona is not commercial *yet* — KodCode data
   (CC BY-NC) is research-OK but tag any weights trained on it `nc-contaminated`; TACO (Apache) is
   the default corpus for product-lineage weights.
4. The tier-preamble stdio bug is FIXED (c6cc6fba) — cheap sufficiency on TACO went 40%→80%.
   Escalation is now honest (cloud→cloud fallback only; fails rather than degrading to local).

## Resume plan (run 3)
1. Finish TACO batch in **small chunks** (crash-safe), e.g.:
   `SPIRAL_FRONTIER_PROVIDER=openai node experiments/spiral_gen_traces.js --src data/eval/taco-easy.jsonl --limit 100 --offset 34 --out data/eval/spiral/vtd-taco-1b.jsonl`
   (repeat offsets 134, 234, 334; merge with `vtd-corpus-all.jsonl` + `vtd-taco-1.jsonl`).
2. Fix the LF venv torch (above). Convert merged corpus → LlamaFactory alpaca format + a **retention
   mix** (~400 rows of a permissive general-instruct set, e.g. dolly-15k) via `dataset_info.json`;
   train QLoRA r=8, lr 5e-5, ≤3 epochs, qwen template, `val_size` + best-checkpoint.
3. Eval with `scripts/eval_qwen_coder.py` on MBPP [400–450) (comparable to −6 → ±0) AND a TACO
   held-out slice; emit the ConvergenceRecord either way (honest null included).
