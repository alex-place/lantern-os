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


# P0 serve-path budgets (env-tunable). The token-transition operator is (d,d) with d = hidden size
# (2048 for Ouro-1.4B), but it has rank ≤ T-1, so its nonzero spectrum comes from a (T-1,T-1)
# reduction (see _empirical_transition). We additionally window T so that stays cheap on very long
# generations, and cap the geometry-dependent continuous diagnostics (which need the full (d,d)
# and cost ~7s at d=2048) to a small dimension. Neither is the primary verdict: that is the
# per-token loop contraction (depth_contraction_stats).
_JAC_TOKEN_WINDOW = int(os.environ.get("SIGMA0_JAC_TOKEN_WINDOW", "256") or 256)
_CONT_GATE_MAX_DIM = int(os.environ.get("SIGMA0_CONT_GATE_MAX_DIM", "512") or 512)
# The discrete dichotomy's Kreiss sweep takes 144 inversions and SVDs. Measured on the dev box: 0.14s
# at d=64, 5s at d=128, 80s at d=512. That is far too much for a diagnostic on the serve path.
_DICHOTOMY_MAX_DIM = int(os.environ.get("SIGMA0_DICHOTOMY_MAX_DIM", "64") or 64)


def _depth_stats(hidden_states_list):
    """One token's contraction stats from its per-depth hidden states, or None. Telemetry must
    never break generation, so any failure reads as 'no stats for this token'."""
    try:
        _src = os.path.join(os.path.dirname(__file__), "..", "..")
        if _src not in sys.path:
            sys.path.insert(0, _src)
        from cio_sde.collapse import depth_contraction_stats  # noqa: PLC0415
        return depth_contraction_stats([h[0, -1, :] for h in hidden_states_list])
    except Exception:
        return None


def _empirical_transition(H, rcond=1e-6, max_full_dim=None):
    """Least-squares operator from one generation's per-token hidden vectors (exact DMD).

    Fits h[t+1] ≈ J h[t] for H of shape (T, d): J = H₊ᵀ(H₀ᵀ)⁺, whose nonzero spectrum equals that
    of the (T-1,T-1) reduction (H₀ᵀ)⁺H₊ᵀ. Scale-invariant: H ↦ cH leaves J unchanged. Returns
    (J or None above the diagnostic cap, reduction).

    This is the TOKEN-to-token map, not the recurrent map's Jacobian, and with T < d its radius is
    a Ritz estimate, which tends to read low. Telemetry and a fallback only. It replaces a mean of
    Δh/‖h‖ ⊗ h, which scaled with ‖h‖ and estimated (J−I)·C rather than J, so its verdict tracked
    the size of the hidden state instead of the dynamics.
    """
    import torch  # noqa: PLC0415
    H0, H1 = H[:-1].double(), H[1:].double()
    U, S, Vh = torch.linalg.svd(H0.T, full_matrices=False)
    keep = S > rcond * S.max().clamp_min(1e-300)
    U, S, Vh = U[:, keep], S[keep], Vh[keep]
    reduced = (Vh.T / S) @ (U.T @ H1.T)
    cap = _CONT_GATE_MAX_DIM if max_full_dim is None else max_full_dim
    full = None if H.shape[1] > cap else ((H1.T @ Vh.T) / S) @ U.T
    return full, reduced


