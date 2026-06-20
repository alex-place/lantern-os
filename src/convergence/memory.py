"""LANTERN-MEMORY: Persistent accumulated learning via append-only JSONL.

Wraps existing JSONL logs (conversations, observations, convergence records)
as a queryable Memory interface with confidence scoring and evidence tracking.

Implements the Remember stage of the Convergence Loop.
Each memory entry is immutable — confidence may shift, content never changes.

Reference: CONVERGANCE-SIGMA0-BRIEFING.md, convergence-core-mapping.md
"""

import json
import hashlib
import itertools
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any, Union
from dataclasses import dataclass, asdict

# #767 (G2) — confidence laundering gate. An append with no evidence and no
# explicit verification is a *proposal*, not durable knowledge: clamp it to this
# cap and route it to the proposals partition so high-temperature reasoner output
# can't be queried back as trusted memory.
UNVERIFIED_CONFIDENCE_CAP = 0.3
VERIFIED_STATUSES = frozenset({"verified", "asserted", "grounded"})


def _integrity_hash(record: Dict[str, Any]) -> str:
    """Deterministic SHA-256 over a record's content-bearing fields + prev_hash.

    Excludes ``entry_hash`` itself (it is the output) so the hash is recomputable
    from any persisted record. ``prev_hash`` IS included, which is what chains the
    ledger: tampering with any record breaks every hash after it.
    """
    payload = {
        "prev_hash": record.get("prev_hash", ""),
        "id": record.get("id"),
        "timestamp": record.get("timestamp"),
        "source": record.get("source"),
        "confidence": record.get("confidence"),
        "content": record.get("content"),
        "evidence_ids": record.get("evidence_ids", []),
        "verification_status": record.get("verification_status", "unverified"),
    }
    blob = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


@dataclass
class MemoryEntry:
    """Single entry in persistent memory log."""
    id: str
    timestamp: datetime
    source: str  # tool/agent that created this
    confidence: float  # 0.0-1.0: trustworthiness
    content: Dict[str, Any]  # the actual data
    evidence_ids: List[str] = None  # which memories support this?
    verification_status: str = "unverified"  # #767 (G2): unverified|verified|asserted|grounded
    prev_hash: str = ""   # #767 (G2/G3): hash of the previous ledger record (chain link)
    entry_hash: str = ""  # #767: integrity hash of this record (set on append)

    def __post_init__(self):
        if self.evidence_ids is None:
            self.evidence_ids = []

    def to_dict(self) -> Dict:
        """Convert to JSON-serializable dict."""
        return {
            "id": self.id,
            "timestamp": self.timestamp.isoformat(),
            "source": self.source,
            "confidence": self.confidence,
            "content": self.content,
            "evidence_ids": self.evidence_ids,
            "verification_status": self.verification_status,
            "prev_hash": self.prev_hash,
            "entry_hash": self.entry_hash,
        }


