"""
Lapse Tesseract — Experiment E1 (the load-bearing one).

Question (docs/research/2026-06-20-lapse-tesseract.md §6, E1):
  Does compute-depth dilation BUY bit dilation? i.e. does an Ouro converged-depth
  predictor + arithmetic coder strictly beat CSF-Omni's round-trip-verified bytes on
  >=1 corpus, once model amortization is honestly counted?

Method:
  Teacher-force Ouro-1.4B over each corpus in independent context windows. For every
  content token compute the model's next-token code length L = -log2 p(x | context) at
  (a) FULL depth R4 (best prediction, lowest bits) and (b) CONVERGENCE-EXIT depth
  (adaptive compute, ||Δh||/||h|| < eps — the "dilation" mechanism). The summed field
  is the size an arithmetic coder realizes to < 2 bits/window (Shannon + Witten-Neal-
  Cleary), so it is the model's achievable RAW rate. We report:
    - RAW rate : model_bits/8  vs CSF-Omni bytes      (model assumed resident/shared)
    - ADJUSTED : + model bytes on disk                 (the deep-research caveat made real)
  Plus E2: corr(per-token converged depth, per-token bits) — is depth spent where the
  bits are?

Honesty:
  * latin-1 makes bytes<->text a bijection, so the ONLY losslessness question is the
    tokenizer round-trip, which we verify and report per corpus.
  * We report the information-theoretic code length (the rate). A bit-exact arithmetic
    coder adds < 2 bits/window (negligible vs the model-vs-codec gap) and cannot change
    the verdict; it is downstream engineering, not measured here. Stated, not hidden.
  * Each context window is independent (no cross-window history) — the standard short-
    context limitation (DeepMind 2309.10668); reported as n_windows.

    PYTHONPATH=src .venv-train/Scripts/python experiments/lapse_e1_ouro_coder.py
"""
from __future__ import annotations

import bz2
import json
import lzma
import math
import os
import sys
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ.setdefault("HF_HOME", "D:/hf-cache")

import torch  # noqa: E402

try:
    import zstandard as zstd
except Exception:
    zstd = None
try:
    import brotli
except Exception:
    brotli = None

REPO = Path(__file__).resolve().parent.parent
LN2 = math.log(2)


# ── corpora (mirror lapse_field_demo, but stream-read the giant kalshi log) ──────────
def load_corpora(caps: dict) -> list[tuple[str, bytes]]:
    out = []
    cube = REPO / "data/cubes/alex.private/deltas/deltas.jsonl"
    if cube.exists():
        with open(cube, "rb") as f:
            out.append(("cube-delta (3^12 lattice storage face)", f.read(caps["cube"])))
    kal = sorted(REPO.glob("data/kalshi/*.jsonl"), key=lambda p: p.stat().st_size, reverse=True)
    if kal:
        with open(kal[0], "rb") as f:
            out.append((f"jsonl memory log ({kal[0].name})", f.read(caps["kalshi"])))
    readme = REPO / "README.md"
    if readme.exists():
        with open(readme, "rb") as f:
            out.append(("README.md (prose)", f.read(caps["readme"])))
    return out


# ── baselines: CSF-Omni + raw codecs, all round-trip-verified ────────────────────────
def baselines(data: bytes) -> dict:
    rows = {}
    r = [("zlib-9", zlib.compress(data, 9), zlib.decompress),
         ("bz2-9", bz2.compress(data, 9), bz2.decompress),
         ("lzma-9e", lzma.compress(data, preset=9 | lzma.PRESET_EXTREME), lzma.decompress)]
    if zstd:
        r.append(("zstd-19", zstd.ZstdCompressor(level=19).compress(data),
                  lambda b: zstd.ZstdDecompressor().decompress(b)))
    if brotli:
        r.append(("brotli-11", brotli.compress(data, quality=11), brotli.decompress))
    for name, comp, dec in r:
        assert dec(comp) == data, f"{name} not lossless"
        rows[name] = len(comp)
    # CSF-Omni (the format's own best-fit panel) — the E1 baseline of record
    try:
        from csf import omni
        blob = omni.compress_best(data)
        assert omni.decompress(blob) == data, "omni not lossless"
        rows["csf-omni"] = len(blob)
    except Exception as e:
        rows["csf-omni_error"] = str(e)
    return rows


