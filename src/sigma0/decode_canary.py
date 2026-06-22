"""
Σ₀ decode canary — wire the looped DECODER into the collapse monitor (#766 / G10).

The Σ₀ collapse instruments (`SurpriseMonitor`, anti-collapse) ran on abstract encoded
state; the decoder that actually degenerates into loops never fed them, so the certificate
could read "healthy" while the output was in full loop-collapse (the gap #766 names).

This closes the instrument→actuator loop. Per generated token, `observe()` turns decode-health
signals — running self-repeat over decoded ids, n-gram echo, argmax margin, realized exit depth —
into a 1-D Kalman observation for `SurpriseMonitor.evaluate()`. A looping decode then drives NIS
past `spook_threshold` and `sigma0_proximity()` → 1; `knobs()` maps that proximity onto decode
knobs (suppress repetition harder, inject novelty, exit the loop sooner).

Pure-CPU and model-free: it consumes token ids + scalars, never tensors of model state, so it is
unit-testable without loading a model (see tests/test_decode_canary.py).
"""
from __future__ import annotations

from collections import Counter, deque
from typing import Any, Dict, Optional

import torch

from cio_sde.surprise import SurpriseMonitor


class DecodeCanary:
    """Per-token decode-health monitor feeding the Σ₀ SurpriseMonitor.

    The Kalman frame is deliberately 1-D and mean-reverting to a *healthy* prior: the monitor
    "expects" low degeneracy every token, so sustained looping yields a sustained large
    innovation (high NIS) rather than the monitor quietly adapting to the collapse.
    """

    def __init__(self, monitor: Optional[SurpriseMonitor] = None, *,
                 window: int = 24, ngram: int = 3,
                 healthy_baseline: float = 0.05, prior_var: float = 0.02, obs_noise: float = 0.02,
                 w_repeat: float = 0.6, w_echo: float = 0.3, w_margin: float = 0.1,
                 ent_alpha: float = 0.15, ent_z_thresh: float = 2.5) -> None:
        # NIS-space proximity thresholds tuned to this 1-D observation scale (not the
        # monitor's encoded-state defaults): healthy NIS≈0, strong loop NIS≫8.
        self.monitor = monitor or SurpriseMonitor(
            spook_sigmas=3.0, sigma0_baseline=1.0, sigma0_collapse_threshold=8.0)
        self.window = window
        self.ngram = ngram
        self.healthy_baseline = healthy_baseline
        self.prior_var = prior_var
        self.obs_noise = obs_noise
        self.w_repeat, self.w_echo, self.w_margin = w_repeat, w_echo, w_margin
        self._ids: deque = deque(maxlen=max(window, ngram * 8))
        self._ngrams: Counter = Counter()
        self.last: Dict[str, Any] = {}
        # #793 entropy collapse signal, folded into this single canary: greedy decode
        # collapses → softmax entropy DROPS (over-confidence). EMA + two-sided z-alarm,
        # tracked here so loop_lm no longer runs a second parallel canary.
        self.ent_alpha, self.ent_z_thresh = ent_alpha, ent_z_thresh
        self._ent_ema: Optional[float] = None    # running softmax-entropy EMA
        self._ent_var: Optional[float] = None    # running entropy variance (for z-score)
        self.collapse_events: list = []          # entropy z-spook events: {token, entropy, z}

    # ── decode-health signals over the decoded id stream ──────────────────────
    def _self_repeat(self) -> float:
        w = list(self._ids)[-self.window:]
        if len(w) < 2:
            return 0.0
        return (len(w) - len(set(w))) / len(w)   # 0 = all distinct, →1 = all the same

    def _echo(self) -> float:
        ids = list(self._ids)
        if len(ids) < self.ngram:
            return 0.0
        prior = self._ngrams.get(tuple(ids[-self.ngram:]), 1) - 1  # earlier occurrences
        return min(1.0, prior / 3.0)             # saturates after a few repeats of an n-gram

    def observe(self, token_id: int, *, margin: Optional[float] = None,
                exit_depth: Optional[int] = None, max_steps: Optional[int] = None,
                entropy: Optional[float] = None, token_idx: Optional[int] = None,
                divergence: Optional[float] = None) -> Dict[str, Any]:
        """Feed one generated token; returns {self_repeat, echo, degeneracy, nis, spook,
        proximity, signal, exit_depth, entropy, entropy_z}.

        Pass `entropy` (full softmax entropy of the decoded logits) to also drive the #793
        over-confidence signal: a sudden entropy drop (|z| ≥ ent_z_thresh) appends a
        {token, entropy, z} record to `self.collapse_events`. `token_idx` labels that record."""
        self._ids.append(int(token_id))
        ids = list(self._ids)
        if len(ids) >= self.ngram:
            self._ngrams[tuple(ids[-self.ngram:])] += 1

        self_repeat = self._self_repeat()
        echo = self._echo()
        margin_bad = 0.0 if margin is None else max(0.0, min(1.0, 1.0 - float(margin)))
        degeneracy = max(0.0, min(1.0,
                         self.w_repeat * self_repeat + self.w_echo * echo + self.w_margin * margin_bad))

        # #793 entropy collapse signal (folded in): EMA + two-sided z-alarm. Greedy decode
        # collapse manifests as entropy suddenly DROPPING (model becomes over-confident).
        ent_z = None
        if entropy is not None:
            e = float(entropy)
            if self._ent_ema is None:
                self._ent_ema, self._ent_var = e, 0.0
            else:
                diff = e - self._ent_ema
                self._ent_var = (1 - self.ent_alpha) * (self._ent_var + self.ent_alpha * diff ** 2)
                self._ent_ema = self.ent_alpha * e + (1 - self.ent_alpha) * self._ent_ema
                std = max(self._ent_var ** 0.5, 1e-6)
                ent_z = (e - self._ent_ema) / std
                if abs(ent_z) >= self.ent_z_thresh:
                    self.collapse_events.append(
                        {"token": token_idx, "entropy": round(e, 3), "z": round(float(ent_z), 2)})

        # 1-D Kalman observation: predict health=baseline, observe degeneracy.
        x_pred = torch.tensor([[self.healthy_baseline]])
        sigma = torch.tensor([[[self.prior_var]]])
        y = torch.tensor([[degeneracy]])
        C = torch.tensor([[[1.0]]])
        R = torch.tensor([[[self.obs_noise]]])
        ev = self.monitor.evaluate(x_pred, sigma, y, C, R)

        self.monitor.record_state({
            "self_repeat": self_repeat, "echo": echo,
            "length": min(1.0, len(self._ids) / max(1, self.window)),
        })
        prox = self.monitor.sigma0_proximity()
        # Σ₀ divergence (the certificate's SECOND fate — runaway / non-termination). The
        # model-free canary cannot tell runaway-but-varied from healthy-varied output, so the
        # caller (loop_lm, which sees the token budget) supplies it. Kept DISTINCT from collapse
        # `proximity` per §4; `proximity_any` is the max for actuation. None ⇒ inert.
        _div = None if divergence is None else max(0.0, min(1.0, float(divergence)))
        out = {
            "self_repeat": round(self_repeat, 4), "echo": round(echo, 4),
            "degeneracy": round(degeneracy, 4), "nis": float(ev["nis"].item()),
            "spook": bool(ev["spook"].item()), "proximity": prox["proximity"],
            "divergence": None if _div is None else round(_div, 4),
            "proximity_any": round(max(prox["proximity"], _div or 0.0), 4),
            "signal": self.monitor.anti_collapse_signal(), "exit_depth": exit_depth,
            "entropy": None if entropy is None else round(float(entropy), 3),
            "entropy_z": None if ent_z is None else round(float(ent_z), 2),
        }
        self.last = out
        return out

    @property
    def mean_entropy(self) -> Optional[float]:
        """Running softmax-entropy EMA (#793 signal), or None if no entropy was fed."""
        return None if self._ent_ema is None else round(self._ent_ema, 3)

    # ── actuator: gate decode knobs on Σ₀ proximity ───────────────────────────
    def knobs(self, q: float, rep_penalty: float, temperature: float = 0.0,
              proximity: Optional[float] = None, divergence: Optional[float] = None,
              eps: Optional[float] = None) -> Dict[str, float]:
        """Map Σ₀ proximity onto decode knobs. COLLAPSE (repetition) → punish repeats, inject
        novelty, exit sooner. DIVERGENCE (runaway) → exit sooner + punish repeats too, but do
        NOT inject novelty (temperature would feed the runaway). Distinct fates, per the
        certificate; the EOS bias that actually halts a runaway lives in loop_lm.generate.

        When `eps` (the latent-convergence exit threshold) is supplied, it also gets a DEPTH
        response — the 'step adaptively to resolve divergence' actuator: DIVERGENCE tightens eps
        (lower ⇒ harder to exit ⇒ the loop steps DEEPER to think the runaway out), while COLLAPSE
        loosens it (a degenerate token needs no deep thought ⇒ exit sooner). Floored positive.
        None ⇒ no eps knob (inert; depth-coupling off)."""
        p = self.monitor.sigma0_proximity()["proximity"] if proximity is None else float(proximity)
        d = 0.0 if divergence is None else max(0.0, min(1.0, float(divergence)))
        out = {
            "q": max(0.2, min(0.95, q - 0.2 * p - 0.2 * d)),   # exit sooner under either fate
            "rep_penalty": rep_penalty + 0.7 * p + 0.3 * d,     # punish repeats harder
            "temperature": max(0.0, temperature) + 0.7 * p,     # novelty for COLLAPSE only
            "proximity": p,
            "divergence": d,
        }
        if eps is not None:
            out["eps"] = max(0.02, float(eps) * (1.0 + 0.5 * p - 0.6 * d))
        return out


