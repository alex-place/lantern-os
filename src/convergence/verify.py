"""Verify stage — fold verification outcomes back into ConvergenceRecords (wq-007).

A ConvergenceRecord starts unverified with a prior confidence. Verification updates
that record from what actually happened — a test/benchmark result, or a Kalman
surprise (NIS) reading from the SurpriseMonitor. This closes Reason → Act → Verify:
claims are graded by evidence, not left at their prior.

- A passing test boosts confidence toward 1.0; a failing test collapses it.
- A high NIS (a "spook" — observation contradicts the model) collapses confidence;
  a consistent NIS nudges it up.

## G9 (#764) — deterministic-reverification ratchet, closed

`verify_with_test(passed=True)` boosts confidence multiplicatively, so *replaying
the same passing test* would ratchet it 0.3 → 0.65 → 0.83 → … → 1.0 with no new
evidence — a red-team path to a fluent-but-unsourced fixed point. Each fold is now
keyed on ``(record_id, evidence_hash)``: the record remembers which evidence it has
already absorbed (``ConvergenceRecord.applied_evidence``), and re-folding identical
evidence is an idempotent no-op. Independent corroborations still count — they carry
distinct evidence, so callers that want a genuinely new fold pass a distinct
``evidence_key`` (or vary the inputs the default key is derived from).

Links to src/cio_sde/surprise.py via its `SurpriseMonitor.evaluate()` output shape
(reads "nis"/"dof"); does not modify that module.
"""
from __future__ import annotations

import hashlib
import math
from typing import Dict, Optional

from .objects import ConvergenceRecord


def _evidence_hash(*parts: object) -> str:
    """Stable short hash identifying a piece of verification evidence.

    The default identity of a fold: identical inputs → identical hash → idempotent.
    Callers with a real evidence id (a test-run id, an observation hash) should pass
    it as ``evidence_key`` instead of relying on this derivation.
    """
    blob = "|".join("\x00" if p is None else str(p) for p in parts)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _fold_once(record: ConvergenceRecord, key: str) -> bool:
    """Return True if ``key`` is new for this record (and record it).

    False means this exact evidence was already folded into ``record.confidence``;
    the caller must then leave confidence untouched (G9 idempotency).
    """
    if record.applied_evidence is None:
        record.applied_evidence = []
    if key in record.applied_evidence:
        return False
    record.applied_evidence.append(key)
    return True


def verify_with_test(record: ConvergenceRecord, passed: bool,
                     notes: Optional[str] = None,
                     evidence_key: Optional[str] = None) -> ConvergenceRecord:
    """Fold a test/benchmark outcome into the record (mutates + returns it).

    G9: the fold is keyed on ``(record_id, evidence_hash)``. Re-folding the same
    evidence (same ``evidence_key``, or same ``passed``/``notes`` when none is given)
    leaves confidence unchanged — replaying one passing test can't ratchet it to 1.0.
    """
    key = evidence_key or _evidence_hash("test", record.id, passed, notes)
    if not _fold_once(record, key):
        record.verified = True
        record.verification_notes = f"duplicate evidence {key} ignored (G9 #764)"
        return record

    if passed:
        record.confidence = min(1.0, 0.5 + 0.5 * record.confidence)
    else:
        record.confidence = max(0.0, record.confidence * 0.2)
    record.verified = True
    record.verification_notes = notes or ("test passed" if passed else "test failed")
    return record


def verify_with_surprise(record: ConvergenceRecord, nis: float, dof: int,
                         spook_sigmas: float = 3.0,
                         evidence_key: Optional[str] = None) -> ConvergenceRecord:
    """Fold a Kalman NIS reading into the record.

    NIS ≫ dof (a spook) means observation contradicts the model → collapse
    confidence. NIS ≈ dof means the claim held → nudge confidence up.

    G9: keyed on ``(record_id, evidence_hash)`` — replaying the same NIS reading is
    idempotent, so a repeated "consistent" reading can't nudge confidence to 1.0.

    A NaN NIS is no evidence. SurpriseMonitor reads NaN for a row it could not score, one
    whose prediction, covariance or observation holds a NaN or inf, and ``NaN > threshold``
    is False, so such a reading used to fold in as "consistent". Now only the note changes:
    confidence, ``verified`` and the applied evidence are left as they were.
    """
    if math.isnan(float(nis)):
        record.verification_notes = "NIS is NaN: the observation could not be scored, so it is not evidence"
        return record
    key = evidence_key or _evidence_hash("surprise", record.id, round(float(nis), 6), int(dof))
    if not _fold_once(record, key):
        record.verified = True
        record.verification_notes = f"duplicate evidence {key} ignored (G9 #764)"
        return record

    threshold = dof + spook_sigmas * math.sqrt(2.0 * dof)
    if nis > threshold:
        record.confidence = max(0.0, record.confidence * 0.3)
        record.verification_notes = (
            f"NIS={nis:.1f} > {threshold:.1f} (spook): observation contradicts claim")
    else:
        record.confidence = min(1.0, record.confidence + 0.1 * (1.0 - record.confidence))
        record.verification_notes = f"NIS={nis:.1f} <= {threshold:.1f}: observation consistent"
    record.verified = True
    return record


def verify_with_monitor(record: ConvergenceRecord, monitor_result: Dict,
                        spook_sigmas: float = 3.0,
                        evidence_key: Optional[str] = None) -> ConvergenceRecord:
    """Convenience: fold a SurpriseMonitor.evaluate() result dict into the record.

    Accepts the dict produced by src/cio_sde/surprise.py::SurpriseMonitor.evaluate
    (keys "nis", "dof"); values may be torch tensors or plain floats.
    """
    nis = monitor_result["nis"]
    dof = monitor_result["dof"]
    nis = float(nis.item()) if hasattr(nis, "item") else float(nis)
    dof = int(dof.item()) if hasattr(dof, "item") else int(dof)
    return verify_with_surprise(record, nis, dof, spook_sigmas=spook_sigmas,
                                evidence_key=evidence_key)