# ── Ouro teacher-forced code length (full depth + convergence-exit depth) ────────────
def ouro_code_lengths(m, data: bytes, ctx: int = 1024, eps: float = 0.05) -> dict:
    bb = m._backbone()
    dev = bb.device if hasattr(bb, "device") else torch.device("cuda")
    lm_head = m.model.lm_head if hasattr(m.model, "lm_head") else bb.lm_head
    n_ut = m.max_steps

    text = data.decode("latin-1")  # bijection: text.encode('latin-1') == data
    enc = m.tok(text, return_tensors="pt").input_ids[0]
    # tokenizer round-trip exactness (the only losslessness question, latin-1 aside)
    detok = m.tok.decode(enc, skip_special_tokens=True)
    tok_roundtrip_exact = (detok == text)

    bos = m.tok.bos_token_id
    if bos is None:
        bos = m.tok.eos_token_id
    content = enc.tolist()
    step = ctx - 1  # leave room for the prepended priming token

    tot_bits_full = 0.0
    tot_bits_conv = 0.0
    n_pred = 0
    depths_sum = 0
    depth_hist = [0] * (n_ut + 1)
    # streaming Pearson accumulators for corr(depth, bits_full)
    sx = sy = sxx = syy = sxy = 0.0
    n_windows = 0
    t0 = time.time()

    with torch.no_grad():
        for s in range(0, len(content), step):
            chunk = content[s:s + step]
            if not chunk:
                break
            inp = torch.tensor([[bos] + chunk], device=dev)
            seq = inp.shape[1]
            _o, hs_list, _g = bb.model(input_ids=inp, use_cache=False)
            H = torch.stack([h[0].float() for h in hs_list])  # (n_ut, seq, hidden)

            # full-depth bits for the actual next token at every position 0..seq-2
            logits_f = lm_head(hs_list[-1])[0].float()        # (seq, vocab)
            tgt = inp[0, 1:]                                   # (seq-1,)
            lse_f = torch.logsumexp(logits_f[:-1], dim=-1)
            true_f = logits_f[:-1].gather(1, tgt.unsqueeze(1)).squeeze(1)
            bits_f = (lse_f - true_f) / LN2                    # (seq-1,) -log2 p

            # convergence-exit depth per position (vectorized converge_step, eps)
            diffs = (H[1:] - H[:-1]).norm(dim=-1)              # (n_ut-1, seq)
            denom = H[:-1].norm(dim=-1).clamp(min=1e-9)
            rel = diffs / denom                                # contraction per step
            below = rel < eps
            depth = torch.full((seq,), n_ut, dtype=torch.long, device=dev)
            for t in range(rel.shape[0]):
                hit = below[t] & (depth == n_ut)
                depth[hit] = t + 2                             # 1-indexed exit depth
            # converged-depth p* bits: hidden at each position's exit depth
            idx = (depth - 1).clamp(0, n_ut - 1)
            Hsel = H[idx, torch.arange(seq, device=dev)]       # (seq, hidden)
            logits_c = lm_head(Hsel.to(lm_head.weight.dtype))[:-1].float()
            lse_c = torch.logsumexp(logits_c, dim=-1)
            true_c = logits_c.gather(1, tgt.unsqueeze(1)).squeeze(1)
            bits_c = (lse_c - true_c) / LN2

            d_pred = depth[:-1]                                # depth used to predict each next tok
            bf = bits_f.detach().cpu()
            bc = bits_c.detach().cpu()
            dp = d_pred.detach().cpu().float()

            tot_bits_full += float(bf.sum())
            tot_bits_conv += float(bc.sum())
            n_pred += bf.numel()
            depths_sum += float(dp.sum())
            for d in d_pred.tolist():
                depth_hist[d] += 1
            # corr accumulators
            x = dp
            y = bf
            sx += float(x.sum()); sy += float(y.sum())
            sxx += float((x * x).sum()); syy += float((y * y).sum())
            sxy += float((x * y).sum())
            n_windows += 1

    n = n_pred
    cov = sxy - sx * sy / n
    vx = sxx - sx * sx / n
    vy = syy - sy * sy / n
    corr = cov / math.sqrt(vx * vy) if vx > 0 and vy > 0 else None

    return {
        "raw_bytes": len(data),
        "n_tokens_total": len(enc),
        "n_predicted": n,
        "bytes_per_token": round(len(data) / max(len(enc), 1), 3),
        "tok_roundtrip_exact": tok_roundtrip_exact,
        "n_windows": n_windows,
        "ctx": ctx,
        "full_depth": {
            "total_bits": round(tot_bits_full, 1),
            "model_bytes": math.ceil(tot_bits_full / 8),
            "bits_per_token": round(tot_bits_full / n, 4),
            "bits_per_byte": round(tot_bits_full / len(data), 4),
            "ratio_raw_vs_input": round(len(data) / (tot_bits_full / 8), 2),
        },
        "converge_depth": {
            "eps": eps,
            "total_bits": round(tot_bits_conv, 1),
            "model_bytes": math.ceil(tot_bits_conv / 8),
            "bits_per_token": round(tot_bits_conv / n, 4),
            "bits_per_byte": round(tot_bits_conv / len(data), 4),
            "ratio_raw_vs_input": round(len(data) / (tot_bits_conv / 8), 2),
            "mean_depth": round(depths_sum / n, 3),
            "max_depth": n_ut,
            "depth_histogram": {str(i): depth_hist[i] for i in range(1, n_ut + 1)},
            "compute_saved_vs_full": round(1 - (depths_sum / n) / n_ut, 3),
        },
        "E2_depth_vs_bits_pearson": round(corr, 4) if corr is not None else None,
        "seconds": round(time.time() - t0, 1),
    }


