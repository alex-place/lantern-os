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


# P0 serve-path budgets (env-tunable). The empirical Jacobian is (d,d) with d = hidden size
# (2048 for Ouro-1.4B), but it is rank ≤ T-1 (a mean of T token-transitions), so ρ — the JSRR
# acceptance object — is computed EXACTLY from a (T-1,T-1) reduced Gram (see generate()). We
# additionally window T so the reduced eigenproblem stays cheap on very long generations, and cap
# the geometry-dependent continuous diagnostics (which need the full (d,d) and cost ~7s at d=2048)
# to a small dimension — they are diagnostic + acceptance-fallback only, never the primary gate.
_JAC_TOKEN_WINDOW = int(os.environ.get("SIGMA0_JAC_TOKEN_WINDOW", "256") or 256)
_CONT_GATE_MAX_DIM = int(os.environ.get("SIGMA0_CONT_GATE_MAX_DIM", "512") or 512)


def _stability_gates(A_tensor, jsrr_matrix=None):
    """Stability certificate on the empirical loop Jacobian A. Returns a dict, or None on
    total failure (never raises). Two independently-computed layers:

      • JSRR (acceptance gate) — the DISCRETE spectral-radius criterion ρ(A)<1 (STARS,
        arXiv:2605.26733), numpy-only, computed FIRST so it survives even in the minimal
        inference venv where scipy (needed by the continuous gates below) is absent. When
        `jsrr_matrix` is supplied it is the exact low-rank reduction of `A_tensor` (same
        nonzero spectrum, hence identical ρ and accept verdict) — used so the serve path
        never eigvals a (2048,2048) matrix; ρ/regime/stable are exact, σ_max/‖Av‖ telemetry
        reflect the reduced matrix.
      • #768 continuous region-wideners + non-normal dichotomy — best-effort telemetry
        (scipy-dependent Lyapunov/Kreiss legs); a stricter, over-rejecting sufficient
        contraction test kept for diagnostics and as an acceptance FALLBACK. Skipped when
        `A_tensor` is larger than `_CONT_GATE_MAX_DIM` (they need the full geometry and are
        O(d³) — the reduction does not apply to them, and they are not the primary gate).
    """
    try:
        _src = os.path.join(os.path.dirname(__file__), "..", "..")
        if _src not in sys.path:
            sys.path.insert(0, _src)
        # jsrr_certificate is numpy-only; importing it must not depend on scipy.
        from cio_sde.collapse import jsrr_certificate  # noqa: PLC0415
    except Exception:
        return None

    out = {}
    # JSRR discrete acceptance gate — the object externally validated on real looped LLMs.
    # Margin tunable via SIGMA0_JSRR_MARGIN (default 0.0 = STARS' literal ρ<1).
    try:
        _margin = float(os.environ.get("SIGMA0_JSRR_MARGIN", "0.0") or 0.0)
    except Exception:
        _margin = 0.0
    try:
        j = jsrr_certificate(jsrr_matrix if jsrr_matrix is not None else A_tensor, margin=_margin)
        out["jsrr"] = {
            "spectral_radius": _finite(j.spectral_radius),
            "radius_estimate": _finite(j.radius_estimate),
            "spectral_norm": _finite(j.spectral_norm),
            "penalty": _finite(j.penalty),
            "margin": _finite(j.margin),
            "regime": j.regime,
            "stable": bool(j.stable),
        }
    except Exception:
        out["jsrr"] = None

    # #768 continuous region-wideners (numerical-range, Lyapunov, ε-pseudospectral, Kreiss)
    # — scipy-dependent; best-effort. Certify contraction of the FULL Jacobian and
    # over-reject non-normal A, so they are diagnostic + acceptance fallback, not primary.
    try:
        # geometry-dependent continuous gates need the full (d,d) and are O(d³); skip them above
        # the cap (they are diagnostic + fallback, and JSRR above already gave the exact verdict).
        try:
            _d = int(A_tensor.shape[0])
        except Exception:
            _d = 0
        if _d > _CONT_GATE_MAX_DIM:
            return out or None
        from cio_sde.collapse import stability_gates, dichotomy_certificate  # noqa: PLC0415
        g = stability_gates(A_tensor, margin=0.0)
        out.update({
            "gate_numerical_range": g.gate_numerical_range,
            "gate_lyapunov": g.gate_lyapunov,
            "gate_pseudospectral": g.gate_pseudospectral,
            "proven_contracting": g.proven_contracting,
            "numerical_range_abscissa": _finite(g.numerical_range_abscissa),
            "spectral_abscissa": _finite(g.spectral_abscissa),
            "pseudospectral_abscissa": _finite(g.pseudospectral_abscissa),
            "lyapunov_transient_bound": _finite(g.lyapunov_transient_bound),
            "kreiss_bound": _finite(g.kreiss_bound),
        })
        # #768 contraction half — the non-normal spectral dichotomy: splits by A's own
        # spectrum (cross-term vanishes by invariance) and reports the ungrounded decode
        # drift's fate (COLLAPSE onto the slow manifold vs DIVERGE). Purely diagnostic.
        try:
            dc = dichotomy_certificate(A_tensor, delta=0.0)
            out["dichotomy"] = {
                "fate": dc.fate,
                "collapses": dc.collapses,
                "active_dim": dc.active_dim,
                "slow_dim": dc.slow_dim,
                "slow_abscissa": _finite(dc.slow_abscissa),
                "active_decay_rate": _finite(dc.active_decay_rate),
                "transient_bound": _finite(dc.transient_bound),
                "invariance_residual": _finite(dc.invariance_residual),
            }
        except Exception:
            out["dichotomy"] = None
    except Exception:
        pass  # continuous gates unavailable (e.g. no scipy) — JSRR still gates acceptance

    return out or None


