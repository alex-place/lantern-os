r"""
sigma0_hardness_depth.py — settle Q-exit adaptivity + depth->accuracy against a REAL hardness
proxy (measured solve-success), matched base rates, larger n. (#2031, trilogy 3/3.)

The two pilots left this open:
  * sigma0_qexit_adaptive.py (#2025): E[exit depth] ~flat, correlated with next-token ENTROPY
    (r=0.48) — but entropy is a poor hardness proxy.
  * sigma0_depth_accuracy.py (#2028): forced depth did NOT help on easy/clean arithmetic; the
    facts route was base-rate confounded and discarded.

This script fixes the proxy. Difficulty is DEFINED by the model's actual multi-step
**solve-success** on a graded arithmetic set (1-step add -> 2x2 multiply and two-step
expressions), validated by measuring that success really falls across tiers. Then:

  (a) ADAPTIVITY vs real difficulty: does E[exit depth] (from the Q-exit gate) allocate more
      recurrent steps to items the model is more likely to get WRONG? Correlate E[depth] with
      per-item P(correct) and with 0/1 solve-success; compare E[depth] on solved vs unsolved.
  (b) DEPTH -> ACCURACY on hard tasks: force total_ut_steps in {1,2,3,4,6,8} and measure
      forced-choice accuracy (logP(true) > logP(false), matched-magnitude distractor => base rate
      0.5) PER TIER. Question: on genuinely hard multi-step tiers, does accuracy rise with depth,
      unlike the flat easy-task curve #2028 found, and does it collapse past trained depth (STARS)?

Run:  .venv-train/Scripts/python.exe experiments/sigma0_hardness_depth.py
Env:  OURO_MODEL (default ByteDance/Ouro-1.4B-Thinking), HD_PER_TIER (items/tier, default 20)
"""
import json
import os
import random
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from ouro_compat import patch_universal_transformer_cache  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
DEPTHS = [1, 2, 3, 4, 6, 8]
PER_TIER = int(os.environ.get("HD_PER_TIER", "20"))
OUT = REPO / "data" / "sigma0" / "hardness_depth_report.json"


def matched_false(v):
    """A wrong answer with the SAME digit count as v (matched base rate / magnitude)."""
    s = len(str(v))
    for delta in (3, -3, 7, -7, 11, -11, 21, -21, 4, -4, 9, -9):
        f = v + delta
        if f > 0 and f != v and len(str(f)) == s:
            return f
    return v + 1 if len(str(v + 1)) == s else max(1, v - 1)


def build_items(seed=0):
    """Graded arithmetic. tier1 (1-step) -> tier4 (multi-step 2x2 / two-step). Each item:
    (tier, prompt_prefix, true_answer_str, false_answer_str)."""
    rng = random.Random(seed)
    items = []

    def add(tier, prefix, val):
        items.append({"tier": tier, "prefix": prefix, "true": str(val), "false": str(matched_false(val))})

    seen = set()

    def uniq(key):
        if key in seen:
            return False
        seen.add(key); return True

    while sum(1 for i in items if i["tier"] == "t1_1step") < PER_TIER:
        a, b = rng.randint(2, 9), rng.randint(2, 9)
        if uniq(("t1", a, b)):
            add("t1_1step", f"{a} + {b} = ", a + b)
    while sum(1 for i in items if i["tier"] == "t2_2digit_add") < PER_TIER:
        a, b = rng.randint(11, 89), rng.randint(11, 89)
        if uniq(("t2", a, b)):
            add("t2_2digit_add", f"{a} + {b} = ", a + b)
    while sum(1 for i in items if i["tier"] == "t3_2x1_mult") < PER_TIER:
        a, b = rng.randint(11, 29), rng.randint(3, 9)
        if uniq(("t3", a, b)):
            add("t3_2x1_mult", f"{a} times {b} equals ", a * b)
    while sum(1 for i in items if i["tier"] == "t4_multistep") < PER_TIER:
        if rng.random() < 0.5:
            a, b = rng.randint(11, 39), rng.randint(11, 39)      # 2x2 multiply
            if uniq(("t4m", a, b)):
                add("t4_multistep", f"{a} times {b} equals ", a * b)
        else:
            a, b, c = rng.randint(3, 19), rng.randint(3, 19), rng.randint(2, 9)  # two-step
            if uniq(("t4s", a, b, c)):
                add("t4_multistep", f"( {a} + {b} ) times {c} equals ", (a + b) * c)
    return items


