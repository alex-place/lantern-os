"""Arm 3's governance: the fresh-task Σ_θ gate, the burned pool, and the budget rule.

Everything here is harness code. The loop hands the gate program text and gets a
decision back; it cannot reach the thresholds (a frozen config), the task issuer, the
burned ledger or the gate log. The rules follow the certificate's §8
(docs/SIGMA0-COLLAPSE-CERTIFICATE.md):

* every promotion is decided on instances drawn fresh for that decision (§8.1.2
  condition 1, fresh-task gain), with a regression veto on a sample of retired
  instances (condition 2, retention), a crash/timeout veto (condition 5, stability),
  and provenance asserted on every id (condition 6, data integrity); the parent stays
  in the archive (condition 7, rollback);
* every improver change is decided the same way: the candidate's and the incumbent's
  children, produced under equal budgets, are re-scored on instances drawn fresh for
  that decision (Yang §13.2's descendant test used as the gate);
* used instances are retired to a burned pool (§8.4 rotating tiers); the final holdout
  is a different stream that this process may not even generate;
* the proposer's prediction error shrinks its candidate budget (Yang §5.6). Yang gives
  no formula; the rule below is this experiment's, fixed before the run.

Conditions 3 (reward integrity) and 4 (drift budget) of §8.1.2 have no separate content
here: there is no proxy reward apart from the fresh score, and no weights to drift.
"""
from __future__ import annotations

import json
import math
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import binpack
from .evaluation import Evaluator


@dataclass(frozen=True)
class GateConfig:
    n_fresh: int = 16            # instances per promotion decision (= arms 1-2 validation size)
    n_retention: int = 16        # retired instances re-read for the regression veto
    t_min: float = 1.0           # paired t needed for a fresh gain
    retention_tol: float = 0.5   # max allowed mean regression on retired instances (score units)
    n_improver: int = 24         # fresh instances per improver decision
    improver_t_min: float = 1.0  # Welch t needed to adopt an improver change
    calib_window: int = 30       # last N valid children used for calibration
    calib_min: int = 10          # below this many, no budget cap


class TaskIssuer:
    """Hands out never-used instance ids from one stream and keeps the burned pool."""

    def __init__(self, stream: str, ledger_path: Path):
        if stream == "holdout":
            raise ValueError("the holdout stream is never issued")
        self.stream = stream
        self.next_idx = 0
        self.burned: List[int] = []
        self._ledger = Path(ledger_path)

    def _log(self, row: dict) -> None:
        with self._ledger.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def draw(self, n: int, purpose: str, gen: int) -> List[binpack.Instance]:
        ids = list(range(self.next_idx, self.next_idx + n))
        self.next_idx += n
        burned = set(self.burned)
        assert not burned.intersection(ids), "a fresh draw overlapped the burned pool"
        self._log({"event": "draw", "gen": gen, "purpose": purpose, "stream": self.stream,
                   "ids": [ids[0], ids[-1]]})
        return binpack.make_instances(self.stream, ids)

    def burn(self, instances: Sequence[binpack.Instance], gen: int) -> None:
        ids = [i.idx for i in instances]
        self.burned.extend(ids)
        self._log({"event": "burn", "gen": gen, "n": len(ids), "pool": len(self.burned)})

    def sample_burned(self, n: int, rng: np.random.Generator) -> List[binpack.Instance]:
        if len(self.burned) < n:
            return []
        ids = rng.choice(np.array(self.burned), size=n, replace=False)
        return binpack.make_instances(self.stream, [int(i) for i in ids])

    def state(self) -> dict:
        return {"stream": self.stream, "next_idx": self.next_idx, "burned": list(self.burned)}

    def restore(self, st: dict) -> None:
        self.next_idx = int(st["next_idx"])
        self.burned = [int(i) for i in st["burned"]]


def paired_t(d: np.ndarray) -> float:
    if len(d) < 2:
        return 0.0
    sd = float(np.std(d, ddof=1))
    m = float(np.mean(d))
    if sd == 0.0:
        return math.inf if m > 0 else 0.0
    return m / (sd / math.sqrt(len(d)))