def _accept_stability(cert):
    """Convergence-acceptance verdict for a generation's empirical loop Jacobian.

    Primary signal is the JSRR discrete criterion ρ(A)<1 (STARS, arXiv:2605.26733) — the
    stability object validated on real looped LLMs. Falls back to the #768 continuous
    `proven_contracting` gate when JSRR is absent (older cert dict / compute failure).
    Returns None when there is no certificate at all (too few tokens) — an honest unknown,
    never a fabricated False (and None is falsy, so a consumer that requires acceptance
    safely declines rather than trusting an un-certified trajectory)."""
    if not isinstance(cert, dict):
        return None
    jsrr = cert.get("jsrr")
    if isinstance(jsrr, dict) and jsrr.get("stable") is not None:
        return bool(jsrr["stable"])
    pc = cert.get("proven_contracting")
    return bool(pc) if pc is not None else None


def assemble_reason_verdict(out):
    """ADR-0012 step 1 — package the loop's already-computed telemetry into one
    normalized ReasonVerdict (pure observability, no behavior change).

    The nested-adaptive-Reason design (docs/adr/0012-nested-adaptive-reason.md)
    uses one shared ReasonVerdict so the within-model Q-exit loop and the
    cross-model fidelity ladder read the SAME convergence signal. This is the
    additive step-1 slice: it only reshapes fields ``generate()`` already returns —
    it changes no exit or escalation behavior. Steps 2-4 (inner break, outer
    trigger, JS serving-path close) consume this struct in later PRs.

    ``out`` is the dict returned by ``Sigma0LoopLM.generate()``. Returns::

        { converged, depth, proximity, grounded, stable, reason }

    Honesty notes about what this layer can and cannot know:
      - ``grounded`` is None here: groundedness is judged by the JS-side
        groundedness-canary at serving time, not inside the token loop. ADR step 4
        fills it; None (not a fabricated 1.0) is deliberate.
      - ``converged`` is None when the stability certificate had too few tokens to
        decide — honest-unknown over a fabricated False (and None is falsy, so the
        ADR's converge-door safely declines to accept when unsure → escalates).
      - ``reason`` is a GENERATE-level summary, not the per-token door reason. The
        per-token reasons (threshold_met / fixed_point / accel_fixed_point /
        max_depth) live in qexit_step/converge_step/accel_step; the aggregate loop
        keeps only the coarse mode-level ``exit_reason``, so this maps to the
        closest verdict reason, with escalation-relevant signals taking priority.
    """
    gates = out.get("stability_gates") if isinstance(out.get("stability_gates"), dict) else {}
    dichotomy = gates.get("dichotomy") if isinstance(gates.get("dichotomy"), dict) else {}
    jsrr = gates.get("jsrr") if isinstance(gates.get("jsrr"), dict) else {}
    fate = str(dichotomy.get("fate") or "").upper()
    regime = str(jsrr.get("regime") or "").lower()   # JSRR discrete verdict (primary gate)
    signal = out.get("canary_signal", "none")

    # stable ∈ {contract, spiral, diverge, None-when-uncertifiable}. The JSRR DISCRETE acceptance
    # (ρ<1−margin) is AUTHORITATIVE for an iterated loop; the #768 continuous proven_contracting gate
    # certifies e^{tA} (max Re λ<0) — a DIFFERENT criterion that must NEVER override a discrete
    # 'divergent' (ρ≥1) verdict (a λ=−2 loop is continuous-stable yet ρ=2 DIVERGES). So JSRR decides
    # when present; proven_contracting/fate are the FALLBACK only when JSRR is absent (older cert),
    # preserving the prior reason_verdict contract. Keying on jsrr.stable (not regime=='contraction')
    # also respects the margin — the near-critical band ρ∈[1−margin,1) is 'spiral', not 'contract'.
    # (Fix 2026-07-23, math-check: OR-ing the continuous gate mislabelled a discrete-divergent loop
    # 'contract' → a false 'grounded' when external_grounded=True.)
    jsrr_accept = jsrr.get("stable")   # True ⟺ ρ<1−margin (margin-respecting); None when no JSRR ran
    if jsrr_accept is True:
        stable = "contract"
    elif jsrr_accept is False:
        stable = "diverge" if regime == "divergent" else "spiral"   # rejected: diverging vs near-critical
    elif gates.get("proven_contracting"):
        stable = "contract"          # FALLBACK: continuous gate, only when the discrete JSRR is absent
    elif fate == "DIVERGE":
        stable = "diverge"
    elif fate in ("COLLAPSE", "MARGINAL"):
        stable = "spiral"
    else:
        stable = None  # too few tokens / no certificate — honest unknown, not a guess

    # reason — escalation-relevant fates win; else fall back to the mode's exit_reason
    if signal and signal != "none":
        reason = "collapse"          # decode-canary caught surface collapse (echo/repeat)
    elif stable == "diverge":
        reason = "divergence"        # latent dynamics running away
    elif stable == "spiral":
        reason = "collapse"          # latent collapse onto the slow manifold / metastable
    elif out.get("exit_reason") == "convergence_exit":
        reason = "fixed_point"
    else:  # "adaptive_qexit" and any other mode-level label
        reason = "threshold_met"

    accepted = out.get("stability_accepted")
    return {
        "converged": (bool(accepted) if accepted is not None else None),
        "depth": out.get("mean_depth"),
        "proximity": out.get("canary_max_proximity"),
        "grounded": None,  # filled by the JS groundedness-canary at serving (ADR step 4)
        "stable": stable,
        "reason": reason,
    }