class MemoryStore:
    """Queryable interface over append-only JSONL logs.

    Manages multiple log files and provides unified query API.
    All appends are immutable; queries filter by pattern/confidence.
    """

    def __init__(self, memory_dir: str = "data"):
        """Initialize memory store with directory containing JSONL logs.

        Args:
            memory_dir: Directory containing JSONL files
        """
        self.memory_dir = Path(memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)

        # Known log files (can expand)
        self.logs = {
            "conversations": self.memory_dir / "conversations" / "garage-conversations.jsonl",
            "observations": self.memory_dir / "observations.jsonl",
            "convergence": self.memory_dir / "convergence-records.jsonl",
            "dreams": self.memory_dir / "dreams.jsonl",
            "trading": self.memory_dir / "trading-history.jsonl",
            # #767 (G2): unverified/low-confidence proposals are partitioned here,
            # never into the trusted logs above.
            "proposals": self.memory_dir / "proposals.jsonl",
        }

        # Ensure directories exist
        for log_path in self.logs.values():
            log_path.parent.mkdir(parents=True, exist_ok=True)
            if not log_path.exists():
                log_path.touch()

        # #767 (G2/G3): tip of each log's hash chain, so a new append links to the
        # last persisted record. Updated on load and on every append.
        self._last_hash: Dict[str, str] = {name: "" for name in self.logs}
        self.cache: Dict[str, MemoryEntry] = {}
        # Monotonic suffix so two appends from the same source can never collide
        # on an ID. datetime.now().timestamp() has coarse resolution on Windows
        # (~15ms system tick), so rapid same-source appends would otherwise share
        # a timestamp -> identical ID -> the first entry is silently lost.
        self._id_counter = itertools.count()
        self._load_cache()

    def _load_cache(self) -> None:
        """Load all memories into cache."""
        for log_name, log_path in self.logs.items():
            if not log_path.exists():
                continue

            try:
                with open(log_path, "r", encoding="utf-8") as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            data = json.loads(line)
                            # Parse timestamp if present
                            if "timestamp" in data and isinstance(data["timestamp"], str):
                                data["timestamp"] = datetime.fromisoformat(data["timestamp"])
                            elif "timestamp" not in data:
                                data["timestamp"] = datetime.now()

                            # Create memory entry with log source
                            mem_id = data.get("id", f"{log_name}-{len(self.cache)}")
                            source = data.get("source", log_name)
                            confidence = data.get("confidence", 0.9)
                            content = data.get("content", data)
                            evidence_ids = data.get("evidence_ids", [])

                            entry = MemoryEntry(
                                id=mem_id,
                                timestamp=data["timestamp"],
                                source=source,
                                confidence=confidence,
                                content=content,
                                evidence_ids=evidence_ids,
                                # #767: legacy records predate these fields; default safely.
                                verification_status=data.get("verification_status", "unverified"),
                                prev_hash=data.get("prev_hash", ""),
                                entry_hash=data.get("entry_hash", ""),
                            )
                            self.cache[mem_id] = entry
                            # Advance the chain tip so the next append links correctly.
                            if entry.entry_hash:
                                self._last_hash[log_name] = entry.entry_hash
                        except (json.JSONDecodeError, KeyError):
                            continue
            except Exception as e:
                print(f"Error loading {log_path}: {e}")

        # #767 (G3): replay confidence-update records so the reconstructed cache
        # reflects the append-only ledger. Without this, a reloaded store would
        # show each entry's original on-disk confidence and diverge from the live
        # store (which applied the update in memory).
        updates = [e for e in self.cache.values() if e.source == "confidence-update"]
        for upd in sorted(updates, key=lambda e: e.timestamp):
            target_id = upd.content.get("updates")
            if target_id and target_id in self.cache:
                self.cache[target_id].confidence = upd.content.get(
                    "new_confidence", self.cache[target_id].confidence
                )

    def append(
        self,
        source: str,
        content: Dict[str, Any],
        confidence: float = UNVERIFIED_CONFIDENCE_CAP,
        evidence_ids: Optional[List[str]] = None,
        log_type: str = "observations",
        verification_status: str = "unverified",
    ) -> MemoryEntry:
        """Append new memory entry to log (hash-chained, append-only).

        #767 (G2) — confidence-laundering gate: an entry is only allowed to carry
        high confidence if it is *grounded* — i.e. it cites evidence (``evidence_ids``)
        or is explicitly marked ``verification_status`` in {verified, asserted,
        grounded}. An ungrounded entry is a proposal: its confidence is clamped to
        ``UNVERIFIED_CONFIDENCE_CAP`` and it is routed to the ``proposals`` partition
        so it can never be queried back as trusted memory. The default confidence is
        the unverified prior, not 0.9.

        Args:
            source: Origin (tool/agent name)
            content: The data to store
            confidence: Requested trust level (0.0-1.0); capped unless grounded
            evidence_ids: Supporting memories (presence makes the entry grounded)
            log_type: Which log file to append to
            verification_status: unverified | verified | asserted | grounded

        Returns: MemoryEntry with assigned ID
        """
        mem_id = f"{source}-{datetime.now().timestamp()}-{next(self._id_counter)}"
        timestamp = datetime.now()
        evidence_ids = evidence_ids or []
        confidence = max(0.0, min(1.0, confidence))

        # #767 (G2): grounded iff it cites evidence or is explicitly verified.
        grounded = bool(evidence_ids) or verification_status in VERIFIED_STATUSES
        if not grounded:
            verification_status = "unverified"
            if confidence > UNVERIFIED_CONFIDENCE_CAP:
                confidence = UNVERIFIED_CONFIDENCE_CAP
            # Route ungrounded proposals to their own partition, never the trusted log.
            log_type = "proposals"
        elif verification_status not in VERIFIED_STATUSES:
            # Grounded by cited evidence alone — label it so query/audit can see why.
            verification_status = "grounded"

        target = log_type if log_type in self.logs else "observations"

        entry = MemoryEntry(
            id=mem_id,
            timestamp=timestamp,
            source=source,
            confidence=confidence,
            content=content,
            evidence_ids=evidence_ids,
            verification_status=verification_status,
            prev_hash=self._last_hash.get(target, ""),
        )
        entry.entry_hash = _integrity_hash(entry.to_dict())

        # Persist to the hash-chained log
        log_path = self.logs[target]
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry.to_dict()) + "\n")
            self._last_hash[target] = entry.entry_hash  # advance chain only on success
        except Exception as e:
            print(f"Error appending to {log_path}: {e}")

        self.cache[mem_id] = entry
        return entry

    def query(
        self,
        pattern: str,
        min_confidence: float = 0.5,
        order_by: Optional[str] = None,
        limit: int = 10,
        source_filter: Optional[str] = None,
    ) -> List[MemoryEntry]:
        """Query memory by pattern and confidence.

        Args:
            pattern: Text pattern to search (checked in source and content)
            min_confidence: Minimum confidence threshold
            order_by: Sort by 'timestamp', 'confidence', or None
            limit: Maximum results
            source_filter: Restrict to specific source

        Returns: List of matching MemoryEntry objects
        """
        pattern_lower = pattern.lower()
        results = []

        for entry in self.cache.values():
            # Filter by confidence
            if entry.confidence < min_confidence:
                continue

            # Filter by source
            if source_filter and source_filter.lower() not in entry.source.lower():
                continue

            # Pattern match on source
            if pattern_lower in entry.source.lower():
                results.append(entry)
                continue

            # Pattern match on content
            try:
                content_str = json.dumps(entry.content, default=str).lower()
                if pattern_lower in content_str:
                    results.append(entry)
            except (TypeError, ValueError):
                if pattern_lower in str(entry.content).lower():
                    results.append(entry)

        # Sort if requested
        if order_by == "timestamp":
            results.sort(key=lambda m: m.timestamp)
        elif order_by == "confidence":
            results.sort(key=lambda m: m.confidence, reverse=True)

        return results[:limit]

    def get_by_id(self, mem_id: str) -> Optional[MemoryEntry]:
        """Retrieve a single memory by ID."""
        return self.cache.get(mem_id)

    def update_confidence(
        self,
        mem_id: str,
        new_confidence: float,
        evidence_ids: Optional[List[str]] = None,
        log_type: str = "convergence",
    ) -> bool:
        """Update confidence of an existing memory (post-verification).

        #767 (G3) — two leaks fixed:
          1. Cache/ledger divergence: the old path mutated ``self.cache`` only and
             never touched disk, so ``query()`` diverged from the append-only log.
             A confidence-update record is now appended to the ledger (hash-chained)
             so the durable history reflects the change.
          2. Unbounded raise: confidence could be raised arbitrarily with no
             evidence. *Raising* confidence now requires ``evidence_ids``; an
             ungrounded raise is rejected. Lowering (e.g. on refutation) is always
             allowed.

        Args:
            mem_id: ID of memory to update
            new_confidence: New confidence value (0.0-1.0)
            evidence_ids: Memories justifying the change (required to raise)
            log_type: Ledger to record the update in

        Returns: True if applied, False if rejected / unknown id
        """
        if mem_id not in self.cache:
            return False

        entry = self.cache[mem_id]
        new_confidence = max(0.0, min(1.0, new_confidence))
        evidence_ids = evidence_ids or []

        # G3: raising confidence demands evidence; lowering never does.
        if new_confidence > entry.confidence and not evidence_ids:
            return False

        old_confidence = entry.confidence
        entry.confidence = new_confidence
        if evidence_ids:
            # Preserve provenance of the upgrade without losing prior evidence.
            entry.evidence_ids = list(dict.fromkeys([*entry.evidence_ids, *evidence_ids]))
            entry.verification_status = "verified"

        # Persist an immutable update record so the ledger never diverges from cache.
        self.append(
            source="confidence-update",
            content={
                "updates": mem_id,
                "old_confidence": old_confidence,
                "new_confidence": new_confidence,
            },
            confidence=new_confidence,
            evidence_ids=evidence_ids or [mem_id],
            log_type=log_type,
            verification_status="verified",
        )
        return True

    def verify_ledger(self, log_type: str) -> Dict[str, Any]:
        """Verify the hash chain of a persisted ledger (tamper-evidence, #767).

        Re-reads the on-disk log and checks, for every hash-chained record, that
        (a) its ``entry_hash`` recomputes from its own fields and (b) its
        ``prev_hash`` matches the previous chained record's ``entry_hash``. Legacy
        records that predate chaining (no ``entry_hash``) are counted, not failed.

        Returns: {ok, checked, legacy, broken_at, reason}
        """
        log_path = self.logs.get(log_type)
        result = {"ok": True, "checked": 0, "legacy": 0, "broken_at": None, "reason": None}
        if not log_path or not log_path.exists():
            return result

        prev = ""
        idx = -1
        with open(log_path, "r", encoding="utf-8") as f:
            for idx, line in enumerate(f):
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    result.update(ok=False, broken_at=idx, reason="unparseable record")
                    return result
                if not rec.get("entry_hash"):
                    result["legacy"] += 1
                    continue
                expected = _integrity_hash(rec)
                if rec["entry_hash"] != expected:
                    result.update(ok=False, broken_at=idx, reason="entry_hash mismatch (record tampered)")
                    return result
                if rec.get("prev_hash", "") != prev:
                    result.update(ok=False, broken_at=idx, reason="prev_hash break (record inserted/removed)")
                    return result
                prev = rec["entry_hash"]
                result["checked"] += 1
        return result

    def statistics(self) -> Dict[str, Any]:
        """Get memory statistics."""
        entries = list(self.cache.values())
        if not entries:
            return {
                "total_entries": 0,
                "average_confidence": 0.0,
                "by_source": {},
            }

        avg_confidence = sum(e.confidence for e in entries) / len(entries)

        by_source = {}
        for entry in entries:
            if entry.source not in by_source:
                by_source[entry.source] = {"count": 0, "avg_confidence": 0.0}
            by_source[entry.source]["count"] += 1

        # Recalculate avg per source
        for source in by_source:
            matching = [e for e in entries if e.source == source]
            by_source[source]["avg_confidence"] = (
                sum(e.confidence for e in matching) / len(matching)
            )

        return {
            "total_entries": len(entries),
            "average_confidence": avg_confidence,
            "by_source": by_source,
            "high_confidence_count": len([e for e in entries if e.confidence >= 0.85]),
        }

    def export_csv(self, output_path: str = "data/memory-export.csv") -> None:
        """Export memory to CSV for analysis."""
        import csv

        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)

        with open(output_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                ["ID", "Timestamp", "Source", "Confidence", "Content", "Evidence IDs"]
            )

            for entry in sorted(
                self.cache.values(), key=lambda e: e.timestamp, reverse=True
            ):
                writer.writerow(
                    [
                        entry.id,
                        entry.timestamp.isoformat(),
                        entry.source,
                        entry.confidence,
                        json.dumps(entry.content),
                        ",".join(entry.evidence_ids),
                    ]
                )

        print(f"Memory exported to {output_path}")


# Global memory store instance
_memory_store: Optional[MemoryStore] = None


def get_memory_store(memory_dir: str = "data") -> MemoryStore:
    """Get or create global memory store singleton."""
    global _memory_store
    if _memory_store is None:
        _memory_store = MemoryStore(memory_dir)
    return _memory_store


def reset_memory_store() -> None:
    """Reset memory store (for testing)."""
    global _memory_store
    _memory_store = None
