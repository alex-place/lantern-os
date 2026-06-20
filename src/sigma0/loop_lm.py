"""
Σ₀ LoopLM — a native Lantern looped-reasoning module.

We do NOT pretrain a looped transformer (that needs 7.7T tokens). Instead this is
our own implementation of the *adaptive-depth latent loop* from
"Scaling Latent Reasoning via Looped Language Models" (Ouro, arXiv 2510.25741),
written from the paper's §3 equations and run on Ouro's pretrained weight-tied
block + exit gate (+ optionally our Σ₀ LoRA adapter).

Why this is a real component, not a re-type: Ouro's stock `generate()` runs a
FIXED depth (total_ut_steps) and does not apply the paper's Q-exit at inference.
This module implements the **Q-exit policy** (per-token cumulative-CDF early exit)
and **surfaces the realized latent loop depth** — the genuine adaptive inference
the paper describes, which the stock checkpoint leaves on the table.

It also adds a **convergence-exit** mode (mode="converge"): instead of halting on
the gate's confidence CDF, iterate the weight-tied block until the last-token hidden
state contracts to a fixed point, ‖hₜ − hₜ₋₁‖/‖hₜ₋₁‖ < ε. See
docs/research/2026-06-19-convergence-tesseract-spiral.md.

Paper §3 (our native impl below):
  λ_t  = σ(gate_t)                     instantaneous exit prob at step t
  S_t  = Π_{j≤t}(1 - λ_j)              survival
  p_t  = λ_t · S_{t-1}                 exit pdf  (last step takes remaining mass)
  CDF  = Σ_{j≤t} p_j
  exit = first t with CDF(t) ≥ q       Q-exit (q = compute/quality knob)

Usage:
    from sigma0.loop_lm import Sigma0LoopLM
    m = Sigma0LoopLM.load("ByteDance/Ouro-1.4B", adapter="D:/lantern-train/ouro-sigma0-adapters/final")
    out = m.generate("Explain a looped language model.", q=0.5, max_new_tokens=200)
    print(out["text"], out["mean_depth"], out["exit_reason"])
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass

os.environ.setdefault("HF_HOME", "D:/hf-cache")

# #768: lazy import of stability gates — only loaded when called, so the module
# is importable without scipy (which is not in the minimal inference venv).
def _finite(x):
    """round(x, 4) or None for nan/inf — JSON-safe scalar for the result dict."""
    return round(float(x), 4) if (x == x and abs(x) != float("inf")) else None


def _stability_gates(A_tensor):
    """Compute #768 region-wideners (numerical-range, Lyapunov, ε-pseudospectral, Kreiss)
    on a Jacobian A. Returns a dict summary (never raises — None on import/compute fail)."""
    try:
        _src = os.path.join(os.path.dirname(__file__), "..", "..")
        if _src not in sys.path:
            sys.path.insert(0, _src)
        from cio_sde.collapse import stability_gates  # noqa: PLC0415
        g = stability_gates(A_tensor, margin=0.0)
        return {
            "gate_numerical_range": g.gate_numerical_range,
            "gate_lyapunov": g.gate_lyapunov,
            "gate_pseudospectral": g.gate_pseudospectral,
            "proven_contracting": g.proven_contracting,
            "numerical_range_abscissa": _finite(g.numerical_range_abscissa),
            "spectral_abscissa": _finite(g.spectral_abscissa),
            "pseudospectral_abscissa": _finite(g.pseudospectral_abscissa),
            "lyapunov_transient_bound": _finite(g.lyapunov_transient_bound),
            "kreiss_bound": _finite(g.kreiss_bound),
        }
    except Exception:
        return None


def _lazy():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    return torch, AutoModelForCausalLM, AutoTokenizer


@dataclass
class Sigma0LoopLM:
    model: object
    tok: object
    max_steps: int

    # ── load ────────────────────────────────────────────────────────────────
    @classmethod
    def load(cls, base="ByteDance/Ouro-1.4B", adapter: str | None = None, dtype="float16"):
        torch, AutoModelForCausalLM, AutoTokenizer = _lazy()
        tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
        if tok.pad_token is None:
            tok.pad_token = tok.eos_token
        model = AutoModelForCausalLM.from_pretrained(
            base, trust_remote_code=True, dtype=getattr(torch, dtype), device_map="auto",
            low_cpu_mem_usage=True)  # avoid the double state-dict materialization that
            # triggers 'OSError 1455: paging file too small' on RAM-starved boxes (#781)
        if adapter:
            from peft import PeftModel
            model = PeftModel.from_pretrained(model, adapter)
        model.eval()
        backbone = model.get_base_model() if hasattr(model, "get_base_model") else model
        max_steps = int(getattr(backbone.config, "total_ut_steps", 4) or 4)
        return cls(model=model, tok=tok, max_steps=max_steps)

    def _backbone(self):
        m = self.model
        return m.get_base_model() if hasattr(m, "get_base_model") else m

    # ── native Q-exit over the last token's per-step gates (paper §3) ─────────
    @staticmethod
    def qexit_step(gate_steps, q: float, max_steps: int):
        """gate_steps: list of scalar exit logits (one per UT step) for ONE token.
        Returns (exit_step_1indexed, confidence_cdf, reason)."""
        import math
        survival = 1.0
        cdf = 0.0
        n = len(gate_steps)
        for t, logit in enumerate(gate_steps, start=1):
            lam = 1.0 / (1.0 + math.exp(-float(logit)))
            p = (survival if t == n else lam * survival)  # last step takes remaining mass
            cdf += p
            survival *= (1.0 - lam)
            if cdf >= q:
                return t, min(1.0, cdf), "threshold_met"
        return n, min(1.0, cdf), "max_depth"

    # ── convergence exit: stop when the latent loop reaches a fixed point ─────
    # Upgrade of Q-exit. Where Q-exit STOPS (confidence CDF ≥ q), this CONVERGES:
    # iterate the weight-tied block until the last-token hidden state contracts,
    # ‖h_t − h_{t-1}‖ / ‖h_{t-1}‖ < eps  →  h* ≈ f(h*) (a fixed point of the loop).
    # See docs/research/2026-06-19-convergence-tesseract-spiral.md (§3, upgrade 1).
    @staticmethod
    def converge_step(hidden_per_step, eps: float, max_steps: int):
        """hidden_per_step: list of last-token hidden vectors (1-D tensors), one per UT step.
        Returns (exit_step_1indexed, rel_delta_at_exit, reason, deltas).
        `deltas` is the full contraction trajectory ‖Δh‖/‖h‖ for experiment E2."""
        deltas = []
        n = len(hidden_per_step)
        for t in range(1, n):
            prev, cur = hidden_per_step[t - 1], hidden_per_step[t]
            denom = float(prev.norm()) or 1e-9
            rel = float((cur - prev).norm()) / denom
            deltas.append(rel)
            if rel < eps:
                return t + 1, rel, "fixed_point", deltas   # 1-indexed exit depth
        return n, (deltas[-1] if deltas else 0.0), "max_depth", deltas

    # ── generation with per-token adaptive depth ─────────────────────────────
    def generate(self, prompt: str, q: float = 0.5, max_new_tokens: int = 200, messages=None,
                 rep_penalty: float = 1.3, mode: str = "qexit", eps: float = 0.05,
                 canary: bool = True, adapt: bool = False):
        """mode='qexit' (baseline, exit on confidence) or 'converge' (exit on
        latent fixed point). 'converge' also returns the mean contraction delta
        so the spiral hypothesis (E2) is falsifiable from real trajectories.

        canary=True wires the decode stream into the Σ₀ SurpriseMonitor (#766): per-token
        self-repeat/echo/argmax-margin feed sigma0_proximity, surfaced as `canary_*` in the
        result — observe-only, it does NOT change the tokens. adapt=True additionally GATES
        rep_penalty/q on that proximity (suppress repeats + exit sooner as collapse nears)."""
        torch, *_ = _lazy()
        if messages is not None:
            ids = self.tok.apply_chat_template(messages, add_generation_prompt=True, return_tensors="pt")
        else:
            # #774/fix-3: match the training template byte-exactly so the trained
            # "### Instruction / ### Response" delimiters activate the adapter.
            formatted = f"### Instruction:\n{prompt}\n\n### Response:\n"
            ids = self.tok(formatted, return_tensors="pt").input_ids
        ids = ids.to(self._backbone().device if hasattr(self._backbone(), "device") else "cuda")
        depths = []
        exit_deltas = []   # contraction trajectory per token (converge mode)
        exit_hiddens = []  # per-token exit-depth hidden vectors (#768 Jacobian)
        eos = self.tok.eos_token_id
        bb = self._backbone()
        lm_head = self.model.lm_head if hasattr(self.model, "lm_head") else bb.lm_head
        # Σ₀ DecodeCanary (#766/#800/#793): the single collapse monitor. Per token it folds
        # self-repeat / n-gram echo / argmax-margin into sigma0_proximity AND tracks the
        # softmax-entropy EMA (#793's over-confidence signal), surfaced as unified canary_*
        # telemetry — no second parallel canary in this loop.
        dc = None
        if canary:
            try:
                from sigma0.decode_canary import DecodeCanary
                dc = DecodeCanary()
            except Exception:
                dc = None  # canary is best-effort; never break generation
        q_cur, rep_cur = q, rep_penalty
        canary_max_prox, canary_spooks, canary_signal = 0.0, 0, "none"
        with torch.no_grad():
            for _tok_idx in range(max_new_tokens):
                # OuroModel.forward returns (outputs, hidden_states_list, gate_list)
                _out, hidden_states_list, gate_list = bb.model(input_ids=ids, use_cache=False)
                if mode == "converge":
                    # contraction over the latent trajectory of the last token
                    h_per_step = [h[0, -1, :] for h in hidden_states_list]
                    step, rel, reason, deltas = self.converge_step(h_per_step, eps, self.max_steps)
                    if deltas:
                        exit_deltas.append(sum(deltas) / len(deltas))
                else:
                    # last-token gate per step → Q-exit
                    gate_steps = [g[0, -1, 0].item() for g in gate_list]
                    step, conf, reason = self.qexit_step(gate_steps, q_cur, self.max_steps)
                depths.append(step)
                hidden = hidden_states_list[step - 1][:, -1:, :]   # hidden at exit depth, last token
                exit_hiddens.append(hidden[0, 0].detach().float().cpu())
                logits = lm_head(hidden)[0, -1]
                if rep_cur and rep_cur != 1.0 and depths:
                    # CTRL-style repetition penalty over tokens already generated this turn
                    for tid in set(ids[0, -len(depths):].tolist()):
                        v = logits[tid]
                        logits[tid] = v / rep_cur if v > 0 else v * rep_cur
                nxt = int(torch.argmax(logits))
                if dc is not None:
                    # Feed both decode-health signals to the one canary: argmax margin
                    # (top1−top2 prob; low = uncertain/degenerate) and full softmax entropy
                    # (#793; a sudden drop = over-confident collapse). softmax computed once
                    # here, after argmax selection, so it never perturbs the chosen token.
                    probs = torch.softmax(logits.float(), dim=-1)
                    top2 = torch.topk(probs, 2).values
                    margin = float((top2[0] - top2[1]).item())
                    entropy = float(-(probs * (probs + 1e-10).log()).sum().item())
                    obs = dc.observe(nxt, margin=margin, exit_depth=step, max_steps=self.max_steps,
                                     entropy=entropy, token_idx=_tok_idx)
                    canary_max_prox = max(canary_max_prox, obs["proximity"])
                    canary_spooks += int(obs["spook"])
                    if obs["signal"] != "none":
                        canary_signal = obs["signal"]
                    if adapt:  # actuator: gate knobs on Σ₀ proximity (opt-in; changes tokens)
                        k = dc.knobs(q, rep_penalty)
                        q_cur, rep_cur = k["q"], k["rep_penalty"]
                ids = torch.cat([ids, torch.tensor([[nxt]], device=ids.device)], dim=1)
                if nxt == eos:
                    break
        text = self.tok.decode(ids[0, -len(depths):], skip_special_tokens=True)
        mean_depth = sum(depths) / len(depths) if depths else 0

        # #768: empirical discrete Jacobian from consecutive exit-depth hidden vectors.
        # A[t] ≈ (h[t+1] - h[t]) / ||h[t]|| — the per-token "transition" in hidden space.
        # We compute a mean outer-product as a compact batch approximation.
        stability_cert = None
        if len(exit_hiddens) >= 2:
            try:
                torch, *_ = _lazy()
                H = torch.stack(exit_hiddens)          # (T, d)
                dH = H[1:] - H[:-1]                   # (T-1, d) deltas
                norms = H[:-1].norm(dim=-1, keepdim=True).clamp(min=1e-9)
                dH_norm = dH / norms                   # normalized transitions
                # Jacobian proxy: mean outer product of consecutive hidden pairs → (d, d)
                A_emp = (dH_norm.unsqueeze(-1) * H[:-1].unsqueeze(-2)).mean(0)
                stability_cert = _stability_gates(A_emp)
            except Exception:
                pass

        out = {
            "text": text,
            "tokens": len(depths),
            "mean_depth": round(mean_depth, 2),
            "max_steps": self.max_steps,
            "exit_reason": "adaptive_qexit" if mode == "qexit" else "convergence_exit",
            "mode": mode,
            "q": q,
            # G10 (#793, now owned by the DecodeCanary): collapse events from the entropy
            # EMA monitor. Empty list = no anomalous confidence spikes during generation.
            "collapse_events": dc.collapse_events if dc is not None else [],
            "canary_mean_entropy": dc.mean_entropy if dc is not None else None,
            # #768: Lyapunov / numerical-range / ε-pseudospectral gates + Kreiss bound on
            # the empirical Jacobian. None = not enough tokens to estimate.
            "stability_gates": stability_cert,
            # #768 acceptance gate — the certificate is CONSUMED here (not just reported):
            # the generation's latent exit-depth trajectory is convergence-ACCEPTED iff its
            # empirical Jacobian is provably contracting by either region-widener gate.
            # None = no certificate (too few tokens). This is the gate the issue asked for.
            "stability_accepted": (bool(stability_cert["proven_contracting"])
                                   if stability_cert is not None else None),
        }
        if dc is not None:   # Σ₀ decode canary telemetry (#766)
            out["canary_max_proximity"] = round(canary_max_prox, 4)
            out["canary_spooks"] = canary_spooks
            out["canary_signal"] = canary_signal
            out["adapt"] = adapt
        if mode == "converge":
            # mean contraction delta across tokens: < eps ⇒ loop genuinely converges (E2)
            out["eps"] = eps
            out["mean_contraction"] = round(sum(exit_deltas) / len(exit_deltas), 4) if exit_deltas else None
        return out


if __name__ == "__main__":
    import sys
    base = sys.argv[1] if len(sys.argv) > 1 else "ByteDance/Ouro-1.4B"
    adapter = sys.argv[2] if len(sys.argv) > 2 else None
    m = Sigma0LoopLM.load(base, adapter=adapter)
    r = m.generate("In one sentence, what is a looped language model?", q=0.5, max_new_tokens=60)
    print("DEPTH(mean):", r["mean_depth"], "/", r["max_steps"], "tokens:", r["tokens"])
    print("TEXT:", r["text"])