def sigma0_grounding_verdict(out, external_grounded=None, verifiable=None):
    """The Σ₀-grounding verdict for ONE generated answer — an honest, two-factor certificate.

    An answer is Σ₀-GROUNDED iff BOTH hold:
      1. the reasoning loop was STABLE — it contracted (JSRR ρ<1), i.e. it did not collapse
         onto a frozen self-agreeing state nor diverge. This is the PROVEN-in-regime gate
         (Collapse Certificate §1/§1.2.3). A stable loop is NECESSARY but NOT SUFFICIENT for a
         correct answer.
      2. an EXTERNAL verifier confirmed the answer — execution/held-out tests (code/math), or
         a groundedness signal (facts). Stability is a property of the *dynamics*; correctness
         is a property of *reality*, and the certificate is explicit that a loop-stability
         signal only becomes a factuality signal once external grounding is supplied
         (SIGMA0-COLLAPSE-CERTIFICATE.md #2236; the Freshness Law: internal signals are alarms,
         never the selector).

    THE LOAD-BEARING INVARIANT (verified in tests): ``grounded=True`` is returned ONLY when the
    loop is stable AND ``external_grounded is True``. It is NEVER True on stability alone — a
    false "grounded" is the one dangerous failure this function exists to prevent.

    Args:
      out: the dict from ``Sigma0LoopLM.generate()`` (or any dict with the verdict fields).
      external_grounded: True/False from an external verifier upstream; None = no check ran
        (the model server itself has no verifier — that signal is supplied by the Spiral /
        exec-verifier / groundedness-canary at the serving or tool layer).
      verifiable: True if the task admits an external check (code/math with tests); None=unknown.

    Returns ``{ grounded, stable, loop_certified, external_grounded, klass, why }`` where
    ``grounded ∈ {True, False, None}`` (None = honestly-undetermined, never a fabricated pass).
    """
    rv = assemble_reason_verdict(out) if "stable" not in out else out
    stable = rv.get("stable")
    loop_certified = (stable == "contract")   # PROVEN-in-regime contraction gate

    if not loop_certified:
        # loop collapsed / diverged / too-few-tokens-to-certify → NOT grounded, escalate/reject
        klass = {"diverge": "diverged", "spiral": "collapsed"}.get(stable, "uncertified")
        return {"grounded": False, "stable": stable, "loop_certified": False,
                "external_grounded": external_grounded, "klass": klass,
                "why": "reasoning loop did not contract (ρ≥1 / collapse / uncertifiable) — not grounded"}

    # loop is stable; grounding now hinges ENTIRELY on the external check
    if external_grounded is True:
        return {"grounded": True, "stable": stable, "loop_certified": True,
                "external_grounded": True, "klass": "externally_verified",
                "why": "stable loop AND external verifier confirmed the answer — Σ₀-grounded"}
    if external_grounded is False:
        return {"grounded": False, "stable": stable, "loop_certified": True,
                "external_grounded": False, "klass": "verification_failed",
                "why": "stable loop but the external verifier rejected the answer — keep spiraling / escalate"}
    # external_grounded is None — no check ran. Stable, but grounding is HONESTLY undetermined.
    if verifiable is False:
        klass, why = "stability_certified_only", ("loop stable; task is not externally verifiable, so Σ₀ "
                     "cannot certify factual grounding — surfaced as unverified, never claimed grounded")
    else:
        klass, why = "unverified", ("loop stable but no external verifier ran yet — the Spiral should "
                     "verify before this is claimed grounded (grounded stays None, not True)")
    return {"grounded": None, "stable": stable, "loop_certified": True,
            "external_grounded": external_grounded, "klass": klass, "why": why}


