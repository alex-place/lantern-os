"""ADR-0034 MoE admission gate — switched-system certification tooling, slice 1.

A routed (MoE) loop is a SWITCHED dynamical system: the router picks which expert
(mode) applies each step. The Collapse Certificate's Part I machinery certifies a
FIXED update map only (cert §1.2.2 voids it for routed loops), and stable pieces do
NOT imply a stable switch: two individually contracting modes can diverge under
fast alternation (the canonical counterexample is in the tests). Admission of an
MoE core therefore requires, per ADR-0034:

    (a) per-mode contraction receipts  — rho(A_i) verdicts, JSRR margin semantics
    (b) a dwell-time certificate       — the average-dwell-time (ADT) bound tau*:
                                          switching no faster than tau* steps/mode
                                          provably preserves stability
    (c) a serve-time dwell monitor     — alarms when observed switching violates
                                          tau*; router-entropy/churn canaries

This module is model-agnostic and numpy-only: modes are (empirical) Jacobians,
exactly like the JSRR gate's proxy input. It certifies nothing about any specific
MoE model until that model's mode Jacobians are measured and fed here — the same
honest boundary as the rest of the certificate ("machine-checked" = algebra +
numerical checks + pytest, not Lean).

Theory (standard, discrete-time; Liberzon / Hespanha–Morse ADT):
  For each stable mode i solve the discrete Lyapunov equation
      A_i^T P_i A_i - P_i = -I            (series sum, converges iff rho(A_i)<1)
  Along mode i:   V_i(x_{k+1}) <= lam_i V_i(x_k),  lam_i = 1 - 1/lambda_max(P_i)
  At a switch:    V_j(x) <= mu V_i(x),     mu = max_j lambda_max(P_j) / min_i lambda_min(P_i)
  ADT bound:      staying >= tau* steps per mode with  mu * lam_max^tau* < 1
                  guarantees the switched trajectory contracts per block:
      tau* = floor(ln mu / ln(1/lam_max)) + 1
  A common Lyapunov P (if found) certifies ARBITRARY switching: tau* = 1.
"""

from __future__ import annotations

import math

import numpy as np

__all__ = [
    "per_mode_receipts",
    "solve_discrete_lyapunov",
    "dwell_time_certificate",
    "common_lyapunov_attempt",
    "DwellMonitor",
]


def _rho(a: np.ndarray) -> float:
    return float(np.max(np.abs(np.linalg.eigvals(np.asarray(a, dtype=float)))))


def per_mode_receipts(modes, margin: float = 0.0):
    """JSRR-style verdict per mode: accept iff rho(A_i) < 1 - margin.

    Returns a list of {mode, rho, verdict} dicts — the per-expert receipt set the
    serve path must be able to emit for every expert composition the router can
    select (ADR-0034 gate (a)).
    """
    out = []
    for i, a in enumerate(modes):
        r = _rho(a)
        out.append({"mode": i, "rho": r, "verdict": "accept" if r < 1.0 - margin else "reject"})
    return out


def solve_discrete_lyapunov(a: np.ndarray, tol: float = 1e-12, max_terms: int = 100000):
    """P = sum_k (A^T)^k A^k solving A^T P A - P = -I, by the convergent series.

    Numpy-only (no scipy dependency). Diverges iff rho(A) >= 1 — returns None then,
    which is itself the honest verdict (no Lyapunov certificate exists for Q=I).
    """
    a = np.asarray(a, dtype=float)
    n = a.shape[0]
    p = np.eye(n)
    term = np.eye(n)
    for _ in range(max_terms):
        term = a.T @ term @ a
        p = p + term
        inc = float(np.linalg.norm(term))
        if inc < tol:
            return p
        if not np.isfinite(inc) or inc > 1e18:
            return None
    return None


