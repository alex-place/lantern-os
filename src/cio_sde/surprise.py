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
Navigation*, 2001 — the NIS χ² test), i.e. surprise relative to uncertainty.

The engine's `CovarianceField` propagates Σ (the Kalman-Bucy Riccati) but never
fuses an observation into x. `kalman_update` here is that missing measurement step;
`SurpriseMonitor.evaluate` reads the innovation before the update — the moment the
horse's ears go back, before it bolts.

Batched conventions:  x (B, d) · Σ (B, d, d) · y (B, m) · C (B, m, d) · R (B, m, m).
"""
from __future__ import annotations

import math
from typing import Dict

import torch

Tensor = torch.Tensor


def kalman_predict(x: Tensor, sigma: Tensor, F: Tensor, Q: Tensor) -> tuple[Tensor, Tensor]:
    """Time update: push the belief forward through the model dynamics F."""
    x_pred = x @ F.transpose(-1, -2)
    sigma_pred = F @ sigma @ F.transpose(-1, -2) + Q
    return x_pred, 0.5 * (sigma_pred + sigma_pred.transpose(-1, -2))


class SurpriseMonitor:
    """Innovation-consistency monitor: NIS, surprise, and the spook flag."""

    def __init__(self, spook_sigmas: float = 3.0) -> None:
        # spook when NIS exceeds mean(χ²_m)=m by `spook_sigmas` std (std=√(2m))
        self.spook_sigmas = spook_sigmas

    @staticmethod
    def _innovation(x_pred: Tensor, sigma: Tensor, y: Tensor,
                    C: Tensor, R: Tensor):
        nu = y - (C @ x_pred.unsqueeze(-1)).squeeze(-1)        # (B, m)
        S = C @ sigma @ C.transpose(-1, -2) + R                # (B, m, m)
        L = torch.linalg.cholesky(S)
        return nu, S, L

    def evaluate(self, x_pred: Tensor, sigma: Tensor, y: Tensor,
                 C: Tensor, R: Tensor) -> Dict[str, Tensor]:
        """Read the surprise of observation y against prediction (x_pred, Σ)."""
        nu, S, L = self._innovation(x_pred, sigma, y, C, R)
        m = C.shape[-2]
        sinv_nu = torch.cholesky_solve(nu.unsqueeze(-1), L)    # (B, m, 1)
        nis = (nu.unsqueeze(-2) @ sinv_nu).squeeze(-1).squeeze(-1)   # (B,)
        logdet = 2.0 * torch.log(torch.diagonal(L, dim1=-2, dim2=-1)).sum(-1)
        surprise = 0.5 * (nis + logdet + m * math.log(2.0 * math.pi))
        threshold = m + self.spook_sigmas * math.sqrt(2.0 * m)
        return {"nis": nis, "surprise": surprise, "dof": m,
                "spook_threshold": threshold, "spook": nis > threshold,
                "innovation_norm": nu.norm(dim=-1)}

    def update(self, x_pred: Tensor, sigma: Tensor, y: Tensor,
               C: Tensor, R: Tensor) -> tuple[Tensor, Tensor]:
        """Measurement update: fuse y into the belief (the correction)."""
        nu, S, L = self._innovation(x_pred, sigma, y, C, R)
        sig_ct = sigma @ C.transpose(-1, -2)                   # (B, d, m)
        sinv_nu = torch.cholesky_solve(nu.unsqueeze(-1), L)    # (B, m, 1)
        x_upd = x_pred + (sig_ct @ sinv_nu).squeeze(-1)
        sinv_csig = torch.cholesky_solve(C @ sigma, L)         # S⁻¹ C Σ  (B, m, d)
        sigma_upd = sigma - sig_ct @ sinv_csig
        return x_upd, 0.5 * (sigma_upd + sigma_upd.transpose(-1, -2))