def _stability_gates(A_tensor, jsrr_matrix=None, depth_stats=None):
    """Stability certificate for one generation. Returns a dict, or None on total failure (never
    raises). Three independently-computed layers:

      • Loop contraction (the verdict) — from `depth_stats`, the per-token
        depth_contraction_stats. Measured on the recurrent map's own iterates, numpy-only, and
        independent of the scale of the hidden state.
      • JSRR — the discrete spectral-radius criterion ρ<1 (STARS, arXiv:2605.26733) on the token-
        transition operator, numpy-only, so it survives in the minimal inference venv. Telemetry,
        and the verdict only when there are no depth stats. `jsrr_matrix`, when supplied, is the
        low-rank reduction of `A_tensor` (same nonzero spectrum, identical ρ), so the serve path
        never eigvals a (2048,2048) matrix. σ_max/‖Av‖ telemetry reflect the reduced matrix.
      • #768 continuous gates + discrete dichotomy on `A_tensor` — best-effort telemetry (scipy).
        `A_tensor` is the discrete map J, so the continuous gates read its flow embedding J−I.
        Skipped when `A_tensor` is None or larger than `_CONT_GATE_MAX_DIM` (O(d³)).
    """
    try:
        _src = os.path.join(os.path.dirname(__file__), "..", "..")
        if _src not in sys.path:
            sys.path.insert(0, _src)
        # both are numpy-only; importing them must not depend on scipy.
        from cio_sde.collapse import jsrr_certificate, loop_contraction_certificate  # noqa: PLC0415
    except Exception:
        return None

    out = {}
    # Margin tunable via SIGMA0_JSRR_MARGIN (default 0.0 = STARS' literal ρ<1).
    try:
        _margin = float(os.environ.get("SIGMA0_JSRR_MARGIN", "0.0") or 0.0)
    except Exception:
        _margin = 0.0
    try:
        _transient_max = float(os.environ.get("SIGMA0_LOOP_TRANSIENT_MAX", "10") or 10)
        lc = loop_contraction_certificate(depth_stats, margin=_margin, transient_max=_transient_max)
        if lc is not None:
            out["loop_contraction"] = {
                "factor": _finite(lc.factor),
                "worst_factor": _finite(lc.worst_factor),
                "net_factor": _finite(lc.net_factor),
                "transient": _finite(lc.transient),
                "n_tokens": lc.n_tokens,
                "margin": _finite(lc.margin),
                "transient_max": _finite(lc.transient_max),
                "regime": lc.regime,
                "stable": bool(lc.stable),
            }
    except Exception:
        pass
    _matrix = jsrr_matrix if jsrr_matrix is not None else A_tensor
    if _matrix is not None:
        try:
            j = jsrr_certificate(_matrix, margin=_margin)
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

    # #768 continuous gates (numerical-range, Lyapunov, ε-pseudospectral, Kreiss) — scipy-
    # dependent; best-effort. They certify the flow ẋ=(J−I)x and over-reject non-normal maps, so
    # they are diagnostic + a last-resort fallback.
    try:
        # geometry-dependent gates need the full (d,d) and are O(d³); skip them above the cap.
        if A_tensor is None or int(A_tensor.shape[0]) > _CONT_GATE_MAX_DIM:
            return out or None
        import torch  # noqa: PLC0415
        from cio_sde.collapse import stability_gates, discrete_dichotomy_certificate  # noqa: PLC0415
        g = stability_gates(A_tensor - torch.eye(A_tensor.shape[0], dtype=A_tensor.dtype), margin=0.0)
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
        # Fate of the token-transition map under the discrete dichotomy. Purely diagnostic.
        if int(A_tensor.shape[0]) > _DICHOTOMY_MAX_DIM:
            return out
        try:
            dc = discrete_dichotomy_certificate(A_tensor, delta=0.0)
            out["dichotomy"] = {
                "fate": dc.fate,
                "collapses": dc.collapses,
                "marginal_kind": dc.marginal_kind,
                "active_dim": dc.active_dim,
                "slow_dim": dc.slow_dim,
                "slow_radius": _finite(dc.slow_radius),
                "active_decay_factor": _finite(dc.active_decay_factor),
                "transient_bound": _finite(dc.transient_bound),
                "coupling_norm": _finite(dc.coupling_norm),
                "full_transient_bound": _finite(dc.full_transient_bound),
                "invariance_residual": _finite(dc.invariance_residual),
            }
        except Exception:
            out["dichotomy"] = None
    except Exception:
        pass  # continuous gates unavailable (e.g. no scipy) — the verdict above still stands

    return out or None


