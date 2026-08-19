"""B -- the auditor. Knows nothing about z. Knows only what NOISE looks like, and says when a
residual window does not look like it.

Three tests, each answering "could this be noise?":
  lag-1 autocorrelation   — noise has none; a missed variable that persists does
  Wald–Wolfowitz runs     — noise changes sign ~half the time; banded residuals do not
  bimodality (dip proxy)  — a hidden z in {-1,+1} splits residuals into two lumps; noise is one
Structured = at least 2 of 3 reject noise at alpha.

B is NEVER rewarded for halting A. It is scored afterwards on whether its BOUNDARY calls matched
the world's ground truth (precision/recall) -- a B that calls structure on everything fails the
null world. That is how a professional skeptic is caught.
"""
from __future__ import annotations

import math

import numpy as np


def _lag1_autocorr(r):
    r = np.asarray(r) - np.mean(r)
    d = float(np.dot(r, r))
    if d <= 0:
        return 0.0
    return float(np.dot(r[:-1], r[1:]) / d)


def _runs_z(r):
    s = np.sign(np.asarray(r) - np.median(r))
    s = s[s != 0]
    n = len(s)
    if n < 4:
        return 0.0
    n1 = int(np.sum(s > 0)); n2 = n - n1
    if n1 == 0 or n2 == 0:
        return 0.0
    runs = 1 + int(np.sum(s[1:] != s[:-1]))
    mu = 1 + 2 * n1 * n2 / n
    var = 2 * n1 * n2 * (2 * n1 * n2 - n) / (n * n * (n - 1))
    return float((runs - mu) / math.sqrt(var)) if var > 0 else 0.0


def _bimodality(r):
    """Sarle's bimodality coefficient: (skew^2 + 1) / kurtosis. > 0.555 suggests two lumps."""
    r = np.asarray(r, dtype=float)
    n = len(r)
    if n < 8:
        return 0.0
    m = np.mean(r); s = np.std(r)
    if s <= 0:
        return 0.0
    z = (r - m) / s
    skew = float(np.mean(z ** 3)); kurt = float(np.mean(z ** 4))
    return (skew ** 2 + 1) / max(kurt, 1e-9)


def _norm_sf(z):
    return 0.5 * math.erfc(abs(z) / math.sqrt(2))


class Auditor:
    def __init__(self, alpha=0.05, bimodal_thresh=0.555):
        self.alpha = alpha
        self.bimodal_thresh = bimodal_thresh

    def judge(self, resid):
        r = np.asarray(resid, dtype=float)
        n = len(r)
        ac = _lag1_autocorr(r)
        p_ac = 2 * _norm_sf(ac * math.sqrt(n))            # under noise, ac ~ N(0, 1/n)
        rz = _runs_z(r)
        p_runs = 2 * _norm_sf(rz)
        bc = _bimodality(r)
        rejects = int(p_ac < self.alpha) + int(p_runs < self.alpha) + int(bc > self.bimodal_thresh)
        # "Structured" = ANY one test rejects noise. The first version demanded 2 of 3, and that
        # was wrong for the thing being hunted: a hidden i.i.d. variable z in {-1,+1} produces
        # two residual bands with ZERO autocorrelation and a normal runs statistic -- only
        # bimodality fires. Measured: in every stuck seed, bimodality fired 99% of the time and
        # the other two 0-1%, so the 2-of-3 rule could never reach BOUNDARY on exactly the
        # failure the MVP exists to detect. The three tests are sensitive to DIFFERENT
        # structures (drift -> autocorr/runs; missing binary -> bimodality); requiring two to
        # agree throws away the signal. False-alarm control is not this rule's job: DESIGN's
        # retraction (no observable explains it -> not a class failure) guards that, and the
        # null world measures it.
        return {
            "lag1_autocorr": round(ac, 4), "p_autocorr": round(p_ac, 4),
            "runs_z": round(rz, 3), "p_runs": round(p_runs, 4),
            "bimodality": round(bc, 4),
            "rejects": rejects, "structured": rejects >= 1,
        }
