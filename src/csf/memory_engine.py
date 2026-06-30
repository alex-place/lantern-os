"""
Lantern OS CSF/CADD Memory Engine
Mirrors MemOS tiers: Trace, Correction, Anchor, Entity, Relation, Ritual, Skill, Procedural, Export.

Design principles:
- Local-first: all records stored in JSONL under data/csf_memory/
- Inspectable: every record is human-readable JSON with full lineage
- Cube-partitioned: raw → refined → canon → archive
- Confidence-calibrated: Brier-style 0.0–1.0 scores on every record
- Privacy-scoped: private | internal | public | export_safe

Promotion flow:
    trace → anchor (attestation)
    trace → correction (human or agent fixes)
    anchor → entity (extracted into world model)
    entity → relation (linked to other entities)
    anchor → ritual (repeated pattern recognized)
    ritual → skill (crystallized, tested, reusable)
    trace → procedural (learned workflow)
    procedural → skill (crystallized, tested)
    skill → export (cleared for external release)
"""

import asyncio
import hashlib
import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from collections import defaultdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Set

# Canonicalization scheme id for MemoryRecord.checksum. Bump this (and add a
# dispatch in verify()) only if a future change makes old records unverifiable
# AND you have chosen to keep them verifiable rather than re-stamp them. The
# current decision is to re-stamp legacy records on migration, not to carry
# multiple schemes — see MemoryRecord.verify() and tests/test_csf_memory_integrity.py.
CHECKSUM_SCHEME = "py-json-canonical/v1"


class Tier(str, Enum):
    TRACE = "trace"
    CORRECTION = "correction"
    ANCHOR = "anchor"
    ENTITY = "entity"
    RELATION = "relation"
    RITUAL = "ritual"
    SKILL = "skill"
    PROCEDURAL = "procedural"
    EXPORT = "export"


class PrivacyScope(str, Enum):
    PRIVATE = "private"
    INTERNAL = "internal"
    PUBLIC = "public"
    EXPORT_SAFE = "export_safe"


class CubePartition(str, Enum):
    RAW = "raw"
    REFINED = "refined"
    CANON = "canon"
    ARCHIVE = "archive"


