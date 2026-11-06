"""
Σ₀ surprise monitor — the "spook" signal (predictive-processing early warning).

A system never sees the whole world. It runs on a predicted state x̂ with
covariance Σ, and corrects when evidence arrives. The horse with blinders is the
canonical picture: it guesses from sparse cues, the guess is usually right, and
it spooks when a cue it never saw (the plastic bag) makes the guess fail.

The signal that fires at the spook is the Kalman INNOVATION measured against the
uncertainty that predicted it:

    ν   = y − C x̂                      innovation (what reality minus what I expected)
    S   = C Σ Cᵀ + R                   innovation covariance (what I expected to be off by)
    NIS = νᵀ S⁻¹ ν                     normalized innovation squared  (χ²_m if consistent)
    surprise(ν) = ½[ NIS + ln det(2πS) ]   observation negative-log-likelihood

Reading it:
    NIS ≈ m   model and reality agree — the guess held.
    NIS ≫ m   the model is OVERCONFIDENT relative to reality: the error dwarfs what
              Σ allowed for. The model drifted and didn't know it. **The spook.**

This is the certificate's §4 "canary" done correctly. The doc proposed a signal
built from eigenvalues of A_s; the right early-warning is an innovation-consistency
test (Bar-Shalom, Li & Kirubarajan, *Estimation with Applications to Tracking and
Navigation*, 2001 § Chapter 5 — the NIS χ² test), i.e. surprise relative to
uncertainty. The NIS = νᵀ S⁻¹ ν is the canonical measure of model-reality
mismatch in Kalman filtering; values >> m indicate the model is overconfident
and has drifted from the truth (the spook event).

The engine's `CovarianceField` propagates Σ (the Kalman-Bucy Riccati) but never
fuses an observation into x. `kalman_update` here is that missing measurement step;
`SurpriseMonitor.evaluate` reads the innovation before the update — the moment the
horse's ears go back, before it bolts.

## Integration with Σ₀ Anti-Collapse

When `anti_collapse_trigger=True`, the surprise monitor's spook flag is wired to
the Σ₀⁻¹ anti-collapse operator. This creates a closed loop:

1. System drifts toward collapse (Σ₀ proximity increases)
2. Surprise monitor detects model-reality mismatch (NIS spike)
3. Spook flag fires → boosts anti-collapse proximity to 1.0
4. Σ₀⁻¹ injects excitation along null modes
5. System re-excites, escapes collapse, restores persistent excitation

This implements the "detect → excite → re-ground" cycle described in issue #506.

Batched conventions:  x (B, d) · Σ (B, d, d) · y (B, m) · C (B, m, d) · R (B, m, m).

Each row of the batch is a trajectory of its own. A row whose x̂, Σ, ν or S holds a NaN or inf (a NaN or
inf in its y, C or R reaches ν or S) is not scored. It never reaches the batched Cholesky, so it cannot make
it raise for the other rows. Its NIS reads NaN, so it never spooks, its posterior is its prior, and it stays
out of the rolling NIS mean. Every other row reads what it reads alone. A batch whose rows are all finite is
computed exactly as before.
"""
from __future__ import annotations

import logging
import math
from collections import deque
from typing import Any, Deque, Dict, List, Optional

import torch

Tensor = torch.Tensor


def kalman_predict(x: Tensor, sigma: Tensor, F: Tensor, Q: Tensor) -> tuple[Tensor, Tensor]:
    """Time update: push the belief forward through the model dynamics F."""
    x_pred = x @ F.transpose(-1, -2)
    sigma_pred = F @ sigma @ F.transpose(-1, -2) + Q
    return x_pred, 0.5 * (sigma_pred + sigma_pred.transpose(-1, -2))


def _rows_finite(t: Tensor, event_dims: int) -> Tensor:
    """For each row of a batch, whether its last `event_dims` dims hold only finite numbers."""
    return torch.isfinite(t).flatten(-event_dims).all(-1)


def scored_mean(nis: Tensor) -> Optional[float]:
    """The mean NIS of the rows that were scored, or None when no row was.

    A NaN NIS is a row that was not scored (see SurpriseMonitor.evaluate), and it is no evidence either way,
    so it stays out of the mean. When every row was scored this is the batch mean, computed as before."""
    scored = ~torch.isnan(nis)
    if not bool(scored.any()):
        return None
    if bool(scored.all()):
        return float(nis.mean().item())
    return float(nis[scored].mean().item())


