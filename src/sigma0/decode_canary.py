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
                entropy: Optional[float] = None, token_idx: Optional[int] = None) -> Dict[str, Any]:
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
        out = {
            "self_repeat": round(self_repeat, 4), "echo": round(echo, 4),
            "degeneracy": round(degeneracy, 4), "nis": float(ev["nis"].item()),
            "spook": bool(ev["spook"].item()), "proximity": prox["proximity"],
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
              proximity: Optional[float] = None) -> Dict[str, float]:
        """Map Σ₀ proximity onto decode knobs. As the decoder nears collapse: punish
        repetition harder, inject novelty (temperature), and exit the loop sooner (lower q)."""
        p = self.monitor.sigma0_proximity()["proximity"] if proximity is None else float(proximity)
        return {
            "q": max(0.2, min(0.95, q - 0.2 * p)),       # exit sooner under collapse
            "rep_penalty": rep_penalty + 0.7 * p,         # punish repeats harder
            "temperature": max(0.0, temperature) + 0.7 * p,  # inject novelty
            "proximity": p,
        }
