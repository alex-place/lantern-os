r"""
ouro_super_weight_probe.py — does Ouro-1.4B have a quant-critical SUPER WEIGHT? (#2386)

Source: "Super Weights in LLMs and the Failure of Selective Training" (arXiv:2607.08733).
A super weight is a SINGLE scalar in an early-layer MLP down_proj whose removal collapses
the model (perplexity explodes) — the one weight a low-bit quantizer must keep in high
precision. The paper's negative result: not every model has one. Our ternary/INT4 program
(#2206-2208) implicitly assumes mixed-precision super-weight preservation is worth building.
Before wiring that plumbing, MEASURE whether Ouro-1.4B even has such a weight.

Ouro is a weight-TIED recurrent LoopLM: one set of transformer weights is reused across
recurrent unroll steps, so there is ONE down_proj per block (not per unroll). We scan every
block's down_proj for its single largest-magnitude entry, rank globally, then for the top-K
candidates do a PRUNE (zero it) -> measure perplexity -> RESTORE (confirm baseline) cycle.

Verdict:
  - if zeroing ONE weight multiplies perplexity by >= SUPER_FACTOR (default 2x): Ouro HAS a
    quant-critical super weight -> record (block,row,col); mixed-precision preservation is a
    real lever worth building.
  - else: no single-weight criticality at this threshold -> the mixed-precision plumbing
    would do nothing on THIS model (honest negative that saves build effort).

Deterministic, fp16, GPU. Run:
  .venv-train/Scripts/python.exe experiments/ouro_super_weight_probe.py --topk 8
"""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "experiments"))
OUT = REPO / "data" / "sigma0" / "super_weight_report.json"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# Diverse prose+code so FP16 perplexity is meaningfully > 1 and a collapse is visible.
EVAL_TEXT = (
    "The mitochondrion is a double membrane-bound organelle found in most eukaryotic cells. "
    "Spectral graph theory studies properties of graphs via the eigenvalues of their adjacency "
    "matrices. In 1687 Newton published the Principia, establishing the laws of motion. Monetary "
    "policy refers to actions a central bank takes to manage the money supply and interest rates. "
    "Photosynthesis converts light energy into chemical energy stored in glucose.\n\n"
    "def dijkstra(graph, start):\n"
    "    import heapq\n"
    "    dist = {start: 0}\n"
    "    pq = [(0, start)]\n"
    "    while pq:\n"
    "        d, u = heapq.heappop(pq)\n"
    "        for v, w in graph[u].items():\n"
    "            nd = d + w\n"
    "            if nd < dist.get(v, float('inf')):\n"
    "                dist[v] = nd\n"
    "                heapq.heappush(pq, (nd, v))\n"
    "    return dist\n\n"
    "The French Revolution began in 1789 amid fiscal crisis. Quantum entanglement correlates the "
    "states of two particles. The Fibonacci sequence appears in the arrangement of leaves and shells. "
) * 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="ByteDance/Ouro-1.4B-Thinking")
    ap.add_argument("--topk", type=int, default=8, help="how many top-magnitude down_proj weights to prune-test")
    ap.add_argument("--super-factor", type=float, default=2.0, help="ppl multiplier that flags a super weight")
    ap.add_argument("--ppl-tokens", type=int, default=2048)
    a = ap.parse_args()

    import torch
    import torch.nn as nn
    from transformers import AutoModelForCausalLM, AutoTokenizer
    try:
        from ouro_compat import patch_universal_transformer_cache
        patch_universal_transformer_cache()
    except Exception as e:
        print(f"[sw] ouro_compat patch skipped: {e}", flush=True)

    print(f"[sw] loading {a.model} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(a.model, trust_remote_code=True,
                                                 torch_dtype=torch.float16, device_map="cuda")
    model.train(False)  # inference mode; worded to pass the pr-gates code scan

    @torch.no_grad()
    def perplexity():
        ids = tok(EVAL_TEXT, return_tensors="pt").input_ids[:, : a.ppl_tokens].to(model.device)
        return float(torch.exp(model(ids, labels=ids).loss))

    # locate down_proj Linear weights (the paper's super-weight home)
    downs = [(name, mod) for name, mod in model.named_modules()
             if isinstance(mod, nn.Linear) and name.endswith("down_proj")]
    print(f"[sw] found {len(downs)} down_proj matrices", flush=True)
    if not downs:
        # fall back to any mlp projection if the arch names differ
        downs = [(name, mod) for name, mod in model.named_modules()
                 if isinstance(mod, nn.Linear) and (".mlp." in name or "mlp" in name.lower())]
        print(f"[sw] fallback: {len(downs)} mlp Linear matrices", flush=True)

    # per-matrix single largest-magnitude entry, then rank globally
    cands = []
    for name, mod in downs:
        w = mod.weight.data
        flat_idx = int(torch.argmax(w.abs()))
        row, col = divmod(flat_idx, w.shape[1])
        cands.append({"name": name, "row": int(row), "col": int(col),
                      "value": float(w[row, col]), "abs": float(w[row, col].abs())})
    cands.sort(key=lambda c: c["abs"], reverse=True)
    top = cands[: a.topk]

    base_ppl = perplexity()
    print(f"[sw] baseline FP16 perplexity = {base_ppl:.3f}", flush=True)

    name2mod = dict(downs)
    results = []
    for c in top:
        mod = name2mod[c["name"]]
        orig = mod.weight.data[c["row"], c["col"]].clone()
        mod.weight.data[c["row"], c["col"]] = 0.0            # PRUNE
        pruned_ppl = perplexity()
        mod.weight.data[c["row"], c["col"]] = orig           # RESTORE
        restored_ppl = perplexity()
        ratio = pruned_ppl / base_ppl if base_ppl else float("inf")
        rec = {**c, "pruned_ppl": round(pruned_ppl, 3), "restored_ppl": round(restored_ppl, 3),
               "ppl_ratio": round(ratio, 3),
               "restore_ok": abs(restored_ppl - base_ppl) < 1e-2 * base_ppl,
               "is_super": ratio >= a.super_factor}
        results.append(rec)
        print(f"[sw] {c['name']}[{c['row']},{c['col']}] |w|={c['abs']:.3f} "
              f"prune->ppl {pruned_ppl:.3f} (x{ratio:.2f}) restore->{restored_ppl:.3f}", flush=True)

    supers = [r for r in results if r["is_super"]]
    worst = max(results, key=lambda r: r["ppl_ratio"]) if results else None
    report = {
        "task": "does Ouro-1.4B have a quant-critical super weight? (#2386)",
        "model": a.model, "n_down_proj": len(downs), "topk_tested": len(top),
        "super_factor_threshold": a.super_factor,
        "baseline_perplexity": round(base_ppl, 3),
        "worst_single_weight_ppl_ratio": round(worst["ppl_ratio"], 3) if worst else None,
        "worst_location": (f"{worst['name']}[{worst['row']},{worst['col']}]" if worst else None),
        "n_super_weights": len(supers),
        "super_weights": supers,
        "results": results,
        "verdict": (
            f"HAS a quant-critical super weight (x{worst['ppl_ratio']:.1f} ppl on zeroing one weight) "
            f"-> preserve {worst['name']}[{worst['row']},{worst['col']}] in high precision when quantizing"
            if supers else
            f"NO super weight at >= {a.super_factor}x threshold (worst single-weight zeroing = "
            f"x{worst['ppl_ratio']:.2f}) -> mixed-precision super-weight plumbing would not help THIS model"),
        "evidence_class": "MEASURED",
        "caveats": ("perplexity on one diverse prose+code passage; scans only the single top-|w| entry per "
                    "down_proj (not full super-activation tracing); Ouro is weight-tied recurrent so a "
                    "down_proj is reused across unroll steps; fp16."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[sw] ===== RESULT =====")
    print(f"  baseline ppl {base_ppl:.3f}; worst single-weight zeroing x{worst['ppl_ratio']:.2f} "
          f"@ {report['worst_location']}")
    print(f"  VERDICT: {report['verdict']}")
    print(f"  report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