# ADR-0012 step 2 kill-switch: the door-2 inner break is OPT-IN and per-step revertible.
# Default OFF ⇒ zero behavior change vs baseline until a bench proves compute-saved ≥ quality.
DOOR2_DEFAULT_PATIENCE = 2


def door2_enabled():
    """True iff the ADR-0012 step-2 door-2 inner break is enabled (SIGMA0_DOOR2=1)."""
    return os.environ.get("SIGMA0_DOOR2") == "1"


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
        # RAM preflight (#781): fail fast with a clear message instead of driving the
        # 12 GB box into the paging-file OOM spiral when a load races other evals/agents.
        from .ram_guard import require_free_ram
        require_free_ram(what=f"Ouro model '{base}'")
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

    # ── ADR-0012 step 2: door-2 inner break on certified instability ─────────────
    # The collapse certificate (`_stability_gates`) already reports the spectral fate
    # (CONTRACT vs DIVERGE) of the latent loop but is "purely diagnostic; reported, not
    # consumed by the gate" (loop_lm.py:73). Step 2 consumes it: stop spending recurrent
    # depth on a token the certificate says will DIVERGE for `patience` consecutive steps —
    # a strict compute saving, independent of steps 1/3/4. This is the pure DECISION core
    # (a patience counter over per-step certificate verdicts), mirroring accel_step's
    # patience pattern so it is unit-testable without the model. The per-step certificate
    # (`_stability_gates` on each step's Jacobian, torch) and the required bench parity on
    # bench_ouro_loop.py / eval_humaneval_ouro.py are the on-box completion — this primitive
    # is what that wiring calls, and it is gated OFF by default (SIGMA0_DOOR2) so it can
    # never change baseline behavior until a bench proves compute-saved ≥ baseline quality.
    @staticmethod
    def stability_break_step(contract_flags, patience: int = 2):
        """Given per-step certificate verdicts, decide the door-2 break.

        `contract_flags[k]` is the fate of recurrent step k: True = proven contracting,
        False = certified non-contract (DIVERGE/spiral), None = uncertifiable (too few
        tokens — honest-unknown). Break when NON-contract persists for `patience`
        CONSECUTIVE steps; True or None resets the run (we only cut depth on a token the
        certificate is *confirming* is diverging, never on an unknown — that stays a
        max-depth ride, matching the ADR's "decline when unsure" stance).

        Returns (break_step_1indexed, reason): the 1-indexed step at which the patience-th
        consecutive non-contract lands and we break, or (None, "no_break") if never.
        """
        run = 0
        for k, flag in enumerate(contract_flags or []):
            if flag is False:
                run += 1
                if run >= patience:
                    return k + 1, "certified_divergence"
            else:  # True (contracting) or None (uncertifiable) → reset the consecutive run
                run = 0
        return None, "no_break"

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
                # INTENTIONAL BEHAVIOR: for generations longer than the window we measure stability
                # over the MOST RECENT transitions, not the whole history. This is (a) a cost bound —
                # the reduced eigenproblem is (T-1,T-1), O(T³), so an unwindowed 2000-token generation
                # would re-approach the 7s cost the (d,d) path had — and (b) arguably the more relevant
                # signal ("is the loop stable *now*"). NOTE: this is NOT verdict-preserving vs pre-patch
                # for T>window; only the low-rank *reduction* (below) is exact. The reduction preserves
                # ρ to machine precision; the window is a deliberate recency change (SIGMA0_JAC_TOKEN_WINDOW).
                if H.shape[0] > _JAC_TOKEN_WINDOW + 1:
                    H = H[-(_JAC_TOKEN_WINDOW + 1):]
                dH = H[1:] - H[:-1]                   # (T-1, d) deltas
                norms = H[:-1].norm(dim=-1, keepdim=True).clamp(min=1e-9)
                dH_norm = dH / norms                   # normalized transitions
                Hprev = H[:-1]                          # (T-1, d)
                # A_emp = (1/(T-1)) Σ_t dH_norm[t] ⊗ Hprev[t] = (1/(T-1)) dH_normᵀ Hprev — a (d,d)
                # matrix of rank ≤ T-1. Its NONZERO spectrum (hence ρ, the JSRR acceptance object)
                # equals that of the (T-1,T-1) Gram G = (1/(T-1)) Hprev dH_normᵀ (UVᵀ↔VᵀU identity),
                # so ρ is computed EXACTLY from the tiny matrix — ~570× cheaper at d=2048, machine-
                # precision match (experiments/p0_gate_measure.py M5). eigvals(d=2048)≈7s/gen → sub-
                # ms. σ_max/‖Av‖ telemetry is NOT preserved by the reduction, so the diagnostic
                # continuous gates still see the full A_emp (capped by dim so they never cost 7s).
                Tm1 = Hprev.shape[0]
                jsrr_mat = (Hprev @ dH_norm.transpose(-1, -2)) / max(Tm1, 1)   # (T-1, T-1), exact ρ
                # (d,d) via matmul — mathematically the same mean-outer-product, but WITHOUT the
                # (T-1,d,d) broadcast intermediate (≈2GB at d=2048); only the diagnostics use it.
                A_emp = (dH_norm.transpose(-1, -2) @ Hprev) / max(Tm1, 1)       # (d, d)
                stability_cert = _stability_gates(A_emp, jsrr_matrix=jsrr_mat)
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
            # Acceptance gate — the certificate is CONSUMED here (not just reported): the
            # generation's latent exit-depth trajectory is convergence-ACCEPTED iff its
            # empirical loop Jacobian passes the JSRR discrete criterion ρ(A)<1 (STARS,
            # arXiv:2605.26733) — the stability object externally validated on real looped
            # LLMs, and the criterion appropriate to a DISCRETE iterated loop. The #768
            # continuous gate (proven_contracting) is a stricter, over-rejecting sufficient
            # condition kept as fallback when JSRR is unavailable, and as telemetry above.
            # None = no certificate (too few tokens to estimate the Jacobian).
            "stability_accepted": _accept_stability(stability_cert),
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
        # ADR-0012 step 1: surface the normalized ReasonVerdict alongside the raw
        # telemetry. Best-effort — a verdict bug must never break generation.
        try:
            out["reason_verdict"] = assemble_reason_verdict(out)
        except Exception:
            out["reason_verdict"] = None
        return out


if __name__ == "__main__":
    import sys
    base = sys.argv[1] if len(sys.argv) > 1 else "ByteDance/Ouro-1.4B"
    adapter = sys.argv[2] if len(sys.argv) > 2 else None
    m = Sigma0LoopLM.load(base, adapter=adapter)
    r = m.generate("In one sentence, what is a looped language model?", q=0.5, max_new_tokens=60)
    print("DEPTH(mean):", r["mean_depth"], "/", r["max_steps"], "tokens:", r["tokens"])
    print("TEXT:", r["text"])
