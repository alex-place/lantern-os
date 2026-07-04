r"""
sigma0_loop_jacobian.py — measure the REAL Ouro recurrent-loop contraction (honest rho).

Background: the Collapse Certificate's headline rho=1.064 ("the loop is non-contracting") was
debunked (experiments/rho_controls.py) — it was a fragile linear fit over four TEXT-SURFACE
features (novelty/self_repeat/echo/length), not the model's dynamics. This script does the
measurement right, now that Ouro loads: it captures the ACTUAL per-recurrent-step hidden-state
trajectory and measures whether the weight-tied loop contracts toward a fixed point.

Ouro's OuroModel.forward runs `for current_ut in range(total_ut_steps)` and appends the residual
hidden state after each UT step to `hidden_states_list` (modeling_ouro.py:655). A forward hook on
`model.model` captures that list. For each (prompt, token position) we get a trajectory
h_0, h_1, ... in R^H. The honest observables (no fit):

  d_t = ||h_{t+1} - h_t||                      step-to-step change
  r_t = d_{t+1} / d_t                          per-step contraction ratio
  rho_obs = geomean(r_t) over t                observed linear convergence factor
                                               (the honest analogue of the certificate's rho)

rho_obs < 1  => the loop CONTRACTS toward a fixed point (converging).
rho_obs ~ 1  => marginal / near-boundary.
rho_obs > 1  => expanding / divergent.

We also run PAST the trained depth (total_ut_steps=12 vs the trained 4) to test the STARS
(arXiv 2605.26733) test-time-depth-scaling claim ("looped LMs peak then collapse") on Ouro.

Run:  D:/lantern-venv-train/Scripts/python.exe experiments/sigma0_loop_jacobian.py
"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from ouro_compat import patch_universal_transformer_cache  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MODEL_ID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
STEPS = int(os.environ.get("LOOP_STEPS", "12"))  # run past the trained depth (4) to probe STARS
OUT = REPO / "data" / "sigma0" / "loop_jacobian_report.json"

PROMPTS = [
    "The capital of France is",
    "Two plus two equals",
    "The mitochondria is the powerhouse of the",
    "In 1969, humans first landed on the",
    "def add(a, b):\n    return",
    "The opposite of hot is",
    "Water is made of hydrogen and",
    "She opened the door and saw",
]


def main() -> None:
    print(f"[loop-jac] loading {MODEL_ID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()

    # Run more recurrent steps than trained (STARS depth-scaling probe). Set BOTH config and every
    # per-module instance attribute (the loop reads self.total_ut_steps, cached at __init__).
    trained = int(getattr(model.config, "total_ut_steps", 4) or 4)
    for attr in ("total_ut_steps", "num_recurrent_steps"):
        if hasattr(model.config, attr):
            setattr(model.config, attr, STEPS)
    for mod in model.modules():
        for attr in ("total_ut_steps", "num_recurrent_steps"):
            if isinstance(getattr(mod, attr, None), int):
                setattr(mod, attr, STEPS)
    print(f"[loop-jac] trained depth = {trained}, probing depth = {STEPS}", flush=True)

    captured = {}

    def hook(_module, _inp, out):
        if isinstance(out, (tuple, list)) and len(out) >= 2 and isinstance(out[1], list):
            captured["hsl"] = out[1]

    handle = model.model.register_forward_hook(hook)

    all_ratios = []            # r_t across all (prompt, token, step)
    per_prompt = []
    first_last_delta_ratio = []  # d_last / d_first per trajectory (does the step shrink overall?)

    for prompt in PROMPTS:
        ids = tok(prompt, return_tensors="pt").to(model.device)
        captured.clear()
        with torch.no_grad():
            model(**ids)
        hsl = captured.get("hsl")
        if not hsl or len(hsl) < 3:
            print(f"[loop-jac] WARN no trajectory for {prompt!r} (got {len(hsl or [])} steps)")
            continue
        # hsl: list of `STEPS` tensors [1, seq, H]. Stack -> [STEPS, seq, H].
        traj = torch.stack([h[0].float() for h in hsl], dim=0)  # [STEPS, seq, H]
        d = (traj[1:] - traj[:-1]).norm(dim=-1)                 # [STEPS-1, seq] step deltas
        # per token position: ratio r_t = d_{t+1}/d_t
        r = (d[1:] / (d[:-1] + 1e-9))                            # [STEPS-2, seq]
        all_ratios.append(r.flatten())
        # overall shrink per token: last delta / first delta
        fld = (d[-1] / (d[0] + 1e-9))                            # [seq]
        first_last_delta_ratio.append(fld)
        # last-token summary
        d_last_tok = d[:, -1]                                    # [STEPS-1]
        per_prompt.append({
            "prompt": prompt,
            "step_deltas_last_token": [round(float(x), 3) for x in d_last_tok],
            "geomean_ratio_last_token": round(float(torch.exp(torch.log(
                (d_last_tok[1:] / (d_last_tok[:-1] + 1e-9)).clamp(min=1e-6)).mean())), 4),
        })

    handle.remove()

    R = torch.cat(all_ratios)                                   # all r_t
    FLD = torch.cat(first_last_delta_ratio)
    rho_obs = float(torch.exp(torch.log(R.clamp(min=1e-6)).mean()))  # geometric-mean contraction factor
    frac_expand = float((R > 1.0).float().mean())
    H = int(hsl[0].shape[-1]) if hsl else None

    report = {
        "model": MODEL_ID,
        "hidden_dim": H,
        "trained_depth": trained,
        "probed_depth": STEPS,
        "n_prompts": len(per_prompt),
        "rho_observed_geomean": round(rho_obs, 4),
        "rho_observed_meaning": "geometric-mean per-step contraction ratio ||dh_{t+1}||/||dh_t|| over all (prompt,token,step); <1 = loop contracts to a fixed point",
        "fraction_steps_expanding": round(frac_expand, 4),
        "median_first_to_last_delta_ratio": round(float(FLD.median()), 4),
        "first_to_last_meaning": "median of ||last step change|| / ||first step change||; <1 means the iteration settles as depth grows",
        "vs_debunked_certificate_rho": "certificate rho=1.064 was a fit over 4 text-surface features (see rho_controls.py); this is the real latent loop, observed not fitted",
        "per_prompt": per_prompt,
        "honest_scope": (
            "Observed contraction of the REAL recurrent hidden-state trajectory (not a fitted "
            "Jacobian, so no fit-artifact). rho_observed is a geometric-mean linear convergence "
            "rate, robust to non-normal transients only in aggregate. Measured at probed depth "
            f"{STEPS} (> trained {trained}) to test STARS-style depth scaling on Ouro."),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"[loop-jac] hidden_dim={H}  prompts={len(per_prompt)}  probed_depth={STEPS}")
    print(f"[loop-jac] rho_observed (geomean step-contraction) = {rho_obs:.4f}  "
          f"-> {'CONTRACTING (loop converges)' if rho_obs < 1 else 'NON-contracting' if rho_obs > 1 else 'MARGINAL'}")
    print(f"[loop-jac] fraction of steps expanding (r>1) = {frac_expand:.3f}")
    print(f"[loop-jac] median (last delta / first delta)  = {float(FLD.median()):.4f}  (<1 = settles with depth)")
    print(f"[loop-jac] vs debunked certificate rho=1.064 (that was a text-surface fit, not this)")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
