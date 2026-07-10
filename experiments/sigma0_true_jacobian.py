r"""
sigma0_true_jacobian.py — measure the TRUE recurrent-block Jacobian of Ouro's UT loop.

Follow-up to #2029. `sigma0_loop_jacobian.py` measured only the *observed* trajectory
proxy rho_obs = geomean ||dh_{t+1}||/||dh_t|| = 0.88. That is a step-to-step ratio, not the
quantity the Collapse Certificate / STARS analysis actually care about: the spectral radius
rho(J) of the one-UT-step map h -> f(h), and its 2-norm ||J||_2 (top singular value) that
governs the non-normal transient.

This script isolates ONE universal-transformer step as a pure, differentiable function of the
hidden state and measures, at real operating points sampled from a forward pass:

  f(h) = norm( layers[0..L-1]( h, current_ut=c ) )       # exactly the loop body (modeling_ouro.py:640)

  rho(J) = spectral radius of J = df/dh   via power iteration on J (autograd JVP)
  ||J||_2 = largest singular value        via power iteration on J^T J (JVP then VJP)

rho(J) < 1  => the loop is a contraction near h*  => converges to a fixed point (the honest
               latent analogue of the debunked certificate rho=1.064 text-surface fit).
||J||_2 >> rho(J) => strong non-normality: individual steps can transiently EXPAND even though
               the loop contracts asymptotically (explains the ~34% momentarily-expanding steps).

No fit, no text features: this is the model's own dynamics via automatic differentiation.

Run:  .venv-train/Scripts/python.exe experiments/sigma0_true_jacobian.py
Env:  OURO_MODEL (default ByteDance/Ouro-1.4B-Thinking), JAC_ITERS (power-iter steps, default 40),
      JAC_PROMPTS (limit prompt count), LOOP_STEPS (probed depth, default = trained depth).
"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import torch  # noqa: E402
from torch.autograd.functional import jvp, vjp  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from ouro_compat import patch_universal_transformer_cache  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MODEL_ID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
ITERS = int(os.environ.get("JAC_ITERS", "40"))
OUT = REPO / "data" / "sigma0" / "true_jacobian_report.json"

PROMPTS = [
    "The capital of France is",
    "Two plus two equals",
    "In 1969, humans first landed on the",
    "def add(a, b):\n    return",
    "Water is made of hydrogen and",
    "She opened the door and saw",
]
_lim = os.environ.get("JAC_PROMPTS")
if _lim:
    PROMPTS = PROMPTS[: int(_lim)]


def power_iter_rho(f, h0, iters):
    """Spectral radius rho(J) of J = df/dh at h0 via power iteration using forward-mode JVP.
    Returns (rho, per-iter tail estimates) — geomean of the last third stabilises complex pairs."""
    v = torch.randn_like(h0)
    v = v / v.norm()
    ests = []
    for _ in range(iters):
        _, Jv = jvp(f, (h0,), (v,), create_graph=False, strict=False)
        nrm = Jv.norm()
        if nrm < 1e-20:
            break
        ests.append(float(nrm))          # ||J v|| for unit v -> |lambda_max| at convergence
        v = (Jv / nrm).detach()
    tail = ests[max(1, len(ests) * 2 // 3):] or ests[-1:]
    rho = float(torch.exp(torch.log(torch.tensor(tail)).mean()))
    if os.environ.get("JAC_DEBUG"):
        show = [round(e, 3) for e in ests]
        print(f"      [rho ests] {show}", flush=True)
    return rho, ests


def power_iter_sigma(f, h0, iters):
    """Largest singular value ||J||_2 via power iteration on J^T J (JVP then VJP)."""
    v = torch.randn_like(h0)
    v = v / v.norm()
    sigma = 0.0
    for _ in range(iters):
        _, Jv = jvp(f, (h0,), (v,), create_graph=False, strict=False)
        sigma = float(Jv.norm())          # at convergence ||J v|| = sigma_max
        _, JTJv = vjp(f, (h0,), Jv, create_graph=False, strict=False)
        JTJv = JTJv[0] if isinstance(JTJv, tuple) else JTJv
        nrm = JTJv.norm()
        if nrm < 1e-20:
            break
        v = (JTJv / nrm).detach()
    return sigma


def main():
    print(f"[true-jac] loading {MODEL_ID} in float32 (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, trust_remote_code=True, torch_dtype=torch.float32, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    for p in model.parameters():
        p.requires_grad_(False)
    # The fused/efficient SDPA kernels have no double-backward (needed for JVP-via-autograd).
    # Force the math backend, which supports the second derivative.
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    torch.backends.cuda.enable_math_sdp(True)

    inner = model.model                      # OuroModel
    L = inner.config.num_hidden_layers
    trained = int(getattr(model.config, "total_ut_steps", 4) or 4)
    probed = int(os.environ.get("LOOP_STEPS", str(trained)))
    H = int(model.config.hidden_size)
    print(f"[true-jac] L={L} layers, trained_depth={trained}, probed_depth={probed}, H={H}", flush=True)

    # --- capture per-layer attention masks + shared rotary embeddings from ONE real forward ---
    cap = {"mask": {}, "pos_ids": None, "pos_emb": None, "cache_pos": None}

    def mk_pre_hook(idx):
        def pre_hook(_m, args, kwargs):
            if idx not in cap["mask"]:
                cap["mask"][idx] = kwargs.get("attention_mask")
                if cap["pos_emb"] is None:
                    cap["pos_ids"] = kwargs.get("position_ids")
                    cap["pos_emb"] = kwargs.get("position_embeddings")
                    cap["cache_pos"] = kwargs.get("cache_position")
        return pre_hook

    handles = [inner.layers[i].register_forward_pre_hook(mk_pre_hook(i), with_kwargs=True)
               for i in range(L)]
    hsl_cap = {}

    def out_hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) >= 2 and isinstance(out[1], list):
            hsl_cap["hsl"] = out[1]
    h_out = inner.register_forward_hook(out_hook)

    results = []
    for prompt in PROMPTS:
        ids = tok(prompt, return_tensors="pt").to(model.device)
        cap["mask"].clear(); cap["pos_emb"] = None; hsl_cap.clear()
        with torch.no_grad():
            model(**ids, use_cache=False)
        hsl = hsl_cap.get("hsl")
        if not hsl:
            print(f"[true-jac] WARN no hidden-state list for {prompt!r}"); continue

        pos_ids, pos_emb, cache_pos = cap["pos_ids"], cap["pos_emb"], cap["cache_pos"]
        masks = dict(cap["mask"])

        def make_step_fn(current_ut):
            def f(h):                                   # h: [1, seq, H] -> [1, seq, H]
                x = h
                for i, layer in enumerate(inner.layers[:L]):
                    x = layer(x, attention_mask=masks[i], position_ids=pos_ids,
                              past_key_value=None, use_cache=False, cache_position=cache_pos,
                              position_embeddings=pos_emb, current_ut=current_ut)
                return inner.norm(x)
            return f

        # operating point entering step c: h_0 = embeddings (== hsl input); hsl[k] is post-step-k.
        # embeddings aren't in hsl, so use hsl[c-1] as the input to step c for c>=1; for c=0 rerun embed.
        embeds = inner.embed_tokens(ids["input_ids"]).float()
        per_step = []
        for c in range(probed):
            h_in = embeds if c == 0 else hsl[c - 1].float()
            h_in = h_in.detach().clone().requires_grad_(True)
            f = make_step_fn(min(c, trained - 1) if c >= trained else c)
            rho, ests = power_iter_rho(f, h_in, ITERS)
            sigma = power_iter_sigma(f, h_in, ITERS)
            per_step.append({"step": c, "current_ut": min(c, trained - 1) if c >= trained else c,
                             "rho_J": round(rho, 4), "norm_J_2": round(sigma, 4),
                             "non_normality_ratio": round(sigma / rho, 3) if rho > 1e-9 else None})
        results.append({"prompt": prompt, "per_step": per_step})
        rr = [s["rho_J"] for s in per_step]
        print(f"[true-jac] {prompt[:32]!r:34} rho(J) per step = "
              f"{[round(x,3) for x in rr]}", flush=True)

    for hd in handles:
        hd.remove()
    h_out.remove()

    # aggregate across (prompt, step)
    all_rho = [s["rho_J"] for r in results for s in r["per_step"]]
    all_sig = [s["norm_J_2"] for r in results for s in r["per_step"]]
    # aggregate at trained steady-state (last trained step only) — the honest headline
    ss_rho = [r["per_step"][trained - 1]["rho_J"] for r in results if len(r["per_step"]) >= trained]
    ss_sig = [r["per_step"][trained - 1]["norm_J_2"] for r in results if len(r["per_step"]) >= trained]

    def geomean(xs):
        t = torch.tensor([x for x in xs if x and x > 0], dtype=torch.float64)
        return float(torch.exp(torch.log(t).mean())) if len(t) else None

    report = {
        "model": MODEL_ID,
        "hidden_dim": H,
        "trained_depth": trained,
        "probed_depth": probed,
        "n_prompts": len(results),
        "power_iter_steps": ITERS,
        "rho_J_geomean_all": round(geomean(all_rho), 4) if all_rho else None,
        "rho_J_geomean_trained_steadystate": round(geomean(ss_rho), 4) if ss_rho else None,
        "rho_J_max": round(max(all_rho), 4) if all_rho else None,
        "norm_J_2_geomean_all": round(geomean(all_sig), 4) if all_sig else None,
        "norm_J_2_geomean_trained_steadystate": round(geomean(ss_sig), 4) if ss_sig else None,
        "norm_J_2_max": round(max(all_sig), 4) if all_sig else None,
        "non_normality_geomean": round(geomean(all_sig) / geomean(all_rho), 3)
        if all_rho and all_sig and geomean(all_rho) else None,
        "meaning": {
            "rho_J": "spectral radius of the one-UT-step Jacobian df/dh via autograd power iteration; "
                     "<1 => the recurrent loop is a local contraction (converges to a fixed point)",
            "norm_J_2": "top singular value of the same Jacobian; ||J||_2 >> rho(J) signals a "
                        "non-normal operator whose steps can transiently expand while the loop still "
                        "contracts asymptotically",
        },
        "vs_observed_proxy": "sigma0_loop_jacobian.py gave rho_observed=0.88 (trajectory ratio, a "
                             "proxy). This is the true Jacobian spectral radius of the loop map, "
                             "measured by automatic differentiation at real operating points.",
        "vs_debunked_certificate": "certificate headline rho=1.064 was a linear fit over 4 text-surface "
                                    "features (rho_controls.py); superseded by this measured rho(J).",
        "per_prompt": results,
        "honest_scope": (
            "rho(J) and ||J||_2 are LOCAL (Jacobian at sampled operating points h*), measured with "
            "float32 autograd JVP/VJP power iteration. Averaged over prompts and UT steps; the "
            "'trained_steadystate' figure isolates the last trained step, the regime the certificate "
            "reasons about. Power iteration returns |dominant eigenvalue|; complex-conjugate pairs are "
            "stabilised by geomean over the iteration tail."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[true-jac] ===== SUMMARY =====")
    print(f"[true-jac] rho(J) geomean (all)             = {report['rho_J_geomean_all']}")
    print(f"[true-jac] rho(J) geomean (trained steady)  = {report['rho_J_geomean_trained_steadystate']}  "
          f"-> {'CONTRACTING' if (report['rho_J_geomean_trained_steadystate'] or 9) < 1 else 'NON-contracting'}")
    print(f"[true-jac] ||J||_2 geomean (all)            = {report['norm_J_2_geomean_all']}")
    print(f"[true-jac] non-normality ||J||/rho          = {report['non_normality_geomean']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