def _accept_stability(cert):
    """Convergence-acceptance verdict for a generation.

    Primary signal is the measured loop contraction (depth_contraction_stats): a norm on the
    recurrent map's own iterates. Falls back to JSRR ρ<1 on the token-transition operator when
    there are no depth stats, then to the continuous gate on an older certificate dict.
    Returns None when there is no certificate at all (too few tokens) — an honest unknown,
    never a fabricated False (and None is falsy, so a consumer that requires acceptance
    safely declines rather than trusting an un-certified trajectory)."""
    if not isinstance(cert, dict):
        return None
    lc = cert.get("loop_contraction")
    if isinstance(lc, dict) and lc.get("stable") is not None:
        return bool(lc["stable"])
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
    lc = gates.get("loop_contraction") if isinstance(gates.get("loop_contraction"), dict) else {}
    primary = lc or jsrr                             # measured contraction, else JSRR
    regime = str(primary.get("regime") or "").lower()
    signal = out.get("canary_signal", "none")

    # stable ∈ {contract, spiral, diverge, None-when-uncertifiable}. The measured discrete verdict
    # (loop contraction, else JSRR ρ<1−margin) is AUTHORITATIVE for an iterated loop; the #768
    # continuous proven_contracting gate certifies a flow — a DIFFERENT criterion that must NEVER
    # override a discrete 'divergent' verdict. So the discrete signal decides when present;
    # proven_contracting/fate are the FALLBACK only when it is absent (older cert), preserving the
    # prior reason_verdict contract. Keying on `stable` (not regime=='contraction') also respects
    # the margin: rejected-but-not-divergent (near-critical, or transient growth) is 'spiral'.
    # (Fix 2026-07-23, math-check: OR-ing the continuous gate mislabelled a discrete-divergent loop
    # 'contract' → a false 'grounded' when external_grounded=True.)
    primary_accept = primary.get("stable")   # None when no discrete signal ran
    if primary_accept is True:
        stable = "contract"
    elif primary_accept is False:
        stable = "diverge" if regime == "divergent" else "spiral"   # rejected: diverging vs not
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
        # Latent collapse onto the slow manifold / metastable. But a plateau ran out of depth without
        # settling, and a transient amplified and came back: neither froze.
        reason = {"plateau": "max_depth", "transient": "divergence"}.get(regime, "collapse")
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


