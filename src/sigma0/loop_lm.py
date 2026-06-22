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

    # ── forward-truncation (EXPERIMENTAL) ─────────────────────────────────────
    # Replicates OuroModel.forward but BREAKS the recurrent loop when the last
    # token's Q-exit fires, so simple tokens cost their realized depth instead of
    # full R4. Uses the model's OWN components (embed_tokens / rotary_emb / norm /
    # early_exit_gate / layers / create_causal_mask) — a faithful replica, not a
    # reinvention. No-cache only (each call processes the full sequence and we read
    # only the last token), so it stays O(N^2); it is a win for SHORT outputs where
    # the avoided steps dominate. MUST pass the harness parity check before trust.
    def _truncated_forward(self, ids, q):
        import math
        import sys
        torch, *_ = _lazy()
        m = self._backbone().model  # OuroModel
        mod = sys.modules[type(m).__module__]
        inputs_embeds = m.embed_tokens(ids)
        seq = inputs_embeds.shape[1]
        cache_position = torch.arange(seq, device=inputs_embeds.device)
        position_ids = cache_position.unsqueeze(0)
        mask_kwargs = dict(config=m.config, input_embeds=inputs_embeds, attention_mask=None,
                           cache_position=cache_position, past_key_values=None, position_ids=position_ids)
        causal = {"full_attention": mod.create_causal_mask(**mask_kwargs)}
        if getattr(m, "has_sliding_layers", False):
            causal["sliding_attention"] = mod.create_sliding_window_causal_mask(**mask_kwargs)
        hidden = inputs_embeds
        pos_emb = m.rotary_emb(hidden, position_ids)
        hs_list, g_list = [], []
        survival, cdf = 1.0, 0.0
        n = m.total_ut_steps
        for current_ut in range(n):
            for layer in m.layers[: m.config.num_hidden_layers]:
                hidden = layer(hidden, attention_mask=causal[layer.attention_type],
                               position_ids=position_ids, past_key_value=None, use_cache=False,
                               cache_position=cache_position, position_embeddings=pos_emb,
                               current_ut=current_ut)
            hn = m.norm(hidden)
            g = m.early_exit_gate(hn)
            hs_list.append(hn)
            g_list.append(g)
            # last-token cumulative Q-exit (paper §3) — break when CDF ≥ q
            logit = float(g[0, -1, 0])
            lam = 1.0 / (1.0 + math.exp(-logit))
            t = current_ut + 1
            p = survival if t == n else lam * survival
            cdf += p
            survival *= (1.0 - lam)
            if cdf >= q:
                break
        return hs_list, g_list

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

    # ── acceleration-based convergence exit (the certificate-consistent upgrade) ─
    # Second-order step-size criterion (Two-Scale, arXiv:2509.23314): exit when the
    # ACCELERATION aᵏ = ‖Δᵏ − Δᵏ⁻¹‖ (normalized) stays < eps for `patience` consecutive
    # steps. The first-order converge_step above false-exits on SPIRAL dynamics — a looped
    # block makes orthogonal refinements, so ‖Δh‖ plateaus at a small nonzero value while the
    # direction keeps ROTATING. That rotation is exactly the non-normal / skew case the collapse
    # certificate §1.1 flags as the hard one (where the energy proof fails), so acceleration is
    # both the SOTA exit and the certificate-consistent choice. `deltas` is still the first-order
    # ‖Δh‖/‖h‖ trajectory, kept identical to converge_step so E2 mean_contraction is unchanged.
    @staticmethod
    def accel_step(hidden_per_step, eps: float, max_steps: int, patience: int = 2):
        """Returns (exit_step_1indexed, accel_at_exit, reason, deltas)."""
        deltas, diffs, hits = [], [], 0
        n = len(hidden_per_step)
        for t in range(1, n):
            prev, cur = hidden_per_step[t - 1], hidden_per_step[t]
            denom = float(prev.norm()) or 1e-9
            d = cur - prev
            deltas.append(float(d.norm()) / denom)
            diffs.append(d)
            if len(diffs) >= 2:
                accel = float((diffs[-1] - diffs[-2]).norm())
                accel /= (float(diffs[-1].norm()) + float(diffs[-2].norm()) + 1e-9)
                if accel < eps:
                    hits += 1
                    if hits >= patience:
                        return t + 1, accel, "accel_fixed_point", deltas
                else:
                    hits = 0
        return n, (deltas[-1] if deltas else 0.0), "max_depth", deltas

    # ── generation with per-token adaptive depth ─────────────────────────────
    def generate(self, prompt: str, q: float = 0.5, max_new_tokens: int = 200, messages=None,
                 rep_penalty: float = 1.3, mode: str = "qexit", eps: float = 0.05,
                 canary: bool = True, adapt: bool = False, stop=None):
        """mode='qexit' (baseline, exit on the trained confidence gate — what Ouro was trained
        for), 'converge' (exit on first-order latent fixed point ‖Δh‖<eps), or 'accel' (exit on
        the spiral-robust second-order acceleration ‖Δᵏ−Δᵏ⁻¹‖<eps for 2 steps — the certificate-
        consistent upgrade). 'converge'/'accel' also return the mean contraction delta so the
        spiral hypothesis (E2) is falsifiable from real trajectories.

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
        q_cur, rep_cur, eps_cur = q, rep_penalty, eps
        canary_max_prox, canary_spooks, canary_signal = 0.0, 0, "none"
        # Σ₀ DIVERGENCE instrument — the certificate's SECOND fate (§7). The decode canary's
        # signals (self-repeat / n-gram echo / entropy-drop) detect COLLAPSE; they are blind to
        # divergence: runaway generation that never terminates (varied tokens, low repeat, so
        # degeneracy≈0). We instrument it here, where the tokenizer + token budget are visible.
        # proximity ramps from _div_start → max_new_tokens ("running to the length limit"), and a
        # stray training-template turn marker is an unambiguous restart → hard stop + truncate.
        canary_max_div, stop_reason, _trunc_text = 0.0, None, None
        _div_start = max(8, int(0.6 * max_new_tokens))
        _stop_markers = stop if stop is not None else [
            "\n### Instruction:", "\n### Response:", "\n### Task:", "\n### Input:",
            "</answer>", "<|im_end|>"]
        _EOS_BIAS = 6.0   # logit boost added to EOS, scaled by divergence, only when adapt=True
        # #PERF: incremental KV decode via the model's native UniversalTransformerCache.
        # The legacy path forwarded the FULL growing sequence with use_cache=False on
        # every token = O(N^2) decode — the dominant cost behind ~1 s/token and the
        # 170-280 s coding outliers on the leaderboard. With the cache we encode the
        # prompt once, then forward ONLY the new token each step (O(N) total). The model
        # auto-creates and returns the cache (see modeling_ouro.OuroModel.forward:596,661).
        # The gate/hidden reads below already index [-1] (last position), so they stay
        # correct whether the pass is the full prompt or a single new token.
        # Set OURO_LOOP_CACHE=0 to fall back to the legacy full-re-encode path.
        _use_cache = os.environ.get("OURO_LOOP_CACHE", "1") == "1"
        # #PERF upgrade #2: forward-truncation (EXPERIMENTAL, OURO_LOOP_TRUNCATE=1).
        # Break the recurrent loop when the last token's Q-exit fires → simple tokens
        # cost their realized depth instead of full R4. INCOMPATIBLE with the cross-token
        # KV cache (an early-exiting token never writes its deeper-step KV, so later
        # tokens can't attend to it) → truncation FORCES no-cache and stays O(N^2). Net:
        # a win for SHORT outputs (chat); the cache fix wins for LONG outputs (coding).
        # qexit mode only. Validate parity via `bench_ouro_loop.py --truncate` first.
        _truncate = os.environ.get("OURO_LOOP_TRUNCATE", "0") == "1" and mode == "qexit"
        if _truncate:
            _use_cache = False
        _past = None
        _cur = ids  # first pass = full prompt; subsequent passes = only the new token
        with torch.no_grad():
            for _tok_idx in range(max_new_tokens):
                # OuroModel.forward returns (BaseModelOutputWithPast, hidden_states_list, gate_list)
                if _truncate:
                    hidden_states_list, gate_list = self._truncated_forward(ids, q_cur)
                elif _use_cache:
                    _out, hidden_states_list, gate_list = bb.model(
                        input_ids=_cur, past_key_values=_past, use_cache=True)
                    _past = _out.past_key_values
                else:
                    _out, hidden_states_list, gate_list = bb.model(input_ids=ids, use_cache=False)
                if mode in ("converge", "accel"):
                    # contraction over the latent trajectory of the last token; 'accel' uses the
                    # spiral-robust second-order criterion, 'converge' the first-order one (E2).
                    h_per_step = [h[0, -1, :] for h in hidden_states_list]
                    _exit = self.accel_step if mode == "accel" else self.converge_step
                    # eps_cur is modulated by the adapt actuator below: DIVERGENCE tightens it
                    # (step deeper to resolve the runaway), COLLAPSE loosens it (exit sooner).
                    step, rel, reason, deltas = _exit(h_per_step, eps_cur, self.max_steps)
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
                # Σ₀ divergence proximity: 0 until _div_start, ramps to 1 at the token cap —
                # approaching the length limit without terminating IS the divergence fate.
                divergence = 0.0
                if max_new_tokens > _div_start:
                    divergence = max(0.0, min(1.0, (_tok_idx - _div_start) / (max_new_tokens - _div_start)))
                canary_max_div = max(canary_max_div, divergence)
                # Divergence actuator (opt-in via adapt): bias toward EOS as the run nears the cap,
                # so a runaway is pulled to a stop instead of rambling to the limit. Gentle + late
                # (only past _div_start) — healthy short answers emit EOS well before it, untouched.
                if adapt and divergence > 0.0 and eos is not None:
                    logits[eos] = logits[eos] + _EOS_BIAS * divergence
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
                                     entropy=entropy, token_idx=_tok_idx, divergence=divergence)
                    canary_max_prox = max(canary_max_prox, obs["proximity"])
                    canary_spooks += int(obs["spook"])
                    if obs["signal"] != "none":
                        canary_signal = obs["signal"]
                    if adapt:  # actuator: gate knobs on Σ₀ proximity + divergence (opt-in)
                        k = dc.knobs(q, rep_penalty, divergence=divergence, eps=eps)
                        q_cur, rep_cur = k["q"], k["rep_penalty"]
                        eps_cur = k.get("eps", eps)   # divergence→deeper, collapse→shallower
                _nxt_t = torch.tensor([[nxt]], device=ids.device)
                ids = torch.cat([ids, _nxt_t], dim=1)
                _cur = _nxt_t  # next pass forwards only the new token; the cache holds the rest
                if nxt == eos:
                    break
                # Σ₀ divergence hard-stop: a training-template turn marker means the model has
                # finished the answer and is hallucinating a NEW turn (a restart) — terminate and
                # truncate before the marker rather than letting the tail ramble/rot.
                _g = self.tok.decode(ids[0, -len(depths):], skip_special_tokens=True)
                _hit = next(((m, _g.find(m)) for m in _stop_markers if m in _g), None)
                if _hit is not None:
                    _trunc_text, stop_reason = _g[:_hit[1]].rstrip(), "restart_marker"
                    break
        text = _trunc_text if _trunc_text is not None else self.tok.decode(ids[0, -len(depths):], skip_special_tokens=True)
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
            out["canary_max_divergence"] = round(canary_max_div, 4)  # §7 second fate (runaway)
            out["stop_reason"] = stop_reason                          # 'restart_marker' | None
            out["adapt"] = adapt
        if mode in ("converge", "accel"):
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