def welch_t(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 2 or len(b) < 2:
        return 0.0
    va, vb = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
    diff = float(np.mean(a) - np.mean(b))
    den = math.sqrt(va / len(a) + vb / len(b))
    if den == 0.0:
        return math.inf if diff > 0 else 0.0
    return diff / den


class SigmaGate:
    def __init__(self, cfg: GateConfig, issuer: TaskIssuer, evaluator: Evaluator, log_path: Path,
                 rng: np.random.Generator):
        self.cfg = cfg
        self.issuer = issuer
        self.ev = evaluator
        self.rng = rng
        self._log_path = Path(log_path)

    def _log(self, row: dict) -> None:
        with self._log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def promote(self, child_code: str, parent_code: str, gen: int, tag: str
                ) -> Tuple[bool, dict, List[binpack.Instance], np.ndarray, np.ndarray]:
        """Fresh-task promotion decision for one child against its parent.

        Returns (accept, record, fresh_instances, child_scores, parent_scores); the scores
        on the fresh instances update both programs' running estimates.
        """
        cfg = self.cfg
        fresh = self.issuer.draw(cfg.n_fresh, "promotion", gen)
        rec: dict = {"kind": "promotion", "gen": gen, "tag": tag,
                     "fresh_ids": [fresh[0].idx, fresh[-1].idx]}
        ok_c, sc, err_c = self.ev.scores(child_code, fresh)
        ok_p, sp, err_p = self.ev.scores(parent_code, fresh)
        if not ok_c or not ok_p:
            rec.update(accept=False, reason="stability", error=(err_c or err_p)[:200])
            self.issuer.burn(fresh, gen)
            self._log(rec)
            return False, rec, fresh, sc, sp
        d = sc - sp
        mean, t = float(np.mean(d)), paired_t(d)
        rec.update(gain=mean, t=t if math.isfinite(t) else 1e9)
        accept = mean > 0 and t >= cfg.t_min
        reason = "fresh_gain" if not accept else "pass"
        if accept:
            ret = self.issuer.sample_burned(cfg.n_retention, self.rng)
            if ret:
                ok_rc, rc, _ = self.ev.scores(child_code, ret)
                ok_rp, rp, _ = self.ev.scores(parent_code, ret)
                if not ok_rc or not ok_rp:
                    accept, reason = False, "stability_retention"
                else:
                    r = float(np.mean(rc - rp))
                    rec["retention"] = r
                    if r < -cfg.retention_tol:
                        accept, reason = False, "retention"
            else:
                rec["retention"] = None
        rec.update(accept=accept, reason=reason)
        self.issuer.burn(fresh, gen)
        self._log(rec)
        return accept, rec, fresh, sc, sp

    def improver(self, incumbent: List[Tuple[Optional[str], str]],
                 candidate: List[Tuple[Optional[str], str]], gen: int) -> Tuple[bool, dict]:
        """Equal-budget descendant test on fresh instances, used as the improver gate.

        Each list holds (child_code or None if the proposal was invalid, parent_code), one
        entry per proposal the improver made in the A/B window. A proposal's value is
        max(0, child - parent) on the fresh set: what a correct gate could keep from it.
        """
        cfg = self.cfg
        rec: dict = {"kind": "improver", "gen": gen, "n_incumbent": len(incumbent),
                     "n_candidate": len(candidate)}
        if not incumbent or not candidate:
            rec.update(adopt=False, reason="empty_window")
            self._log(rec)
            return False, rec
        fresh = self.issuer.draw(cfg.n_improver, "improver", gen)

        def values(group):
            out = []
            for child, parent in group:
                if child is None:
                    out.append(0.0)
                    continue
                ok_c, sc, _ = self.ev.scores(child, fresh)
                ok_p, sp, _ = self.ev.scores(parent, fresh)
                out.append(max(0.0, float(np.mean(sc - sp))) if ok_c and ok_p else 0.0)
            return np.array(out)

        qi, qc = values(incumbent), values(candidate)
        t = welch_t(qc, qi)
        diff = float(qc.mean() - qi.mean())
        adopt = diff > 0 and t >= cfg.improver_t_min
        rec.update(q_incumbent=float(qi.mean()), q_candidate=float(qc.mean()), diff=diff,
                   t=t if math.isfinite(t) else 1e9, adopt=adopt,
                   reason="pass" if adopt else "no_fresh_gain",
                   fresh_ids=[fresh[0].idx, fresh[-1].idx])
        self.issuer.burn(fresh, gen)
        self._log(rec)
        return adopt, rec


class Calibration:
    """Yang §5.6 operationalized: a proposer that cannot predict its effects gets fewer
    candidates per parent.

    skill = 1 - sum|pred - actual| / sum|actual - median(actual)| over the last `window`
    valid children (a missing prediction counts as 0). skill <= 0 means no better than
    always predicting the median. k_cap = 1 if skill < 0.25, 2 if skill < 0.75, else 3;
    no cap until `min_n` children have been scored.
    """

    def __init__(self, window: int, min_n: int):
        self.pairs: deque = deque(maxlen=window)
        self.min_n = min_n

    def add(self, predicted: Optional[float], actual: float) -> None:
        self.pairs.append((0.0 if predicted is None else float(predicted), float(actual)))

    def skill(self) -> Optional[float]:
        if len(self.pairs) < self.min_n:
            return None
        p = np.array([a for a, _ in self.pairs])
        a = np.array([b for _, b in self.pairs])
        base = float(np.sum(np.abs(a - np.median(a))))
        err = float(np.sum(np.abs(p - a)))
        if base == 0.0:
            return 1.0 if err == 0.0 else -1.0
        return 1.0 - err / base

    def k_cap(self) -> int:
        s = self.skill()
        if s is None:
            return 3
        return 1 if s < 0.25 else (2 if s < 0.75 else 3)

    def state(self) -> dict:
        return {"pairs": list(self.pairs), "maxlen": self.pairs.maxlen, "min_n": self.min_n}

    @classmethod
    def from_state(cls, st: dict) -> "Calibration":
        c = cls(st["maxlen"], st["min_n"])
        c.pairs.extend(tuple(p) for p in st["pairs"])
        return c