# Default training-template turn markers — a stray one means the model finished and is
# hallucinating a NEW turn (a restart). Pass to generate() as stop_strings to truncate there.
RESTART_MARKERS = ["\n### Instruction:", "\n### Response:", "\n### Task:", "\n### Input:"]


class CanaryLogitsProcessor:
    """Run the Σ₀ DecodeCanary on the FAST cached decode path (HF `generate`) instead of the
    slow native Python loop — same collapse+divergence stack, ~2.5× the throughput.

    Per step it reads the step logits (argmax margin + softmax entropy) and the last generated
    token (self-repeat / n-gram echo) to drive the canary, derives a length-based DIVERGENCE
    proxy, and — when `adapt` — applies the score actuators: an EOS bias that grows with
    divergence (pull a runaway toward stopping) and an extra repetition penalty under collapse.
    Per-step recurrent DEPTH control + contraction telemetry are native-only (HF generate uses
    the model's trained internal exit); detection + the score actuators are all available here.

    Implements the HF LogitsProcessor protocol: __call__(input_ids, scores) -> scores."""

    def __init__(self, prompt_len: int, max_new_tokens: int, eos_id: Optional[int], *,
                 canary: Optional["DecodeCanary"] = None, adapt: bool = False,
                 eos_bias: float = 6.0, div_start_frac: float = 0.6) -> None:
        self.dc = canary or DecodeCanary()
        self.prompt_len = int(prompt_len)
        self.max_new = int(max_new_tokens)
        self.eos_id = eos_id
        self.adapt = bool(adapt)
        self.eos_bias = float(eos_bias)
        self.div_start = max(8, int(div_start_frac * self.max_new))
        self.max_proximity = 0.0
        self.max_divergence = 0.0
        self.spooks = 0
        self.signal = "none"
        self.n = 0

    def __call__(self, input_ids, scores):
        row = scores[0].float()
        probs = torch.softmax(row, dim=-1)
        top2 = torch.topk(probs, 2).values
        margin = float((top2[0] - top2[1]).item())
        entropy = float(-(probs * (probs + 1e-10).log()).sum().item())
        gen = input_ids[0, self.prompt_len:]
        # length-based divergence proxy: 0 until div_start, → 1 at the token cap (runaway).
        div = 0.0
        if self.max_new > self.div_start:
            div = max(0.0, min(1.0, (self.n - self.div_start) / (self.max_new - self.div_start)))
        self.max_divergence = max(self.max_divergence, div)
        if gen.numel() > 0:   # observe the previously-chosen token
            obs = self.dc.observe(int(gen[-1].item()), margin=margin, entropy=entropy,
                                  divergence=div, token_idx=self.n)
            self.max_proximity = max(self.max_proximity, obs["proximity"])
            self.spooks += int(obs["spook"])
            if obs["signal"] != "none":
                self.signal = obs["signal"]
        self.n += 1
        if self.adapt:
            if self.eos_id is not None and div > 0.0:
                scores[0, self.eos_id] = scores[0, self.eos_id] + self.eos_bias * div
            if self.max_proximity > 0.3 and gen.numel() > 0:
                for tid in set(gen[-8:].tolist()):   # extra repetition penalty under collapse
                    scores[0, tid] = scores[0, tid] - 2.0 * self.max_proximity
        return scores

    def telemetry(self) -> Dict[str, Any]:
        return {
            "canary_max_proximity": round(self.max_proximity, 4),
            "canary_max_divergence": round(self.max_divergence, 4),
            "canary_spooks": self.spooks,
            "canary_signal": self.signal,
            "collapse_events": len(self.dc.collapse_events),
            "tokens": self.n,
        }