def main():
    caps = {"cube": 1 << 20, "kalshi": 256 * 1024, "readme": 1 << 20}
    ctx = int(os.environ.get("E1_CTX", "1024"))
    eps = float(os.environ.get("E1_EPS", "0.05"))

    from sigma0.loop_lm import Sigma0LoopLM
    print("loading Ouro-1.4B ...", flush=True)
    m = Sigma0LoopLM.load("ByteDance/Ouro-1.4B")
    # model size on disk (fp16 weights) for the ADJUSTED rate
    model_bytes = 0
    cache_dir = Path("D:/hf-cache/hub/models--ByteDance--Ouro-1.4B")
    for p in cache_dir.rglob("*.safetensors"):
        model_bytes += p.stat().st_size
    n_params = sum(p.numel() for p in m.model.parameters())
    print(f"model on disk: {model_bytes/1e9:.2f} GB ({n_params/1e9:.2f}B params)", flush=True)

    report = {
        "experiment": "lapse-tesseract E1 — converged-depth Ouro coder vs CSF-Omni",
        "model": "ByteDance/Ouro-1.4B",
        "n_ut_steps": m.max_steps,
        "model_bytes_on_disk": model_bytes,
        "n_params": n_params,
        "ctx": ctx, "eps": eps,
        "corpora": [],
    }
    for name, data in load_corpora(caps):
        print(f"\n### {name}  raw={len(data):,} B", flush=True)
        base = baselines(data)
        ou = ouro_code_lengths(m, data, ctx=ctx, eps=eps)
        # verdict per corpus: does Ouro RAW rate (full depth, best) beat csf-omni?
        omni_b = base.get("csf-omni")
        best_codec = min((v for k, v in base.items() if not k.endswith("_error")), default=None)
        ou_raw = ou["full_depth"]["model_bytes"]
        ou_adj = ou_raw + model_bytes
        rec = {
            "name": name,
            "baselines_bytes": base,
            "ouro": ou,
            "verdict": {
                "ouro_raw_bytes": ou_raw,
                "ouro_adjusted_bytes": ou_adj,
                "csf_omni_bytes": omni_b,
                "best_baseline_bytes": best_codec,
                "raw_beats_csf_omni": (omni_b is not None and ou_raw < omni_b),
                "raw_beats_best_codec": (best_codec is not None and ou_raw < best_codec),
                "adjusted_beats_csf_omni": (omni_b is not None and ou_adj < omni_b),
            },
        }
        report["corpora"].append(rec)
        v = rec["verdict"]
        print(f"  csf-omni={omni_b:,}B  best={best_codec:,}B  "
              f"ouro_raw={ou_raw:,}B  ouro_adj={ou_adj:,}B", flush=True)
        print(f"  full: {ou['full_depth']['bits_per_byte']} b/B "
              f"({ou['full_depth']['ratio_raw_vs_input']}x)  "
              f"converge: {ou['converge_depth']['bits_per_byte']} b/B "
              f"mean_depth={ou['converge_depth']['mean_depth']}/{m.max_steps}  "
              f"E2 corr(depth,bits)={ou['E2_depth_vs_bits_pearson']}", flush=True)
        print(f"  RAW beats csf-omni: {v['raw_beats_csf_omni']}   "
              f"ADJUSTED beats csf-omni: {v['adjusted_beats_csf_omni']}", flush=True)

    any_raw_win = any(c["verdict"]["raw_beats_csf_omni"] for c in report["corpora"])
    any_adj_win = any(c["verdict"]["adjusted_beats_csf_omni"] for c in report["corpora"])
    report["E1_verdict"] = {
        "raw_rate_beats_csf_omni_on_any_corpus": any_raw_win,
        "adjusted_rate_beats_csf_omni_on_any_corpus": any_adj_win,
        "kill_criterion": "E1 KILLED unless the coder strictly beats CSF-Omni verified bytes on >=1 corpus",
        "note": "RAW assumes the model is resident/shared (not charged). ADJUSTED counts model bytes.",
    }
    out = REPO / "data/lapse_e1_ouro_coder_report.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nRAW beats CSF-Omni on >=1 corpus: {any_raw_win}")
    print(f"ADJUSTED beats CSF-Omni on >=1 corpus: {any_adj_win}")
    print(f"report -> {out}")


if __name__ == "__main__":
    raise SystemExit(main())
