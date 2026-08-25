"""A -- the explorer. Ordinary least squares on whatever features it currently has.

Deliberately dumb: it can fit parameters and nothing else. It cannot notice that a variable is
missing, it cannot propose one, it has no concept of its own model class. If the controller
finds the hidden variable, it is NOT because A did anything clever. That is the point of the
MVP -- the mechanism lives in the controller and the auditor, not in the explorer.
"""
from __future__ import annotations

import numpy as np


class Explorer:
    def __init__(self, features):
        self.features = list(features)      # e.g. ["x"] then ["x", "z3"]
        self.beta = None

    def fit(self, X, y):
        Xb = np.column_stack([np.ones(len(y)), X])
        self.beta, *_ = np.linalg.lstsq(Xb, y, rcond=None)
        return self.beta

    def predict(self, X):
        if self.beta is None:
            return np.zeros(len(X))
        Xb = np.column_stack([np.ones(len(X)), X])
        return Xb @ self.beta

    def residuals(self, X, y):
        return np.asarray(y) - self.predict(X)