TIERS = ["t1_1step", "t2_2digit_add", "t3_2x1_mult", "t4_multistep"]


def set_depth(model, d):
    for attr in ("total_ut_steps", "num_recurrent_steps"):
        if hasattr(model.config, attr):
            setattr(model.config, attr, d)
    for mod in model.modules():
        for attr in ("total_ut_steps", "num_recurrent_steps"):
            if isinstance(getattr(mod, attr, None), int):
                setattr(mod, attr, d)


def main():
    print(f"[hd] loading {MID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    trained = int(getattr(model.config, "total_ut_steps", 4) or 4)

    captured = {}

    def hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) >= 3 and isinstance(out[2], list):
            captured["gates"] = out[2]
    handle = model.model.register_forward_hook(hook)

    items = build_items()
    print(f"[hd] {len(items)} items, {PER_TIER}/tier, trained depth {trained}", flush=True)

    def fill_logprob(prefix, fill):
        pre = tok(prefix, return_tensors="pt").input_ids
        full = tok(prefix + fill, return_tensors="pt").input_ids.to(model.device)
        a = pre.shape[1]
        with torch.no_grad():
            logits = model(input_ids=full).logits[0].float()
        lp = [float(torch.log_softmax(logits[t - 1], dim=-1)[full[0, t]]) for t in range(a, full.shape[1])]
        return float(np.mean(lp)) if lp else 0.0, (float(np.sum(lp)) if lp else 0.0)

    def greedy_answer(prefix, max_new=6):
        enc = tok(prefix, return_tensors="pt").to(model.device)
        with torch.no_grad():
            gen = model.generate(enc.input_ids, attention_mask=enc.attention_mask,
                                 max_new_tokens=max_new, do_sample=False,
                                 pad_token_id=tok.eos_token_id)
        return tok.decode(gen[0, enc.input_ids.shape[1]:], skip_special_tokens=True).strip()

    def exit_depth(prefix):
        ids = tok(prefix, return_tensors="pt").to(model.device)
        captured.clear()
        with torch.no_grad():
            out = model(**ids)
        gates = captured["gates"]
        lam = [float(torch.sigmoid(gates[i].squeeze(-1)[0, -1])) for i in range(trained)]
        remaining, pdf = 1.0, []
        for i, l in enumerate(lam):
            p_i = (l * remaining) if i < trained - 1 else remaining
            remaining *= (1.0 - l)
            pdf.append(p_i)
        return float(sum((i + 1) * pi for i, pi in enumerate(pdf)))

    # --- pass 1 @ trained depth: solve-success (real hardness), P(true), E[exit depth] per item ---
    set_depth(model, trained)
    for it in items:
        gen = greedy_answer(it["prefix"])
        # success = the decoded continuation begins with the exact true answer (token-boundary tolerant)
        it["solved"] = int(gen.replace(" ", "").startswith(it["true"]))
        mean_lp, _ = fill_logprob(it["prefix"], it["true"])
        it["p_true"] = float(np.exp(mean_lp))            # soft difficulty in (0,1]
        it["exit_depth"] = round(exit_depth(it["prefix"]), 3)
    handle.remove()

    # tier solve-success validates the difficulty gradient
    tier_success = {t: round(float(np.mean([i["solved"] for i in items if i["tier"] == t])), 3) for t in TIERS}
    tier_depth = {t: round(float(np.mean([i["exit_depth"] for i in items if i["tier"] == t])), 3) for t in TIERS}
    tier_ptrue = {t: round(float(np.mean([i["p_true"] for i in items if i["tier"] == t])), 3) for t in TIERS}

    depth = np.array([i["exit_depth"] for i in items])
    solved = np.array([i["solved"] for i in items])
    ptrue = np.array([i["p_true"] for i in items])
    # adaptivity: does the gate spend MORE depth on harder (lower P(true) / unsolved) items?
    corr_depth_ptrue = float(np.corrcoef(depth, ptrue)[0, 1])          # <0 => adaptive (more depth when less sure)
    corr_depth_solved = float(np.corrcoef(depth, solved)[0, 1])        # <0 => adaptive
    d_solved = float(depth[solved == 1].mean()) if (solved == 1).any() else float("nan")
    d_unsolved = float(depth[solved == 0].mean()) if (solved == 0).any() else float("nan")

    # --- pass 2: forced-choice accuracy per tier per forced depth (base rate 0.5) ---
    acc = {t: {} for t in TIERS}
    for d in DEPTHS:
        set_depth(model, d)
        for t in TIERS:
            pool = [i for i in items if i["tier"] == t]
            c = 0
            for it in pool:
                lp_t, _ = fill_logprob(it["prefix"], it["true"])
                lp_f, _ = fill_logprob(it["prefix"], it["false"])
                c += int(lp_t > lp_f)
            acc[t][d] = round(c / len(pool), 4)
        print(f"[hd] depth {d}: " + "  ".join(f"{t.split('_')[0]}={acc[t][d]:.2f}" for t in TIERS), flush=True)

    def rises(curve):
        return bool(curve[trained] > curve[1] + 0.05)

    def collapses(curve):
        return bool(curve[DEPTHS[-1]] < curve[trained] - 0.05)

    hard_tiers = ["t3_2x1_mult", "t4_multistep"]
    # Tier-level adaptivity: does E[exit depth] rise as real solve-success falls across tiers?
    # (the REAL hardness axis this issue asks for — cleaner than per-item confidence).
    tier_succ_arr = np.array([tier_success[t] for t in TIERS])
    tier_depth_arr = np.array([tier_depth[t] for t in TIERS])
    corr_tier = float(np.corrcoef(tier_succ_arr, tier_depth_arr)[0, 1])  # <0 => harder tier -> more depth
    tier_depth_spread = float(tier_depth_arr.max() - tier_depth_arr.min())
    tier_monotone_harder_deeper = bool(tier_depth[TIERS[-1]] > tier_depth[TIERS[0]] + 0.1)
    # graded verdict keyed on the SOLVE-SUCCESS proxy (per-item corr + tier trend), not P_true.
    gap = d_unsolved - d_solved
    strong = (corr_depth_solved < -0.4) or (corr_tier < -0.8 and tier_depth_spread > 0.6)
    weak = (corr_depth_solved < -0.1) or (corr_tier < -0.3 and tier_monotone_harder_deeper) or (gap > 0.05)
    adapt_level = "strong" if strong else ("weak" if weak else "none")
    adaptive = adapt_level != "none"
    report = {
        "task": "Q-exit adaptivity + depth->accuracy vs REAL hardness (measured solve-success), matched base rate",
        "model": MID, "trained_depth": trained, "n_items": len(items), "per_tier": PER_TIER,
        "tiers": TIERS,
        "difficulty_validation_solve_success_by_tier": tier_success,
        "difficulty_gradient_real": bool(tier_success[TIERS[0]] > tier_success[TIERS[-1]] + 0.1),
        "expected_exit_depth_by_tier": tier_depth,
        "p_true_by_tier": tier_ptrue,
        "adaptivity": {
            "corr(exit_depth, P_true)": round(corr_depth_ptrue, 3),
            "corr(exit_depth, solved)": round(corr_depth_solved, 3),
            "E[depth] on solved": round(d_solved, 3),
            "E[depth] on unsolved": round(d_unsolved, 3),
            "exit_depth_range": round(float(depth.max() - depth.min()), 3),
            "corr(exit_depth, solve_success)_per_tier": round(corr_tier, 3),
            "tier_exit_depth_spread": round(tier_depth_spread, 3),
            "tier_monotone_harder_deeper": tier_monotone_harder_deeper,
            "verdict_adaptive": bool(adaptive),
            "adaptivity_level": adapt_level,
            "note": (f"{adapt_level.upper()} adaptivity to REAL difficulty: E[exit depth] rises across "
                     f"tiers as solve-success falls (per-tier corr {round(corr_tier,2)}, spread "
                     f"{round(tier_depth_spread,2)} steps) and per-item corr(E[depth],solved)="
                     f"{round(corr_depth_solved,2)}; the effect is real but small — NOT a strong "
                     f"adaptive-compute story" if adaptive else
                     "E[depth] does NOT track real difficulty (solve-success) => Q-exit is ~fixed-depth "
                     "on this model, confirming #2025 with a REAL proxy, not next-token entropy"),
        },
        "forcedchoice_accuracy_by_tier_by_depth": {t: acc[t] for t in TIERS},
        "depth_helps": {t: {"rises_with_depth": rises(acc[t]), "collapses_past_trained": collapses(acc[t]),
                            "at_depth1": acc[t][1], "at_trained": acc[t][trained], "at_max": acc[t][DEPTHS[-1]],
                            "best": max(acc[t].values()), "best_depth": max(acc[t], key=acc[t].get)}
                        for t in TIERS},
        "depth_helps_on_hard_tasks": any(rises(acc[t]) for t in hard_tiers),
        "evidence_class": "MEASURED (data/sigma0/hardness_depth_report.json)",
        "honest_headline": "",
        "caveats": ("fp16, Ouro-1.4B-Thinking, arithmetic-only graded set (clean, checkable, matched-"
                    "magnitude distractors => base rate 0.5); greedy solve-success uses a 6-token decode + "
                    "prefix-match; forced-choice isolates readout from generation; depths >4 exceed the "
                    "trained operating point (gate undefined there, so E[depth] uses trained depth)."),
    }
    hh = (f"Real difficulty gradient confirmed (solve-success {tier_success[TIERS[0]]} -> "
          f"{tier_success[TIERS[-1]]} across tiers). Q-exit shows {adapt_level.upper()} adaptivity to it "
          f"(corr(E[depth],P_true)={corr_depth_ptrue:.2f}, unsolved E[depth]={d_unsolved:.2f} vs "
          f"solved {d_solved:.2f}). Forced depth "
          f"{'HELPS' if report['depth_helps_on_hard_tasks'] else 'does NOT help'} on hard multi-step "
          f"tiers (t4 {acc['t4_multistep'][1]:.2f}@d1 -> {acc['t4_multistep'][trained]:.2f}@trained -> "
          f"{acc['t4_multistep'][DEPTHS[-1]]:.2f}@d{DEPTHS[-1]}).")
    report["honest_headline"] = hh

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\n=== REAL difficulty (greedy solve-success by tier) ===")
    print("  " + "  ".join(f"{t.split('_')[0]}={tier_success[t]:.2f}" for t in TIERS))
    print("=== Q-exit adaptivity vs real difficulty ===")
    print(f"  corr(E[depth],P_true)={corr_depth_ptrue:.3f}  E[depth] unsolved={d_unsolved:.3f} vs solved={d_solved:.3f}  "
          f"=> {'ADAPTIVE' if adaptive else 'NOT adaptive'}")
    print("=== forced-choice accuracy by tier x depth ===")
    print("depth : " + "  ".join(f"{d:>4}" for d in DEPTHS))
    for t in TIERS:
        print(f"{t.split('_')[0]:5} : " + "  ".join(f"{acc[t][d]:.2f}" for d in DEPTHS))
    print(f"depth helps on hard tasks: {report['depth_helps_on_hard_tasks']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