class SurpriseMonitor:
    """Innovation-consistency monitor: NIS, surprise, and the spook flag."""

    def __init__(self, spook_sigmas: float = 3.0,
                 anti_collapse_trigger: bool = False,
                 nis_window: int = 20,
                 sigma0_baseline: float = 0.1,
                 sigma0_collapse_threshold: float = 0.8) -> None:
        # spook when NIS exceeds mean(χ²_m)=m by `spook_sigmas` std (std=√(2m))
        self.spook_sigmas = spook_sigmas
        # When True, spook events trigger anti-collapse excitation
        self.anti_collapse_trigger = anti_collapse_trigger
        # Rolling NIS history for sigma0_proximity computation
        self.nis_window = nis_window
        self._nis_history: Deque[float] = deque(maxlen=nis_window)
        # Most recent state vector fields for anti_collapse_signal selection
        # Expected keys: self_repeat, echo, length (all floats in [0,1])
        self._last_state: Optional[Dict[str, Any]] = None
        # Σ₀ proximity configuration
        self.sigma0_baseline = sigma0_baseline
        self.sigma0_collapse_threshold = sigma0_collapse_threshold

    @staticmethod
    def _innovation(x_pred: Tensor, sigma: Tensor, y: Tensor,
                    C: Tensor, R: Tensor):
        """(ν, S, L, scored). When every row is finite, L is the batched Cholesky of S, exactly as before, and
        scored is None. Otherwise scored marks the rows whose x̂, Σ, ν and S are finite, and every other row's
        S is swapped for I before the factorization, so a NaN or inf never reaches it."""
        nu = y - (C @ x_pred.unsqueeze(-1)).squeeze(-1)        # (B, m)
        S = C @ sigma @ C.transpose(-1, -2) + R                # (B, m, m)
        scored = (_rows_finite(nu, 1) & _rows_finite(S, 2)
                  & _rows_finite(x_pred, 1) & _rows_finite(sigma, 2))
        if bool(scored.all()):
            return nu, S, torch.linalg.cholesky(S), None
        eye = torch.eye(S.shape[-1], dtype=S.dtype, device=S.device)
        return nu, S, torch.linalg.cholesky(torch.where(scored[..., None, None], S, eye)), scored

    def evaluate(self, x_pred: Tensor, sigma: Tensor, y: Tensor,
                 C: Tensor, R: Tensor) -> Dict[str, Tensor]:
        """Read the surprise of observation y against prediction (x_pred, Σ).

        A row whose x̂, Σ, ν or S holds a NaN or inf is not scored: it stays out of the batched Cholesky, its
        "nis" and "surprise" read NaN, and it never spooks, since NaN exceeds no threshold. Each other row reads
        what it reads alone. The rolling mean that sigma0_proximity reads gets the scored rows only."""
        nu, S, L, scored = self._innovation(x_pred, sigma, y, C, R)
        m = C.shape[-2]
        sinv_nu = torch.cholesky_solve(nu.unsqueeze(-1), L)    # (B, m, 1)
        nis = (nu.unsqueeze(-2) @ sinv_nu).squeeze(-1).squeeze(-1)   # (B,)
        if scored is not None:                                 # a row not scored has no NIS
            nis = torch.where(scored, nis, torch.full_like(nis, math.nan))
        logdet = 2.0 * torch.log(torch.diagonal(L, dim1=-2, dim2=-1)).sum(-1)
        surprise = 0.5 * (nis + logdet + m * math.log(2.0 * math.pi))
        threshold = m + self.spook_sigmas * math.sqrt(2.0 * m)
        result = {"nis": nis, "surprise": surprise, "dof": m,
                  "spook_threshold": threshold, "spook": nis > threshold,
                  "innovation_norm": nu.norm(dim=-1)}
        # Record the mean NIS of the scored rows for proximity tracking (see sigma0_proximity)
        mean = scored_mean(nis)
        if mean is not None:
            self._nis_history.append(mean)
        return result

    def record_state(self, state: Dict[str, Any]) -> None:
        """Record the most recent state-vector fields for anti-collapse routing.

        Callers should pass a dict with float fields such as:
            self_repeat  — fraction of recently repeated tokens/tokens [0, 1]
            echo         — echo/context-repetition score [0, 1]
            length       — normalised context length [0, 1]
        """
        self._last_state = state

    def sigma0_proximity(self) -> Dict[str, Any]:
        """Compute Σ₀ proximity score from recent NIS history.

        proximity = clip((mean_nis - baseline) / (collapse_threshold - baseline), 0, 1)

        Each evaluate adds one value to the window: the mean NIS of the rows it scored. A row it did not
        score, whose NIS is NaN, stays out of that mean, and an evaluate that scored no row adds nothing. So
        one broken trajectory neither raises nor lowers the proximity the other rows report. Letting its NaN
        in would not read as NaN: max(0, min(1, NaN)) is 1.0 in Python, so the window would report
        proximity 1.0, an alert, until the NaN left it nis_window evaluations later.

        Returns
        -------
        dict with keys:
            proximity   float [0, 1] — 0 = far from collapse, 1 = at boundary
            mean_nis    float        — mean NIS over the current window
            window_size int          — number of NIS samples used
            alert       bool         — True when proximity > 0.7
        """
        if not self._nis_history:
            return {"proximity": 0.0, "mean_nis": 0.0,
                    "window_size": 0, "alert": False}

        mean_nis = sum(self._nis_history) / len(self._nis_history)
        span = self.sigma0_collapse_threshold - self.sigma0_baseline
        raw = (mean_nis - self.sigma0_baseline) / span if span > 0 else 0.0
        proximity = max(0.0, min(1.0, raw))
        alert = proximity > 0.7

        if alert:
            logging.getLogger(__name__).warning(
                "SurpriseMonitor Σ₀ alert: proximity=%.3f mean_nis=%.3f "
                "(window=%d)", proximity, mean_nis, len(self._nis_history)
            )

        return {
            "proximity": proximity,
            "mean_nis": mean_nis,
            "window_size": len(self._nis_history),
            "alert": alert,
        }

    def anti_collapse_signal(self) -> str:
        """Recommend an anti-collapse operator based on current proximity and state.

        Decision logic (applied only when proximity > 0.7):
            self_repeat high (> 0.6) → "inject_novelty"
            echo high (> 0.6)        → "truncate_context"
            length low (< 0.3)       → "switch_agent"
            fallback                 → "inject_novelty"

        Returns "none" when proximity ≤ 0.7.
        """
        prox = self.sigma0_proximity()
        if prox["proximity"] <= 0.7:
            return "none"

        state = self._last_state or {}
        self_repeat = float(state.get("self_repeat", 0.0))
        echo = float(state.get("echo", 0.0))
        length = float(state.get("length", 0.5))

        if self_repeat > 0.6:
            return "inject_novelty"
        if echo > 0.6:
            return "truncate_context"
        if length < 0.3:
            return "switch_agent"
        return "inject_novelty"

    def update(self, x_pred: Tensor, sigma: Tensor, y: Tensor,
               C: Tensor, R: Tensor) -> tuple[Tensor, Tensor]:
        """Measurement update: fuse y into the belief (the correction).

        A row that evaluate would not score is not updated. Its posterior is its prior, x̂ and Σ as they came
        in, with Σ symmetrized as every posterior is. For a row whose observation is not finite, that is the
        Kalman filter's step for a missing measurement. A prior that is not finite is passed on as it is."""
        nu, S, L, scored = self._innovation(x_pred, sigma, y, C, R)
        sig_ct = sigma @ C.transpose(-1, -2)                   # (B, d, m)
        sinv_nu = torch.cholesky_solve(nu.unsqueeze(-1), L)    # (B, m, 1)
        x_upd = x_pred + (sig_ct @ sinv_nu).squeeze(-1)
        sinv_csig = torch.cholesky_solve(C @ sigma, L)         # S⁻¹ C Σ  (B, m, d)
        sigma_upd = sigma - sig_ct @ sinv_csig
        if scored is not None:                                 # a row not scored keeps its prior
            x_upd = torch.where(scored[..., None], x_upd, x_pred)
            sigma_upd = torch.where(scored[..., None, None], sigma_upd, sigma)
        return x_upd, 0.5 * (sigma_upd + sigma_upd.transpose(-1, -2))
