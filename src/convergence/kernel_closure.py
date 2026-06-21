"""
Σ₀-K1 component 9 — kernel serving-loop closure  (#848, spec §4.5).

The Kalshi slice already closes Reason→Verify→Converge (suggest → settle → grade +
write-back). This generalizes that closure to the *kernel* serving path: given any
served kernel continuation ``{prompt, reply, confidence, evidence, source}``, write a
Convergence Record (``data/convergence/records.jsonl``, the schema the JS emitter
uses) AND a Memory write-back via ``MemoryStore.append`` — so a kernel reply lands in
persistent memory under the same confidence-laundering gate as everything else.

This is the *closure logic*, exercised here with a stubbed/CIO_SDE-rollout
continuation so it is unit-testable without a live served Ouro. Wiring it onto the
real served continuation (``scripts/ouro_serve.py`` _generate) is the non-local half:
that needs a GPU + the state-ABI shim (#844), and the served reply text itself.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from .memory import MemoryStore

DEFAULT_RECORDS_PATH = "data/convergence/records.jsonl"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def close_kernel_loop(continuation: Dict[str, Any], *,
                      records_path: str = DEFAULT_RECORDS_PATH,
                      memory: Optional[MemoryStore] = None,
                      agent: str = "Kernel") -> Dict[str, Any]:
    """Close the loop on one kernel continuation: emit a Convergence Record + memory write-back.

    ``continuation`` keys: ``prompt``, ``reply``, ``confidence`` (0-1), ``evidence``
    (list of source strings), ``source``. Grounding (non-empty ``evidence``) decides
    whether the memory write-back is trusted or routed to the proposals partition.
    Returns ``{"record": <dict>, "memory_entry": <MemoryEntry>}``.
    """
    reply = str(continuation.get("reply", ""))
    prompt = str(continuation.get("prompt", ""))
    evidence = [str(e) for e in (continuation.get("evidence") or [])]
    confidence = float(continuation.get("confidence", 0.5))
    source = str(continuation.get("source") or "kernel")
    grounded = bool(evidence)

    # (a) Convergence Record — same shape the JS emitter writes to records.jsonl.
    record = {
        "timestamp": continuation.get("timestamp") or _utcnow_iso(),
        "claim": reply,
        "type": "kernel-continuation",
        "evidence": "; ".join(evidence),
        "confidence": confidence,
        "source": source,
        "sources": evidence,
        "agent": agent,
        "userMessage": prompt,
        "corrected": False,
    }
    rp = Path(records_path)
    rp.parent.mkdir(parents=True, exist_ok=True)
    with rp.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")

    # (b) Memory write-back — grounded entries land in the trusted convergence log;
    # ungrounded ones are clamped and partitioned to proposals by the store's gate.
    store = memory if memory is not None else MemoryStore()
    entry = store.append(
        source=source,
        content={"prompt": prompt, "reply": reply, "claim": reply},
        confidence=confidence,
        evidence_ids=(evidence or None),
        log_type="convergence",
        verification_status="grounded" if grounded else "unverified",
    )
    return {"record": record, "memory_entry": entry}