def dwell_time_certificate(modes, margin: float = 0.0):
    """The ADT certificate for a set of mode Jacobians (ADR-0034 gate (b)).

    Returns {certifiable, tau_star, mu, lam_max, receipts, reason}. Not certifiable
    when any mode fails its contraction receipt (a switched system with an unstable
    mode has no dwell bound under this construction) or a Lyapunov series diverges.
    tau_star is CONSERVATIVE (sufficient, not necessary) — the honest direction for
    an admission gate.
    """
    receipts = per_mode_receipts(modes, margin=margin)
    if any(r["verdict"] == "reject" for r in receipts):
        return {"certifiable": False, "tau_star": None, "mu": None, "lam_max": None,
                "receipts": receipts, "reason": "per-mode contraction receipt failed"}

    ps = []
    for a in modes:
        p = solve_discrete_lyapunov(np.asarray(a, dtype=float))
        if p is None:
            return {"certifiable": False, "tau_star": None, "mu": None, "lam_max": None,
                    "receipts": receipts, "reason": "lyapunov series diverged"}
        ps.append(p)

    lam_max = 0.0
    eig_maxes = []
    eig_mins = []
    for p in ps:
        ev = np.linalg.eigvalsh(p)
        eig_maxes.append(float(ev[-1]))
        eig_mins.append(float(ev[0]))
        lam_max = max(lam_max, 1.0 - 1.0 / float(ev[-1]))

    mu = max(eig_maxes) / min(eig_mins)
    if lam_max <= 0.0:  # single-step contraction to zero in V — arbitrary switching fine
        tau_star = 1
    else:
        tau_star = int(math.floor(math.log(mu) / math.log(1.0 / lam_max))) + 1
        tau_star = max(1, tau_star)
    return {"certifiable": True, "tau_star": tau_star, "mu": float(mu),
            "lam_max": float(lam_max), "receipts": receipts, "reason": None}


def common_lyapunov_attempt(modes, tol: float = 1e-9):
    """Try one cheap common-Lyapunov candidate: P = mean of the per-mode P_i.

    Found  => ARBITRARY switching is certified (tau* = 1) — the strong certificate.
    Not found => says nothing (absence of this candidate is not nonexistence);
    the ADT bound remains the operative certificate. Honest by construction.
    """
    ps = []
    for a in modes:
        p = solve_discrete_lyapunov(np.asarray(a, dtype=float))
        if p is None:
            return {"found": False, "p": None}
    # recompute list (loop above bailed early on purpose for the None case)
    ps = [solve_discrete_lyapunov(np.asarray(a, dtype=float)) for a in modes]
    p = np.mean(ps, axis=0)
    for a in modes:
        a = np.asarray(a, dtype=float)
        decrement = a.T @ p @ a - p
        if float(np.linalg.eigvalsh(decrement)[-1]) >= -tol:
            return {"found": False, "p": None}
    return {"found": True, "p": p}


class DwellMonitor:
    """Serve-time dwell + router canaries (ADR-0034 gates (b-monitor) and (c)).

    Feed the router's chosen expert id each step via observe(). A switch that
    arrives before tau_star steps have elapsed in the current mode is a dwell
    VIOLATION — the switched-system analog of a failed JSRR verdict, and grounds
    to reject the generation. Router entropy (over a sliding window) and churn
    rate are exported as canary axes: a thrashing router is pre-collapse behavior
    even when no single dwell violation fires.
    """

    def __init__(self, tau_star: int, window: int = 64):
        if tau_star < 1:
            raise ValueError("tau_star must be >= 1")
        self.tau_star = int(tau_star)
        self.window = int(window)
        self._current = None
        self._dwell = 0
        self._history = []
        self.violations = 0
        self.switches = 0
        self.steps = 0

    def observe(self, expert_id) -> bool:
        """Record one routing step. Returns True iff this step VIOLATED the dwell bound."""
        self.steps += 1
        self._history.append(expert_id)
        if len(self._history) > self.window:
            self._history.pop(0)
        violated = False
        if self._current is None:
            self._current = expert_id
            self._dwell = 1
        elif expert_id == self._current:
            self._dwell += 1
        else:
            self.switches += 1
            if self._dwell < self.tau_star:
                self.violations += 1
                violated = True
            self._current = expert_id
            self._dwell = 1
        return violated

    def entropy(self) -> float:
        """Shannon entropy (bits) of the expert distribution over the window."""
        if not self._history:
            return 0.0
        _, counts = np.unique(np.asarray(self._history, dtype=object), return_counts=True)
        p = counts / counts.sum()
        return float(-(p * np.log2(p)).sum())

    def churn(self) -> float:
        """Switches per step over the whole observation (0 = never switches)."""
        return self.switches / self.steps if self.steps else 0.0

    def verdict(self):
        """The receipt the serve path logs per generation (JSRR-verdict shape)."""
        return {
            "ok": self.violations == 0,
            "violations": self.violations,
            "switches": self.switches,
            "steps": self.steps,
            "tau_star": self.tau_star,
            "entropy_bits": self.entropy(),
            "churn": self.churn(),
        }