def sigma0_grounding_verdict(out, external_grounded=None, verifiable=None, experiments_exhausted=False):
    """The Σ₀-grounding verdict for ONE generated answer — an honest, two-factor certificate with
    an ACTIVE last leg.

    An answer is Σ₀-GROUNDED iff BOTH hold:
      1. the reasoning loop was STABLE — it contracted (measured loop contraction), i.e. it did not collapse
         onto a frozen self-agreeing state nor diverge (MEASURED on the iterates; §1.2.3). Necessary,
         NOT sufficient.
      2. an EXTERNAL verifier confirmed the answer — execution/held-out tests, or a groundedness
         signal. A loop-stability signal only becomes a factuality signal once external grounding
         is supplied (#2236; Freshness Law).

    THE ACTIVE FACE (Certificate Part IV §10, ACT-TO-KNOW): a stable-but-unverified answer is NOT
    left to rest as "I don't know". The system takes the last leg — it EXPERIMENTS to manufacture
    the missing verification (run the test, execute, retrieve, escalate). The verdict signals this
    with ``next_action="experiment"`` and ``grounded=None`` (a PENDING state that DIRECTS action,
    not a refusal). Only when **all available means are exhausted** does the answer settle to
    ``grounded=False`` — treated as **EFFECTIVELY FALSE until an experiment proves it true**
    (a falsificationist stance; NOT a claim of real-world falsity). Refusal/abstention is not a
    resting place: verify it, or hold it false.

    THE LOAD-BEARING INVARIANT (verified in tests, UNCHANGED): ``grounded=True`` is returned ONLY
    when the loop is stable AND ``external_grounded is True`` — never on stability alone, and the
    active-face change only ever moves the undetermined case toward the SAFE (not-grounded) side.

    Args:
      out: the dict from ``Sigma0LoopLM.generate()`` (or any dict with the verdict fields).
      external_grounded: True/False from an external verifier upstream; None = not yet checked.
      verifiable: True if the task admits an external check; False = no experiment can help;
        None = unknown (default: assume a means exists and experiment).
      experiments_exhausted: True once the active loop has tried every available means and still
        could not verify — flips the undetermined case to grounded=False (effectively false).

    Returns ``{ grounded, stable, loop_certified, external_grounded, klass, next_action, why }``.
    ``next_action ∈ {accept, experiment, escalate, halt}`` — the machine directive for the loop.
    """
    rv = assemble_reason_verdict(out) if "stable" not in out else out
    stable = rv.get("stable")
    loop_certified = (stable == "contract")   # the measured contraction verdict

    if not loop_certified:
        # loop collapsed / diverged / too-few-tokens-to-certify → NOT grounded; escalate & retry
        spiral = "collapsed" if rv.get("reason", "collapse") == "collapse" else "unsettled"
        klass = {"diverge": "diverged", "spiral": spiral}.get(stable, "uncertified")
        return {"grounded": False, "stable": stable, "loop_certified": False,
                "external_grounded": external_grounded, "klass": klass, "next_action": "escalate",
                "why": "reasoning loop did not contract (ρ≥1 / collapse / plateau / uncertifiable) — not grounded"}

    # loop is stable; grounding now hinges ENTIRELY on the external check
    if external_grounded is True:
        return {"grounded": True, "stable": stable, "loop_certified": True,
                "external_grounded": True, "klass": "externally_verified", "next_action": "accept",
                "why": "stable loop AND external verifier confirmed the answer — Σ₀-grounded"}
    if external_grounded is False:
        return {"grounded": False, "stable": stable, "loop_certified": True,
                "external_grounded": False, "klass": "verification_failed", "next_action": "escalate",
                "why": "stable loop but the external verifier rejected the answer — keep spiraling / escalate"}

    # external_grounded is None — not yet verified. THE ACTIVE FACE: do not refuse; take the last leg.
    means_left = (verifiable is not False) and (not experiments_exhausted)
    if means_left:
        return {"grounded": None, "stable": stable, "loop_certified": True,
                "external_grounded": None, "klass": "experiment_required", "next_action": "experiment",
                "why": "stable but unverified — ACT to verify (run the test / exec-verify / retrieve / "
                       "escalate); this is a PENDING directive, not a resting refusal (Certificate Part IV)"}
    # every available means exhausted (or the task admits no experiment) → effectively FALSE until true
    return {"grounded": False, "stable": stable, "loop_certified": True,
            "external_grounded": None, "klass": "unverifiable_exhausted", "next_action": "halt",
            "why": "stable but unverifiable after exhausting all means — treated as EFFECTIVELY FALSE "
                   "until an experiment proves it true (falsificationist; NOT a claim of real-world falsity)"}


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
        exit_hiddens = []  # per-token exit-depth hidden vectors (token-transition telemetry)
        depth_stats = []   # per-token depth_contraction_stats (the acceptance verdict)
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
                depth_stats.append(_depth_stats(hidden_states_list))
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

        # Stability certificate: measured loop contraction (verdict) + token-transition telemetry.
        stability_cert = None
        full, reduced = None, None
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
                full, reduced = _empirical_transition(H)
            except Exception:
                pass   # the SVD refuses a non-finite H, which must not erase the verdict below
        try:
            stability_cert = _stability_gates(full, jsrr_matrix=reduced,
                                              depth_stats=depth_stats[-_JAC_TOKEN_WINDOW:])
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
            # Acceptance verdict: the generation is convergence-ACCEPTED iff the recurrent loop
            # measurably contracted on its own iterates (loop_contraction), with JSRR ρ<1 on the
            # token-transition operator as the fallback. Reported here, not enforced: the text is
            # returned either way, and sigma0_grounding_verdict turns this into a next_action.
            # None = no certificate (too few tokens to estimate anything).
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