@dataclass
class MemoryRecord:
    memory_id: str
    tier: Tier
    created_at: str
    updated_at: str
    content: Dict[str, Any]
    confidence: float = 0.0
    privacy_scope: PrivacyScope = PrivacyScope.PRIVATE
    source_surface: str = ""
    promoted_from: Optional[str] = None
    promotion_chain: List[str] = field(default_factory=list)
    cube_partition: CubePartition = CubePartition.RAW
    tags: List[str] = field(default_factory=list)
    agents: List[str] = field(default_factory=list)
    checksum: str = ""
    vector_embedding: Optional[List[float]] = None
    keywords: List[str] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    actor_id: str = ""
    actor_type: str = "system"  # user | agent | system | inferred
    confidence_reasoning: str = ""
    staleness_signals: List[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.checksum:
            self.checksum = self._compute_checksum()

    def _compute_checksum(self) -> str:
        """SHA-256 of canonical JSON (excludes checksum itself).

        Canonicalization scheme ``CHECKSUM_SCHEME`` (``py-json-canonical/v1``):
        ``json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)``.
        This is the **Python-runtime** scheme; it is NOT byte-identical to the
        JS writers' canonical form (JS formats e.g. ``1.0`` as ``1``), so a
        record stamped by one runtime will not ``verify()`` under the other.
        Checksum verification is therefore **runtime-local** by design — see
        the cross-runtime contract documented in
        ``apps/lantern-garage/lib/csf-memory-writer.js``.
        """
        payload = {k: v for k, v in asdict(self).items() if k != "checksum"}
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def verify(self) -> bool:
        """Tamper-evidence check: recompute the canonical checksum and compare.

        IMPORTANT — known limitations (see tests/test_csf_memory_integrity.py):

        * ``verify()`` is **not invoked on any read/load path** today.
          ``from_dict()``/``MemoryEngine.read()``/``query()`` deliberately do
          NOT re-verify, so this is an opt-in integrity probe, not an enforced
          gate. Turning it into a read-path gate requires first re-stamping or
          migrating legacy records (see ``scripts/restamp-csf-memory.js``),
          otherwise it would reject genuine records.
        * It only confirms records written by the **same** canonicalization
          scheme (``py-json-canonical/v1``). Records authored by the JS writers
          use a JS canonical scheme and will not verify here.
        * Records written before 2026-06-29 by ``trading-memory.js`` /
          ``trading-news.js`` used a *broken* canonicalization (a
          ``JSON.stringify`` replacer-allowlist mistaken for a key sort) that
          excluded nested ``content.*`` from the hash. Those records are not
          verifiable under any sound scheme and should be re-stamped on
          migration rather than blessed by a versioned fallback (that would
          assert integrity over content the hash never covered).
        """
        return self.checksum == self._compute_checksum()

    def promote(
        self,
        to_tier: Tier,
        new_content: Optional[Dict[str, Any]] = None,
        confidence: Optional[float] = None,
        privacy_scope: Optional[PrivacyScope] = None,
        agent: str = "system",
    ) -> "MemoryRecord":
        """Create a promoted copy with updated tier and lineage. Preserves all new fields."""
        chain = list(self.promotion_chain)
        chain.append(f"{self.tier.value}→{to_tier.value}")
        return MemoryRecord(
            memory_id=f"{self.memory_id}_{to_tier.value}_{_ts()}",
            tier=to_tier,
            created_at=self.created_at,
            updated_at=_now(),
            content=new_content or dict(self.content),
            confidence=confidence if confidence is not None else max(self.confidence - 0.05, 0.0),
            privacy_scope=privacy_scope or self.privacy_scope,
            source_surface=self.source_surface,
            promoted_from=self.memory_id,
            promotion_chain=chain,
            cube_partition=_next_cube(self.cube_partition, to_tier),
            tags=list(self.tags),
            agents=list(self.agents) + [agent],
            keywords=list(self.keywords),
            entities=list(self.entities),
            metadata=dict(self.metadata),
            actor_id=self.actor_id,
            actor_type=self.actor_type,
            confidence_reasoning=self.confidence_reasoning,
            staleness_signals=list(self.staleness_signals),
        )

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["tier"] = self.tier.value
        d["privacy_scope"] = self.privacy_scope.value
        d["cube_partition"] = self.cube_partition.value
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MemoryRecord":
        d = dict(d)
        d["tier"] = Tier(d.pop("tier"))
        d["privacy_scope"] = PrivacyScope(d.pop("privacy_scope"))
        d["cube_partition"] = CubePartition(d.pop("cube_partition"))
        return cls(**d)


# Memory limits to prevent unbounded growth
_MAX_INDEX_SIZE = 100_000


class MemoryEngine:
    """Local-first cube-partitioned memory store."""

    def __init__(self, base_path: Optional[str] = None):
        self.base = Path(base_path or os.environ.get("CSF_MEMORY_PATH", "data/csf_memory"))
        self.base.mkdir(parents=True, exist_ok=True)
        for part in CubePartition:
            (self.base / part.value).mkdir(exist_ok=True)
        self._pending: List[Any] = []  # async write queue
        self._keyword_index: Dict[str, Set[str]] = defaultdict(set)
        self._entity_index: Dict[str, Set[str]] = defaultdict(set)
        self._index_path = self.base / "_index.json"
        self._load_index()

    def _path(self, record: MemoryRecord) -> Path:
        tier_dir = self.base / record.cube_partition.value / record.tier.value
        tier_dir.mkdir(parents=True, exist_ok=True)
        return tier_dir / f"{record.memory_id}.json"

    def _registry_path(self, partition: CubePartition) -> Path:
        return self.base / f"{partition.value}.jsonl"

    def write(self, record: MemoryRecord) -> Path:
        record.updated_at = _now()
        record.checksum = record._compute_checksum()
        path = self._path(record)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(record.to_dict(), f, indent=2, ensure_ascii=False, default=str)
        self._append_registry(record)
        self._update_index(record)
        self._save_index()
        return path

    def write_async(self, record: MemoryRecord):
        """Fire-and-forget async write. Tracks pending queue depth.

        Exceptions are captured in the returned task; callers may await
        the task to surface errors (disk full, permission denied, etc.).
        """
        task = asyncio.create_task(self._async_write(record))
        self._pending.append(task)
        task.add_done_callback(self._on_async_done)
        return task

    def _on_async_done(self, task: asyncio.Task):
        """Cleanup callback — safe because asyncio callbacks run sequentially."""
        try:
            self._pending.remove(task)
        except ValueError:
            pass  # already removed

    async def _async_write(self, record: MemoryRecord):
        """Async body factored out to share logic with synchronous write()."""
        return self.write(record)

    @property
    def pending_queue_depth(self) -> int:
        return len([t for t in self._pending if not t.done()])

    def _append_registry(self, record: MemoryRecord):
        reg = self._registry_path(record.cube_partition)
        with open(reg, "a", encoding="utf-8") as f:
            f.write(json.dumps(record.to_dict(), ensure_ascii=False, default=str) + "\n")

    def read(self, memory_id: str) -> Optional[MemoryRecord]:
        for part in CubePartition:
            for tier in Tier:
                path = self.base / part.value / tier.value / f"{memory_id}.json"
                if path.exists():
                    with open(path, "r", encoding="utf-8") as f:
                        return MemoryRecord.from_dict(json.load(f))
        return None

    def _update_index(self, record: MemoryRecord) -> None:
        """Add a record to keyword/entity indexes."""
        for kw in record.keywords:
            kw_lower = kw.lower()
            # Skip index update if already at max size
            if len(self._keyword_index[kw_lower]) >= _MAX_INDEX_SIZE:
                continue
            self._keyword_index[kw_lower].add(record.memory_id)
        for ent in record.entities:
            ent_lower = ent.lower()
            # Skip index update if already at max size
            if len(self._entity_index[ent_lower]) >= _MAX_INDEX_SIZE:
                continue
            self._entity_index[ent_lower].add(record.memory_id)

    def _save_index(self) -> None:
        """Persist indexes to JSON for fast cold starts."""
        try:
            with open(self._index_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "keywords": {k: list(v) for k, v in self._keyword_index.items()},
                        "entities": {k: list(v) for k, v in self._entity_index.items()},
                    },
                    f,
                    ensure_ascii=False,
                )
        except Exception:
            pass  # index is a perf optimization; failure is non-fatal

    def _load_index(self) -> None:
        """Load persisted indexes, or rebuild from registries if stale/missing."""
        if self._index_path.exists():
            try:
                with open(self._index_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._keyword_index = defaultdict(set, {k: set(v) for k, v in data.get("keywords", {}).items()})
                self._entity_index = defaultdict(set, {k: set(v) for k, v in data.get("entities", {}).items()})
                return
            except Exception:
                pass
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        """Full scan of all registries to rebuild indexes."""
        self._keyword_index.clear()
        self._entity_index.clear()
        for part in CubePartition:
            reg = self._registry_path(part)
            if not reg.exists():
                continue
            with open(reg, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = MemoryRecord.from_dict(json.loads(line))
                        self._update_index(rec)
                    except Exception:
                        continue
        self._save_index()

    def _scan_registry(self, partition: CubePartition) -> Generator[MemoryRecord, None, None]:
        """Yield parsed records from a single registry."""
        reg = self._registry_path(partition)
        if not reg.exists():
            return
        with open(reg, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield MemoryRecord.from_dict(json.loads(line))
                except Exception:
                    continue

    def _filter_record(self, rec: MemoryRecord, **filters) -> bool:
        """Apply non-keyword/non-entity filters to a record."""
        if filters.get("tier") and rec.tier != filters["tier"]:
            return False
        if filters.get("privacy_scope") and rec.privacy_scope != filters["privacy_scope"]:
            return False
        if filters.get("min_confidence") and rec.confidence < filters["min_confidence"]:
            return False
        if filters.get("source_surface") and rec.source_surface != filters["source_surface"]:
            return False
        if filters.get("tags") and not any(t in rec.tags for t in filters["tags"]):
            return False
        if filters.get("metadata_filter") and not self._metadata_matches(rec.metadata, filters["metadata_filter"]):
            return False
        return True

    def _indexed_candidates(
        self,
        keywords: Optional[List[str]],
        entities: Optional[List[str]],
        match_any: bool = False,
    ) -> Optional[Set[str]]:
        """Return candidate memory_ids from indexes, or None for full scan.

        match_any=False (default): a candidate must match ALL provided keywords
        and entities (set intersection) — strict, good for precise lookups.

        match_any=True: a candidate matching ANY provided keyword/entity is
        included (set union). Natural-language queries rarely have every token in
        one record, so AND-intersection returns nothing; union is the correct
        recall behavior for retrieval-augmented memory (ranking then orders them).
        """
        if not keywords and not entities:
            return None
        candidate_sets: List[Set[str]] = []
        if keywords:
            for kw in keywords:
                candidate_sets.append(self._keyword_index.get(kw.lower(), set()))
        if entities:
            for ent in entities:
                candidate_sets.append(self._entity_index.get(ent.lower(), set()))
        if not candidate_sets:
            return None
        result = candidate_sets[0].copy()
        for s in candidate_sets[1:]:
            if match_any:
                result |= s
            else:
                result &= s
        return result

    def query(
        self,
        tier: Optional[Tier] = None,
        partition: Optional[CubePartition] = None,
        privacy_scope: Optional[PrivacyScope] = None,
        tags: Optional[List[str]] = None,
        min_confidence: float = 0.0,
        source_surface: Optional[str] = None,
        metadata_filter: Optional[Dict[str, Any]] = None,
        keywords: Optional[List[str]] = None,
        entities: Optional[List[str]] = None,
        limit: int = 100,
        use_multi_signal: bool = False,
        match_any: bool = False,
    ) -> List[MemoryRecord]:
        """Query memory records with optional multi-signal retrieval.

        When keywords or entities are provided, uses inverted indexes for
        O(matched_candidates) lookup instead of O(all_records) full scan.

        When use_multi_signal=True and keywords/entities are provided,
        results are scored and ranked by fused semantic + keyword + entity signals.
        """
        results: List[MemoryRecord] = []
        scored: List[tuple[float, MemoryRecord]] = []
        candidate_ids = self._indexed_candidates(keywords, entities, match_any=match_any)

        if candidate_ids is not None:
            # Index path: load only candidates
            for mid in candidate_ids:
                rec = self.read(mid)
                if rec is None:
                    continue
                if not self._filter_record(
                    rec,
                    tier=tier,
                    privacy_scope=privacy_scope,
                    min_confidence=min_confidence,
                    source_surface=source_surface,
                    tags=tags,
                    metadata_filter=metadata_filter,
                ):
                    continue
                if use_multi_signal:
                    score = self._multi_signal_score(rec, keywords or [], entities or [])
                    scored.append((score, rec))
                else:
                    results.append(rec)
                    if len(results) >= limit:
                        return results
        else:
            # Full scan fallback when no keywords/entities provided
            partitions = [partition] if partition else list(CubePartition)
            for part in partitions:
                for rec in self._scan_registry(part):
                    if not self._filter_record(
                        rec,
                        tier=tier,
                        privacy_scope=privacy_scope,
                        min_confidence=min_confidence,
                        source_surface=source_surface,
                        tags=tags,
                        metadata_filter=metadata_filter,
                    ):
                        continue
                    if use_multi_signal and (keywords or entities):
                        score = self._multi_signal_score(rec, keywords or [], entities or [])
                        scored.append((score, rec))
                    else:
                        results.append(rec)
                        if len(results) >= limit:
                            return results

        if use_multi_signal and scored:
            scored.sort(key=lambda x: x[0], reverse=True)
            return [rec for _, rec in scored[:limit]]
        return results

    @staticmethod
    def _metadata_matches(record_meta: Dict[str, Any], filter_meta: Dict[str, Any]) -> bool:
        """Check if record metadata contains all filter key-value pairs."""
        for key, value in filter_meta.items():
            if key not in record_meta:
                return False
            if record_meta[key] != value:
                return False
        return True

    @staticmethod
    def _multi_signal_score(
        rec: MemoryRecord,
        query_keywords: List[str],
        query_entities: List[str],
    ) -> float:
        """Fused retrieval score: semantic 0.5 + keyword 0.3 + entity 0.2.

        Semantic component falls back to record confidence when no external
        vector similarity is available.
        """
        semantic = rec.confidence if rec.confidence else 0.5
        keyword_score = 0.0
        entity_score = 0.0

        if query_keywords and rec.keywords:
            matched = sum(1 for kw in query_keywords if kw.lower() in [k.lower() for k in rec.keywords])
            keyword_score = matched / max(len(query_keywords), 1)

        if query_entities and rec.entities:
            matched = sum(1 for ent in query_entities if ent.lower() in [e.lower() for e in rec.entities])
            entity_score = matched / max(len(query_entities), 1)

        return semantic * 0.5 + keyword_score * 0.3 + entity_score * 0.2

    def promote(
        self,
        memory_id: str,
        to_tier: Tier,
        agent: str = "system",
        new_content: Optional[Dict[str, Any]] = None,
        confidence: Optional[float] = None,
        privacy_scope: Optional[PrivacyScope] = None,
    ) -> MemoryRecord:
        """Promote a record to a higher tier."""
        rec = self.read(memory_id)
        if not rec:
            raise ValueError(f"Memory not found: {memory_id}")
        promoted = rec.promote(
            to_tier=to_tier,
            new_content=new_content,
            confidence=confidence,
            privacy_scope=privacy_scope,
            agent=agent,
        )
        self.write(promoted)
        return promoted

    def stats(self) -> Dict[str, Any]:
        """Cube and tier coverage statistics."""
        stats = {"total": 0, "by_partition": {}, "by_tier": {}, "by_privacy": {}}
        for part in CubePartition:
            reg = self._registry_path(part)
            if not reg.exists():
                continue
            with open(reg, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = MemoryRecord.from_dict(json.loads(line))
                    except Exception:
                        continue
                    stats["total"] += 1
                    stats["by_partition"][part.value] = stats["by_partition"].get(part.value, 0) + 1
                    stats["by_tier"][rec.tier.value] = stats["by_tier"].get(rec.tier.value, 0) + 1
                    stats["by_privacy"][rec.privacy_scope.value] = stats["by_privacy"].get(rec.privacy_scope.value, 0) + 1
        return stats


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _next_cube(current: CubePartition, target_tier: Tier) -> CubePartition:
    """Determine cube partition based on tier promotion."""
    if target_tier == Tier.EXPORT:
        return CubePartition.ARCHIVE
    if target_tier in (Tier.SKILL, Tier.RITUAL, Tier.PROCEDURAL):
        return CubePartition.CANON
    if target_tier in (Tier.ENTITY, Tier.RELATION, Tier.ANCHOR):
        return CubePartition.REFINED
    return current


def create_trace(
    text: str,
    session_id: str,
    surface: str = "dream-chat",
    role: str = "user",
    confidence: float = 1.0,
    privacy_scope: PrivacyScope = PrivacyScope.PRIVATE,
    tags: Optional[List[str]] = None,
    keywords: Optional[List[str]] = None,
    entities: Optional[List[str]] = None,
) -> MemoryRecord:
    """Factory: create a raw trace record."""
    return MemoryRecord(
        memory_id=f"trace_{uuid.uuid4().hex[:8]}_{_ts()}",
        tier=Tier.TRACE,
        created_at=_now(),
        updated_at=_now(),
        content={
            "text": text,
            "session_id": session_id,
            "timestamp": _now(),
            "surface": surface,
            "role": role,
            "raw_input": text,
        },
        confidence=confidence,
        privacy_scope=privacy_scope,
        source_surface=surface,
        tags=tags or [],
        keywords=keywords or [],
        entities=entities or [],
    )


def create_correction(
    original: MemoryRecord,
    corrected_field: str,
    new_value: Any,
    reason: str,
    corrected_by: str = "user",
    confidence: float = 0.9,
) -> MemoryRecord:
    """Factory: create a correction record from an existing memory."""
    return original.promote(
        to_tier=Tier.CORRECTION,
        new_content={
            "original_memory_id": original.memory_id,
            "corrected_field": corrected_field,
            "old_value": original.content.get(corrected_field),
            "new_value": new_value,
            "reason": reason,
            "corrected_by": corrected_by,
            "correction_type": "factual",
        },
        confidence=confidence,
        agent=corrected_by,
    )


def create_entity(
    name: str,
    entity_type: str,
    description: str,
    confidence: float = 0.7,
    privacy_scope: PrivacyScope = PrivacyScope.INTERNAL,
    source_trace_id: Optional[str] = None,
) -> MemoryRecord:
    """Factory: create an entity from scratch or promoted from trace."""
    rec = MemoryRecord(
        memory_id=f"ent_{name.lower().replace(' ', '_')}_{uuid.uuid4().hex[:6]}",
        tier=Tier.ENTITY,
        created_at=_now(),
        updated_at=_now(),
        content={
            "name": name,
            "entity_type": entity_type,
            "description": description,
            "aliases": [],
            "first_seen_at": _now(),
            "occurrence_count": 1,
        },
        confidence=confidence,
        privacy_scope=privacy_scope,
        cube_partition=CubePartition.REFINED,
    )
    if source_trace_id:
        rec.promoted_from = source_trace_id
        rec.promotion_chain = [f"trace→entity"]
    return rec


def create_skill(
    name: str,
    capability: str,
    implementation_ref: str,
    confidence: float = 0.8,
    privacy_scope: PrivacyScope = PrivacyScope.INTERNAL,
    source_ritual_id: Optional[str] = None,
) -> MemoryRecord:
    """Factory: create a crystallized skill record."""
    rec = MemoryRecord(
        memory_id=f"skill_{name.lower().replace(' ', '_')}_{uuid.uuid4().hex[:6]}",
        tier=Tier.SKILL,
        created_at=_now(),
        updated_at=_now(),
        content={
            "name": name,
            "capability": capability,
            "implementation_ref": implementation_ref,
            "tested": False,
            "test_results": [],
            "crystallized_at": _now(),
        },
        confidence=confidence,
        privacy_scope=privacy_scope,
        cube_partition=CubePartition.CANON,
    )
    if source_ritual_id:
        rec.promoted_from = source_ritual_id
        rec.promotion_chain = [f"ritual→skill"]
    return rec


def create_procedure(
    name: str,
    steps: List[str],
    tool_invocations: Optional[List[str]] = None,
    confidence: float = 0.6,
    privacy_scope: PrivacyScope = PrivacyScope.INTERNAL,
    source_trace_id: Optional[str] = None,
) -> MemoryRecord:
    """Factory: create a procedural memory record (how-to workflow)."""
    rec = MemoryRecord(
        memory_id=f"proc_{name.lower().replace(' ', '_')}_{uuid.uuid4().hex[:6]}",
        tier=Tier.PROCEDURAL,
        created_at=_now(),
        updated_at=_now(),
        content={
            "name": name,
            "steps": steps,
            "tool_invocations": tool_invocations or [],
            "success_rate": 0.0,
            "invocation_count": 0,
            "last_applied_at": None,
        },
        confidence=confidence,
        privacy_scope=privacy_scope,
        cube_partition=CubePartition.CANON,
    )
    if source_trace_id:
        rec.promoted_from = source_trace_id
        rec.promotion_chain = [f"trace→procedural"]
    return rec


def check_staleness(record: MemoryRecord, candidate: MemoryRecord, threshold: float = 0.7) -> bool:
    """Lightweight contradiction check between two same-entity memories.

    Returns True if candidate contradicts record (same entity type and name,
    but conflicting content). When True, this function MUTATES record:
    - appends a staleness signal
    - halves confidence (bounded by threshold as a floor)
    """
    if record.memory_id == candidate.memory_id:
        return False
    old_name = record.content.get("name", "")
    new_name = candidate.content.get("name", "")
    old_type = record.content.get("entity_type", "")
    new_type = candidate.content.get("entity_type", "")
    if old_name and new_name and old_name == new_name:
        if old_type and new_type and old_type != new_type:
            return False  # same name but different types — not a contradiction
        conflict_fields = ["description", "employer", "location", "status", "value"]
        for field in conflict_fields:
            old_val = record.content.get(field)
            new_val = candidate.content.get(field)
            if old_val and new_val and old_val != new_val:
                record.staleness_signals.append(
                    f"contradiction:{field}:{_ts()}"
                )
                record.confidence = max(record.confidence * 0.5, threshold)
                return True
    return False
